'use strict'

const { blendThresholds } = require('./regime')
const { simEntry, simExit, intraStopCheck } = require('./executor')

// ── Agent ─────────────────────────────────────────────────────────────────────

class Agent {
  /**
   * @param {object} opts
   * @param {string} opts.id       — e.g. 'A1', 'A2'
   * @param {string} opts.mode     — 'live' | 'paper'
   * @param {object} opts.config   — full config object (from ConfigStore)
   * @param {number} opts.capital  — starting capital in USD
   * @param {number} opts.configVersion — current config version number
   */
  constructor({ id, mode, config, capital, configVersion = 0, personality = '' }) {
    this.id            = id
    this.mode          = mode          // 'live' | 'paper'
    this.config        = config
    this.configVersion = configVersion
    this.personality   = personality
    this.capital       = capital       // cash available
    this.positions     = {}            // pair → { entryPrice, sizeUsd, entryScore, entryTick, entryRegime }
    this.tickCount     = 0             // increments each candle
    this.tradeHistory  = {}            // pair → [{ win, pnl_pct }]  (rolling 20, for Kelly)
    this.spotAccumMacroWasLow = false  // spot_accum_mode: tracks if macro was in capitulation
    this.prevMacroUp          = null   // spot_accum_mode: previous tick's macro_p_trending_up
    this.spotAccumMacroDepth  = 1.0   // spot_accum_mode: lowest macro seen since last reset
  }

  // ── Config hot-reload ─────────────────────────────────────────────────────

  updateConfig(config, version) {
    this.config        = config
    this.configVersion = version
  }

  // ── Composite score ───────────────────────────────────────────────────────

  /**
   * score(sv) — weighted sum of sub-signals using this agent's config weights.
   * Returns a float, not clamped (agents can observe raw signal strength).
   */
  score(sv) {
    const w = this.config.weights
    return (
      sv.cvd_norm          * (w.cvd_norm          || 0) +
      sv.funding_signal    * (w.funding_signal    || 0) +
      sv.momentum_1h       * (w.momentum_1h       || 0) +
      sv.momentum_4h       * (w.momentum_4h       || 0) +
      sv.rsi_norm          * (w.rsi_norm          || 0) +
      sv.volume_zscore     * (w.volume_zscore     || 0) +
      sv.fear_greed_signal * (w.fear_greed_signal || 0) +
      (sv.news_signal || 0) * (w.news_signal      || 0)
    )
  }

  // ── Kelly sizing ──────────────────────────────────────────────────────────

  /**
   * kellySize(pair) — returns position size as a fraction of capital.
   * Falls back to buy_size_pct_base until kelly_min_trades is reached.
   */
  kellySize(pair) {
    const cfg  = this.config
    const base = cfg.sizing.buy_size_pct_base
    const hist = this.tradeHistory[pair] || []

    if (hist.length < cfg.kelly.kelly_min_trades) return base

    const wins    = hist.filter(t => t.win)
    const losses  = hist.filter(t => !t.win)
    const p       = wins.length / hist.length
    const q       = 1 - p
    const avgWin  = wins.length  ? wins.reduce((s, t) => s + t.pnl_pct, 0)  / wins.length  : 0
    const avgLoss = losses.length ? losses.reduce((s, t) => s + Math.abs(t.pnl_pct), 0) / losses.length : 1
    const b       = avgLoss > 0 ? avgWin / avgLoss : 0

    const f = b > 0 ? 0.5 * (b * p - q) / b : 0  // half-Kelly
    if (f <= 0) return 0  // negative expectancy — signal but no size → skip entry

    const cap = base * cfg.kelly.kelly_cap_multiplier
    return Math.min(f, cap)
  }

  // ── Total portfolio value ─────────────────────────────────────────────────

  totalValue(prices) {
    let val = this.capital
    for (const [posKey, pos] of Object.entries(this.positions)) {
      const pair = pos.pair || posKey
      val += pos.sizeUsd * ((prices[pair] || pos.entryPrice) / pos.entryPrice)
    }
    return val
  }

  // ── Decide ────────────────────────────────────────────────────────────────

  /**
   * decide(signalVectors, prices) → Action[]
   *
   * Called once per candle close. Returns an ordered array of actions:
   * exits first (highest priority), then at most one entry.
   *
   * Action shapes:
   *   { type: 'EXIT',     pair, exit_reason, fill, pnl_pct, signal_score, regimeProbs, configVersion }
   *   { type: 'ENTRY',    pair, fill, signal_score, regimeProbs, configVersion }
   *   { type: 'REJECTED', pair, gate_failed, signal_score, regimeProbs, configVersion }
   */
  decide(signalVectors, prices) {
    this.tickCount++
    const actions   = []
    const cfg       = this.config
    const svByPair  = Object.fromEntries(signalVectors.map(sv => [sv.pair, sv]))

    // ── 1. Exits ────────────────────────────────────────────────────────────
    for (const [posKey, pos] of Object.entries(this.positions)) {
      if (pos.blocked) continue   // position bloquée manuellement — protégée des sorties auto
      const pair = pos.pair || posKey
      const sv  = svByPair[pair]
      const mid = prices[pair]
      if (!sv || !mid) continue

      const score    = this.score(sv)
      const regime   = { p_volatile: sv.p_volatile, p_trending_up: sv.p_trending_up,
                         p_trending_down: sv.p_trending_down, p_ranging: sv.p_ranging }

      // Effective stop loss — blended by current regime probs
      const stopPct  = blendThresholds(regime, {
        volatile:      cfg.exit.sell_loss_pct_base,
        trending_up:   cfg.exit.sell_loss_pct_base,
        trending_down: cfg.exit.sell_loss_pct_trending_down,
        ranging:       cfg.exit.sell_loss_pct_base
      })

      const fill         = simExit(pos.entryPrice, mid, pos.sizeUsd)
      const unrealisedPct = fill.pnl_pct

      const holdingRounds = this.tickCount - pos.entryTick
      const minHold       = cfg.hold.min_hold_rounds || 0

      const minSignalHold = cfg.hold.min_signal_hold_rounds || 0

      let exit_reason = null

      // Priority 1 — hard stop loss (gated by minimum hold rounds)
      if (unrealisedPct <= -stopPct && holdingRounds >= minHold) {
        exit_reason = 'stop_loss'

      // Priority 2 — take profit (with optional CVD confirmation)
      } else if (unrealisedPct >= cfg.exit.sell_profit_pct) {
        if (!cfg.exit.take_profit_requires_cvd_turn || sv.cvd_norm < 0) {
          exit_reason = 'take_profit'
        }

      // Priority 3 — macro regime exit (trend_follow_mode / spot_accum_mode): exit when 4h trend turns bearish
      } else if (cfg.entry.trend_follow_mode || cfg.entry.spot_accum_mode) {
        const macroExitMin = cfg.exit.trend_follow_macro_exit ?? 0.4
        if ((sv.macro_p_trending_up ?? 1) < macroExitMin && holdingRounds >= minHold) {
          exit_reason = 'macro_exit'

        // Priority 3b — 15m regime flip exit: faster exit when 15m turns trending_down
        } else {
          const regimeExitDown = cfg.exit.trend_follow_regime_exit_down ?? null
          if (regimeExitDown !== null && regime.p_trending_down > regimeExitDown && holdingRounds >= minHold) {
            exit_reason = 'regime_exit'
          }
        }

      // Priority 3 (standard) — signal turned bearish
      } else if (score < cfg.exit.sell_signal && holdingRounds >= minSignalHold) {
        exit_reason = 'signal'

      // Priority 4 — CVD turned strongly negative
      } else if (sv.cvd_norm < cfg.exit.cvd_sell_max && holdingRounds >= minSignalHold) {
        exit_reason = 'cvd'

      // Priority 5 — deadweight
      } else if (
        this.tickCount - pos.entryTick >= cfg.hold.deadweight_rounds_min &&
        Math.abs(unrealisedPct) < cfg.hold.deadweight_pnl_threshold
      ) {
        exit_reason = 'deadweight'
      }

      if (exit_reason) {
        // Update capital and trade history
        this.capital += pos.sizeUsd + fill.pnl_usd - fill.fee_usd
        this._recordTrade(pair, fill.pnl_pct)
        delete this.positions[posKey]

        actions.push({
          type:          'EXIT',
          pair,
          exit_reason,
          fill,
          pnl_pct:       fill.pnl_pct,
          holding_rounds: this.tickCount - pos.entryTick,
          entry_score:   pos.entryScore,
          signal_score:  score,
          regimeProbs:   regime,
          configVersion: this.configVersion
        })
      }
    }

    // ── 2. Entry — pick best qualifying pair ────────────────────────────────
    const posCount = Object.keys(this.positions).length
    const totalVal = this.totalValue(prices)
    const cashPct  = totalVal > 0 ? this.capital / totalVal : 1

    let bestEntry = null

    for (const sv of signalVectors) {
      const { pair } = sv
      // already holding this pair (via agent buy or manual buy)
      if (Object.entries(this.positions).some(([k, p]) => (p.pair || k) === pair)) continue

      // Gate 0 — pair allowlist (if configured, restricts universe for this agent)
      const allowedPairs = cfg.entry.allowed_pairs
      if (allowedPairs && !allowedPairs.includes(pair)) continue

      const mid   = prices[pair]
      if (!mid) continue

      const score  = this.score(sv)
      const regime = { p_volatile: sv.p_volatile, p_trending_up: sv.p_trending_up,
                       p_trending_down: sv.p_trending_down, p_ranging: sv.p_ranging }

      if (cfg.entry.spot_accum_mode) {
        // ── Spot accumulation mode: buy BTC dip when macro recovers from capitulation ──

        // only operates on BTCUSDT
        if (pair !== 'BTCUSDT') continue

        const macroUp  = sv.macro_p_trending_up ?? 0
        const lowThresh = cfg.entry.spot_accum_macro_low_threshold ?? 0.20
        if (macroUp < lowThresh) this.spotAccumMacroWasLow = true
        if (macroUp < this.spotAccumMacroDepth) this.spotAccumMacroDepth = macroUp

        const prevMacro    = this.prevMacroUp ?? macroUp
        this.prevMacroUp   = macroUp

        const priceCeiling = cfg.entry.spot_accum_price_ceiling ?? Infinity
        const macroMin     = cfg.entry.spot_accum_macro_min     ?? 0.30

        if (mid > priceCeiling) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'sa_price_ceiling',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        if (!this.spotAccumMacroWasLow) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'sa_macro_was_low',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        if (macroUp < macroMin) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'sa_macro_min',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        const dipMinPct = cfg.entry.spot_accum_dip_min_pct ?? 0
        if (dipMinPct > 0 && (sv.btc_dip_pct ?? 0) > -dipMinPct) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'sa_dip_insufficient',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        const atrMinPct = cfg.entry.spot_accum_atr_min_pct ?? 0
        if (atrMinPct > 0 && (sv.btc_atr_4h_pct ?? 0) < atrMinPct) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'sa_atr_insufficient',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        if (macroUp <= prevMacro) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'sa_macro_rising',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        // all gates passed — fall through to sizing

      } else if (cfg.entry.trend_follow_mode) {
        // ── Trend-follow mode: bypass composite score, use regime + raw signal gates only ──

        // Gate TF-1 — 4h macro must be bullish
        const tfMacroMin = cfg.entry.trend_follow_macro_min ?? 0.6
        if ((sv.macro_p_trending_up ?? 0) < tfMacroMin) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_macro',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate TF-2 — 15m regime must not be trending down
        const tfDownMax = cfg.entry.trend_follow_down_max ?? 0.4
        if (regime.p_trending_down > tfDownMax) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_regime_down',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate TF-2b — block ranging regime: no clear direction, trend-follow has no edge
        const tfRangingMax = cfg.entry.trend_follow_ranging_max ?? null
        if (tfRangingMax !== null && regime.p_ranging > tfRangingMax) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_ranging',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate TF-3 — per-candle CVD dip: buy net selling pressure within the uptrend
        // cvd_1c < 0 means sellers dominated this 15m candle → mean-reversion dip entry
        const tfCvd1cMax = cfg.entry.trend_follow_cvd1c_max ?? 0
        if ((sv.cvd_1c ?? 0) > tfCvd1cMax) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_cvd1c_dip',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate TF-4 — 15m regime must show upward trend (not just macro)
        const tfRegimeMin = cfg.entry.trend_follow_regime_min ?? 0
        if (tfRegimeMin > 0 && regime.p_trending_up < tfRegimeMin) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_regime_15m',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate TF-5 — RSI not overbought: dip entry should also show in RSI
        const tfRsiMax = cfg.entry.trend_follow_rsi_max ?? null
        if (tfRsiMax !== null && (sv.rsi_norm ?? 0) > tfRsiMax) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_rsi',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate TF-6 — 1h momentum range: require pullback (not free-falling, not overbought)
        const tfMom1hMin = cfg.entry.trend_follow_mom1h_min ?? null
        const tfMom1hMax = cfg.entry.trend_follow_mom1h_max ?? null
        if (tfMom1hMin !== null && (sv.momentum_1h ?? 0) < tfMom1hMin) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_mom1h_min',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        if (tfMom1hMax !== null && (sv.momentum_1h ?? 0) > tfMom1hMax) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_mom1h_max',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate TF-7 — weekly regime: require weekly uptrend (slow, high-conviction filter)
        const tfWeeklyMin = cfg.entry.trend_follow_weekly_min ?? null
        if (tfWeeklyMin !== null && (sv.weekly_p_trending_up ?? 0) < tfWeeklyMin) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_weekly',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate TF-8 — BTC 200-day MA: price/SMA200 >= threshold (1.0 = above, <1.0 = below)
        const tfBtc200dMin = cfg.entry.trend_follow_btc200d_min ?? null
        if (tfBtc200dMin !== null && (sv.btc_above_200d ?? 1) < tfBtc200dMin) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'tf_btc200d',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

      } else {
        // ── Standard scoring mode ──────────────────────────────────────────────

        // Effective entry threshold — use 4h macro regime if configured (Fix 2)
        const thresholdRegime = (cfg.entry.use_macro_regime && sv.macro_p_trending_up != null)
          ? { p_volatile:      sv.macro_p_volatile,
              p_trending_up:   sv.macro_p_trending_up,
              p_trending_down: sv.macro_p_trending_down,
              p_ranging:       sv.macro_p_ranging }
          : regime
        const threshold = blendThresholds(thresholdRegime, cfg.entry.buy_signal_per_regime)

        // Gate 1 — signal threshold
        if (score < threshold) continue

        // Gate 1a — macro trend (4h): require bullish higher-timeframe regime (Fix 1)
        const macroMin = cfg.entry.macro_trend_min
        if (macroMin != null && sv.macro_p_trending_up != null && sv.macro_p_trending_up < macroMin) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'macro_trend',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate 1b — momentum floor
        const mom4hMin = cfg.entry.momentum_4h_min
        if (mom4hMin != null && sv.momentum_4h < mom4hMin) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'momentum_4h_floor',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate 1c — hard veto on unfavourable regime probabilities
        const tdMaxProb  = cfg.entry.trending_down_max_prob ?? 1
        const rgMaxProb  = cfg.entry.ranging_max_prob       ?? 1
        const volMaxProb = cfg.entry.volatile_max_prob      ?? 1
        if (regime.p_trending_down > tdMaxProb) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'trending_down_veto',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        if (regime.p_ranging > rgMaxProb) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'ranging_veto',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
        if (regime.p_volatile > volMaxProb) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'volatile_veto',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }

        // Gate 2 — CVD flow (Fix 3: reversion mode buys dips, momentum mode requires positive flow)
        if (cfg.entry.cvd_dip_required) {
          const dipMax = cfg.entry.cvd_dip_max ?? 0
          if (sv.cvd_norm > dipMax || sv.cvd_norm < cfg.entry.cvd_buy_min) {
            actions.push({ type: 'REJECTED', pair, gate_failed: 'cvd',
              signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
            continue
          }
        } else {
          if (sv.cvd_norm < cfg.entry.cvd_buy_min) {
            actions.push({ type: 'REJECTED', pair, gate_failed: 'cvd',
              signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
            continue
          }
        }

        // Gate 3 — funding not too crowded
        if (sv.funding_signal < -cfg.entry.funding_buy_max) {
          actions.push({ type: 'REJECTED', pair, gate_failed: 'funding',
            signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
          continue
        }
      }

      // Gate 4 — max positions
      if (posCount >= cfg.sizing.max_positions) {
        actions.push({ type: 'REJECTED', pair, gate_failed: 'max_positions',
          signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
        continue
      }

      // Gate 5 — cash reserve
      if (cashPct < cfg.sizing.cash_min_pct) {
        actions.push({ type: 'REJECTED', pair, gate_failed: 'cash_min',
          signal_score: score, regimeProbs: regime, configVersion: this.configVersion })
        continue
      }

      // Sizing: spot_accum_mode uses fixed allocation; others use Kelly
      const sizeFraction = cfg.entry.spot_accum_mode
        ? (cfg.sizing.spot_accum_size_pct ?? cfg.sizing.buy_size_pct_base)
        : this.kellySize(pair)
      if (sizeFraction <= 0) continue

      // Track best qualifying entry by score
      if (!bestEntry || score > bestEntry.score) {
        bestEntry = { pair, score, regime, sizeFraction, mid, isSpotAccum: !!cfg.entry.spot_accum_mode }
      }
    }

    if (bestEntry) {
      const { pair, score, regime, sizeFraction, mid, isSpotAccum } = bestEntry
      const sizeUsd = Math.min(this.capital * sizeFraction, this.capital * 0.99)
      if (sizeUsd >= 1) {
        const fill = simEntry(mid, sizeUsd)

        this.capital -= sizeUsd
        this.positions[pair] = {
          pair,
          entryPrice: fill.price,
          sizeUsd,
          entryScore: score,
          entryTick:  this.tickCount,
          entryRegime: regime
        }

        if (isSpotAccum) {
          this.spotAccumMacroWasLow = false  // reset: no re-entry on same dip
          this.spotAccumMacroDepth  = 1.0   // reset depth tracker for next cycle
        }

        actions.push({
          type:          'ENTRY',
          pair,
          fill,
          size_usd:      sizeUsd,
          signal_score:  score,
          regimeProbs:   regime,
          configVersion: this.configVersion
        })
      }
    }

    return actions
  }

  // ── Gate trace (for TUI diagnostics) ─────────────────────────────────────

  /**
   * gateTrace(signalVectors, prices) → { pair: { held, score, threshold, gates: bool[5] } }
   *
   * Evaluates all 5 entry gates for every pair independently (non-sequential),
   * so the TUI can show which gate(s) are blocking each pair at a glance.
   *
   * Gates:
   *   0 — score ≥ blended threshold
   *   1 — cvd_norm ≥ cvd_buy_min
   *   2 — funding_signal ≥ -funding_buy_max
   *   3 — posCount < max_positions
   *   4 — cashPct ≥ cash_min_pct
   */
  gateTrace(signalVectors, prices) {
    const cfg      = this.config
    const posCount = Object.keys(this.positions).length
    const totalVal = this.totalValue(prices)
    const cashPct  = totalVal > 0 ? this.capital / totalVal : 1
    const result   = {}

    for (const sv of signalVectors) {
      const { pair } = sv
      const mid = prices[pair]
      if (!mid) continue

      if (Object.entries(this.positions).some(([k, p]) => (p.pair || k) === pair)) {
        result[pair] = { held: true }
        continue
      }

      const score     = this.score(sv)
      const regime    = { p_volatile: sv.p_volatile, p_trending_up: sv.p_trending_up,
                          p_trending_down: sv.p_trending_down, p_ranging: sv.p_ranging }
      const threshold = blendThresholds(regime, cfg.entry.buy_signal_per_regime)

      result[pair] = {
        score,
        threshold,
        gates: [
          score >= threshold,
          sv.cvd_norm >= cfg.entry.cvd_buy_min,
          sv.funding_signal >= -cfg.entry.funding_buy_max,
          posCount < cfg.sizing.max_positions,
          cashPct >= cfg.sizing.cash_min_pct
        ]
      }
    }
    return result
  }

  // ── Intra-candle stop scan ────────────────────────────────────────────────

  /**
   * intraStops(prices) → Action[]
   * Checks all open positions against current (mid-candle) prices.
   * Returns EXIT actions for any position breaching its stop.
   * Called between candles — does not increment tickCount.
   */
  intraStops(prices) {
    const actions = []
    const cfg     = this.config

    for (const [posKey, pos] of Object.entries(this.positions)) {
      if (pos.blocked) continue   // position bloquée — stop intra-candle désactivé
      const pair = pos.pair || posKey
      const mid = prices[pair]
      if (!mid) continue

      if (intraStopCheck(pos.entryPrice, mid, cfg.exit.sell_loss_pct_base)) {
        const fill = simExit(pos.entryPrice, mid, pos.sizeUsd)

        this.capital += pos.sizeUsd + fill.pnl_usd - fill.fee_usd
        this._recordTrade(pair, fill.pnl_pct)
        delete this.positions[posKey]

        actions.push({
          type:          'EXIT',
          pair,
          exit_reason:   'stop_loss_intra',
          fill,
          pnl_pct:       fill.pnl_pct,
          holding_rounds: 0,
          entry_score:   pos.entryScore,
          signal_score:  null,
          regimeProbs:   pos.entryRegime,
          configVersion: this.configVersion
        })
      }
    }

    return actions
  }

  // ── Trade history (for Kelly) ─────────────────────────────────────────────

  _recordTrade(pair, pnl_pct) {
    if (!this.tradeHistory[pair]) this.tradeHistory[pair] = []
    this.tradeHistory[pair].push({ win: pnl_pct > 0, pnl_pct })
    if (this.tradeHistory[pair].length > 20) this.tradeHistory[pair].shift()
  }

  // ── Snapshot (for TUI / WebSocket push) ──────────────────────────────────

  snapshot(prices) {
    const totalVal = this.totalValue(prices)
    const positions = Object.entries(this.positions).map(([posKey, pos]) => {
      const pair       = pos.pair || posKey
      const mid        = prices[pair] || pos.entryPrice
      const unrealised = ((mid - pos.entryPrice) / pos.entryPrice) * 100
      return { posId: posKey, pair, sizeUsd: pos.sizeUsd, entryPrice: pos.entryPrice,
               currentPrice: mid, unrealisedPct: Math.round(unrealised * 100) / 100,
               blocked: pos.blocked || false }
    })
    return {
      id:            this.id,
      mode:          this.mode,
      personality:   this.personality,
      capital:       Math.round(this.capital * 100) / 100,
      totalValue:    Math.round(totalVal * 100) / 100,
      positionCount: positions.length,
      positions,
      configVersion: this.configVersion,
      tickCount:     this.tickCount
    }
  }
}

module.exports = Agent
