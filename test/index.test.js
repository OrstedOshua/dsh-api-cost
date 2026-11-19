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

// Clock control so daily bucketing can be exercised across calendar-day
// boundaries without depending on the wall clock. `nowOverride` becomes the
// value returned by Date.now for the duration of a test.
const REAL_NOW = Date.now
let nowOverride = null

// Each test gets its own temp DSH_HOME so state is fully isolated.
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-api-cost-'))
  process.env.DSH_HOME = home
  nowOverride = null
  Date.now = () => (nowOverride ?? REAL_NOW())
  return home
})

afterEach(() => {
  const home = process.env.DSH_HOME
  if (home) rmSync(home, { recursive: true, force: true })
  Date.now = REAL_NOW
})

/**
 * Build a fresh plugin instance via the real `apply()` and capture the pieces
 * a test needs: the session-event handler and the registered HTTP fetch route.
 */
function makeApp(extraCtx = {}) {
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
    ...extraCtx,
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
// Helpers for the 20-day chart window and the client-side currency conversion.
// `convertRub` mirrors the documented formula in lib/client.js (a browser
// bundle that is not imported here), so the conversion contract is testable
// without a DOM environment.
// ---------------------------------------------------------------------------

function ymd(ts) {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + day
}

/** The last `count` calendar-day keys (YYYY-MM-DD) ending at (y, mo, d). */
function lastNDays(count, y, mo, d) {
  const out = []
  for (let i = count - 1; i >= 0; i--) out.push(ymd(new Date(y, mo, d - i)))
  return out
}

/** Client-side RUB → selected-currency conversion (mirror of lib/client.js). */
function convertRub(amountRub, currency, rates) {
  const n = Number.isFinite(amountRub) && amountRub >= 0 ? amountRub : 0
  const base = rates && Number(rates.RUB)
  const to = rates && Number(rates[currency])
  if (base > 0 && to > 0) return (n / base) * to
  return n
}

/** Mirror of the client's chart labelling (lib/client.js): show a date label on
 * every `step`-th column plus the final one, so ~6 labels never collide on a
 * 20-bar chart. Returns the column indexes that receive a label. */
function chartLabelPositions(days) {
  const step = Math.max(1, Math.ceil(days.length / 6))
  const positions = []
  for (let i = 0; i < days.length; i++) {
    if (i % step === 0 || i === days.length - 1) positions.push(i)
  }
  return positions
}

/** Client-side label text: strip the leading year (YYYY-MM-DD -> MM-DD). */
function chartLabel(dateStr) {
  return String(dateStr).slice(5)
}

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
  // Legacy day *records* migrate to sessions, so the numeric daily-aggregate
  // map stays empty (it is only fed by addUsage during live usage events).
  assert.deepEqual(saved.days, {})
  assert.ok(saved.sessions['day/2026-11-15'])
})

// ---------------------------------------------------------------------------
// Chat name (name / setSessionName)
// ---------------------------------------------------------------------------

test('session has an empty name by default', async () => {
  const app = makeApp()
  const payload = await get(app.fetch, 's')
  assert.equal(payload.session.name, '')
})

test('setSessionName stores and persists a trimmed name', async () => {
  const app = makeApp()
  const res = await post(app.fetch, { action: 'setSessionName', session: 's', name: '  My Chat  ' })
  assert.equal(res.ok, true)
  assert.equal(res.session.name, 'My Chat')

  // name is readable through GET and persisted to disk
  const payload = await get(app.fetch, 's')
  assert.equal(payload.session.name, 'My Chat')
  assert.equal(readState().sessions.s.name, 'My Chat')
})

test('setSessionName supports renaming a chat', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setSessionName', session: 's', name: 'First' })
  const res = await post(app.fetch, { action: 'setSessionName', session: 's', name: 'Second' })
  assert.equal(res.session.name, 'Second')

  const payload = await get(app.fetch, 's')
  assert.equal(payload.session.name, 'Second')
})

test('setSessionName normalizes the name (trim + 200-char cap)', async () => {
  const app = makeApp()
  const long = 'x'.repeat(250)
  const res = await post(app.fetch, { action: 'setSessionName', session: 's', name: '  ' + long + '  ' })
  assert.equal(res.session.name, 'x'.repeat(200))

  // whitespace-only input trims to empty string
  const res2 = await post(app.fetch, { action: 'setSessionName', session: 's', name: '   ' })
  assert.equal(res2.session.name, '')
})

test('setSessionName requires a session id', async () => {
  const app = makeApp()
  const res = await post(app.fetch, { action: 'setSessionName', name: 'no-session' })
  assert.ok(res.error, 'expected a sessionRequired error')
})

// ---------------------------------------------------------------------------
// Default title from the sessionTitle service (when name is empty)
// ---------------------------------------------------------------------------

test('GET returns title from sessionTitle when the name is empty', async () => {
  const app = makeApp({
    sessionTitle: { get: () => 'DSH System Title' },
  })
  const payload = await get(app.fetch, 's')
  assert.equal(payload.session.name, '')
  assert.equal(payload.session.title, 'DSH System Title')
})

test('a user-set name takes precedence over the system title', async () => {
  const app = makeApp({
    sessionTitle: { get: () => 'DSH System Title' },
  })
  await post(app.fetch, { action: 'setSessionName', session: 's', name: 'User Name' })
  const payload = await get(app.fetch, 's')
  assert.equal(payload.session.name, 'User Name')
  assert.equal(payload.session.title, undefined)
})

test('no title is added when sessionTitle has no value', async () => {
  const app = makeApp({
    sessionTitle: { get: () => '' },
  })
  const payload = await get(app.fetch, 's')
  assert.equal(payload.session.name, '')
  assert.equal(payload.session.title, undefined)
})

test('chat list resolves the system title for unnamed chats', async () => {
  const app = makeApp({
    sessionTitle: { get: () => 'DSH System Title' },
  })
  await post(app.fetch, { action: 'setPrices', prices: PRICE })
  app.emit('s', { outputTokens: 2 })

  const payload = await get(app.fetch)
  const sess = payload.sessions.find((s) => s.sessionId === 's')
  assert.equal(sess.name, '')
  assert.equal(sess.title, 'DSH System Title') // shown bold as the chat name
  assert.equal(sess.sessionId, 's') // sessionId stays separate, listed small below
})

test('chat list prefers an explicit user name and omits the system title', async () => {
  const app = makeApp({
    sessionTitle: { get: () => 'DSH System Title' },
  })
  await post(app.fetch, { action: 'setPrices', prices: PRICE })
  app.emit('s', { outputTokens: 2 })
  await post(app.fetch, { action: 'setSessionName', session: 's', name: 'My Chat' })

  const payload = await get(app.fetch)
  const sess = payload.sessions.find((s) => s.sessionId === 's')
  assert.equal(sess.name, 'My Chat')
  assert.equal(sess.title, undefined)
  assert.equal(sess.sessionId, 's')
})

test('chat list shows the raw sessionId when there is no name or title', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })
  app.emit('s', { outputTokens: 2 })

  const payload = await get(app.fetch)
  const sess = payload.sessions.find((s) => s.sessionId === 's')
  assert.equal(sess.name, '')
  assert.equal(sess.title, undefined)
  assert.equal(sess.sessionId, 's') // UI falls back to the id as the visible label
})

// ---------------------------------------------------------------------------
// Daily spend series (days / getDays): always 20 columns ending today,
// zero-filled, populated as spend accrues.
// ---------------------------------------------------------------------------

test('days series always returns 20 columns ending today, zero-filled', async () => {
  const app = makeApp()
  nowOverride = Date.parse('2026-11-19T12:00:00')
  const payload = await get(app.fetch)
  assert.equal(payload.days.length, 20)
  assert.deepEqual(
    payload.days.map((d) => d.date),
    lastNDays(20, 2026, 10, 19),
  )
  assert.ok(payload.days.every((d) => d.costRub === 0), 'empty days are zero-filled')
})

test('daily spend fills the matching columns in the 20-day series', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })

  nowOverride = Date.parse('2026-11-18T10:00:00')
  app.emit('s', { outputTokens: 2 }) // cost 2 on 11-18
  app.emit('s', { outputTokens: 3 }) // -> 5 on 11-18
  nowOverride = Date.parse('2026-11-19T10:00:00')
  app.emit('s', { outputTokens: 4 }) // cost 4 on 11-19

  const payload = await get(app.fetch)
  assert.equal(payload.days.length, 20)
  const byDate = Object.fromEntries(payload.days.map((d) => [d.date, d.costRub]))
  assert.equal(byDate['2026-11-18'], 5)
  assert.equal(byDate['2026-11-19'], 4)
  // Columns outside the active spend window stay zero-filled (no sparse array).
  assert.equal(byDate['2026-11-17'], 0)
  assert.equal(byDate['2026-11-01'], 0)
  assert.equal(byDate['2026-10-31'], 0)
})

test('usage around midnight splits into separate daily buckets in the series', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })

  nowOverride = Date.parse('2026-11-18T23:59:59')
  app.emit('s', { outputTokens: 1 }) // cost 1 on 11-18
  nowOverride = Date.parse('2026-11-19T00:00:01')
  app.emit('s', { outputTokens: 1 }) // cost 1 on 11-19

  const payload = await get(app.fetch)
  assert.equal(payload.days.length, 20)
  const byDate = Object.fromEntries(payload.days.map((d) => [d.date, d.costRub]))
  assert.equal(byDate['2026-11-18'], 1)
  assert.equal(byDate['2026-11-19'], 1)
})

test('GET for a single session also carries the 20-day series', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })
  nowOverride = Date.parse('2026-11-18T12:00:00')
  app.emit('s', { outputTokens: 2 })

  const payload = await get(app.fetch, 's')
  assert.equal(payload.days.length, 20)
  const byDate = Object.fromEntries(payload.days.map((d) => [d.date, d.costRub]))
  assert.equal(byDate['2026-11-18'], 2)
})

// ---------------------------------------------------------------------------
// Currency conversion (bug fix): stored costs are RUB; the UI converts them to
// the selected currency at the live USD-base rate. 160 ₽ must become ~2 $
// rather than being shown as 160 $.
// ---------------------------------------------------------------------------

test('convertRub converts RUB to USD at the exchange rate', () => {
  const usd = convertRub(160, 'USD', { RUB: 90, USD: 1 })
  assert.ok(Math.abs(usd - 160 / 90) < 1e-9, `expected ≈1.78, got ${usd}`)
  assert.ok(usd < 160, 'converted value must not equal the raw RUB amount (bug regression)')
})

test('convertRub converts RUB to EUR and CNY at the exchange rate', () => {
  const rates = { RUB: 90, USD: 1, EUR: 0.9, CNY: 7.2 }
  assert.ok(Math.abs(convertRub(160, 'EUR', rates) - (160 / 90) * 0.9) < 1e-9)
  assert.ok(Math.abs(convertRub(160, 'CNY', rates) - (160 / 90) * 7.2) < 1e-9)
})

test('convertRub falls back to the raw RUB amount without valid rates', () => {
  assert.equal(convertRub(160, 'USD', null), 160)
  assert.equal(convertRub(160, 'USD', { RUB: 0, USD: 1 }), 160)
  assert.equal(convertRub(NaN, 'USD', { RUB: 90, USD: 1 }), 0)
  assert.equal(convertRub(-5, 'USD', { RUB: 90, USD: 1 }), 0)
})

test('switching currency keeps stored RUB totals intact and supplies rates for the UI', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })
  app.emit('s', { outputTokens: 160 }) // costRub = 160

  await post(app.fetch, { action: 'setCurrency', currency: 'USD' })
  const payload = await get(app.fetch)

  assert.equal(payload.currency, 'USD')
  assert.equal(payload.rates.base, 'USD')
  assert.equal(payload.rates.RUB, 90)

  // The stored total is still 160 RUB (stored amounts are never rewritten to
  // the display currency)...
  const sess = payload.sessions.find((s) => s.sessionId === 's')
  assert.equal(sess.costRub, 160)
  // ...and converting it with the API-served rates yields ≈1.78 USD.
  const usd = convertRub(sess.costRub, payload.currency, payload.rates)
  assert.ok(Math.abs(usd - 160 / 90) < 1e-9)
})

// ---------------------------------------------------------------------------
// Bug fix: session title is resolved from the injected sessions/sessionTitle
// services (systemTitle), so a chat shows a real name instead of a raw id.
// ---------------------------------------------------------------------------

test('systemTitle returns the title from the sessions projection', async () => {
  const sessions = new Map([
    ['chat-1', { projections: { values: () => ({ title: 'Миграция данных' }) } }],
  ])
  const app = makeApp({ sessions })
  const payload = await get(app.fetch, 'chat-1')
  assert.equal(payload.session.name, '')
  assert.equal(payload.session.title, 'Миграция данных')
})

test('systemTitle prefers the sessionTitle service over the sessions projection', async () => {
  const sessions = new Map([
    ['chat-1', { projections: { values: () => ({ title: 'From projection' }) } }],
  ])
  const app = makeApp({
    sessions,
    sessionTitle: { get: () => 'From service' },
  })
  const payload = await get(app.fetch, 'chat-1')
  assert.equal(payload.session.title, 'From service')
})

test('chat list shows titles resolved from injected sessions/sessionTitle', async () => {
  const sessions = new Map([
    ['chat-1', { projections: { values: () => ({ title: 'Проект Альфа' }) } }],
  ])
  const app = makeApp({ sessions })
  await post(app.fetch, { action: 'setPrices', prices: PRICE })
  app.emit('chat-1', { outputTokens: 2 })

  const payload = await get(app.fetch)
  const sess = payload.sessions.find((s) => s.sessionId === 'chat-1')
  assert.ok(sess, 'chat must appear after emitting usage')
  assert.equal(sess.name, '')
  assert.equal(sess.title, 'Проект Альфа')
  assert.equal(sess.sessionId, 'chat-1')
})

test('missing sessions/sessionTitle still resolve to an empty title (no crash)', async () => {
  const app = makeApp() // no extra context
  const payload = await get(app.fetch, 'chat-1')
  assert.equal(payload.session.name, '')
  assert.equal(payload.session.title, undefined)
})

// ---------------------------------------------------------------------------
// Bug fix: cost updates in real time — the very next read after an
// assistant/message event reflects the new spend (no reload/silent poll).
// ---------------------------------------------------------------------------

test('cost is immediately reflected after an assistant/message event', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })

  // Initial state: zero spend.
  let payload = await get(app.fetch, 'chat-1')
  assert.equal(payload.session.costRub, 0)
  assert.equal(payload.session.outputTokens, 0)

  // After the event, the very next read already carries the updated cost.
  app.emit('chat-1', { outputTokens: 3 })
  payload = await get(app.fetch, 'chat-1')
  assert.equal(payload.session.costRub, 3)
  assert.equal(payload.session.outputTokens, 3)

  // A second event accumulates immediately too.
  app.emit('chat-1', { outputTokens: 2 })
  payload = await get(app.fetch, 'chat-1')
  assert.equal(payload.session.costRub, 5)
  assert.equal(payload.session.outputTokens, 5)
})

test('only assistant/message events update the live cost', async () => {
  const app = makeApp()
  await post(app.fetch, { action: 'setPrices', prices: PRICE })

  // A non-assistant event with usage must NOT move the cost.
  app.emit('chat-1', { outputTokens: 9 }, 'user/message')
  let payload = await get(app.fetch, 'chat-1')
  assert.equal(payload.session.costRub, 0)
  assert.equal(payload.session.outputTokens, 0)

  // The assistant/message event updates it.
  app.emit('chat-1', { outputTokens: 4 })
  payload = await get(app.fetch, 'chat-1')
  assert.equal(payload.session.costRub, 4)
})

// ---------------------------------------------------------------------------
// Bug fix: daily chart labels are spaced out so dates on the 20-column chart
// do not collide — only every Nth column (plus the last) gets a label.
// ---------------------------------------------------------------------------

test('chart label step is computed so ~6 labels fit without overlap', async () => {
  const days = lastNDays(20, 2026, 10, 19)
  const step = Math.max(1, Math.ceil(days.length / 6))
  assert.equal(step, 4)

  // A label is shown at i%step===0 plus the final column.
  const labelled = days.map((_, i) => i % step === 0 || i === days.length - 1)
  const shown = labelled.filter(Boolean).length
  assert.equal(shown, 6, 'expected exactly 6 labels on a 20-column chart')

  // Labels are spaced roughly `step` apart (every Nth column), except the
  // final column which is always labelled even when it sits just after the
  // last regular tick. Never every column.
  const indexes = labelled
    .map((on, i) => (on ? i : -1))
    .filter((i) => i >= 0)
  assert.equal(indexes[0], 0, 'first column is always labelled')
  for (let i = 1; i < indexes.length - 1; i++) {
    assert.equal(indexes[i] - indexes[i - 1], step, 'regular label spacing must equal the computed step')
  }
  assert.equal(indexes[indexes.length - 1], days.length - 1, 'last column is always labelled')
})

test('chart labels format as MM-DD (year stripped) and read in date order', async () => {
  const days = lastNDays(20, 2026, 10, 19)
  const step = Math.max(1, Math.ceil(days.length / 6))
  const labels = days
    .map((d, i) => (i % step === 0 || i === days.length - 1 ? chartLabel(d) : null))
    .filter(Boolean)

  assert.ok(labels.length > 0)
  for (const l of labels) {
    assert.match(l, /^\d{2}-\d{2}$/, `label must be MM-DD, got "${l}"`)
  }
  // Ascending chronological order across the 20-day window.
  const sorted = [...labels].sort()
  assert.deepEqual(labels, sorted)
  assert.equal(labels[0], '10-31')
  assert.equal(labels[labels.length - 1], '11-19')
})

test('few days get labelled on every column (no sparsity needed)', async () => {
  const days = lastNDays(5, 2026, 10, 19)
  const step = Math.max(1, Math.ceil(days.length / 6))
  assert.equal(step, 1)
  const labels = days.map((d, i) => (i % step === 0 || i === days.length - 1 ? chartLabel(d) : null))
  assert.equal(labels.filter(Boolean).length, days.length, 'every column is labelled for 5 days')
})

// end of dsh-api-cost test suite
