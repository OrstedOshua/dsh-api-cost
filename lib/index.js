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
 * Added behaviour (this version):
 * - Migration from the legacy state format (a `days` key holding per-day
 *   aggregate records) into the current `sessions` model, plus defaulting of
 *   `language`/`currency` when absent.
 * - History is bounded: zero/null sessions are pruned and at most
 *   `MAX_SESSIONS` (200) chats are kept (top by cost).
 * - Per-session `lastActive` timestamp enables a "today" vs "all time" range.
 * - A summary (totals across the selected range) is computed for the UI.
 * - Settings + statistics can be exported to / imported from JSON.
 * - A batch "clear all chats" operation..
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
const MAX_SESSIONS = 200

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

/** Host error messages, translated by the stored UI language (ru/en). */
const HOST_ERRORS = {
  ru: {
    badBody: 'тело запроса должно быть JSON',
    sessionRequired: 'требуется идентификатор сессии',
    unknownAction: 'неизвестное действие',
    importFailed: 'ошибка импорта',
    invalidData: 'недопустимые данные',
  },
  en: {
    badBody: 'request body must be JSON',
    sessionRequired: 'session is required',
    unknownAction: 'unknown action',
    importFailed: 'import failed',
    invalidData: 'invalid data',
  },
}

/** Resolve a host error message for the stored language. */
function hostError(language, key) {
  const dict = HOST_ERRORS[language] || HOST_ERRORS.ru
  return dict[key] || key
}

/** Fresh (empty) per-session record. */
function emptySession() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costRub: 0,
    lastActive: 0,
  }
}

/** Coerce a token/cost field; NaN / negative / missing → 0. */
function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** True when a session carries no meaningful spend (all zeros). */
function isZeroSession(s) {
  return (
    !s ||
    (!s.costRub &&
      !s.inputTokens &&
      !s.outputTokens &&
      !s.cacheReadTokens &&
      !s.cacheWriteTokens &&
      !s.lastActive)
  )
}

/**
 * Normalise one session record from untrusted input (migration / import).
 * All numeric fields are coerced, `lastActive` falls back to the record's date
 * string when not explicitly present.
 */
function normalizeSession(rec, dateStr) {
  const src = rec && typeof rec === 'object' ? rec : {}
  let lastActive = num(src.lastActive)
  if (!lastActive && dateStr) {
    const parsed = Date.parse(String(dateStr))
    if (Number.isFinite(parsed)) lastActive = parsed
  }
  return {
    inputTokens: num(src.inputTokens),
    outputTokens: num(src.outputTokens),
    cacheReadTokens: num(src.cacheReadTokens),
    cacheWriteTokens: num(src.cacheWriteTokens),
    costRub: num(src.costRub),
    lastActive,
  }
}

/**
 * Migrate a legacy state object (`days` → `sessions`).
 *
 * Legacy format (pre-v3) stored per-day aggregate records under a `days` key:
 *
 *   { version: 2, enabled, language, currency, prices,
 *     days: { "2026-11-15": { inputTokens, outputTokens, cacheReadTokens,
 *                              cacheWriteTokens, costRub } } }
 *
 * Each flat day record becomes one session keyed `day/<YYYY-MM-DD>`. A legacy
 * `days` entry that itself maps sessionId → record (nested variant) is also
 * flattened. Returns the migrated sessions map and whether anything changed.
 */
function migrateDays(raw) {
  const sessions = {}
  let changed = false
  if (!raw || typeof raw !== 'object' || !raw.days || typeof raw.days !== 'object') {
    return { sessions, changed }
  }
  for (const [date, rec] of Object.entries(raw.days)) {
    if (!rec || typeof rec !== 'object') continue
    const isFlat = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costRub', 'lastActive'].some((k) => k in rec)
    if (isFlat) {
      sessions['day/' + date] = normalizeSession(rec, date)
    } else {
      for (const [sid, sr] of Object.entries(rec)) {
        if (sr && typeof sr === 'object') sessions[sid] = normalizeSession(sr, date)
      }
    }
    changed = true
  }
  return { sessions, changed }
}

/** Drop zero sessions and cap to the top MAX_SESSIONS by cost (then recency). */
function pruneSessions(sessions) {
  const out = {}
  for (const [id, s] of Object.entries(sessions)) {
    if (isZeroSession(s)) continue
    out[id] = s
  }
  const arr = Object.entries(out).sort((a, b) => {
    const byCost = (b[1].costRub || 0) - (a[1].costRub || 0)
    if (byCost !== 0) return byCost
    return (b[1].lastActive || 0) - (a[1].lastActive || 0)
  })
  const capped = {}
  const limit = Math.min(arr.length, MAX_SESSIONS)
  for (let i = 0; i < limit; i++) capped[arr[i][0]] = arr[i][1]
  return capped
}

/** True when a timestamp falls on the current calendar day (local time). */
function isToday(ts) {
  if (!ts) return false
  const d = new Date(ts)
  const n = new Date()
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
}

/** Totals across a set of sessions (the given map is assumed pre-filtered). */
function summarize(sessions) {
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let costRub = 0
  let count = 0
  for (const s of Object.values(sessions)) {
    inputTokens += s.inputTokens || 0
    outputTokens += s.outputTokens || 0
    cacheReadTokens += s.cacheReadTokens || 0
    cacheWriteTokens += s.cacheWriteTokens || 0
    costRub += s.costRub || 0
    if (!isZeroSession(s)) count++
  }
  return {
    count,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costRub,
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
          let sessions = {}
          let changed = false
          if (raw.sessions && typeof raw.sessions === 'object') {
            for (const [id, rec] of Object.entries(raw.sessions)) {
              sessions[id] = normalizeSession(rec)
            }
          } else {
            const migrated = migrateDays(raw)
            sessions = migrated.sessions
            changed = migrated.changed
          }
          sessions = pruneSessions(sessions)
          changed = changed || Object.keys(sessions).length !== Object.keys(raw.sessions || {}).length
          const state = {
            version: STATE_VERSION,
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
            language: LANGUAGES.includes(raw.language) ? raw.language : DEFAULT_LANGUAGE,
            currency: CURRENCIES.includes(raw.currency) ? raw.currency : DEFAULT_CURRENCY,
            prices: { ...DEFAULT_PRICES, ...(raw.prices || {}) },
            sessions,
          }
          // Persist the upgraded shape so the file is rewritten in the new format.
          if (changed) {
            const prior = this.data
            this.data = state
            if (prior) this.pending = false
            this.save()
          }
          return state
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
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
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
    s.lastActive = Date.now()
    this.data.sessions = pruneSessions(this.data.sessions)
    this.save()
  }

  clearSession(sessionId) {
    if (this.data.sessions[sessionId]) {
      delete this.data.sessions[sessionId]
    }
    this.save()
  }

  clearAll() {
    this.data.sessions = {}
    this.save()
    return true
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

  /** Sessions for a range ('today' | 'all'), sorted by cost (then recency). */
  listSessions(range) {
    const all = this.data.sessions
    const entries = Object.entries(all).filter(([, s]) =>
      range === 'today' ? isToday(s.lastActive) : true,
    )
    return entries
      .sort((a, b) => {
        const byCost = (b[1].costRub || 0) - (a[1].costRub || 0)
        if (byCost !== 0) return byCost
        return (b[1].lastActive || 0) - (a[1].lastActive || 0)
      })
      .map(([sessionId, s]) => ({ sessionId, ...s }))
  }

  /** Summary totals across the range. */
  summary(range) {
    const filtered = {}
    for (const [id, s] of Object.entries(this.data.sessions)) {
      if (range === 'today' && !isToday(s.lastActive)) continue
      filtered[id] = s
    }
    return summarize(filtered)
  }

  /** Deep-clone the serializable state for export. */
  exportData() {
    return JSON.parse(JSON.stringify(this.data))
  }

  /**
   * Import an exported state blob. Settings are re-validated, sessions are
   * normalised + pruned + capped. Returns {ok:true} or {ok:false, error}.
   */
  importData(data) {
    if (!data || typeof data !== 'object') return { ok: false, error: hostError(this.data.language, 'invalidData') }
    try {
      const language = LANGUAGES.includes(data.language) ? data.language : this.data.language
      const currency = CURRENCIES.includes(data.currency) ? data.currency : this.data.currency
      const enabled = typeof data.enabled === 'boolean' ? data.enabled : this.data.enabled
      const prices = { ...this.data.prices }
      for (const key of ['input', 'output', 'cache']) {
        const v = Number(data.prices?.[key])
        if (Number.isFinite(v) && v >= 0) prices[key] = v
      }
      const sessions = {}
      if (data.sessions && typeof data.sessions === 'object') {
        for (const [id, rec] of Object.entries(data.sessions)) {
          if (rec && typeof rec === 'object') sessions[id] = normalizeSession(rec)
        }
      }
      this.data.language = language
      this.data.currency = currency
      this.data.enabled = enabled
      this.data.prices = prices
      this.data.sessions = pruneSessions(sessions)
      this.data.version = STATE_VERSION
      this.save()
      return { ok: true }
    } catch {
      return { ok: false, error: hostError(this.data.language, 'invalidData') }
    }
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

function basePayload(state, range) {
  return {
    enabled: state.data.enabled,
    language: state.data.language,
    currency: state.data.currency,
    prices: state.data.prices,
    range,
  }
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
          const range = url.searchParams.get('range') === 'today' ? 'today' : 'all'
          const payload = { ...basePayload(state, range), rates: await fetchRates() }
          if (sessionId) {
            const s = state.session(sessionId)
            payload.session = { sessionId, ...s }
          } else {
            // Summarise every tracked chat so the settings panel can list and
            // clear them individually without needing a live session id.
            payload.sessions = state.listSessions(range)
            payload.summary = state.summary(range)
          }
          return jsonResponse(200, payload)
        }
        let body
        try {
          body = await request.json()
        } catch {
          return jsonResponse(400, { error: hostError(state.data.language, 'badBody') })
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
          if (!sessionId) return jsonResponse(400, { error: hostError(state.data.language, 'sessionRequired') })
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
        if (action === 'clearAll') {
          state.clearAll()
          return jsonResponse(200, {
            ok: true,
            ...basePayload(state, 'all'),
            sessions: [],
            summary: state.summary('all'),
          })
        }
        if (action === 'export') {
          const data = state.exportData()
          return jsonResponse(200, { ok: true, data })
        }
        if (action === 'import') {
          const result = state.importData(body?.data)
          if (!result.ok) return jsonResponse(400, { error: result.error || hostError(state.data.language, 'importFailed') })
          return jsonResponse(200, {
            ok: true,
            ...basePayload(state, 'all'),
            sessions: state.listSessions('all'),
            summary: state.summary('all'),
          })
        }
        return jsonResponse(400, { error: hostError(state.data.language, 'unknownAction') })
      },
    })
  })
}

export { TokenCostStore, MAX_SESSIONS, emptySession }
