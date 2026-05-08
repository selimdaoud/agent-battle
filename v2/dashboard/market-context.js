'use strict'

const https = require('https')

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept':     'application/json'
      }
    }, res => {
      let raw = ''
      res.on('data', chunk => raw += chunk)
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }
        try { resolve(JSON.parse(raw)) }
        catch (_) { reject(new Error('parse error')) }
      })
    })
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')) })
    req.on('error', reject)
  })
}

function yfinanceMeta(ticker) {
  const sym = encodeURIComponent(ticker)
  return httpsGet(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=1d&interval=5m`)
    .then(data => {
      const meta = data?.chart?.result?.[0]?.meta
      if (!meta) throw new Error('no meta')
      return meta
    })
}

// ── State ─────────────────────────────────────────────────────────────────────

let _state = {
  vix:       null,   // current VIX level
  spxDayPct: null,   // SPX daily return %
  ok:        null,   // null=never fetched  true=ok  false=error
  error:     null,
  fetchedAt: null
}

const MIN_INTERVAL_MS = 5 * 60 * 1000

// ── Refresh ───────────────────────────────────────────────────────────────────

let _inflight = false

async function refresh() {
  if (_inflight) return
  const now = Date.now()
  if (_state.fetchedAt && (now - _state.fetchedAt) < MIN_INTERVAL_MS) return

  _inflight = true
  try {
    const [vixMeta, spxMeta] = await Promise.all([
      yfinanceMeta('^VIX'),
      yfinanceMeta('^GSPC')
    ])

    const vix       = vixMeta.regularMarketPrice ?? null
    const spxPrice  = spxMeta.regularMarketPrice ?? null
    const spxPrev   = spxMeta.chartPreviousClose ?? spxMeta.previousClose ?? null
    const spxDayPct = (spxPrice != null && spxPrev)
      ? ((spxPrice - spxPrev) / spxPrev) * 100
      : null

    _state = { vix, spxDayPct, ok: true, error: null, fetchedAt: Date.now() }
  } catch (err) {
    _state = { ..._state, ok: false, error: err.message, fetchedAt: Date.now() }
  } finally {
    _inflight = false
  }
}

function get() { return _state }

module.exports = { refresh, get }
