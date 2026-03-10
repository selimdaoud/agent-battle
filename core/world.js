'use strict'

require('dotenv').config()
const Database = require('better-sqlite3')

// ── Constants ─────────────────────────────────────────────────────────────────
// These are defined before C so they can be interpolated into ARCHETYPES strings
const _ALPHA_MOMENTUM_THRESHOLD = 0.12  // signal_score above which ALPHA seeks momentum buys
const _BETA_OVERSOLD_SIGNAL     = -0.3  // signal_score below which BETA looks for contrarian buys
const _BETA_OVERSOLD_RSI        = 40    // RSI below which BETA considers an asset oversold

const C = {
  INITIAL_CAPITAL:           parseInt(process.env.INITIAL_CAPITAL) || 10000,
  BANKRUPTCY_FLOOR:          3000,
  MAX_POSITIONS:             5,
  MAX_POSITION_PCT:          0.30,
  MAX_EXPOSURE_PCT:          0.80,
  STOP_LOSS_PCT:             0.08,   // auto-sell when position drops this fraction from entry
  SLIPPAGE_PCT:              0.001,

  // ── Sell-decision thresholds (agent flags & prompts) ────────────────────────
  TAKE_PROFIT_FLAG_PCT:      20,    // % gain at which ← TAKE PROFIT? flag appears on a holding
  NEAR_STOP_WARN_PCT:        6,     // % loss at which ← NEAR STOP-LOSS warning flag appears
  DEADWEIGHT_ROUNDS:         5,     // rounds held with no movement before labeled deadweight

  // ── Position sizing by volatility tier ──────────────────────────────────────
  VOL_TIER_LOW_MAX_PCT:      30,    // max allocation % per position for low-vol pairs (BTC, ETH, LTC)
  VOL_TIER_MED_MAX_PCT:      20,    // max allocation % per position for med-vol pairs
  VOL_TIER_HIGH_MAX_PCT:     10,    // max allocation % per position for high-vol pairs

  // ── Archetype signal thresholds ──────────────────────────────────────────────
  ALPHA_MOMENTUM_THRESHOLD:  _ALPHA_MOMENTUM_THRESHOLD,
  BETA_OVERSOLD_SIGNAL:      _BETA_OVERSOLD_SIGNAL,
  BETA_OVERSOLD_RSI:         _BETA_OVERSOLD_RSI,

  // ── Realistic execution model ────────────────────────────────────────────────
  TAKER_FEE_PCT:        0.001,   // 0.10% Binance standard taker fee (market orders)
  MAKER_FEE_PCT:        0.001,   // 0.10% (reference only — we use market orders)
  BID_ASK_SPREAD: {              // full spread (halved for each side of trade)
    LOW:    0.0003,              // ~0.03% BTC, ETH, LTC
    MEDIUM: 0.0008,              // ~0.08% BNB, XRP, ADA, LINK, ATOM
    HIGH:   0.0015,              // ~0.15% SOL, DOGE, AVAX, DOT, MATIC, UNI, NEAR
  },
  MAX_TRADE_VOLUME_PCT: 0.005,   // max 0.5% of 20h USD volume per single trade

  // ── Backtester simulation parameters ────────────────────────────────────────
  BACKTEST_BUY_SIGNAL:       0.4,   // signal_score above which backtester enters a long
  BACKTEST_SELL_SIGNAL:      -0.4,  // signal_score below which backtester exits a long
  BACKTEST_BUY_SIZE_PCT:     0.20,  // fraction of capital deployed per BUY in backtester
  BACKTEST_MIN_CAPITAL:      500,   // minimum capital required to allow a BUY in backtester
  BACKTEST_TRAIN_DAYS:       30,    // default training window for walk-forward (days)
  BACKTEST_TEST_DAYS:        7,     // default test window for walk-forward (days)

  CULL_EVERY_N_ROUNDS:       10,
  LAST_PLACE_CULL_THRESHOLD: 3,
  UNDERPERFORM_GAP_PCT:      0.25,
  UNDERPERFORM_MIN_ROUND:    20,

  PAIRS: [
    'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
    'DOGEUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','MATICUSDT',
    'LINKUSDT','LTCUSDT','UNIUSDT','ATOMUSDT','NEARUSDT'
  ],

  LABELS: {
    BTCUSDT:'BTC/USDT', ETHUSDT:'ETH/USDT', BNBUSDT:'BNB/USDT',
    SOLUSDT:'SOL/USDT', XRPUSDT:'XRP/USDT', DOGEUSDT:'DOGE/USDT',
    ADAUSDT:'ADA/USDT', AVAXUSDT:'AVAX/USDT', DOTUSDT:'DOT/USDT',
    MATICUSDT:'MATIC/USDT', LINKUSDT:'LINK/USDT', LTCUSDT:'LTC/USDT',
    UNIUSDT:'UNI/USDT', ATOMUSDT:'ATOM/USDT', NEARUSDT:'NEAR/USDT'
  },

  ARCHETYPES: {
    ALPHA: {
      label: 'Momentum Rider',
      constraint: `You MUST hold at least 1 position at all times.
Bias toward assets with signal_score > ${_ALPHA_MOMENTUM_THRESHOLD}.
Holding more than 60% cash for 2+ consecutive rounds hurts your survival score.`,
      survivalBonus: 'momentum'
    },
    BETA: {
      label: 'Contrarian',
      constraint: `You look for oversold assets (signal_score < ${_BETA_OVERSOLD_SIGNAL}, RSI < ${_BETA_OVERSOLD_RSI}).
When ALPHA and GAMMA both hold an asset, treat that as a reason to avoid it.
Your survival score gets a bonus when your holdings differ from both rivals.`,
      survivalBonus: 'divergence'
    },
    GAMMA: {
      label: 'Risk Manager',
      constraint: `You hold MAXIMUM 2 positions at any time.
You MUST keep at least 40% cash at all times. This is enforced by the engine.
Your survival score rewards low drawdown more than raw returns.`,
      survivalBonus: 'stability'
    }
  },

  SIGNAL_WEIGHTS: {
    funding_signal:    0.25,  // contrarian: crowded longs/shorts on perpetuals
    cvd_norm:          0.20,  // taker buy/sell flow imbalance from kline data
    momentum_1h:       0.15,  // recent price momentum
    rsi_norm:          0.15,  // overbought / oversold
    fear_greed_signal: 0.10,  // market-wide contrarian sentiment
    volume_zscore:     0.10,  // unusual volume (now real, from klines)
    momentum_4h:       0.05,  // medium-term momentum
  },

  REGIME_MULTIPLIERS: {
    trending_up:   1.0,
    trending_down: 1.0,
    ranging:       0.9,
    volatile:      0.5
  },

  // ── Strategy engine thresholds (core/strategy.js) ───────────────────────────
  STRATEGY: {
    SYNTHESIS_EVERY_N_ROUNDS: 20,  // how often the LLM generates personality & market view

    ALPHA: {
      buy_signal:    _ALPHA_MOMENTUM_THRESHOLD, // min signal_score to enter (0.12)
      sell_signal:   -0.15,  // signal_score at which ALPHA exits
      cvd_buy_min:    0.00,  // min cvd_norm to confirm buy flow (0 = don't require positive CVD)
      cvd_sell_max:  -0.30,  // cvd below which ALPHA exits regardless of price signal
      funding_buy_max: 0.50, // max funding_signal allowed (avoid buying already-crowded longs)
      buy_size_pct:   0.25,  // fraction of capital per BUY
    },

    BETA: {
      funding_buy_min:  0.40,  // min funding_signal (crowded shorts) to trigger contrarian entry
      fear_buy_max:     25,    // max Fear & Greed index for fear-based entry
      greed_sell_min:   75,    // min Fear & Greed index to trigger greed-based exit
      sell_signal:      0.50,  // exit when signal_score rises above this (no longer oversold)
      buy_size_pct:     0.20,  // fraction of capital per BUY
    },

    GAMMA: {
      buy_signal:      0.18,  // min signal_score — high quality bar
      cvd_buy_min:     0.05,  // min cvd to confirm buy flow
      funding_buy_max: 0.60,  // max funding_signal (do not buy already-crowded longs)
      sell_loss_pct:   5,     // exit if unrealized loss exceeds this % (tighter than auto-stop)
      sell_profit_pct: 10,    // take profit at this % gain if flow turns
      cash_min_pct:    0.40,  // must keep at least 40% in cash at all times
      max_positions:   2,     // hard cap on simultaneous open positions
      buy_size_pct:    0.15,  // fraction of capital per BUY (conservative)
    },
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Half-spread for a pair based on its volatility tier. */
function _pairSpread(pair) {
  const s = C.BID_ASK_SPREAD
  if (['BTCUSDT','ETHUSDT','LTCUSDT'].includes(pair))                                         return s.LOW    / 2
  if (['BNBUSDT','XRPUSDT','ADAUSDT','LINKUSDT','ATOMUSDT'].includes(pair))                   return s.MEDIUM / 2
  return s.HIGH / 2
}

function _totalValue(agent, prices) {
  let total = agent.capital
  for (const [pair, qty] of Object.entries(agent.holdings)) {
    if (qty > 0 && prices[pair]) total += qty * prices[pair]
  }
  return total
}

function _defaultAgent(name) {
  return {
    name,
    alive:                true,
    capital:              C.INITIAL_CAPITAL,
    holdings:             {},
    entryPrices:          {},
    entryRounds:          {},
    personality:          '',
    archetype:            C.ARCHETYPES[name].label,
    respawnCount:         0,
    consecutiveLastPlace: 0,
    threatened:           false,
    survivalScore:        0,
    portfolioHistory:     [C.INITIAL_CAPITAL]
  }
}

// ── World class ───────────────────────────────────────────────────────────────
class World {
  constructor(dbPath) {
    // 1. Open SQLite
    this._db = new Database(dbPath)

    // 2. Create tables
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        round   INTEGER NOT NULL,
        type    TEXT    NOT NULL,
        agent   TEXT,
        payload TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_ticks_round ON ticks(round);
      CREATE INDEX IF NOT EXISTS idx_ticks_agent ON ticks(agent, type);
    `)

    // 3. Rebuild snapshot from DB
    this._snapshot = null
    this._lastPrices = {}
    this._rebuild()

    // 4. Seed config defaults if first run
    const roundRow = this._db.prepare("SELECT value FROM config WHERE key='current_round'").get()
    if (!roundRow) {
      this._db.prepare("INSERT OR IGNORE INTO config(key,value) VALUES(?,?)").run('current_round', '0')
    }
  }

  // ── Rebuild snapshot from DB ─────────────────────────────────────────────
  _rebuild() {
    const roundRow = this._db.prepare("SELECT value FROM config WHERE key='current_round'").get()
    const round = roundRow ? parseInt(roundRow.value, 10) : 0

    // Check if there are any ticks at all
    const anyTick = this._db.prepare('SELECT id FROM ticks LIMIT 1').get()

    if (!anyTick) {
      // First run — seed default snapshot
      this._snapshot = {
        round,
        running: false,
        agents: {
          ALPHA: _defaultAgent('ALPHA'),
          BETA:  _defaultAgent('BETA'),
          GAMMA: _defaultAgent('GAMMA')
        },
        priceHistory: Object.fromEntries(C.PAIRS.map(p => [p, []])),
        lastSignals:  [],
        lastEventId:  0
      }
      return
    }

    // ── Replay from DB ────────────────────────────────────────────────────
    const agents = {}
    for (const name of ['ALPHA', 'BETA', 'GAMMA']) {
      const agent = _defaultAgent(name)

      // a. Replay all TRADE ticks to reconstruct capital + holdings
      const tradeTicks = this._db.prepare(
        "SELECT * FROM ticks WHERE agent=? AND type='TRADE' ORDER BY id ASC"
      ).all(name)

      for (const row of tradeTicks) {
        const t = JSON.parse(row.payload)
        if (t.action === 'BUY') {
          const cost = t.qty * t.price * (1 + C.SLIPPAGE_PCT)
          agent.capital -= cost
          agent.holdings[t.pair] = (agent.holdings[t.pair] || 0) + t.qty
          agent.entryPrices[t.pair] = t.price
          agent.entryRounds[t.pair] = row.round
        } else if (t.action === 'SELL') {
          const proceeds = t.qty * t.price * (1 - C.SLIPPAGE_PCT)
          agent.capital += proceeds
          agent.holdings[t.pair] = (agent.holdings[t.pair] || 0) - t.qty
          if (agent.holdings[t.pair] <= 1e-10) {
            delete agent.holdings[t.pair]
            delete agent.entryPrices[t.pair]
            delete agent.entryRounds[t.pair]
          }
        }
        // Use capital_after from trade record if available for accuracy
        if (t.capital_after !== undefined) agent.capital = t.capital_after
      }

      // b. Read last DECISION tick → personality
      const lastDecision = this._db.prepare(
        "SELECT payload FROM ticks WHERE agent=? AND type='DECISION' ORDER BY id DESC LIMIT 1"
      ).get(name)
      if (lastDecision) {
        const d = JSON.parse(lastDecision.payload)
        if (d.personality) agent.personality = d.personality
      }

      // c. Read SURVIVAL ticks → threatened / alive / respawnCount
      const survivalTicks = this._db.prepare(
        "SELECT * FROM ticks WHERE agent=? AND type='SURVIVAL' ORDER BY id ASC"
      ).all(name)

      let lastRespawnId = -1
      for (const row of survivalTicks) {
        const s = JSON.parse(row.payload)
        const et = s.event_type
        if (et === 'AUTO_RESPAWN' || (et === 'MASTER_CMD' && s.new_status === 'alive')) {
          agent.alive = true
          agent.threatened = false
          agent.respawnCount++
          lastRespawnId = row.id
        } else if (et === 'AUTO_ELIMINATE' || (et === 'MASTER_CMD' && s.new_status === 'eliminated')) {
          if (row.id > lastRespawnId) agent.alive = false
        } else if (et === 'AUTO_THREATEN' || (et === 'MASTER_CMD' && s.new_status === 'threatened')) {
          agent.threatened = true
        } else if (et === 'MASTER_CMD' && s.new_status === 'safe') {
          agent.threatened = false
        }
        if (s.consecutiveLastPlace !== undefined) {
          agent.consecutiveLastPlace = s.consecutiveLastPlace
        }
      }

      // e. If ELIMINATE found after last respawn, mark dead
      // (handled above in the survival loop)

      // Rebuild portfolioHistory from TRADE ticks grouped by round
      const roundValues = {}
      for (const row of tradeTicks) {
        const t = JSON.parse(row.payload)
        if (t.capital_after !== undefined) {
          roundValues[row.round] = t.capital_after
        }
      }
      if (Object.keys(roundValues).length > 0) {
        agent.portfolioHistory = [C.INITIAL_CAPITAL, ...Object.keys(roundValues).sort((a,b)=>a-b).map(r => roundValues[r])]
      }

      agents[name] = agent
    }

    // d. Rebuild priceHistory from PRICE ticks (last 50 per pair)
    const priceHistory = Object.fromEntries(C.PAIRS.map(p => [p, []]))
    const priceTicks = this._db.prepare(
      "SELECT payload FROM ticks WHERE type='PRICE' ORDER BY id DESC LIMIT 50"
    ).all().reverse()

    for (const row of priceTicks) {
      const prices = JSON.parse(row.payload)
      for (const pair of C.PAIRS) {
        if (prices[pair] !== undefined) priceHistory[pair].push(prices[pair])
      }
    }

    // Last event id
    const lastEvent = this._db.prepare('SELECT id FROM ticks ORDER BY id DESC LIMIT 1').get()

    this._snapshot = {
      round,
      running: false,
      agents,
      priceHistory,
      lastSignals:  [],
      lastEventId:  lastEvent ? lastEvent.id : 0
    }
  }

  // ── Read methods ─────────────────────────────────────────────────────────
  getSnapshot() {
    return JSON.parse(JSON.stringify(this._snapshot))
  }

  getPriceHistory() {
    return this._snapshot.priceHistory
  }

  getAgent(name) {
    return this._snapshot.agents[name]
  }

  getPromptContext(agentName, signals, currentPrices) {
    const agent    = this._snapshot.agents[agentName]
    const archetype = C.ARCHETYPES[agentName]

    // ── Memory: last 10 decisions with explicit win/loss ─────────────────────
    const rawDecisions = this.getRecentTicks(10, 'DECISION')
      .filter(t => t.agent === agentName)

    const memory = rawDecisions.map(t => {
      const d         = t.payload
      const priceNow  = currentPrices[d.pair]
      const priceThen = d.price_at_decision
      const movePct   = priceThen ? ((priceNow - priceThen) / priceThen * 100) : null
      const win       = movePct == null ? null
                      : d.action === 'BUY'  ? movePct > 0
                      : d.action === 'SELL' ? movePct < 0
                      : null
      const moveStr   = movePct != null ? `${movePct > 0 ? '+' : ''}${movePct.toFixed(2)}%` : 'n/a'
      const outcome   = d.action === 'BUY'  ? `price ${moveStr} since entry [${win ? 'WIN' : 'LOSS'}]`
                      : d.action === 'SELL' ? `price moved ${moveStr} after exit [${win ? 'WIN' : 'LOSS'}]`
                      : 'held'
      return {
        round:       t.round,
        action:      d.action,
        pair:        C.LABELS[d.pair] || d.pair,
        pairRaw:     d.pair,
        amount:      d.amount_usd,
        outcome,
        win,
        signalScore: d.signal_score,
        reasoning:   d.reasoning
      }
    })

    // ── Losing streak: consecutive losses from most recent ───────────────────
    let losingStreak = 0
    for (const m of memory) {
      if (m.win === false) losingStreak++
      else if (m.win === true) break
    }

    // ── Per-pair win rate from last 20 decisions ──────────────────────────────
    const statsRaw = this.getRecentTicks(20, 'DECISION')
      .filter(t => t.agent === agentName)
    const pairMap = {}
    for (const t of statsRaw) {
      const d = t.payload
      if (d.action === 'HOLD') continue
      const priceNow  = currentPrices[d.pair]
      const priceThen = d.price_at_decision
      const movePct   = priceThen ? (priceNow - priceThen) / priceThen * 100 : 0
      const win       = d.action === 'BUY' ? movePct > 0 : movePct < 0
      if (!pairMap[d.pair]) pairMap[d.pair] = { wins: 0, total: 0, winPnl: 0, lossPnl: 0 }
      pairMap[d.pair].wins  += win ? 1 : 0
      pairMap[d.pair].total += 1
      if (win) pairMap[d.pair].winPnl  += Math.abs(movePct)
      else     pairMap[d.pair].lossPnl += Math.abs(movePct)
    }
    const pairPerformance = Object.entries(pairMap)
      .filter(([, s]) => s.total >= 2)
      .map(([pair, s]) => {
        const losses = s.total - s.wins
        return {
          rawPair: pair,
          pair:    C.LABELS[pair] || pair,
          winRate: Math.round(s.wins / s.total * 100),
          trades:  s.total,
          avgWin:  s.wins   > 0 ? s.winPnl  / s.wins   : 0,
          avgLoss: losses   > 0 ? s.lossPnl / losses   : 0,
        }
      })
      .sort((a, b) => a.winRate - b.winRate)

    // ── Rivals: last 3 actions each ───────────────────────────────────────────
    const rivals = Object.values(this._snapshot.agents)
      .filter(a => a.name !== agentName && a.alive)
      .map(a => {
        const recentActions = this.getRecentTicks(3, 'DECISION')
          .filter(t => t.agent === a.name)
          .map(t => t.payload.action)
        return {
          name:          a.name,
          archetype:     a.archetype,
          totalValue:    _totalValue(a, currentPrices),
          pnlPct:        ((_totalValue(a, currentPrices) - C.INITIAL_CAPITAL) / C.INITIAL_CAPITAL * 100).toFixed(1),
          survivalScore: a.survivalScore,
          holdings:      Object.entries(a.holdings)
                           .filter(([, q]) => q > 0)
                           .map(([p]) => C.LABELS[p]).join(', ') || 'none',
          recentActions
        }
      })

    return {
      agentName,
      round:               this._snapshot.round,
      archetype:           archetype.label,
      archetypeConstraint: archetype.constraint,
      capital:             agent.capital,
      holdings:            agent.holdings,
      entryPrices:         agent.entryPrices,
      entryRounds:         agent.entryRounds,
      totalValue:          _totalValue(agent, currentPrices),
      survivalScore:       agent.survivalScore,
      respawnCount:        agent.respawnCount,
      threatened:          agent.threatened,
      personality:         agent.personality,
      signals,
      currentPrices,
      memory,
      losingStreak,
      pairPerformance,
      rivals,
      config: {
        cullEvery:       C.CULL_EVERY_N_ROUNDS,
        cullThreshold:   C.LAST_PLACE_CULL_THRESHOLD,
        bankruptcyFloor: C.BANKRUPTCY_FLOOR,
        underperformGap: C.UNDERPERFORM_GAP_PCT * 100
      }
    }
  }

  getRecentTicks(limit, type) {
    limit = parseInt(limit, 10) || 100
    let rows
    if (type) {
      rows = this._db.prepare(
        'SELECT * FROM ticks WHERE type=? ORDER BY id DESC LIMIT ?'
      ).all(type, limit)
    } else {
      rows = this._db.prepare(
        'SELECT * FROM ticks ORDER BY id DESC LIMIT ?'
      ).all(limit)
    }
    return rows.map(r => ({ ...r, payload: JSON.parse(r.payload) }))
  }

  // ── Write methods ────────────────────────────────────────────────────────
  updatePrices(priceMap) {
    // Update rolling priceHistory (max 50 per pair)
    for (const pair of C.PAIRS) {
      if (priceMap[pair] !== undefined) {
        const hist = this._snapshot.priceHistory[pair]
        hist.push(priceMap[pair])
        if (hist.length > 50) hist.shift()
      }
    }

    // Log PRICE tick to DB
    const row = this._db.prepare(
      'INSERT INTO ticks(ts, round, type, agent, payload) VALUES(?,?,?,?,?)'
    ).run(Date.now(), this._snapshot.round, 'PRICE', null, JSON.stringify(priceMap))

    this._snapshot.lastEventId = row.lastInsertRowid
    this._lastPrices = { ...priceMap }
  }

  applyDecision(agentName, decision, currentPrices) {
    const agent = this._snapshot.agents[agentName]
    if (!agent || !agent.alive) return null

    // Enforce risk limits
    decision = this._enforceRisk(agentName, decision, currentPrices)

    const price = currentPrices[decision.pair]
    let trade = null

    if (decision.action === 'BUY' && decision.amount_usd > 0 && price) {
      // Fill at ask: mid + half-spread; fee on trade value
      const halfSpread = _pairSpread(decision.pair)
      const askPrice   = price * (1 + halfSpread)
      const qty        = decision.amount_usd / askPrice
      const cost       = decision.amount_usd * (1 + C.TAKER_FEE_PCT)

      agent.capital -= cost
      agent.holdings[decision.pair] = (agent.holdings[decision.pair] || 0) + qty
      agent.entryPrices[decision.pair] = askPrice   // entry tracked at ask
      agent.entryRounds[decision.pair] = this._snapshot.round

      trade = {
        action: 'BUY',
        pair:   decision.pair,
        qty,
        price,
        proceeds_or_cost: cost,
        capital_after:    agent.capital
      }
    } else if (decision.action === 'SELL' && price) {
      const qty = decision.amount_usd > 0
        ? Math.min(decision.amount_usd / price, agent.holdings[decision.pair] || 0)
        : (agent.holdings[decision.pair] || 0)

      if (qty > 0) {
        // Fill at bid: mid − half-spread; fee deducted from proceeds
        const halfSpread = _pairSpread(decision.pair)
        const bidPrice   = price * (1 - halfSpread)
        const proceeds   = qty * bidPrice * (1 - C.TAKER_FEE_PCT)

        agent.capital += proceeds
        agent.holdings[decision.pair] = (agent.holdings[decision.pair] || 0) - qty
        if (agent.holdings[decision.pair] <= 1e-10) {
          delete agent.holdings[decision.pair]
          delete agent.entryPrices[decision.pair]
          delete agent.entryRounds[decision.pair]
        }

        trade = {
          action: 'SELL',
          pair:   decision.pair,
          qty,
          price,
          proceeds_or_cost: proceeds,
          capital_after:    agent.capital
        }
        if (decision.enforced_reason) trade.enforced_reason = decision.enforced_reason
      }
    }

    // Log DECISION tick
    const decisionPayload = {
      action:             decision.action,
      pair:               decision.pair,
      amount_usd:         decision.amount_usd,
      reasoning:          decision.reasoning || '',
      personality:        decision.personality || '',
      signal_score:       decision.signal_score || null,
      portfolio_before:   _totalValue(agent, currentPrices),
      price_at_decision:  price || null
    }
    if (decision.enforced_reason) decisionPayload.enforced_reason = decision.enforced_reason

    const decRow = this._db.prepare(
      'INSERT INTO ticks(ts, round, type, agent, payload) VALUES(?,?,?,?,?)'
    ).run(Date.now(), this._snapshot.round, 'DECISION', agentName, JSON.stringify(decisionPayload))

    this._snapshot.lastEventId = decRow.lastInsertRowid

    if (decision.personality) agent.personality = decision.personality

    // Log TRADE tick if a trade happened
    if (trade) {
      const tradeRow = this._db.prepare(
        'INSERT INTO ticks(ts, round, type, agent, payload) VALUES(?,?,?,?,?)'
      ).run(Date.now(), this._snapshot.round, 'TRADE', agentName, JSON.stringify(trade))
      this._snapshot.lastEventId = tradeRow.lastInsertRowid
    }

    return { decision, trade }
  }

  endTick(signals) {
    const currentPrices = this._lastPrices

    // Log SIGNAL ticks
    for (const sig of signals) {
      this._db.prepare(
        'INSERT INTO ticks(ts, round, type, agent, payload) VALUES(?,?,?,?,?)'
      ).run(Date.now(), this._snapshot.round, 'SIGNAL', null, JSON.stringify(sig))
    }
    this._snapshot.lastSignals = signals

    // Stop-loss scan
    this._scanStopLosses(currentPrices)

    // Survival checks
    this._runSurvivalChecks(this._snapshot.round)

    // Update survival scores + portfolioHistory
    for (const [name, agent] of Object.entries(this._snapshot.agents)) {
      if (!agent.alive) continue
      agent.survivalScore = this._computeSurvivalScore(name, currentPrices)
      agent.portfolioHistory.push(_totalValue(agent, currentPrices))
    }

    // Increment round
    this._snapshot.round++
    this._db.prepare("INSERT OR REPLACE INTO config(key,value) VALUES('current_round',?)")
      .run(String(this._snapshot.round))
  }

  applyCommand(command) {
    const { command: cmd, agent: agentName, params } = command

    if (cmd === 'threaten' && agentName) {
      return this._threatenAgent(agentName, 'MASTER_CMD')
    }
    if (cmd === 'remove_threat' && agentName) {
      const agent = this._snapshot.agents[agentName]
      if (!agent) return { ok: false, message: `Unknown agent: ${agentName}` }
      agent.threatened = false
      this._logSurvival(agentName, { event_type: 'MASTER_CMD', reason: 'remove_threat', new_status: 'safe' })
      return { ok: true, message: `Threat removed from ${agentName}` }
    }
    if (cmd === 'terminate' && agentName) {
      const sub = params && params.action
      if (sub === 'eliminate') return this._eliminateAgent(agentName, 'MASTER_CMD')
      if (sub === 'respawn')   return this._respawnAgent(agentName, 'MASTER_CMD')
      if (sub === 'replace')   return this._respawnAgent(agentName, 'MASTER_CMD')
      return { ok: false, message: 'terminate requires params.action: eliminate|respawn|replace' }
    }
    if (cmd === 'set_interval') {
      // handled in engine.js
      return { ok: true, message: 'interval set' }
    }
    return { ok: false, message: `Unknown command: ${cmd}` }
  }

  // ── Private helpers ──────────────────────────────────────────────────────
  _enforceRisk(agentName, decision, currentPrices) {
    const agent = this._snapshot.agents[agentName]
    const total = _totalValue(agent, currentPrices)

    if (decision.action === 'BUY') {
      decision.amount_usd = Math.min(decision.amount_usd, agent.capital * 0.95)
      decision.amount_usd = Math.min(decision.amount_usd, total * C.MAX_POSITION_PCT)

      // Volume-based limit: cap trade at MAX_TRADE_VOLUME_PCT of 20h USD volume
      const sig = this._snapshot.lastSignals.find(s => s.pair === decision.pair)
      if (sig?.vol_usd_20h > 0) {
        decision.amount_usd = Math.min(decision.amount_usd, sig.vol_usd_20h * C.MAX_TRADE_VOLUME_PCT)
      }

      const invested = total - agent.capital
      if (total > 0 && invested / total >= C.MAX_EXPOSURE_PCT) {
        return { ...decision, action: 'HOLD', amount_usd: 0, enforced_reason: 'max_exposure' }
      }
    }

    if (agentName === 'GAMMA') {
      const cfg      = C.STRATEGY.GAMMA
      const positions = Object.values(agent.holdings).filter(q => q > 0).length
      if (decision.action === 'BUY' && positions >= cfg.max_positions) {
        return { ...decision, action: 'HOLD', amount_usd: 0, enforced_reason: 'gamma_pos_limit' }
      }
      if (decision.action === 'BUY' && total > 0 && agent.capital / total < cfg.cash_min_pct) {
        return { ...decision, action: 'HOLD', amount_usd: 0, enforced_reason: 'gamma_cash_floor' }
      }
    }

    return decision
  }

  _scanStopLosses(currentPrices) {
    for (const [name, agent] of Object.entries(this._snapshot.agents)) {
      if (!agent.alive) continue
      for (const [pair, qty] of Object.entries(agent.holdings)) {
        if (qty <= 0) continue
        const entry = agent.entryPrices[pair]
        const now   = currentPrices[pair]
        if (entry && now && now < entry * (1 - C.STOP_LOSS_PCT)) {
          this.applyDecision(name,
            { action: 'SELL', pair, amount_usd: 0, enforced_reason: 'stop_loss' },
            currentPrices)
        }
      }
    }
  }

  _runSurvivalChecks(round) {
    const alive = Object.values(this._snapshot.agents).filter(a => a.alive)

    // Rule 1 — Bankruptcy
    for (const agent of alive) {
      if (_totalValue(agent, this._lastPrices) < C.BANKRUPTCY_FLOOR) {
        this._respawnAgent(agent.name, 'bankruptcy')
      }
    }

    // Rule 2 — Periodic cull
    if (round > 0 && round % C.CULL_EVERY_N_ROUNDS === 0) {
      const ranked = [...alive].sort((a, b) => a.survivalScore - b.survivalScore)
      const last   = ranked[0]
      last.consecutiveLastPlace++
      if (last.consecutiveLastPlace >= C.LAST_PLACE_CULL_THRESHOLD) {
        this._eliminateAgent(last.name, 'persistent_last_place')
      } else {
        this._threatenAgent(last.name, 'last_place')
      }
    }

    // Rule 3 — Underperformance gap (after round 20)
    if (round >= C.UNDERPERFORM_MIN_ROUND) {
      const aliveNow = Object.values(this._snapshot.agents).filter(a => a.alive)
      const maxVal   = Math.max(...aliveNow.map(a => _totalValue(a, this._lastPrices)))
      for (const agent of aliveNow) {
        if (_totalValue(agent, this._lastPrices) < maxVal * (1 - C.UNDERPERFORM_GAP_PCT)) {
          if (!agent.threatened) this._threatenAgent(agent.name, 'underperformance_gap')
        }
      }
    }

    // Rule 4 — Auto-clear threat for agents that have recovered
    const aliveAll = Object.values(this._snapshot.agents).filter(a => a.alive)
    if (aliveAll.length > 1) {
      const maxVal      = Math.max(...aliveAll.map(a => _totalValue(a, this._lastPrices)))
      const rankedAsc   = [...aliveAll].sort((a, b) => _totalValue(a, this._lastPrices) - _totalValue(b, this._lastPrices))
      const lastPlace   = rankedAsc[0].name
      for (const agent of aliveAll) {
        if (!agent.threatened) continue
        const val            = _totalValue(agent, this._lastPrices)
        const isLastPlace    = agent.name === lastPlace
        const isUnderperform = val < maxVal * (1 - C.UNDERPERFORM_GAP_PCT)
        if (!isLastPlace && !isUnderperform) {
          agent.threatened = false
          this._logSurvival(agent.name, { event_type: 'AUTO_CLEAR_THREAT', reason: 'recovered', new_status: 'safe' })
        }
      }
    }
  }

  _computeSurvivalScore(agentName, currentPrices) {
    const ss = require('simple-statistics')
    const agent   = this._snapshot.agents[agentName]
    const hist    = agent.portfolioHistory.slice(-10)
    const returns = hist.slice(1).map((v, i) => (v - hist[i]) / hist[i])

    const totalVal = _totalValue(agent, currentPrices)
    const pnlScore = (totalVal - C.INITIAL_CAPITAL) / C.INITIAL_CAPITAL

    const consistency = returns.length > 1
      ? Math.max(0, 1 - ss.standardDeviation(returns) * 10)
      : 0.5

    const adaptation  = this._didAdapt(agentName)
    const drawdown    = _maxDrawdown(hist)
    const riskPenalty = Math.max(0, drawdown - 0.10)

    let score = pnlScore * 0.50 + consistency * 0.25 + adaptation * 0.15 - riskPenalty * 0.10

    const archetype = C.ARCHETYPES[agentName].survivalBonus
    if (archetype === 'momentum'   && this._isBuyingMomentum(agentName))       score += 0.05
    if (archetype === 'divergence' && this._isDivergentFromRivals(agentName))  score += 0.05
    if (archetype === 'stability'  && drawdown < 0.05)                         score += 0.05

    return Math.max(-1, Math.min(2, score))
  }

  _didAdapt(agentName) {
    const recent = this._db.prepare(
      "SELECT payload FROM ticks WHERE agent=? AND type='DECISION' ORDER BY id DESC LIMIT 10"
    ).all(agentName).map(r => JSON.parse(r.payload))

    if (recent.length < 6) return 0
    const first  = recent.slice(5)
    const second = recent.slice(0, 5)
    const dominant = arr => {
      const counts = { BUY: 0, SELL: 0, HOLD: 0 }
      arr.forEach(d => { if (counts[d.action] !== undefined) counts[d.action]++ })
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    }
    return dominant(first) !== dominant(second) ? 0.2 : 0
  }

  _isBuyingMomentum(agentName) {
    const recent = this._db.prepare(
      "SELECT payload FROM ticks WHERE agent=? AND type='DECISION' ORDER BY id DESC LIMIT 5"
    ).all(agentName).map(r => JSON.parse(r.payload))
    if (!recent.length) return false
    const buys = recent.filter(d => d.action === 'BUY' && d.signal_score > 0.3)
    return buys.length === recent.length
  }

  _isDivergentFromRivals(agentName) {
    const agent  = this._snapshot.agents[agentName]
    const rivals = Object.values(this._snapshot.agents).filter(a => a.name !== agentName && a.alive)
    const myPairs    = new Set(Object.keys(agent.holdings).filter(p => agent.holdings[p] > 0))
    const rivalPairs = new Set(
      rivals.flatMap(r => Object.keys(r.holdings).filter(p => r.holdings[p] > 0))
    )
    let shared = 0
    for (const p of myPairs) { if (rivalPairs.has(p)) shared++ }
    return shared < 1
  }

  _logSurvival(agentName, payload) {
    const row = this._db.prepare(
      'INSERT INTO ticks(ts, round, type, agent, payload) VALUES(?,?,?,?,?)'
    ).run(Date.now(), this._snapshot.round, 'SURVIVAL', agentName, JSON.stringify(payload))
    this._snapshot.lastEventId = row.lastInsertRowid
  }

  _threatenAgent(agentName, reason) {
    const agent = this._snapshot.agents[agentName]
    if (!agent) return { ok: false, message: `Unknown agent: ${agentName}` }
    agent.threatened = true
    this._logSurvival(agentName, { event_type: 'AUTO_THREATEN', reason, new_status: 'threatened' })
    return { ok: true, message: `${agentName} threatened: ${reason}` }
  }

  _eliminateAgent(agentName, reason) {
    const agent = this._snapshot.agents[agentName]
    if (!agent) return { ok: false, message: `Unknown agent: ${agentName}` }
    agent.alive     = false
    agent.threatened = false
    this._logSurvival(agentName, { event_type: 'AUTO_ELIMINATE', reason, new_status: 'eliminated' })
    return { ok: true, message: `${agentName} eliminated: ${reason}` }
  }

  _respawnAgent(agentName, reason) {
    const agent = this._snapshot.agents[agentName]
    if (!agent) return { ok: false, message: `Unknown agent: ${agentName}` }
    const totalPortfolio = Object.values(this._snapshot.agents)
      .reduce((s, a) => s + _totalValue(a, this._lastPrices), 0)
    const respawnCapital = Math.max(totalPortfolio * 0.3, C.BANKRUPTCY_FLOOR * 2)
    agent.alive              = true
    agent.threatened         = false
    agent.capital            = respawnCapital
    agent.holdings           = {}
    agent.entryPrices        = {}
    agent.entryRounds        = {}
    agent.consecutiveLastPlace = 0
    agent.respawnCount++
    agent.portfolioHistory.push(agent.capital)
    this._logSurvival(agentName, {
      event_type: 'AUTO_RESPAWN',
      reason,
      new_status:      'alive',
      respawn_capital: agent.capital
    })
    return { ok: true, message: `${agentName} respawned at $${agent.capital.toFixed(2)}` }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────
function _maxDrawdown(portfolioValues) {
  let peak = -Infinity, maxDD = 0
  for (const v of portfolioValues) {
    if (v > peak) peak = v
    const dd = peak > 0 ? (peak - v) / peak : 0
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}

module.exports = World
module.exports.C = C
module.exports.pairSpread = _pairSpread
