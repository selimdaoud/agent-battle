'use strict'

// tools/dxy-fetcher.js — Fetch DXY weekly closes from Yahoo Finance (no key needed),
// compute 10w/20w SMA, write result to data/macro-signal.json.

const https = require('https')
const fs    = require('fs')
const path  = require('path')

const OUT_FILE = path.join(__dirname, '../data/macro-signal.json')
const YAHOO_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/DX-Y.NYB?interval=1wk&range=2y'

function get(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }
    const req = https.get(url, opts, res => {
      let body = ''
      res.on('data', d => { body += d })
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}`))
        try { resolve(JSON.parse(body)) } catch { reject(new Error('JSON parse failed')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  })
}

async function fetchDxy() {
  const data   = await get(YAHOO_URL)
  const result = data?.chart?.result?.[0]
  if (!result) throw new Error('unexpected Yahoo Finance response shape')

  const timestamps = result.timestamp || []
  const rawCloses  = result.indicators?.quote?.[0]?.close || []

  const points = timestamps
    .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), value: rawCloses[i] }))
    .filter(d => d.value != null && !isNaN(d.value))
    .slice(-30)

  if (points.length < 20) throw new Error(`insufficient DXY data: ${points.length} points`)

  const values     = points.map(d => d.value)
  const latest     = values[values.length - 1]
  const latestDate = points[points.length - 1].date

  const sma = (arr, n) => arr.slice(-n).reduce((s, v) => s + v, 0) / n
  const sma10w = sma(values, 10)
  const sma20w = sma(values, 20)

  // falling = dollar weakening = bullish for crypto
  const trend  = sma10w < sma20w ? 'falling' : 'rising'
  const advice = trend === 'falling' ? 'green' : 'pause'

  return { dxy: latest, latestDate, sma10w, sma20w, trend, advice, updatedAt: Date.now() }
}

async function run() {
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) } catch { /* first run */ }

  const result = await fetchDxy()
  result.trading_paused = existing.trading_paused ?? false  // preserve user override

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2))
  return result
}

module.exports = { run, fetchDxy }

if (require.main === module) {
  run()
    .then(r => {
      console.log(`DXY ${r.dxy.toFixed(2)}  (${r.latestDate})`)
      console.log(`10w SMA: ${r.sma10w.toFixed(2)}  20w SMA: ${r.sma20w.toFixed(2)}`)
      console.log(`Trend: ${r.trend.toUpperCase()}  Advice: ${r.advice.toUpperCase()}`)
    })
    .catch(err => { console.error('DXY fetch failed:', err.message); process.exit(1) })
}
