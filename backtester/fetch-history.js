'use strict'

// CLI: node backtester/fetch-history.js --pairs BTC,ETH,SOL --period 365 --interval 1h

const fs   = require('fs')
const path = require('path')
const { C } = require('../core/world')

const PAIR_ALIASES = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', BNB: 'BNBUSDT', SOL: 'SOLUSDT',
  XRP: 'XRPUSDT', DOGE: 'DOGEUSDT', ADA: 'ADAUSDT', AVAX: 'AVAXUSDT',
  DOT: 'DOTUSDT', MATIC: 'MATICUSDT', LINK: 'LINKUSDT', LTC: 'LTCUSDT',
  UNI: 'UNIUSDT', ATOM: 'ATOMUSDT', NEAR: 'NEARUSDT'
}

const INTERVAL_MS = {
  '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000,
  '4h': 14400000, '1d': 86400000
}

function parseArgs() {
  const args = process.argv.slice(2)
  const get  = flag => {
    const i = args.indexOf(flag)
    return i !== -1 ? args[i + 1] : null
  }
  const pairsArg = get('--pairs') || 'BTC,ETH'
  const period   = parseInt(get('--period') || '30', 10)
  const interval = get('--interval') || '1h'
  const force    = args.includes('--force')

  const symbols = pairsArg === 'ALL'
    ? C.PAIRS
    : pairsArg.split(',').map(p => PAIR_ALIASES[p.toUpperCase()] || (p.toUpperCase() + 'USDT'))

  return { symbols, period, interval, force }
}

async function fetchKlines(symbol, interval, startTime, endTime) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}` +
              `&startTime=${startTime}&endTime=${endTime}&limit=1000`
  const res  = await fetch(url)
  if (!res.ok) throw new Error(`Binance error ${res.status} for ${symbol}`)
  return res.json()
}

async function downloadPair(symbol, period, interval, force) {
  const outDir  = path.join(__dirname, '../data/ohlcv')
  const outFile = path.join(outDir, `${symbol}_${interval}.json`)

  if (!force && fs.existsSync(outFile)) {
    const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'))
    console.log(`${C.LABELS[symbol] || symbol}: ${existing.length} bars (cached, use --force to re-download)`)
    return
  }

  const intervalMs = INTERVAL_MS[interval] || 3600000
  const endTime    = Date.now()
  const startTime  = endTime - period * 24 * 60 * 60 * 1000

  const all = []
  let cursor = startTime

  while (cursor < endTime) {
    const raw = await fetchKlines(symbol, interval, cursor, endTime)
    if (!raw.length) break

    for (const k of raw) {
      all.push({
        ts:     k[0],
        open:   parseFloat(k[1]),
        high:   parseFloat(k[2]),
        low:    parseFloat(k[3]),
        close:  parseFloat(k[4]),
        volume: parseFloat(k[5])
      })
    }

    cursor = raw[raw.length - 1][0] + intervalMs
    if (raw.length < 1000) break
  }

  fs.writeFileSync(outFile, JSON.stringify(all))
  const daysLabel = `${period}d × ${interval}`
  console.log(`${C.LABELS[symbol] || symbol}: ${all.length} bars (${daysLabel})`)
}

async function main() {
  const { symbols, period, interval, force } = parseArgs()
  console.log(`Fetching ${symbols.length} pair(s) — ${period}d of ${interval} bars...`)
  for (const sym of symbols) {
    await downloadPair(sym, period, interval, force)
  }
}

main().catch(err => { console.error(err.message); process.exit(1) })
