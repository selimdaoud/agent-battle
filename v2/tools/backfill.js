'use strict'

// tools/backfill.js — Fetch historical Binance data and populate a backtest DB.
//
// Usage:
//   node tools/backfill.js                              # 365 days → data/backtest.db
//   node tools/backfill.js --days 180                   # shorter window
//   node tools/backfill.js --end 2025-01-31             # end at specific date
//   node tools/backfill.js --days 120 --end 2025-01-31  # Oct–Jan 2025 (bull run)
//   node tools/backfill.js --out ./data/bt2.db          # custom output file
//   node tools/backfill.js --pairs BTCUSDT,ETHUSDT
//
// After running:
//   node tools/replay.js --src ./data/backtest.db --test-from 2025-07-01

require('dotenv').config()

const https    = require('https')
const Database = require('better-sqlite3')
const { classifyRegime } = require('../core/regime')

const log = (...a) => process.stdout.write(
  new Date().toISOString().slice(11, 19) + ' [BACKFILL] ' + a.join(' ') + '\n'
)

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { days: 365, end: null, interval: '15m', out: './data/backtest.db', pairs: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days'     && argv[i+1]) { args.days     = parseInt(argv[++i]);              continue }
    if (argv[i] === '--end'      && argv[i+1]) { args.end      = new Date(argv[++i]).getTime();    continue }
    if (argv[i] === '--interval' && argv[i+1]) { args.interval = argv[++i];                        continue }
    if (argv[i] === '--out'      && argv[i+1]) { args.out      = argv[++i];                        continue }
    if (argv[i] === '--pairs'    && argv[i+1]) { args.pairs    = argv[++i].split(',');              continue }
  }
  return args
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
  'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT', 'DOTUSDT', 'LTCUSDT',
  'LINKUSDT', 'UNIUSDT', 'ATOMUSDT', 'XLMUSDT'
  // MATICUSDT excluded — rebranded/delisted on Binance perps
]

const INTERVAL_MS = {
  '1m': 60000, '3m': 180000, '5m': 300000, '15m': 900000,
  '30m': 1800000, '1h': 3600000, '4h': 14400000
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, res => {
      if (res.statusCode >= 400) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} for ${url.slice(0, 80)}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())) }
        catch (e) { reject(new Error('JSON parse error: ' + e.message)) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout: ' + url.slice(0, 80))) })
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Math helpers (mirrors signals.js exactly) ─────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
function mean(a)  { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0 }
function stddev(a) {
  if (a.length < 2) return 0
  const m = mean(a)
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1))
}

// Wilder RSI — identical to signals.js
function wilderRsi(closes, period = 14) {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    if (d > 0) gains += d; else losses -= d
  }
  const ag = gains / period, al = losses / period
  if (al === 0) return 100
  return 100 - 100 / (1 + ag / al)
}

// Z-score of last 1-bar return — identical to signals.js
function momentumZscore(closes) {
  if (closes.length < 3) return 0
  const returns = closes.slice(1).map((v, i) => (v - closes[i]) / closes[i])
  const lastRet = returns[returns.length - 1]
  const sd      = stddev(returns.slice(-20))
  return sd === 0 ? 0 : clamp(lastRet / sd, -3, 3)
}

// Volume z-score — identical to signals.js (returns [-3,3]; /3 before storing)
function volumeZscore(volumes) {
  if (volumes.length < 4) return 0
  const last = volumes[volumes.length - 1]
  const hist = volumes.slice(0, -1)
  const sd   = stddev(hist)
  return sd === 0 ? 0 : clamp((last - mean(hist)) / sd, -3, 3)
}

// CVD from taker buy vol — identical to signals.js
function computeCvd(volumes, takerBuyVols) {
  let totalVol = 0, netDelta = 0
  for (let i = 0; i < volumes.length; i++) {
    netDelta += 2 * takerBuyVols[i] - volumes[i]
    totalVol += volumes[i]
  }
  return totalVol === 0 ? 0 : clamp(netDelta / totalVol, -1, 1)
}

// Signal uncertainty — identical to signals.js
function computeSignalUncertainty(buffer) {
  if (buffer.length < 2) return 0
  const win = buffer.slice(-10)
  const composites = win.map(s =>
    (s.cvd_norm + s.funding_signal + s.momentum_1h + s.momentum_4h +
     s.rsi_norm + s.volume_zscore + s.fear_greed_signal) / 7
  )
  const m  = mean(composites)
  const sd = Math.sqrt(composites.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, composites.length - 1))
  return Math.round(sd * 10000) / 10000
}

// ── Binance klines ────────────────────────────────────────────────────────────

async function fetchAllKlines(symbol, interval, startMs, endMs) {
  const stepMs  = INTERVAL_MS[interval] || 900000
  const allBars = []
  let cursor    = startMs
  let reqCount  = 0

  while (cursor < endMs) {
    const batchEnd = Math.min(cursor + 1000 * stepMs - 1, endMs)
    try {
      const url  = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${batchEnd}&limit=1000`
      const data = await get(url)
      if (!Array.isArray(data) || !data.length) break
      for (const b of data) {
        allBars.push({
          openTime:    parseInt(b[0]),
          close:       parseFloat(b[4]),
          volume:      parseFloat(b[5]),
          takerBuyVol: parseFloat(b[9])
        })
      }
      cursor = allBars[allBars.length - 1].openTime + stepMs
      reqCount++
      if (reqCount % 5 === 0) await sleep(300)  // ~16 req/s, well within 1200/min
    } catch (err) {
      log(`  warn ${symbol}: ${err.message}`)
      break
    }
  }
  return allBars
}

// ── Binance funding rates ─────────────────────────────────────────────────────

async function fetchFundingRates(symbol, startMs, endMs) {
  const rates  = []
  let cursor   = startMs

  while (cursor < endMs) {
    try {
      const url  = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&startTime=${cursor}&limit=1000`
      const data = await get(url)
      if (!Array.isArray(data) || !data.length) break
      for (const r of data) {
        rates.push({ ts: parseInt(r.fundingTime), rate: parseFloat(r.fundingRate) })
      }
      cursor = rates[rates.length - 1].ts + 1
      await sleep(150)
    } catch {
      break  // spot-only pair or delisted from perps — return empty
    }
  }
  return rates
}

// Binary-search lookup: returns the value of the most recent record at or before ts
function buildLookup(records, valueKey) {
  records.sort((a, b) => a.ts - b.ts)
  return (ts) => {
    let lo = 0, hi = records.length - 1, result = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (records[mid].ts <= ts) { result = records[mid][valueKey]; lo = mid + 1 }
      else hi = mid - 1
    }
    return result
  }
}

// ── Fear & Greed history ──────────────────────────────────────────────────────

async function fetchFearGreedHistory(days) {
  try {
    const data = await get(`https://api.alternative.me/fng/?limit=${days + 5}&date_format=us`)
    return data.data
      .map(d => ({ ts: parseInt(d.timestamp) * 1000, value: parseInt(d.value) }))
      .sort((a, b) => a.ts - b.ts)
  } catch (err) {
    log('warn: F&G history unavailable:', err.message, '— using neutral (50)')
    return []
  }
}

// ── DB setup ──────────────────────────────────────────────────────────────────

function openDb(filePath) {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticks (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp          INTEGER NOT NULL,
      pair               TEXT    NOT NULL,
      mid                REAL,
      bid                REAL,
      ask                REAL,
      spread             REAL,
      volume             REAL,
      taker_buy_vol      REAL,
      funding_rate       REAL,
      fear_greed         INTEGER,
      cvd_norm           REAL,
      cvd_1c             REAL,
      funding_signal     REAL,
      momentum_1h        REAL,
      momentum_4h        REAL,
      rsi_norm           REAL,
      volume_zscore      REAL,
      fear_greed_signal  REAL,
      signal_uncertainty REAL,
      news_signal        REAL DEFAULT 0,
      p_volatile         REAL,
      p_trending_up      REAL,
      p_trending_down    REAL,
      p_ranging          REAL,
      UNIQUE(timestamp, pair)
    );
    CREATE INDEX IF NOT EXISTS idx_ticks_pair_ts ON ticks (pair, timestamp);
    CREATE INDEX IF NOT EXISTS idx_ticks_ts      ON ticks (timestamp);
  `)
  return db
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const args    = parseArgs(process.argv)
  const pairs   = args.pairs || DEFAULT_PAIRS
  const endMs   = args.end || Date.now()
  const startMs = endMs - args.days * 24 * 60 * 60 * 1000

  log(`pairs=${pairs.length}  days=${args.days}  interval=${args.interval}`)
  log(`period: ${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)}`)
  log(`output: ${args.out}`)

  const db = openDb(args.out)

  const insert = db.prepare(`
    INSERT OR IGNORE INTO ticks
      (timestamp, pair, mid, volume, taker_buy_vol, funding_rate, fear_greed,
       cvd_norm, cvd_1c, funding_signal, momentum_1h, momentum_4h, rsi_norm,
       volume_zscore, fear_greed_signal, signal_uncertainty, news_signal,
       p_volatile, p_trending_up, p_trending_down, p_ranging)
    VALUES
      (@timestamp, @pair, @mid, @volume, @taker_buy_vol, @funding_rate, @fear_greed,
       @cvd_norm, @cvd_1c, @funding_signal, @momentum_1h, @momentum_4h, @rsi_norm,
       @volume_zscore, @fear_greed_signal, @signal_uncertainty, 0,
       @p_volatile, @p_trending_up, @p_trending_down, @p_ranging)
  `)
  const insertBatch = db.transaction(rows => { for (const r of rows) insert.run(r) })

  // ── Fear & Greed (one global request) ────────────────────────────────────────

  log('\nfetching Fear & Greed history...')
  const fngRecords = await fetchFearGreedHistory(args.days)
  const fearGreedAt = fngRecords.length ? buildLookup(fngRecords, 'value') : () => 50
  log(`  ${fngRecords.length} records`)

  // ── Per-pair ──────────────────────────────────────────────────────────────────

  let totalRows = 0

  for (const pair of pairs) {
    log(`\n${pair}`)

    // 1. Klines
    process.stdout.write(`  klines...`)
    const klines = await fetchAllKlines(pair, args.interval, startMs, endMs)
    if (!klines.length) { process.stdout.write(' no data — skipping\n'); continue }
    process.stdout.write(` ${klines.length} candles\n`)

    // 2. Funding rates
    process.stdout.write(`  funding rates...`)
    const fundingRecords = await fetchFundingRates(pair, startMs, endMs)
    const fundingAt = fundingRecords.length ? buildLookup(fundingRecords, 'rate') : () => 0
    process.stdout.write(` ${fundingRecords.length} records\n`)

    // 3. Compute signals candle by candle
    const closes       = []
    const volumes      = []
    const takerBuyVols = []
    const signalBuffer = []
    const rows         = []
    const WARMUP       = 50  // need at least 50 closes for RSI(14) + momentum

    for (let i = 0; i < klines.length; i++) {
      const { openTime, close, volume, takerBuyVol } = klines[i]
      closes.push(close)
      volumes.push(volume)
      takerBuyVols.push(takerBuyVol)

      if (i < WARMUP) continue

      const fundingRate = fundingAt(openTime) ?? 0
      const fearGreed   = fearGreedAt(openTime) ?? 50

      // Price signals — mirrors computeSignals exactly
      const rsi_norm    = (wilderRsi(closes) - 50) / 50
      const momentum_1h = momentumZscore(closes)
      const momentum_4h = momentumZscore(closes.filter((_, j) => j % 4 === 0))

      // Flow signals — use last 20 bars like fetchVolumeData(pairs, 20)
      const vols20   = volumes.slice(-20)
      const taker20  = takerBuyVols.slice(-20)
      const vol_z    = volumeZscore(vols20)
      const volume_zscore   = clamp(vol_z / 3, -1, 1)   // /3 same as computeSignals
      const cvd_norm        = computeCvd(vols20, taker20)

      // Per-candle CVD — single candle taker buy ratio (more responsive than rolling-20)
      const lastVol    = volumes[i]
      const lastTaker  = takerBuyVols[i]
      const cvd_1c     = lastVol > 0 ? clamp(2 * lastTaker / lastVol - 1, -1, 1) : 0

      const funding_signal    = -clamp(fundingRate / 0.001, -1, 1)
      const fear_greed_signal = (50 - fearGreed) / 50

      // Regime
      const regime = classifyRegime(closes, args.interval)

      // Uncertainty — note volume_zscore is already /3 here (matches provisional in computeSignals)
      const sv = { cvd_norm, funding_signal, momentum_1h, momentum_4h,
                   rsi_norm, volume_zscore, fear_greed_signal }
      signalBuffer.push(sv)
      const signal_uncertainty = computeSignalUncertainty(signalBuffer)

      rows.push({
        timestamp:         openTime,
        pair,
        mid:               close,
        volume,
        taker_buy_vol:     takerBuyVol,
        funding_rate:      fundingRate,
        fear_greed:        fearGreed,
        cvd_norm,
        cvd_1c,
        funding_signal,
        momentum_1h,
        momentum_4h,
        rsi_norm,
        volume_zscore,
        fear_greed_signal,
        signal_uncertainty,
        p_volatile:        regime.p_volatile,
        p_trending_up:     regime.p_trending_up,
        p_trending_down:   regime.p_trending_down,
        p_ranging:         regime.p_ranging
      })
    }

    insertBatch(rows)
    totalRows += rows.length
    log(`  stored ${rows.length} tick rows`)
  }

  db.close()

  log(`\n${'─'.repeat(50)}`)
  log(`done  total_rows=${totalRows}  db=${args.out}`)
  log(``)
  log(`next steps:`)
  log(`  # Run replay on full dataset:`)
  log(`  node tools/replay.js --src ${args.out}`)
  log(`  # Run with train/test split (last 6 months as test):`)
  const testFrom = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10)
  log(`  node tools/replay.js --src ${args.out} --test-from ${testFrom}`)
}

main().catch(err => { log('fatal:', err.message); console.error(err); process.exit(1) })
