'use strict'

// Sim-only fill model. No real exchange calls.
// For both live and paper agents — paper agents receive the same fill
// calculation but capital is not modified (engine handles that distinction).

const TAKER_FEE  = 0.001   // 0.10% per side
const SLIPPAGE   = parseFloat(process.env.SLIPPAGE_PCT || '0.001')  // 0.10%

/**
 * simEntry(mid, sizeUsd)
 * Returns { price, fee_usd, size_usd } for a BUY at current mid price.
 * Entry price = ASK: mid × (1 + slippage + half-spread)
 */
function simEntry(mid, sizeUsd) {
  const price   = mid * (1 + SLIPPAGE + 0.0005)
  const fee_usd = sizeUsd * TAKER_FEE
  return { price, fee_usd, size_usd: sizeUsd }
}

/**
 * simExit(entryPrice, mid, sizeUsd)
 * Returns { price, fee_usd, pnl_usd, pnl_pct } for a SELL at current mid price.
 * Exit price = BID: mid × (1 - half-spread)
 * P&L is computed after fees.
 */
function simExit(entryPrice, mid, sizeUsd) {
  const price     = mid * (1 - 0.0005)
  const proceeds  = sizeUsd * (price / entryPrice)
  const fee_usd   = proceeds * TAKER_FEE
  const pnl_usd   = proceeds - fee_usd - sizeUsd
  const pnl_pct   = (pnl_usd / sizeUsd) * 100
  return { price, fee_usd, pnl_usd, pnl_pct: Math.round(pnl_pct * 10000) / 10000 }
}

/**
 * intraStopCheck(entryPrice, currentMid, stopPct)
 * Returns true if the position has breached the stop threshold.
 * Used for intra-candle stop scans (same as v1).
 */
function intraStopCheck(entryPrice, currentMid, stopPct) {
  const lossPct = ((currentMid - entryPrice) / entryPrice) * 100
  return lossPct <= -stopPct
}

module.exports = { simEntry, simExit, intraStopCheck, TAKER_FEE, SLIPPAGE }
