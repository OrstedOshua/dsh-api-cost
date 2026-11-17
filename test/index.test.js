import { test, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, name } from '../lib/index.js'

// ---------------------------------------------------------------------------
// Harness: drive the plugin purely through its public `apply(ctx)` contract.
// No lib/ internals are touched or re-implemented here.
// ---------------------------------------------------------------------------

const STATE_FILE = 'token-cost-state.json'
const ROUTE = '/api/token-cost'

// Each test gets its own temp DSH_HOME so state is fully isolated.
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-api-cost-'))
  process.env.DSH_HOME = home
  return home
})

afterEach(() => {
  const home = process.env.DSH_HOME
  if (home) rmSync(home, { recursive: true, force: true })
})

/**
 * Build a fresh plugin instance via the real `apply()` and capture the pieces
 * a test needs: the session-event handler and the registered HTTP fetch route.
 */
function makeApp() {
  const handlers = {}
  let config = null
  let fetchHandler = null
  const ctx = {
    on(type, fn) {
      handlers[type] = fn
    },
    inject(deps, fn) {
      fn({
        connection: {
          fetch: {
            register(cfg) {
              config = cfg
              fetchHandler = cfg.fetch
            },
          },
        },
      })
    },
  }
  apply(ctx)

  return {
    ctx,
    handlers,
    config,
    fetch: fetchHandler,
    /** Emit a provider-reported assistant/message usage event for a session. */
    emit(sessionId, usage, eventType = 'assistant/message') {
      handlers['session/event']({ id: sessionId }, { type: eventType, data: { usage } })
    },
  }
}

function request(fetch, req) {
  return fetch(req)
}

async function get(fetch, sessionId) {
  const query = sessionId ? '?session=' + encodeURIComponent(sessionId) : ''
  const res = await request(fetch, { method: 'GET', url: 'http://localhost' + ROUTE + query })
  return res.json()
}

async function post(fetch, body) {
  const res = await request(fetch, { method: 'POST', json: async () => body })
  return res.json()
}

function readState() {
  const file = join(process.env.DSH_HOME, STATE_FILE)
  return JSON.parse(readFileSync(file, 'utf8'))
}

// Set prices: output price 1_000_000 per 1M tokens => 1 token = 1 cost unit.
const PRICE = { input: 0, output: 1_000_000, cache: 0 }

// ---------------------------------------------------------------------------
// Exchange-rate fallback behaviour (fetchRates). We stub the global fetch so
// the tests are deterministic and never hit the real network.
// ---------------------------------------------------------------------------

let failRates = false

before(() => {
  globalThis.fetch = async () => {
    if (failRates) throw new Error('simulated network failure')
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: 'success',
        date: '2026-01-01',
        rates: { USD: 1, EUR: 0.9, RUB: 90, CNY: 7.2 },
      }),
    }
  }
})

test('module exposes the expected name', () => {
  assert.equal(name, 'api-cost')
})

test('apply registers the route for GET and POST on the fenced path', () => {
  const app = makeApp()
  assert.equal(app.config.path, ROUTE)
  assert.deepEqual([...app.config.methods].sort(), ['GET', 'POST'])
})

test('fetchRates falls back to a zeroed-safe payload when the API is offline', async () => {
  failRates = true
  try {
    const app = makeApp()
    const payload = await get(app.fetch)
    assert.ok(payload.rates, 'GET must always return a rates object')
    assert.equal(payload.rates.base, 'USD')
    assert.equal(payload.rates.USD, 1)
    assert.equal(payload.rates.RUB, 0)
    assert.equal(payload.rates.EUR, 0)
    assert.equal(typeof payload.rates.date, 'object') // null on failure
  } finally {
    failRates = false
  }
})

test('fetchRates returns live rates from the API when it succeeds', async () => {
  const app = makeApp()
  const payload = await get(app.fetch)
  assert.equal(payload.rates.base, 'USD')
  assert.equal(payload.rates.USD, 1)
  assert.equal(payload.rates.RUB, 90)
  assert.equal(payload.rates.EUR, 0.9)
  assert.equal(payload.rates.date, '2026-01-01')
})

// ---------------------------------------------------------------------------
// Per-session cost tracking
// ---------------------------------------------------------------------------

test('cost is tracked per session and remains independent', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })

  app.emit('session-a', { outputTokens: 2 })
  app.emit('session-b', { outputTokens: 5 })

  const payload = await get(app.fetch)
  const byId = Object.fromEntries(payload.sessions.map((s) => [s.sessionId, s]))
  assert.equal(byId['session-a'].costRub, 2)
  assert.equal(byId['session-a'].outputTokens, 2)
  assert.equal(byId['session-b'].costRub, 5)
  assert.equal(byId['session-b'].outputTokens, 5)
})

test('input/output/cache tokens are accumulated and billed separately', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })

  app.emit('s', { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 200, cacheWriteTokens: 50 })

  const payload = await get(app.fetch, 's')
  assert.equal(payload.session.inputTokens, 1000)
  assert.equal(payload.session.outputTokens, 500)
  assert.equal(payload.session.cacheReadTokens, 200)
  assert.equal(payload.session.cacheWriteTokens, 50)
  // billing: input miss (input - cacheRead) @ p.input, output @ p.output,
  // cache (read+write) @ p.cache. With only output priced, cost = 500.
  const inputMiss = 1000 - 200
  const expected =
    (inputMiss / 1e6) * PRICE.input +
    (500 / 1e6) * PRICE.output +
    ((200 + 50) / 1e6) * PRICE.cache
  assert.equal(payload.session.costRub, expected)
  assert.equal(expected, 500)
})

// ---------------------------------------------------------------------------
// Price freeze on use
// ---------------------------------------------------------------------------

test('prices are frozen at use: later price changes never rewrite past spend', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE }) // output = 1e6

  app.emit('s', { outputTokens: 2 }) // cost = 2

  await post(app.fetch, { action: 'setPrices', prices: { input: 0, output: 0, cache: 0 } })

  app.emit('s', { outputTokens: 3 }) // cost = 0 at new price

  const payload = await get(app.fetch, 's')
  assert.equal(payload.session.outputTokens, 5)
  assert.equal(payload.session.costRub, 2) // unchanged by the price edit
})

// ---------------------------------------------------------------------------
// enabled switch
// ---------------------------------------------------------------------------

test('enabled=false pauses accumulation; re-enabling resumes it', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })

  await post(app.fetch, { action: 'setEnabled', enabled: false })
  app.emit('s', { outputTokens: 5 })
  let payload = await get(app.fetch)
  assert.equal(payload.enabled, false)
  assert.deepEqual(payload.sessions, []) // nothing recorded while disabled
  assert.deepEqual(readState().sessions, {})

  await post(app.fetch, { action: 'setEnabled', enabled: true })
  app.emit('s', { outputTokens: 5 })
  payload = await get(app.fetch)
  assert.equal(payload.enabled, true)
  assert.equal(payload.sessions[0].outputTokens, 5)
})

// ---------------------------------------------------------------------------
// clearSession
// ---------------------------------------------------------------------------

test('clearSession removes a session from persisted state', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })
  app.emit('s', { outputTokens: 4 })

  let payload = await get(app.fetch)
  assert.equal(payload.sessions.length, 1)

  const cleared = await post(app.fetch, { action: 'clearSession', session: 's' })
  assert.equal(cleared.ok, true)
  // return payload already reports an emptied session record
  assert.equal(cleared.session.costRub, 0)
  assert.equal(cleared.session.outputTokens, 0)

  // the key is gone from disk
  assert.deepEqual(readState().sessions, {})
})

// ---------------------------------------------------------------------------
// language / currency preferences
// ---------------------------------------------------------------------------

test('language and currency are settable and reflected in GET', async () => {
  const app = makeApp()
  let payload = await get(app.fetch)
  assert.equal(payload.language, 'ru')
  assert.equal(payload.currency, 'RUB')

  await post(app.fetch, { action: 'setLanguage', language: 'en' })
  await post(app.fetch, { action: 'setCurrency', currency: 'USD' })
  payload = await get(app.fetch)
  assert.equal(payload.language, 'en')
  assert.equal(payload.currency, 'USD')
})

test('invalid language/currency fall back to defaults', async () => {
  const app = makeApp()
  const l = await post(app.fetch, { action: 'setLanguage', language: 'xx' })
  assert.equal(l.language, 'ru')
  const c = await post(app.fetch, { action: 'setCurrency', currency: 'XX' })
  assert.equal(c.currency, 'RUB')
})

// ---------------------------------------------------------------------------
// Legacy state-file migration: old format keyed by `days` (not `sessions`)
// ---------------------------------------------------------------------------

test('legacy state file (days format) migrates to per-day sessions', async () => {
  // Legacy (pre-v3) state tracked spend per-day under a `days` key and had no
  // `sessions` container. Per the agreed migration contract, each day must be
  // migrated to a session keyed "day/<YYYY-MM-DD>".
  const legacy = {
    version: 2,
    days: {
      '2026-11-15': {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        cacheWriteTokens: 50,
        costRub: 0.012,
      },
      '2026-11-16': { inputTokens: 10 },
    },
    enabled: false,
  }
  writeFileSync(join(process.env.DSH_HOME, STATE_FILE), JSON.stringify(legacy, null, 2))

  const app = makeApp()
  const payload = await get(app.fetch)

  // Scalar preferences fall back to defaults when missing in the legacy file.
  assert.equal(payload.enabled, false)
  assert.equal(payload.language, 'ru')
  assert.equal(payload.currency, 'RUB')

  // Each legacy day becomes a session keyed "day/<YYYY-MM-DD>".
  const s15 = payload.sessions.find((s) => s.sessionId === 'day/2026-11-15')
  const s16 = payload.sessions.find((s) => s.sessionId === 'day/2026-11-16')
  assert.ok(s15, 'day/2026-11-15 migrated to a session')
  assert.equal(s15.inputTokens, 1000)
  assert.equal(s15.outputTokens, 500)
  assert.equal(s15.cacheReadTokens, 200)
  assert.equal(s15.cacheWriteTokens, 50)
  assert.equal(s15.costRub, 0.012)
  assert.equal(s15.lastActive, Date.parse('2026-11-15'))
  assert.ok(s16, 'day/2026-11-16 migrated to a session')
  assert.equal(s16.inputTokens, 10)
  assert.equal(s16.outputTokens, 0) // absent numeric fields normalize to 0

  // The persisted file is upgraded to v3 and stores `sessions`, not `days`.
  const saved = readState()
  assert.equal(saved.version, 3)
  assert.ok(!saved.days)
  assert.ok(saved.sessions['day/2026-11-15'])
})

// end of dsh-api-cost test suite
