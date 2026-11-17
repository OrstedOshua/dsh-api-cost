/**
 * dsh-api-cost host entry.
 *
 * Counts real API token usage from session events (`assistant/message` events
 * carry `usage` reported by the provider) and turns it into a cost using
 * user-configured prices per 1M tokens (input / output / cache).
 *
 * Model:
 * - Cost is tracked **per session (per chat)**, keyed by session id.
 * - The cost of an event is computed from the prices in effect at that moment
 *   and accumulated into the session's total. Totals are never recomputed from
 *   token counts, so changing prices never rewrites already-spent amounts.
 * - A global `enabled` switch lets the user pause counting entirely (e.g. for
 *   free APIs). While disabled no usage is accumulated.
 * - `language` (ru/en) and `currency` (RUB/USD/EUR/CNY) are user preferences
 *   served to the UI. Live exchange rates are fetched from a free, open API
 *   (open.er-api.com) and cached for an hour.
 *
 * State is persisted to a JSON file under the DSH home directory and served to
 * the settings panel + composer indicator through a fenced /api route.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'api-cost'

const HOME_ENV = 'DSH_HOME'
const HOME_DIR_NAME = '.dsh'
const STATE_FILE_NAME = 'token-cost-state.json'
const ROUTE_PATH = '/api/token-cost'
const STATE_VERSION = 3

const LANGUAGES = ['ru', 'en']
const CURRENCIES = ['RUB', 'USD', 'EUR', 'CNY']
const DEFAULT_LANGUAGE = 'ru'
const DEFAULT_CURRENCY = 'RUB'

/** Free open exchange-rate API (no key). Base currency: USD. */
const RATES_URL = 'https://open.er-api.com/v6/latest/USD'
const RATES_TTL_MS = 60 * 60 * 1000 // 1 hour

/** Prices (in the user's chosen currency) per 1M tokens. */
const DEFAULT_PRICES = {
  input: 0,
  output: 0,
  cache: 0,
}

/** Fresh (empty) per-session record. */
function emptySession() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costRub: 0,
  }
}

/**
 * Resolve the harness home exactly as the built-in instruction loader does:
 * a non-blank $DSH_HOME wins, otherwise ~/.dsh.
 */
function resolveHome() {
  const configured = process.env[HOME_ENV]
  const chosen =
    configured !== undefined && configured.trim().length > 0
      ? configured
      : join(homedir(), HOME_DIR_NAME)
  return resolve(chosen)
}

class TokenCostStore {
  constructor(file) {
    this.file = file
    this.data = this.load()
    this.pending = false
  }

  load() {
    const base = {
      version: STATE_VERSION,
      enabled: true,
      language: DEFAULT_LANGUAGE,
      currency: DEFAULT_CURRENCY,
      prices: { ...DEFAULT_PRICES },
      sessions: {},
    }
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, 'utf8'))
        if (raw && typeof raw === 'object') {
          const sessions =
            raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {}
          const language = LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_LANGUAGE
          const currency = CURRENCIES.includes(raw.currency) ? raw.currency : DEFAULT_CURRENCY
          return {
            version: STATE_VERSION,
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
            language,
            currency,
            prices: { ...DEFAULT_PRICES, ...(raw.prices || {}) },
            sessions,
          }
        }
      }
    } catch {
      /* malformed state → start fresh */
    }
    return base
  }

  save() {
    if (this.pending) return
    this.pending = true
    // Fire-and-forget; the volume is small. Guarded to avoid redundant writes.
    try {
      const dir = resolve(this.file, '..')
      mkdirSync(dir, { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
    } catch {
      /* non-fatal: next write retries */
    } finally {
      this.pending = false
    }
  }

  session(sessionId) {
    if (!this.data.sessions[sessionId]) {
      this.data.sessions[sessionId] = emptySession()
    }
    return this.data.sessions[sessionId]
  }

  /**
   * Account one provider-reported token usage record for a session.
   * Billing model (DeepSeek): prompt tokens split into cache-hit / cache-miss;
   * billed input = miss, billed cache = hit (+ any writes).
   *
   * Cost is computed from the prices in effect NOW and accumulated into the
   * session's running total. It is never recomputed later, so changing prices
   * only affects future events.
   */
  addUsage(sessionId, usage) {
    if (!this.data.enabled) return
    const s = this.session(sessionId)
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const cacheRead = Number(usage.cacheReadTokens) || 0
    const cacheWrite = Number(usage.cacheWriteTokens) || 0
    const inputMiss = Math.max(0, input - cacheRead)
    const p = this.data.prices
    const cost =
      (inputMiss / 1e6) * (p.input || 0) +
      (output / 1e6) * (p.output || 0) +
      ((cacheRead + cacheWrite) / 1e6) * (p.cache || 0)
    s.inputTokens += input
    s.outputTokens += output
    s.cacheReadTokens += cacheRead
    s.cacheWriteTokens += cacheWrite
    s.costRub += cost
    this.save()
  }

  clearSession(sessionId) {
    if (this.data.sessions[sessionId]) {
      delete this.data.sessions[sessionId]
    }
    this.save()
  }

  setPrices(prices) {
    const next = { ...this.data.prices }
    for (const key of ['input', 'output', 'cache']) {
      const v = Number(prices?.[key])
      if (Number.isFinite(v) && v >= 0) next[key] = v
    }
    this.data.prices = next
    this.save()
    return next
  }

  setEnabled(value) {
    this.data.enabled = Boolean(value)
    this.save()
    return this.data.enabled
  }

  setLanguage(value) {
    const language = LANGUAGES.includes(value) ? value : DEFAULT_LANGUAGE
    this.data.language = language
    this.save()
    return language
  }

  setCurrency(value) {
    const currency = CURRENCIES.includes(value) ? value : DEFAULT_CURRENCY
    this.data.currency = currency
    this.save()
    return currency
  }
}

// ---------------------------------------------------------------- live rates
let ratesCache = { data: null, at: 0 }

/**
 * Fetch exchange rates relative to USD from the free open API, cached for an
 * hour. On failure we return the stale cache (or a zeroed fallback) so the UI
 * never crashes over an offline moment.
 */
async function fetchRates() {
  const now = Date.now()
  if (ratesCache.data && now - ratesCache.at < RATES_TTL_MS) {
    return ratesCache.data
  }
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error('rates http ' + res.status)
    const json = await res.json()
    const rates = { base: 'USD', date: json.date || null }
    for (const c of CURRENCIES) {
      rates[c] = c === 'USD' ? 1 : Number(json.rates && json.rates[c]) || 0
    }
    ratesCache = { data: rates, at: now }
    return rates
  } catch {
    // Offline / failed: keep whatever we last had.
    return ratesCache.data || { base: 'USD', date: null, RUB: 0, USD: 1, EUR: 0, CNY: 0 }
  }
}

function jsonResponse(status, payload) {
  return Response.json(payload, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

export function apply(ctx) {
  const state = new TokenCostStore(join(resolveHome(), STATE_FILE_NAME))

  ctx.on('session/event', (session, event) => {
    if (event?.type === 'assistant/message' && event.data?.usage) {
      state.addUsage(String(session?.id ?? ''), event.data.usage)
    }
  })

  ctx.inject(['connection'], (host) => {
    host.connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        if (request.method === 'GET') {
          const url = new URL(request.url)
          const sessionId = url.searchParams.get('session') || ''
          const payload = {
            enabled: state.data.enabled,
            language: state.data.language,
            currency: state.data.currency,
            prices: state.data.prices,
            rates: await fetchRates(),
          }
          if (sessionId) {
            const s = state.session(sessionId)
            payload.session = { sessionId, ...s }
          } else {
            // Summarise every tracked chat so the settings panel can list and
            // clear them individually without needing a live session id.
            const sessions = []
            for (const [id, s] of Object.entries(state.data.sessions)) {
              sessions.push({ sessionId: id, costRub: s.costRub, inputTokens: s.inputTokens, outputTokens: s.outputTokens })
            }
            sessions.sort((a, b) => b.costRub - a.costRub)
            payload.sessions = sessions
          }
          return jsonResponse(200, payload)
        }
        let body
        try {
          body = await request.json()
        } catch {
          return jsonResponse(400, { error: 'request body must be JSON' })
        }
        const action = body?.action
        if (action === 'setEnabled') {
          const enabled = state.setEnabled(body.enabled)
          return jsonResponse(200, { ok: true, enabled, language: state.data.language, currency: state.data.currency, prices: state.data.prices })
        }
        if (action === 'setLanguage') {
          const language = state.setLanguage(body.language)
          return jsonResponse(200, { ok: true, enabled: state.data.enabled, language, currency: state.data.currency, prices: state.data.prices })
        }
        if (action === 'setCurrency') {
          const currency = state.setCurrency(body.currency)
          return jsonResponse(200, { ok: true, enabled: state.data.enabled, language: state.data.language, currency, prices: state.data.prices })
        }
        if (action === 'setPrices') {
          const prices = state.setPrices(body?.prices)
          return jsonResponse(200, { ok: true, enabled: state.data.enabled, language: state.data.language, currency: state.data.currency, prices })
        }
        if (action === 'clearSession') {
          const sessionId = String(body?.session ?? '')
          if (!sessionId) return jsonResponse(400, { error: 'session is required' })
          state.clearSession(sessionId)
          return jsonResponse(200, {
            ok: true,
            enabled: state.data.enabled,
            language: state.data.language,
            currency: state.data.currency,
            prices: state.data.prices,
            session: { sessionId, ...emptySession() },
          })
        }
        return jsonResponse(400, { error: 'unknown action' })
      },
    })
  })
}
