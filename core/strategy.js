'use strict'

/**
 * core/strategy.js — Deterministic rules engine (Phase 2)
 *
 * Replaces the LLM in the hot path. Each archetype has a distinct strategy
 * that uses the new signal set (funding rate, CVD, Fear & Greed, momentum).
 *
 * decide(ctx) → { action, pair, amount_usd, reasoning, signal_score }
 *
 * The LLM is no longer called here. It runs periodically via synthesize()
 * in agent.js to generate personality flavor text only.
 */

const fs   = require('fs')
const path = require('path')
const { C } = require('./world')

const VERSION = '1.0.0'

// MEGA config — loaded at startup; hot-reloadable via reloadMegaConfig()
const MEGA_CONFIG_PATH = path.join(__dirname, '../agents/mega-config.json')
let megaConfig = JSON.parse(fs.readFileSync(MEGA_CONFIG_PATH, 'utf8'))

function reloadMegaConfig() {
  megaConfig = JSON.parse(fs.readFileSync(MEGA_CONFIG_PATH, 'utf8'))
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/** Build a { pair → signal } lookup from the signals array. */
function signalMap(signals) {
  const map = {}
  for (const s of signals) map[s.pair] = s
  return map
}

/** Unrealized PnL % for a holding. Returns null if no entry price. */
function unrealizedPct(pair, ctx) {
  const entry = ctx.entryPrices[pair]
  const now   = ctx.currentPrices[pair]
  if (!entry || !now) return null
  return (now - entry) / entry * 100
}

/** Number of rounds a position has been held. */
function roundsHeld(pair, ctx) {
  return ctx.entryRounds[pair] != null ? ctx.round - ctx.entryRounds[pair] : 0
}

/** Pairs held by both rivals simultaneously. */
function rivalConsensus(ctx) {
  const rivalHoldings = ctx.rivals.map(r =>
    new Set(r.holdings.split(',').map(s => s.trim()).filter(Boolean)
      .map(label => Object.entries(C.LABELS).find(([, v]) => v === label)?.[0]).filter(Boolean))
  )
  if (rivalHoldings.length < 2) return new Set()
  const [a, b] = rivalHoldings
  return new Set([...a].filter(p => b.has(p)))
}

/**
 * Half-Kelly position sizing using per-pair win/loss history from ctx.
 * Falls back to cfg.buy_size_pct when there is insufficient data (<6 trades).
 * Returns a fraction of capital (not a dollar amount).
 *   f_half = 0.5 × (b×p − q) / b   where b = avgWin/avgLoss, p = winRate
 * Capped at 2× the base size to prevent over-betting on a lucky streak.
 */
function kellyFraction(pair, ctx, cfg) {
  const stats = ctx.pairPerformance.find(s => s.rawPair === pair)
  if (!stats || stats.trades < 6 || stats.avgLoss === 0) return cfg.buy_size_pct

  const p = stats.winRate / 100
  const q = 1 - p
  const b = stats.avgWin / stats.avgLoss
  const kelly = (b * p - q) / b

  if (kelly <= 0) return 0  // negative expectancy — don't size in at all

  return Math.min(kelly * 0.5, cfg.buy_size_pct * 2)
}

/** Conviction × Kelly-sized buy amount in USD. Returns 0 if Kelly is negative. */
function buyAmount(pair, signal_score, ctx, cfg) {
  const fraction = kellyFraction(pair, ctx, cfg)
  if (fraction === 0) return 0
  const conviction = clamp(Math.abs(signal_score) / 0.5, 0.5, 1.0)
  return ctx.capital * fraction * conviction
}

// ── Position count ─────────────────────────────────────────────────────────────
function positionCount(ctx) {
  return Object.values(ctx.holdings).filter(q => q > 0).length
}

// ── Deadweight check ───────────────────────────────────────────────────────────
function isDeadweight(pair, ctx) {
  const held = roundsHeld(pair, ctx)
  const pct  = unrealizedPct(pair, ctx)
  return held >= C.DEADWEIGHT_ROUNDS && pct != null && Math.abs(pct) < 3
}

// ── Archetype strategies ──────────────────────────────────────────────────────

/**
 * ALPHA — Momentum Rider
 * Buy the strongest momentum with confirmed flow.
 * Exit fast when momentum reverses or selling pressure builds.
 */
function alphaDecide(ctx, smap, threatened) {
  const regime = ctx.signals[0]?.regime || 'ranging'
  const base   = C.STRATEGY.ALPHA
  const cfg    = { ...base, ...(base.regime_overrides[regime] || {}) }
  const threatAdj = threatened ? 0.08 : 0  // lower threshold when threatened

  // ── SELL: scan holdings for exits ──────────────────────────────────────────
  let worstPair  = null
  let worstScore = Infinity

  for (const [pair, qty] of Object.entries(ctx.holdings)) {
    if (qty <= 0) continue
    const s   = smap[pair]
    if (!s) continue
    const pct = unrealizedPct(pair, ctx)

    const momentumReversed  = s.signal_score < (cfg.sell_signal + threatAdj)
    const sellingPressure   = s.cvd_norm < cfg.cvd_sell_max
    const deadweight        = isDeadweight(pair, ctx)

    if (momentumReversed || sellingPressure || deadweight) {
      if (s.signal_score < worstScore) {
        worstScore = s.signal_score
        worstPair  = pair
      }
    }
  }

  if (worstPair) {
    const s   = smap[worstPair]
    const pct = unrealizedPct(worstPair, ctx)
    const pctStr = pct != null ? `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%` : 'n/a'
    const why = isDeadweight(worstPair, ctx)
      ? `deadweight after ${roundsHeld(worstPair, ctx)} rounds (${pctStr})`
      : s.cvd_norm < cfg.cvd_sell_max
        ? `selling pressure (cvd=${s.cvd_norm.toFixed(2)})`
        : `momentum reversed (score=${s.signal_score.toFixed(2)})`
    return {
      action:       'SELL',
      pair:         worstPair,
      amount_usd:   0,  // full position
      reasoning:    `ALPHA exiting ${C.LABELS[worstPair] || worstPair}: ${why}. Rotating to stronger momentum.`,
      signal_score: s.signal_score
    }
  }

  // ── BUY: find best momentum candidate ──────────────────────────────────────
  const positions = positionCount(ctx)

  const candidates = ctx.signals
    .filter(s =>
      s.signal_score > (cfg.buy_signal - threatAdj) &&
      s.cvd_norm     > (threatened ? 0 : cfg.cvd_buy_min) &&
      s.funding_signal < cfg.funding_buy_max &&
      !ctx.holdings[s.pair] &&          // not already holding
      positions < C.MAX_POSITIONS
    )
    .sort((a, b) => b.signal_score - a.signal_score)

  if (candidates.length > 0) {
    const s      = candidates[0]
    const amount = buyAmount(s.pair, s.signal_score, ctx, cfg)
    if (amount < 50) return holdDecision('insufficient capital for sizing')
    return {
      action:       'BUY',
      pair:         s.pair,
      amount_usd:   amount,
      reasoning:    `ALPHA [${regime}] entering ${C.LABELS[s.pair] || s.pair}: score=${s.signal_score.toFixed(2)} (thr=${cfg.buy_signal.toFixed(2)}), cvd=${s.cvd_norm.toFixed(2)}, fund=${s.funding_signal.toFixed(2)}.`,
      signal_score: s.signal_score
    }
  }

  return holdDecision(`ALPHA [${regime}]: no signal above threshold ${cfg.buy_signal.toFixed(2)}`)
}

/**
 * BETA — Contrarian
 * Enter on crowded positioning extremes (high funding, extreme fear).
 * Exit when the crowd catches up (rivals hold it, greed spikes, signal normalises).
 */
function betaDecide(ctx, smap, threatened) {
  const regime     = ctx.signals[0]?.regime || 'ranging'
  const base       = C.STRATEGY.BETA
  const cfg        = { ...base, ...(base.regime_overrides[regime] || {}) }
  const consensus  = rivalConsensus(ctx)
  const fearGreed  = ctx.signals[0]?.fear_greed ?? 50
  const threatAdj  = threatened ? 0.15 : 0

  // ── SELL: exit when contrarian thesis is exhausted ─────────────────────────
  for (const [pair, qty] of Object.entries(ctx.holdings)) {
    if (qty <= 0) continue
    const s = smap[pair]
    if (!s) continue

    const rivalsCaughtUp  = consensus.has(pair) && s.signal_score > 0
    const greedExtreme    = fearGreed > cfg.greed_sell_min
    const normalised      = s.signal_score > cfg.sell_signal  // no longer oversold

    if (rivalsCaughtUp || greedExtreme || normalised) {
      const why = rivalsCaughtUp
        ? `rivals now consensus-hold it (divergence lost, score=${s.signal_score.toFixed(2)})`
        : greedExtreme
          ? `extreme greed (F&G=${fearGreed}) — contrarian exit`
          : `signal normalised (score=${s.signal_score.toFixed(2)}) — thesis complete`
      return {
        action:       'SELL',
        pair,
        amount_usd:   0,
        reasoning:    `BETA exiting ${C.LABELS[pair] || pair}: ${why}.`,
        signal_score: s.signal_score
      }
    }
  }

  // ── BUY: enter on crowd-positioning extremes ───────────────────────────────
  const positions = positionCount(ctx)
  if (positions >= C.MAX_POSITIONS) return holdDecision('max positions reached')

  // Rank by funding_signal desc (most crowded shorts = highest contrarian opportunity)
  const byFunding = ctx.signals
    .filter(s =>
      (s.funding_signal > (cfg.funding_buy_min - threatAdj) || fearGreed < cfg.fear_buy_max) &&
      s.signal_score > -0.8 &&              // not in absolute freefall
      !ctx.holdings[s.pair] &&             // not already in it
      !(consensus.has(s.pair))             // rivals haven't piled in already
    )
    .sort((a, b) => b.funding_signal - a.funding_signal)

  if (byFunding.length > 0) {
    const s      = byFunding[0]
    const amount = buyAmount(s.pair, s.signal_score, ctx, cfg)
    if (amount < 50) return holdDecision('insufficient capital')
    const trigger = s.funding_signal > cfg.funding_buy_min
      ? `funding=${s.funding_signal.toFixed(2)} (crowded shorts)`
      : `F&G=${fearGreed} (extreme fear)`
    return {
      action:       'BUY',
      pair:         s.pair,
      amount_usd:   amount,
      reasoning:    `BETA [${regime}] contrarian entry in ${C.LABELS[s.pair] || s.pair}: ${trigger}, score=${s.signal_score.toFixed(2)}. Rivals not holding — divergence preserved.`,
      signal_score: s.signal_score
    }
  }

  return holdDecision(`BETA [${regime}]: no qualifying contrarian setup`)
}

/**
 * GAMMA — Risk Manager
 * Only enter on high-conviction, confirmed signals with strict cash reserve.
 * Exit quickly on any loss or when flow turns against the position.
 */
function gammaDecide(ctx, smap, threatened) {
  const regime    = ctx.signals[0]?.regime || 'ranging'
  const base      = C.STRATEGY.GAMMA
  const cfg       = { ...base, ...(base.regime_overrides[regime] || {}) }
  const fearGreed = ctx.signals[0]?.fear_greed ?? 50
  const threatAdj = threatened ? 0.10 : 0

  // ── SELL: tight risk exits first ───────────────────────────────────────────
  let exitPair = null
  let exitWhy  = ''

  for (const [pair, qty] of Object.entries(ctx.holdings)) {
    if (qty <= 0) continue
    const s   = smap[pair]
    if (!s) continue
    const pct = unrealizedPct(pair, ctx)

    const stopOut    = pct != null && pct < -cfg.sell_loss_pct
    const anyBearish = s.signal_score < 0
    const takePft    = pct != null && pct > cfg.sell_profit_pct && s.cvd_norm < 0

    if (stopOut) {
      exitPair = pair
      exitWhy  = `loss exceeds ${cfg.sell_loss_pct}% (${pct.toFixed(1)}%) — capital protection`
      break
    }
    if (anyBearish && !exitPair) {
      exitPair = pair
      exitWhy  = `signal turned bearish (score=${s.signal_score.toFixed(2)}) — exit before drawdown`
    }
    if (takePft && !exitPair) {
      exitPair = pair
      exitWhy  = `profit target ${cfg.sell_profit_pct}% reached (${pct.toFixed(1)}%) with flow turning (cvd=${s.cvd_norm.toFixed(2)})`
    }
  }

  if (exitPair) {
    const s = smap[exitPair]
    return {
      action:       'SELL',
      pair:         exitPair,
      amount_usd:   0,
      reasoning:    `GAMMA exiting ${C.LABELS[exitPair] || exitPair}: ${exitWhy}.`,
      signal_score: s?.signal_score ?? 0
    }
  }

  // ── BUY: only on high-quality confirmed signals ────────────────────────────
  const positions = positionCount(ctx)
  if (positions >= cfg.max_positions) return holdDecision('GAMMA max positions reached')

  const cashRatio = ctx.capital / ctx.totalValue
  if (cashRatio < cfg.cash_min_pct && !threatened) {
    return holdDecision(`GAMMA cash reserve too low (${(cashRatio * 100).toFixed(0)}% < ${cfg.cash_min_pct * 100}%)`)
  }

  const quality = ctx.signals
    .filter(s =>
      s.signal_score  > (cfg.buy_signal  - threatAdj) &&
      s.cvd_norm      > (cfg.cvd_buy_min - threatAdj * 0.5) &&
      s.funding_signal < cfg.funding_buy_max &&
      fearGreed        < 65 &&
      !ctx.holdings[s.pair]
    )
    .sort((a, b) => b.signal_score - a.signal_score)

  if (quality.length > 0) {
    const s      = quality[0]
    const amount = buyAmount(s.pair, s.signal_score, ctx, cfg)
    // Verify cash remains above minimum after this trade
    if ((ctx.capital - amount) / ctx.totalValue < cfg.cash_min_pct && !threatened) {
      return holdDecision('trade would breach cash reserve minimum')
    }
    if (amount < 50) return holdDecision('insufficient capital for sizing')
    return {
      action:       'BUY',
      pair:         s.pair,
      amount_usd:   amount,
      reasoning:    `GAMMA [${regime}] high-quality entry in ${C.LABELS[s.pair] || s.pair}: score=${s.signal_score.toFixed(2)} (thr=${cfg.buy_signal.toFixed(2)}), cvd=${s.cvd_norm.toFixed(2)}, fund=${s.funding_signal.toFixed(2)}, F&G=${fearGreed}.`,
      signal_score: s.signal_score
    }
  }

  return holdDecision(`GAMMA [${regime}]: signal quality insufficient (thr=${cfg.buy_signal.toFixed(2)}) — preserving capital`)
}

/**
 * MEGA — Adaptive Synthesizer
 * Regime-aware strategy loaded from agents/mega-config.json.
 * Applies regime_overrides on top of base thresholds for each market condition.
 */
function megaDecide(ctx, smap, threatened) {
  const baseCfg = megaConfig.strategy
  const regime  = ctx.signals[0]?.regime || 'trending_up'
  const ov      = megaConfig.regime_overrides[regime] || {}
  const cfg     = { ...baseCfg, ...ov }

  const threatAdj = threatened ? 0.08 : 0

  // ── SELL: scan holdings for exits ──────────────────────────────────────────
  let exitPair = null
  let exitWhy  = ''

  for (const [pair, qty] of Object.entries(ctx.holdings)) {
    if (qty <= 0) continue
    const s   = smap[pair]
    if (!s) continue
    const pct = unrealizedPct(pair, ctx)

    const stopOut    = pct != null && pct < -cfg.sell_loss_pct
    const flowBad    = s.cvd_norm < cfg.cvd_sell_max
    const sigGone    = s.signal_score < (cfg.sell_signal + threatAdj)
    const takePft    = pct != null && pct > cfg.sell_profit_pct && s.cvd_norm < 0
    const deadweight = isDeadweight(pair, ctx)

    if (stopOut) {
      exitPair = pair
      exitWhy  = `loss exceeds ${cfg.sell_loss_pct}% (${pct.toFixed(1)}%) — capital protection`
      break
    }
    if (!exitPair && (flowBad || sigGone || takePft || deadweight)) {
      exitPair = pair
      if      (takePft)    exitWhy = `profit target ${cfg.sell_profit_pct}% reached (${pct.toFixed(1)}%) with flow turning`
      else if (flowBad)    exitWhy = `selling pressure (cvd=${s.cvd_norm.toFixed(2)})`
      else if (deadweight) exitWhy = `deadweight after ${roundsHeld(pair, ctx)} rounds`
      else                 exitWhy = `momentum gone (score=${s.signal_score.toFixed(2)})`
    }
  }

  if (exitPair) {
    const s = smap[exitPair]
    return {
      action:       'SELL',
      pair:         exitPair,
      amount_usd:   0,
      reasoning:    `MEGA [${regime}] exiting ${C.LABELS[exitPair] || exitPair}: ${exitWhy}.`,
      signal_score: s?.signal_score ?? 0
    }
  }

  // ── BUY: find best candidate under regime-adjusted thresholds ──────────────
  const positions = positionCount(ctx)
  if (positions >= cfg.max_positions) return holdDecision(`MEGA [${regime}]: max positions reached`)

  const cashRatio = ctx.capital / ctx.totalValue
  if (cashRatio < cfg.cash_min_pct && !threatened) {
    return holdDecision(`MEGA [${regime}]: cash reserve too low (${(cashRatio * 100).toFixed(0)}% < ${cfg.cash_min_pct * 100}%)`)
  }

  const candidates = ctx.signals
    .filter(s =>
      s.signal_score   > (cfg.buy_signal - threatAdj) &&
      s.cvd_norm       > (threatened ? 0 : cfg.cvd_buy_min) &&
      s.funding_signal < cfg.funding_buy_max &&
      !ctx.holdings[s.pair] &&
      positions < C.MAX_POSITIONS
    )
    .sort((a, b) => b.signal_score - a.signal_score)

  if (candidates.length > 0) {
    const s      = candidates[0]
    const amount = buyAmount(s.pair, s.signal_score, ctx, cfg)
    if (amount < 50) return holdDecision('MEGA: insufficient capital for sizing')
    return {
      action:       'BUY',
      pair:         s.pair,
      amount_usd:   amount,
      reasoning:    `MEGA [${regime}] entering ${C.LABELS[s.pair] || s.pair}: score=${s.signal_score.toFixed(2)}, cvd=${s.cvd_norm.toFixed(2)}, fund=${s.funding_signal.toFixed(2)}. Threshold=${cfg.buy_signal.toFixed(2)} (regime-adjusted).`,
      signal_score: s.signal_score
    }
  }

  return holdDecision(`MEGA [${regime}]: no signal above threshold ${cfg.buy_signal.toFixed(2)}`)
}

// ── HOLD fallback ─────────────────────────────────────────────────────────────

function holdDecision(reason) {
  return {
    action:       'HOLD',
    pair:         'BTCUSDT',
    amount_usd:   0,
    reasoning:    reason,
    signal_score: 0
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * decide(ctx) → { action, pair, amount_usd, reasoning, signal_score }
 *
 * Deterministic — no randomness, no LLM. Same interface as the old decide().
 * personality is left empty here; synthesize() in agent.js fills it periodically.
 */
function decide(ctx) {
  const smap      = signalMap(ctx.signals)
  const threatened = ctx.threatened
  const name      = ctx.agentName

  let decision
  if (name === 'ALPHA') {
    decision = alphaDecide(ctx, smap, threatened)
  } else if (name === 'BETA') {
    decision = betaDecide(ctx, smap, threatened)
  } else if (name === 'GAMMA') {
    decision = gammaDecide(ctx, smap, threatened)
  } else if (name === 'MEGA') {
    decision = megaDecide(ctx, smap, threatened)
  } else {
    decision = holdDecision('unknown archetype')
  }

  // Ensure personality field exists (filled in by synthesize() periodically)
  decision.personality = ctx.personality || ''
  return decision
}

module.exports = { decide, reloadMegaConfig, VERSION }
