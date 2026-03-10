'use strict'

const ss = require('simple-statistics')
const { C } = require('./world')

// ── Math helpers ───────────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr.length) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function stddev(arr) {
  if (arr.length < 2) return 0
  return ss.standardDeviation(arr)
}

function sma(arr, period) {
  if (arr.length < period) return mean(arr)
  return mean(arr.slice(-period))
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// ── Price-derived indicators ───────────────────────────────────────────────────

// Wilder RSI (14-period)
function wilderRsi(closes, period) {
  period = period || 14
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
  const rs = avgGain / avgLoss
  return 100 - (100 / (1 + rs))
}

// Z-score of last 1-bar return vs rolling 20-bar stddev of returns
function momentumZscore(closes) {
  if (closes.length < 3) return 0
  const returns = closes.slice(1).map((v, i) => (v - closes[i]) / closes[i])
  const lastRet = returns[returns.length - 1]
  const window  = returns.slice(-20)
  const sd      = stddev(window)
  if (sd === 0) return 0
  return lastRet / sd
}

// Regime classifier — uses last 20 closes
function classifyRegime(closes) {
  if (closes.length < 10) return { regime: 'ranging', regime_confidence: 0.6 }

  const last20     = closes.slice(-20)
  const logReturns = last20.slice(1).map((v, i) => Math.log(v / last20[i]))

  const realisedVol = logReturns.length >= 2
    ? stddev(logReturns) * Math.sqrt(8760)
    : 0

  if (realisedVol > 0.80) {
    return {
      regime:            'volatile',
      regime_confidence: clamp(realisedVol / 0.80, 0.5, 1.0)
    }
  }

  const last10  = closes.slice(-10)
  const first5  = last10.slice(0, 5)
  const second5 = last10.slice(5)
  const smaFirst  = mean(first5)
  const smaSecond = mean(second5)
  const smaSlope  = smaFirst !== 0 ? (smaSecond - smaFirst) / smaFirst : 0

  const absRets  = logReturns.map(r => Math.abs(r))
  const meanAbs  = mean(absRets)
  const sdRets   = stddev(logReturns)
  const adxProxy = sdRets > 0 ? meanAbs / sdRets : 0

  if (adxProxy > 1.5 && smaSlope >= 0) {
    return { regime: 'trending_up',   regime_confidence: clamp(adxProxy / 1.5, 0.5, 1.0) }
  }
  if (adxProxy > 1.5 && smaSlope < 0) {
    return { regime: 'trending_down', regime_confidence: clamp(adxProxy / 1.5, 0.5, 1.0) }
  }
  return { regime: 'ranging', regime_confidence: 0.6 }
}

// ── External data fetchers ─────────────────────────────────────────────────────

/**
 * Fetch perpetual funding rates for all pairs from Binance futures.
 * Returns { BTCUSDT: 0.0001, ETHUSDT: -0.0002, ... }
 * Pairs with no futures contract default to 0.
 */
async function fetchFundingRates() {
  try {
    const res  = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex', { signal: AbortSignal.timeout(4000) })
    const data = await res.json()
    const map  = {}
    for (const item of data) {
      map[item.symbol] = parseFloat(item.lastFundingRate) || 0
    }
    return map
  } catch {
    return {}
  }
}

/**
 * Fetch last `limit` 1h klines for each pair from Binance spot.
 * Returns { BTCUSDT: { volumes: [...], takerBuyBase: [...] }, ... }
 * Uses Promise.all so all pairs are fetched in parallel.
 */
async function fetchVolumeData(pairs, limit = 20) {
  const results = await Promise.all(
    pairs.map(async pair => {
      try {
        const url  = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1h&limit=${limit}`
        const res  = await fetch(url, { signal: AbortSignal.timeout(4000) })
        const bars = await res.json()
        // kline fields: [openTime, open, high, low, close, volume, ..., takerBuyBase, ...]
        const volumes      = bars.map(b => parseFloat(b[5]))
        const takerBuyVol  = bars.map(b => parseFloat(b[9]))
        const quoteVolumes = bars.map(b => parseFloat(b[7]))  // USD (quote) volume
        return [pair, { volumes, takerBuyVol, quoteVolumes }]
      } catch {
        return [pair, null]
      }
    })
  )
  return Object.fromEntries(results)
}

/**
 * Fetch the Crypto Fear & Greed Index (market-wide, not per-pair).
 * Returns a number 0–100: 0 = Extreme Fear, 100 = Extreme Greed.
 * Falls back to 50 (neutral) on error.
 */
async function fetchFearGreed() {
  try {
    const res  = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(4000) })
    const data = await res.json()
    return parseInt(data.data[0].value, 10)
  } catch {
    return 50  // neutral fallback
  }
}

// ── Signal normalisers ─────────────────────────────────────────────────────────

/**
 * Normalise a funding rate to [-1, +1] as a contrarian signal.
 *   High positive funding → crowded longs → bearish (→ -1)
 *   High negative funding → crowded shorts → bullish (→ +1)
 * Typical 8h rate: ±0.0003; extreme: ±0.002
 */
function normaliseFunding(rate) {
  return -clamp(rate / 0.001, -1, 1)
}

/**
 * Compute volume z-score from last-bar volume vs recent history.
 * Clamped to [-3, 3].
 */
function volumeZscore(volumes) {
  if (volumes.length < 4) return 0
  const lastVol = volumes[volumes.length - 1]
  const history = volumes.slice(0, -1)
  const sd      = stddev(history)
  if (sd === 0) return 0
  return clamp((lastVol - mean(history)) / sd, -3, 3)
}

/**
 * Compute CVD (Cumulative Volume Delta) over the last N bars, normalised.
 * CVD = sum(takerBuyVol - takerSellVol) / totalVol ∈ [-1, +1]
 * Positive → net buy pressure; negative → net sell pressure.
 */
function computeCvd(volumes, takerBuyVol) {
  if (!volumes.length) return 0
  let totalVol = 0
  let netDelta = 0
  for (let i = 0; i < volumes.length; i++) {
    const vol     = volumes[i]
    const buyVol  = takerBuyVol[i]
    const sellVol = vol - buyVol
    netDelta += buyVol - sellVol   // = 2*buyVol - vol
    totalVol += vol
  }
  if (totalVol === 0) return 0
  return clamp(netDelta / totalVol, -1, 1)
}

/**
 * Normalise Fear & Greed as a contrarian mid-term signal.
 *   Extreme Fear (0)  → +1 (buy zone)
 *   Neutral (50)      →  0
 *   Extreme Greed (100) → -1 (sell zone)
 */
function normaliseFearGreed(value) {
  return (50 - value) / 50
}

// ── Main export ────────────────────────────────────────────────────────────────

/**
 * computeSignals(prices, priceHistories, opts) → Promise<SignalVector[]>
 *
 * prices:         { BTCUSDT: 67420, ... }
 * priceHistories: { BTCUSDT: [65000, ..., 67420], ... }  — last 50 closes
 * opts.backtest:  true → skip all external API calls (returns neutral for new fields)
 */
async function computeSignals(prices, priceHistories, { backtest = false } = {}) {

  // ── Fetch external data in parallel (skipped in backtest mode) ──────────────
  let fundingRates = {}
  let volumeData   = {}
  let fearGreed    = 50

  if (!backtest) {
    ;[fundingRates, volumeData, fearGreed] = await Promise.all([
      fetchFundingRates(),
      fetchVolumeData(C.PAIRS),
      fetchFearGreed()
    ])
  }

  const fear_greed        = fearGreed
  const fear_greed_signal = normaliseFearGreed(fearGreed)

  // ── Per-pair signal computation ─────────────────────────────────────────────
  const signals = []

  // BTC momentum for btc_lead on alts
  const btcHistory = priceHistories['BTCUSDT'] || []
  const btcMom1h   = momentumZscore(btcHistory)

  for (const pair of C.PAIRS) {
    if (prices[pair] === undefined) continue

    const closes = priceHistories[pair] || []
    const price  = prices[pair]

    // ── Price-derived signals ────────────────────────────────────────────────
    const momentum_1h = momentumZscore(closes)
    const closes4h    = closes.filter((_, i) => i % 4 === 0)
    const momentum_4h = momentumZscore(closes4h)

    const rsi_14   = wilderRsi(closes, 14)
    const rsi_norm = (rsi_14 - 50) / 50

    const last20         = closes.slice(-20)
    const sma20          = sma(closes, 20)
    const std20          = stddev(last20)
    const mean_rev_sigma = std20 > 0 ? (price - sma20) / std20 : 0
    const lower_bb       = sma20 - 2 * std20
    const upper_bb       = sma20 + 2 * std20
    const bb_range       = upper_bb - lower_bb
    const bb_position    = bb_range > 0 ? (price - lower_bb) / bb_range : 0.5

    let rsi_divergence = false
    if (closes.length >= 11) {
      const last10Closes = closes.slice(-10)
      const last10Rsis   = last10Closes.map((_, idx) =>
        wilderRsi(closes.slice(0, closes.length - 10 + idx + 1), 14)
      )
      const priceNewHigh = price > Math.max(...last10Closes.slice(0, -1))
      const rsiLowerHigh = rsi_14 < Math.max(...last10Rsis.slice(0, -1))
      rsi_divergence     = priceNewHigh && rsiLowerHigh
    }

    const btc_lead_signal = pair === 'BTCUSDT' ? null : btcMom1h

    // ── External / flow signals ──────────────────────────────────────────────
    const funding_rate   = fundingRates[pair] ?? 0
    const funding_signal = normaliseFunding(funding_rate)

    const volEntry      = volumeData[pair]
    const volume_zscore = volEntry ? volumeZscore(volEntry.volumes) : 0
    const cvd_norm      = volEntry ? computeCvd(volEntry.volumes, volEntry.takerBuyVol) : 0
    const vol_usd_20h   = volEntry ? volEntry.quoteVolumes.reduce((s, v) => s + v, 0) : null

    // ── Regime ────────────────────────────────────────────────────────────────
    const { regime, regime_confidence } = classifyRegime(closes)

    // ── Composite signal_score ────────────────────────────────────────────────
    const w   = C.SIGNAL_WEIGHTS
    const raw =
      funding_signal                             * (w.funding_signal    || 0) +
      cvd_norm                                   * (w.cvd_norm          || 0) +
      momentum_1h                                * (w.momentum_1h       || 0) +
      rsi_norm                                   * (w.rsi_norm          || 0) +
      fear_greed_signal                          * (w.fear_greed_signal || 0) +
      Math.max(-1, Math.min(1, volume_zscore/3)) * (w.volume_zscore     || 0) +
      momentum_4h                                * (w.momentum_4h       || 0) +
      (-mean_rev_sigma / 3)                      * (w.mean_rev          || 0) +
      (btc_lead_signal || 0)                     * (w.btc_lead          || 0)

    const signal_score = clamp(raw * (C.REGIME_MULTIPLIERS[regime] || 1.0), -1, 1)

    signals.push({
      pair,
      price,
      // price-derived
      momentum_1h,
      momentum_4h,
      rsi_14,
      rsi_norm,
      rsi_divergence,
      mean_rev_sigma,
      bb_position,
      btc_lead_signal,
      // flow / external
      funding_rate,
      funding_signal,
      volume_zscore,
      cvd_norm,
      vol_usd_20h,
      fear_greed,
      fear_greed_signal,
      // regime
      regime,
      regime_confidence,
      // composite
      signal_score
    })
  }

  return signals
}

module.exports = { computeSignals }
