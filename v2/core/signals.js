'use strict'

const ss = require('simple-statistics')
const { classifyRegime } = require('./regime')

// ── Math helpers ──────────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function stddev(arr) {
  if (arr.length < 2) return 0
  return ss.standardDeviation(arr)
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// ── Price-derived indicators ──────────────────────────────────────────────────

// Wilder RSI (14-period) — ported from v1
function wilderRsi(closes, period = 14) {
  if (closes.length < period + 1) return 50
  let gains = 0, losses = 0
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1]
    if (change > 0) gains  += change
    else            losses -= change
  }
  const avgGain = gains  / period
  const avgLoss = losses / period
  if (avgLoss === 0) return 100
  return 100 - (100 / (1 + avgGain / avgLoss))
}

// Z-score of last 1-bar return vs rolling 20-bar stddev of returns — ported from v1
function momentumZscore(closes) {
  if (closes.length < 3) return 0
  const returns = closes.slice(1).map((v, i) => (v - closes[i]) / closes[i])
  const lastRet = returns[returns.length - 1]
  const sd      = stddev(returns.slice(-20))
  if (sd === 0) return 0
  return clamp(lastRet / sd, -3, 3)
}

// ── External data fetchers ────────────────────────────────────────────────────

// Perpetual funding rates — ported from v1
async function fetchFundingRates() {
  try {
    const res  = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { signal: AbortSignal.timeout(4000) })
    const data = await res.json()
    const map  = {}
    for (const item of data) map[item.symbol] = parseFloat(item.lastFundingRate) || 0
    return map
  } catch {
    return {}
  }
}

// Last N klines per pair — volumes + taker buy volume — ported from v1
async function fetchVolumeData(pairs, limit = 20, interval = '1h') {
  const results = await Promise.all(
    pairs.map(async pair => {
      try {
        const url  = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`
        const bars = await fetch(url, { signal: AbortSignal.timeout(4000) }).then(r => r.json())
        return [pair, {
          volumes:     bars.map(b => parseFloat(b[5])),
          takerBuyVol: bars.map(b => parseFloat(b[9])),
          closes:      bars.map(b => parseFloat(b[4]))
        }]
      } catch {
        return [pair, null]
      }
    })
  )
  return Object.fromEntries(results)
}

// Fear & Greed index — cached 1h — ported from v1
let _fngCache = { value: 50, fetchedAt: 0 }
async function fetchFearGreed() {
  if (Date.now() - _fngCache.fetchedAt < 3600000) return _fngCache.value
  try {
    const res   = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(4000) })
    const data  = await res.json()
    const value = parseInt(data.data[0].value, 10)
    _fngCache   = { value, fetchedAt: Date.now() }
    return value
  } catch {
    return _fngCache.value
  }
}

// ── Signal normalisers ────────────────────────────────────────────────────────

// High positive funding → crowded longs → bearish (→ -1). Ported from v1.
function normaliseFunding(rate) {
  return -clamp(rate / 0.001, -1, 1)
}

// Volume z-score of last bar vs recent history. Ported from v1.
function volumeZscore(volumes) {
  if (volumes.length < 4) return 0
  const lastVol = volumes[volumes.length - 1]
  const history = volumes.slice(0, -1)
  const sd      = stddev(history)
  if (sd === 0) return 0
  return clamp((lastVol - mean(history)) / sd, -3, 3)
}

// CVD: net taker buy pressure normalised to [-1, +1]. Ported from v1.
function computeCvd(volumes, takerBuyVol) {
  if (!volumes.length) return 0
  let totalVol = 0, netDelta = 0
  for (let i = 0; i < volumes.length; i++) {
    netDelta += 2 * takerBuyVol[i] - volumes[i]
    totalVol += volumes[i]
  }
  if (totalVol === 0) return 0
  return clamp(netDelta / totalVol, -1, 1)
}

// Per-candle CVD: buy/sell ratio of a single candle normalised to [-1, +1].
// More responsive than rolling CVD — captures the current candle's pressure directly.
function computeCvd1c(totalVol, takerBuyVol) {
  if (totalVol === 0) return 0
  return clamp(2 * takerBuyVol / totalVol - 1, -1, 1)
}

// Extreme Fear (0) → +1 contrarian buy. Extreme Greed (100) → -1. Ported from v1.
function normaliseFearGreed(value) {
  return (50 - value) / 50
}

// ── Signal uncertainty ────────────────────────────────────────────────────────

/**
 * Compute signal uncertainty from a rolling buffer of raw sub-signal vectors.
 * Returns the standard deviation of the equal-weight composite over the last
 * 10 entries in the buffer. This is a market-state property (not per-agent) —
 * it measures how stable/noisy the signal environment has been recently.
 *
 * buffer: array of sub-signal objects (oldest first), last 10 used.
 */
function computeSignalUncertainty(buffer) {
  if (buffer.length < 2) return 0
  const window = buffer.slice(-10)
  const composites = window.map(s =>
    (s.cvd_norm + s.funding_signal + s.momentum_1h + s.momentum_4h +
     s.rsi_norm + (s.volume_zscore / 3) + s.fear_greed_signal) / 7
  )
  return Math.round(stddev(composites) * 10000) / 10000
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * computeSignals(prices, priceHistories, opts) → Promise<SignalVector[]>
 *
 * Key difference from v1: signal weights are NOT applied here.
 * This function returns raw normalised sub-signals only.
 * Each agent applies its own config.weights to compute its composite score.
 *
 * prices:         { BTCUSDT: 84200, ... }
 * priceHistories: { BTCUSDT: [closes...], ... }  — last 50 closes, oldest first
 * opts.pairs:     array of pair symbols to compute (required)
 * opts.interval:  candle interval label, e.g. '15m' (default '15m')
 * opts.backtest:  true → skip all external API calls, return neutral externals
 * opts.newsSignal: NewsSignal instance or null — injected to avoid circular dep
 * opts.signalBuffers: { BTCUSDT: [lastSignalVectors...], ... } — for uncertainty
 * opts.aggTradeCollector: AggTradeCollector instance or null — provides real-time CVD
 *
 * Returns array of SignalVector, one per pair:
 * {
 *   pair, price,
 *   cvd_norm,      — rolling 20-candle CVD (legacy, kept for compat)
 *   cvd_1c,        — single-candle CVD from last kline taker volume
 *   cvd_intra,     — intra-candle CVD from aggTrade stream (0 if no collector)
 *   cvd_accel,     — CVD acceleration within current candle (0 if no collector)
 *   funding_signal, momentum_1h, momentum_4h,
 *   rsi_norm, volume_zscore, fear_greed_signal,
 *   signal_uncertainty, news_signal,
 *   funding_rate, fear_greed,
 *   p_volatile, p_trending_up, p_trending_down, p_ranging
 * }
 */
async function computeSignals(prices, priceHistories, opts = {}) {
  const {
    pairs,
    interval           = '15m',
    backtest           = false,
    newsSignal         = null,
    signalBuffers      = {},
    aggTradeCollector  = null
  } = opts

  if (!pairs || !pairs.length) throw new Error('computeSignals: opts.pairs is required')

  // ── Fetch external data in parallel ────────────────────────────────────────
  let fundingRates = {}
  let volumeData   = {}
  let fearGreed    = 50

  if (!backtest) {
    ;[fundingRates, volumeData, fearGreed] = await Promise.all([
      fetchFundingRates(),
      fetchVolumeData(pairs, 20, interval),
      fetchFearGreed()
    ])
  }

  const fear_greed_signal = normaliseFearGreed(fearGreed)
  const now = Date.now()

  // ── BTC macro regime (single shared signal for all pairs) ──────────────────
  const btcCloses   = priceHistories['BTCUSDT'] || priceHistories[pairs[0]] || []
  const btcCloses4h = btcCloses.filter((_, i) => i % 4 === 0)
  const macroRegime = classifyRegime(btcCloses4h, '4h')

  // ── BTC rolling-high dip (shared signal, used by spot_accum gate) ──────────
  // lookback = 672 bars = 7 days at 15m; uses whatever history is available
  const BTC_HIGH_LOOKBACK = 672
  const btcHighWindow = btcCloses.slice(-BTC_HIGH_LOOKBACK)
  const btcRollingHigh = btcHighWindow.length > 0 ? Math.max(...btcHighWindow) : null
  const btcCurrentPrice = btcCloses.length > 0 ? btcCloses[btcCloses.length - 1] : null
  const btcDipPct = (btcRollingHigh && btcCurrentPrice)
    ? (btcCurrentPrice - btcRollingHigh) / btcRollingHigh * 100
    : 0

  // ── BTC 4h ATR % (shared signal, used by spot_accum gate) ──────────────────
  // Average absolute % move per 4h bar over last 28 bars (= 7 days)
  const BTC_ATR_LOOKBACK = 28
  const btcAtr4hPct = (() => {
    const bars = btcCloses4h.slice(-BTC_ATR_LOOKBACK - 1)
    if (bars.length < 2) return 0
    const moves = bars.slice(1).map((p, i) => Math.abs(p - bars[i]) / bars[i] * 100)
    return moves.reduce((s, v) => s + v, 0) / moves.length
  })()

  // ── Per-pair computation ────────────────────────────────────────────────────
  const results = []

  for (const pair of pairs) {
    if (prices[pair] == null) continue

    const closes = priceHistories[pair] || []
    const price  = prices[pair]

    // Price-derived signals
    const momentum_1h = momentumZscore(closes)
    const momentum_4h = momentumZscore(closes.filter((_, i) => i % 4 === 0))
    const rsi_norm    = (wilderRsi(closes, 14) - 50) / 50

    // Flow signals
    const funding_rate   = fundingRates[pair] ?? 0
    const funding_signal = normaliseFunding(funding_rate)

    const volEntry      = volumeData[pair]
    const volume_zscore = volEntry ? volumeZscore(volEntry.volumes) : 0
    const cvd_norm      = volEntry ? computeCvd(volEntry.volumes, volEntry.takerBuyVol) : 0

    // Per-candle CVD: last kline's taker buy ratio (more responsive than rolling-20)
    const cvd_1c = volEntry && volEntry.volumes.length > 0
      ? computeCvd1c(
          volEntry.volumes[volEntry.volumes.length - 1],
          volEntry.takerBuyVol[volEntry.takerBuyVol.length - 1]
        )
      : 0

    // Intra-candle signals from aggTrade stream (live only; 0 in backtest)
    const cvd_intra = aggTradeCollector ? aggTradeCollector.getCvdIntra(pair) : 0
    const cvd_accel = aggTradeCollector ? aggTradeCollector.getCvdAccel(pair) : 0

    // News signal — decayed value from the cache (0.0 if no active event)
    const news_signal = newsSignal ? newsSignal.getScore(pair, now) : 0

    // Signal uncertainty — std of equal-weight composite over last 10 candles
    const buffer = signalBuffers[pair] || []
    // Build a provisional sub-signal object for the buffer (without uncertainty itself)
    const provisional = { cvd_norm, funding_signal, momentum_1h, momentum_4h,
                          rsi_norm, volume_zscore: clamp(volume_zscore / 3, -1, 1),
                          fear_greed_signal }
    const signal_uncertainty = computeSignalUncertainty([...buffer, provisional])

    // Regime
    const regime = classifyRegime(closes, interval)

    results.push({
      pair,
      price,
      // raw sub-signals (all normalised to roughly [-1, +1])
      cvd_norm,
      cvd_1c,
      cvd_intra,
      cvd_accel,
      funding_signal,
      momentum_1h,
      momentum_4h,
      rsi_norm,
      volume_zscore: clamp(volume_zscore / 3, -1, 1),  // /3 to keep in [-1,+1]
      fear_greed_signal,
      news_signal,
      signal_uncertainty,
      // raw values for display / logging
      funding_rate,
      fear_greed: fearGreed,
      // regime distribution
      p_volatile:      regime.p_volatile,
      p_trending_up:   regime.p_trending_up,
      p_trending_down: regime.p_trending_down,
      p_ranging:       regime.p_ranging,
      // 4h macro regime distribution
      macro_p_volatile:      macroRegime.p_volatile,
      macro_p_trending_up:   macroRegime.p_trending_up,
      macro_p_trending_down: macroRegime.p_trending_down,
      macro_p_ranging:       macroRegime.p_ranging,
      // BTC rolling-high dip % (negative = below high; 0 = at/above high)
      btc_dip_pct:           btcDipPct,
      // BTC 4h ATR as % of price (avg abs move per 4h bar, last 7 days)
      btc_atr_4h_pct:        btcAtr4hPct
    })
  }

  return results
}

/**
 * Fetch last N closes from Binance for history warmup.
 * Used by engine.js on startup to seed priceHistories before first candle.
 */
async function fetchHistoricalCloses(pairs, limit = 50, interval = '15m') {
  const results = await Promise.allSettled(
    pairs.map(async pair => {
      const url  = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`
      const bars = await fetch(url, { signal: AbortSignal.timeout(6000) }).then(r => r.json())
      return [pair, bars.map(b => parseFloat(b[4]))]
    })
  )
  const map = {}
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const [pair, closes] = r.value
      if (closes.length) map[pair] = closes
    }
  }
  return map
}

module.exports = {
  computeSignals,
  fetchHistoricalCloses,
  fetchFundingRates,
  fetchVolumeData,
  fetchFearGreed,
  // exported for testing
  wilderRsi,
  momentumZscore,
  computeCvd,
  computeCvd1c,
  normaliseFunding,
  volumeZscore: (v) => volumeZscore(v),
  computeSignalUncertainty
}
