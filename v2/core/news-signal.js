'use strict'

// core/news-signal.js — LLM-assisted leading indicator
//
// Flow:
//   1. Poll configured sources (RSS feeds, Binance announcements) every NEWS_POLL_MS
//   2. For each new item: call OpenAI API with structured classification prompt
//   3. Parse response → { pair, direction, confidence, score, rationale }
//   4. Store in NEWS event table + in-memory decay cache
//   5. getScore(pair, nowMs) returns current decayed value
//
// Decay: linear over NEWS_DECAY_HOURS
//   score(t) = base_score × max(0, 1 − (t − event_time) / decay_ms)
//   Multiple active events per pair: additive, clamped to [−1, +1]
//
// Replay mode: skips API calls, reads NEWS events from event store on start
//
// Graceful degradation: if API unavailable or key missing, getScore() returns 0

const https = require('https')

const log = (...args) => process.stdout.write(new Date().toISOString() + ' [NEWS] ' + args.join(' ') + '\n')

// ── Constants ──────────────────────────────────────────────────────────────────

const DECAY_HOURS   = parseFloat(process.env.NEWS_DECAY_HOURS) || 2
const POLL_MS       = parseInt(process.env.NEWS_POLL_MS)       || 5 * 60 * 1000  // 5 min
const MAX_EVENTS    = parseInt(process.env.NEWS_MAX_EVENTS)    || 50  // in-memory cap

// Confidence label → base score magnitude
const CONFIDENCE_SCORES = {
  high:    1.0,
  medium:  0.6,
  low:     0.3,
  neutral: 0.0
}

// Direction → sign
const DIRECTION_SIGN = {
  bullish:  +1,
  bearish:  -1,
  neutral:   0
}

// RSS sources — plain HTTPS GET, returns XML we parse minimally
const SOURCES = {
  coindesk:      'https://feeds.feedburner.com/CoinDesk',
  cointelegraph: 'https://cointelegraph.com/rss',
  decrypt:       'https://decrypt.co/feed'
}

// ── Minimal RSS fetcher ────────────────────────────────────────────────────────

async function fetchRss(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 5000 }, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => { req.destroy(); resolve('') })
  })
}

/**
 * parseRssItems(xml) — extract title + description from RSS/Atom feed.
 * Deliberately minimal: no XML library dependency.
 * Returns [{ title, description, guid }] — newest items first.
 */
function parseRssItems(xml) {
  const items = []
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi
  let m
  while ((m = itemRe.exec(xml)) !== null) {
    const inner = m[1]
    const title = (/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/title>/.exec(inner) ||
                   /<title[^>]*>([\s\S]*?)<\/title>/.exec(inner) || [])[1] || ''
    const desc  = (/<description[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(inner) ||
                   /<description[^>]*>([\s\S]*?)<\/description>/.exec(inner) || [])[1] || ''
    const guid  = (/<guid[^>]*>([\s\S]*?)<\/guid>/.exec(inner) || [])[1] || title
    items.push({
      title:       title.replace(/<[^>]+>/g, '').trim(),
      description: desc.replace(/<[^>]+>/g, '').trim().slice(0, 400),
      guid:        guid.trim()
    })
  }
  return items
}

// ── OpenAI classification ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a crypto trading signal classifier and risk advisor.
Given a news headline and optional description, output JSON with these fields:
{
  "pairs":      ["BTCUSDT", ...],   // affected trading pairs (from the list), or []
  "direction":  "bullish|bearish|neutral",
  "confidence": "high|medium|low|neutral",
  "rationale":  "one-sentence explanation of why the news matters",
  "action":     "one concrete sentence: what a short-term algo trading engine should do — e.g. increase/reduce exposure, tighten/widen stops, avoid new entries, watch for breakout, etc."
}
Only use pairs from this list: BTCUSDT ETHUSDT BNBUSDT SOLUSDT XRPUSDT ADAUSDT DOGEUSDT AVAXUSDT DOTUSDT MATICUSDT LTCUSDT LINKUSDT UNIUSDT ATOMUSDT XLMUSDT.
If the news is not clearly relevant to any of these, return pairs=[].
Return JSON only, no markdown.`

async function classifyWithOpenAI(openaiClient, headline, description) {
  const userContent = `Headline: ${headline}\n${description ? `Description: ${description}` : ''}`
  try {
    const response = await openaiClient.chat.completions.create({
      model:       'gpt-4o-mini',
      messages:    [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: userContent }],
      temperature: 0,
      max_tokens:  300
    })
    const raw = response.choices[0]?.message?.content?.trim() || '{}'
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ── NewsSignal ────────────────────────────────────────────────────────────────

class NewsSignal {
  /**
   * @param {object} opts
   * @param {object|null} opts.openaiClient — OpenAI SDK client, or null to disable
   * @param {object}      opts.eventStore  — EventStore instance
   * @param {number}      [opts.decayHours] — override NEWS_DECAY_HOURS
   * @param {string[]}    [opts.sources]   — source keys to poll, e.g. ['coindesk']
   * @param {boolean}     [opts.replayMode] — if true, skip polling, load from DB
   */
  constructor({ openaiClient, eventStore, decayHours, sources, replayMode = false }) {
    this.openaiClient = openaiClient || null
    this.eventStore   = eventStore
    this.decayMs      = (decayHours || DECAY_HOURS) * 3600 * 1000
    this.replayMode   = replayMode

    // Active source keys to poll
    const rawSources = sources || (process.env.NEWS_SOURCES || 'coindesk').split(',').map(s => s.trim())
    this.sources = rawSources.filter(s => SOURCES[s])

    // In-memory event cache: [{ pair, score, timestamp, headline }]
    // (additive per pair, decayed by getScore)
    this._cache     = []
    this._seenGuids = new Set()
    this._interval  = null
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  async start() {
    if (this.replayMode) {
      this._loadFromStore()
      log(`replay mode  events=${this._cache.length}`)
      return
    }
    if (!this.openaiClient) {
      log('no OpenAI client — news signal disabled (returning 0 for all pairs)')
      return
    }
    log(`started  sources=${this.sources.join(',')}  decay=${this.decayMs / 3600000}h  poll=${POLL_MS / 60000}m`)
    this._poll()
    this._interval = setInterval(() => this._poll(), POLL_MS)
  }

  async stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null }
    log('stopped')
  }

  // ── Score lookup ──────────────────────────────────────────────────────────────

  /**
   * getScore(pair, nowMs) — current decayed score for a pair.
   * Returns a float in [-1, +1]. Returns 0 if no active events or API disabled.
   */
  getScore(pair, nowMs = Date.now()) {
    if (!this._cache.length) return 0

    let total = 0
    for (const ev of this._cache) {
      if (ev.pair !== pair) continue
      const age     = nowMs - ev.timestamp
      const decayed = ev.score * Math.max(0, 1 - age / this.decayMs)
      if (decayed !== 0) total += decayed
    }

    // Clamp to [-1, +1]
    return Math.max(-1, Math.min(1, total))
  }

  // ── Internal poll ─────────────────────────────────────────────────────────────

  _poll() {
    // Fire-and-forget — never blocks the engine tick loop
    this._doPoll().catch(err => log(`poll error  ${err.message}`))
  }

  async _doPoll() {
    // Fetch all sources in parallel
    const fetches = await Promise.allSettled(
      this.sources.map(async sourceKey => {
        const xml   = await fetchRss(SOURCES[sourceKey])
        const items = parseRssItems(xml)
        const fresh = items.filter(item => {
          if (this._seenGuids.has(item.guid)) return false
          this._seenGuids.add(item.guid)
          return true
        })
        return { sourceKey, fresh }
      })
    )

    // Classify all new items across all sources in parallel
    const classifyTasks = []
    for (const r of fetches) {
      if (r.status === 'rejected') { log(`source error  ${r.reason?.message}`); continue }
      const { sourceKey, fresh } = r.value
      for (const item of fresh) {
        classifyTasks.push(this._processItem(item, sourceKey))
      }
    }
    await Promise.allSettled(classifyTasks)

    // Evict fully-decayed entries
    const now = Date.now()
    this._cache = this._cache.filter(ev => now - ev.timestamp < this.decayMs)
    if (this._cache.length > MAX_EVENTS) {
      this._cache = this._cache.slice(-MAX_EVENTS)
    }
  }

  async _processItem(item, source) {
    const result = await classifyWithOpenAI(this.openaiClient, item.title, item.description)
    if (!result || !result.pairs?.length) return
    if (result.direction === 'neutral' || result.confidence === 'neutral') return

    const baseScore = (CONFIDENCE_SCORES[result.confidence] || 0) * (DIRECTION_SIGN[result.direction] || 0)
    if (baseScore === 0) return

    const now = Date.now()
    for (const pair of result.pairs) {
      const ev = {
        pair,
        score:     baseScore,
        timestamp: now,
        headline:  item.title
      }
      this._cache.push(ev)

      // Persist to event store
      try {
        this.eventStore.append({
          type:       'news',
          timestamp:  now,
          pair,
          direction:  result.direction,
          confidence: result.confidence,
          score:      baseScore,
          decay_ms:   this.decayMs,
          headline:   item.title.slice(0, 200),
          source,
          rationale:  (result.rationale || '').slice(0, 300),
          action:     (result.action    || '').slice(0, 300)
        })
      } catch { /* best-effort */ }

      log(`event  pair=${pair}  dir=${result.direction}  conf=${result.confidence}  score=${baseScore.toFixed(2)}  "${item.title.slice(0, 60)}"`)
      if (result.action) log(`action  ${result.action.slice(0, 100)}`)
    }
  }

  // ── Replay mode: hydrate cache from event store ───────────────────────────────

  _loadFromStore() {
    try {
      const events = this.eventStore.query('news', { order: 'asc', limit: 5000 })
      for (const ev of events) {
        this._cache.push({
          pair:      ev.pair,
          score:     ev.score,
          timestamp: ev.timestamp,
          headline:  ev.headline || ''
        })
      }
    } catch { /* event store may not have news table in older DBs */ }
  }
}

module.exports = NewsSignal
