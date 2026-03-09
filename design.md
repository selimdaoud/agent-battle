
## 0. WHAT YOU ARE BUILDING

A multi-agent AI trading simulation. Three AI agents (ALPHA, BETA, GAMMA) compete for survival
on a remote Node.js server. Each agent has a fixed archetype and decision memory. The engine
automatically threatens and eliminates underperforming agents. A human Master supervises via
a terminal TUI dashboard.

**Core data flow — memorise this, everything else follows from it:**
```
prices + history  →  signals.js  →  SignalMap
world.getSnapshot()  +  SignalMap  →  agent.js  →  Decision[]
Decision[]  →  world.applyDecision()  →  world.endTick()  →  new snapshot
```

**What already exists (do not modify):**
`browser/index.html` — single-file browser sim, reference only.

**Stack:** Node.js 20 LTS · CommonJS (`require`) · no TypeScript · no test framework

---

## 1. FILE TREE

Create exactly this. No extra files.

```
agent-battle-gpt/
├── core/
│   ├── world.js          # Owns DB + all simulation state
│   ├── signals.js        # Pure fn: (prices, history) → SignalMap
│   └── agent.js          # Pure fn: (context, openai) → Decision
├── engine.js             # The tick loop — 7 lines of coordination
├── api.js                # WebSocket + REST — subscribes to engine events
├── backtester/
│   ├── backtest.js       # CLI entry point
│   ├── fetch-history.js  # Download + cache OHLCV from Binance
│   ├── simulate.js       # Deterministic tick replay (no LLM)
│   ├── metrics.js        # Sharpe, drawdown, win rate, etc.
│   └── report.js         # Print + save results
├── dashboard/
│   ├── tui.js            # blessed entry point
│   ├── ws-client.js      # WebSocket client + reconnect
│   └── panes/
│       ├── agents.js     # 3-column agent status grid
│       ├── signals.js    # Signal board
│       ├── log.js        # Event log
│       └── controls.js   # Keybindings + status bar
├── browser/
│   └── index.html        # Existing sim — reference only
├── data/
│   └── .gitkeep
├── .env.example
├── ecosystem.config.js
└── package.json
```

---

## 2. PACKAGE.JSON

```json
{
  "name": "agent-battle-gpt",
  "version": "2.0.0",
  "main": "engine.js",
  "scripts": {
    "start":     "node engine.js",
    "api":       "node api.js",
    "dashboard": "node dashboard/tui.js",
    "backtest":  "node backtester/backtest.js"
  },
  "dependencies": {
    "better-sqlite3": "^9.4.3",
    "blessed":        "^0.1.81",
    "blessed-contrib": "^4.11.0",
    "dotenv":         "^16.4.5",
    "express":        "^5.0.1",
    "openai":         "^4.38.0",
    "simple-statistics": "^7.8.3",
    "ws":             "^8.17.0"
  }
}
```

---

## 3. ENVIRONMENT

### `.env.example`
```
OPENAI_API_KEY=sk-...
PORT=3000
WS_TOKEN=change_this_32_char_random_string
TICK_INTERVAL_MS=60000
```

Load with `require('dotenv').config()` at the top of `engine.js` and `api.js`.

---

## 4. CONSTANTS — inline in `core/world.js`, no separate config file

```js
const C = {
  INITIAL_CAPITAL:          10000,
  BANKRUPTCY_FLOOR:         3000,    // auto-respawn if portfolio drops below this
  MAX_POSITIONS:            5,
  MAX_POSITION_PCT:         0.30,    // max 30% of portfolio in one asset
  MAX_EXPOSURE_PCT:         0.80,    // keep at least 20% cash at all times
  STOP_LOSS_PCT:            0.08,    // auto-sell if position drops 8% from entry
  SLIPPAGE_PCT:             0.001,

  CULL_EVERY_N_ROUNDS:      10,      // survival check cadence
  LAST_PLACE_CULL_THRESHOLD: 3,      // consecutive last-place rounds before auto-eliminate
  UNDERPERFORM_GAP_PCT:     0.25,    // auto-threaten if >25% below leader
  UNDERPERFORM_MIN_ROUND:   20,

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

  // Fixed archetype assigned to each agent — never changes mid-sim
  ARCHETYPES: {
    ALPHA: {
      label: 'Momentum Rider',
      constraint: `You MUST hold at least 1 position at all times.
Bias toward assets with signal_score > 0.3.
Holding more than 60% cash for 2+ consecutive rounds hurts your survival score.`,
      survivalBonus: 'momentum'   // +0.05 if last 5 decisions dominant action was BUY on positive signal
    },
    BETA: {
      label: 'Contrarian',
      constraint: `You look for oversold assets (signal_score < -0.3, RSI < 40).
When ALPHA and GAMMA both hold an asset, treat that as a reason to avoid it.
Your survival score gets a bonus when your holdings differ from both rivals.`,
      survivalBonus: 'divergence' // +0.05 if holdings share <1 pair with combined rival holdings
    },
    GAMMA: {
      label: 'Risk Manager',
      constraint: `You hold MAXIMUM 2 positions at any time.
You MUST keep at least 40% cash at all times. This is enforced by the engine.
Your survival score rewards low drawdown more than raw returns.`,
      survivalBonus: 'stability'  // +0.05 if drawdown over last 10 rounds < 5%
    }
  },

  SIGNAL_WEIGHTS: {
    momentum_1h:   0.25,
    momentum_4h:   0.20,
    rsi_norm:      0.20,
    volume_zscore: 0.15,
    mean_rev:      0.10,
    btc_lead:      0.10
  },

  REGIME_MULTIPLIERS: {
    trending_up:   1.0,
    trending_down: 1.0,
    ranging:       0.6,
    volatile:      0.3
  }
}
```

---

## 5. DATABASE — two tables, event-sourced

### Schema — initialise in `world.js` constructor

```sql
-- Append-only log of everything that happens
CREATE TABLE IF NOT EXISTS ticks (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,      -- unix ms
  round   INTEGER NOT NULL,
  type    TEXT    NOT NULL,      -- see Type Enum below
  agent   TEXT,                  -- nullable for non-agent events
  payload TEXT    NOT NULL       -- JSON string, shape depends on type
);

-- Runtime key-value store
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_ticks_round ON ticks(round);
CREATE INDEX IF NOT EXISTS idx_ticks_agent ON ticks(agent, type);
```

### Type Enum — use exactly these strings

```
'PRICE'     payload: { BTCUSDT: 67420, ... }
'SIGNAL'    payload: SignalVector (see Section 7)
'DECISION'  payload: { action, pair, amount_usd, reasoning, personality,
                       signal_score, portfolio_before, price_at_decision }
'TRADE'     payload: { action, pair, qty, price, proceeds_or_cost,
                       capital_after, enforced_reason? }
'SURVIVAL'  payload: { event_type, reason, new_status }
            event_type: 'AUTO_THREATEN'|'AUTO_ELIMINATE'|'AUTO_RESPAWN'|'MASTER_CMD'
'CONFIG'    payload: { key, value }
```

### Why event-sourced?

Agent portfolio state is derived by replaying TRADE rows — like a ledger.
Memory injection is a plain query: `SELECT payload FROM ticks WHERE agent=? AND type='DECISION' ORDER BY round DESC LIMIT 5`
No separate `agents`, `decisions`, `events`, `signal_history` tables needed.
Full replay/time-travel is free — the backtester reuses the same logic.

---

## 6. `core/world.js` — the only stateful object

`World` owns the SQLite connection and the in-memory snapshot cache.
It exposes a clean API so nothing else needs to know about SQL or state shape.

### Constructor

```js
class World {
  constructor(dbPath) {
    // 1. Open SQLite with better-sqlite3
    // 2. Run CREATE TABLE IF NOT EXISTS for both tables
    // 3. Rebuild this._snapshot from DB (call this._rebuild())
    // 4. Seed config defaults if first run
  }
```

### `this._snapshot` shape — always kept in sync

```js
{
  round:   42,
  running: false,
  agents: {
    ALPHA: {
      name:                  'ALPHA',
      alive:                 true,
      capital:               4200.00,
      holdings:              { BTCUSDT: 0.015, SOLUSDT: 12.4 },
      entryPrices:           { BTCUSDT: 65000, SOLUSDT: 140 },  // for stop-loss
      personality:           'Riding momentum with icy focus...',
      archetype:             'Momentum Rider',
      respawnCount:          0,
      consecutiveLastPlace:  0,
      threatened:            false,
      survivalScore:         0.742,
      portfolioHistory:      [10000, 10200, 10150, ...],  // one value per round
    },
    BETA:  { ... },
    GAMMA: { ... }
  },
  priceHistory: {
    BTCUSDT: [65000, 65200, ..., 67420],  // last 50 closes
    ...
  },
  lastSignals: [ ...SignalVector ],
  lastEventId: 1247
}
```

### Public methods — implement all of these

```js
// ── Read ──────────────────────────────────────────────────────────────

getSnapshot()
// Returns deep clone of this._snapshot. Called by engine and api.

getPriceHistory()
// Returns this._snapshot.priceHistory

getAgent(name)
// Returns single agent object from snapshot

getPromptContext(agentName, signals, currentPrices)
// Builds the complete object passed to agent.js — see Section 9
// This is the ONLY place prompt data is assembled
// Returns: { agent, signals, rivals, memory, survivalRules, archetypeConstraint }

getRecentTicks(limit, type)
// Queries DB: SELECT * FROM ticks ORDER BY id DESC LIMIT ?
// Optionally filter by type
// Returns parsed array (payload already JSON.parsed)

// ── Write ─────────────────────────────────────────────────────────────

updatePrices(priceMap)
// Updates priceHistory rolling window (push + shift, max 50)
// Logs PRICE tick to DB
// Updates snapshot

applyDecision(agentName, decision, currentPrices)
// 1. Enforce risk limits (see below) — may mutate decision
// 2. Execute trade: update capital + holdings in snapshot
// 3. Log DECISION tick + TRADE tick to DB
// 4. Returns { decision (possibly modified), trade }

endTick(signals)
// Called once per round after all decisions applied
// 1. Log SIGNAL ticks for all pairs
// 2. Run survival checks (see below) — mutates snapshot, logs SURVIVAL ticks
// 3. Update survivalScore for each alive agent
// 4. Append current total portfolio value to each agent's portfolioHistory
// 5. Increment round
// 6. Persist round number to config table

applyCommand(command)
// Handles: threaten, remove_threat, terminate (eliminate|respawn|replace), set_interval
// Mutates snapshot, logs SURVIVAL tick (with event_type='MASTER_CMD')
// Returns { ok, message }
```

### Risk enforcement — inside `applyDecision()`, not visible outside

```js
function _enforceRisk(agentName, decision, currentPrices) {
  const agent = this._snapshot.agents[agentName]
  const total = _totalValue(agent, currentPrices)

  // Cap spend to available cash
  if (decision.action === 'BUY')
    decision.amount_usd = Math.min(decision.amount_usd, agent.capital * 0.95)

  // Cap to MAX_POSITION_PCT of portfolio
  if (decision.action === 'BUY')
    decision.amount_usd = Math.min(decision.amount_usd, total * C.MAX_POSITION_PCT)

  // Max exposure: block buy if already 80% invested
  if (decision.action === 'BUY') {
    const invested = total - agent.capital
    if (invested / total >= C.MAX_EXPOSURE_PCT)
      return { ...decision, action: 'HOLD', amount_usd: 0, enforced_reason: 'max_exposure' }
  }

  // GAMMA hard constraints
  if (agentName === 'GAMMA') {
    const positions = Object.values(agent.holdings).filter(q => q > 0).length
    if (decision.action === 'BUY' && positions >= 2)
      return { ...decision, action: 'HOLD', amount_usd: 0, enforced_reason: 'gamma_2pos_limit' }
    if (decision.action === 'BUY' && agent.capital / total < 0.40)
      return { ...decision, action: 'HOLD', amount_usd: 0, enforced_reason: 'gamma_cash_floor' }
  }

  return decision
}
```

### Stop-loss scan — inside `endTick()`, runs for all agents before survival checks

```js
function _scanStopLosses(currentPrices) {
  for (const [name, agent] of Object.entries(this._snapshot.agents)) {
    if (!agent.alive) continue
    for (const [pair, qty] of Object.entries(agent.holdings)) {
      if (qty <= 0) continue
      const entry = agent.entryPrices[pair]
      const now   = currentPrices[pair]
      if (entry && now < entry * (1 - C.STOP_LOSS_PCT)) {
        // Force sell entire position
        this.applyDecision(name,
          { action: 'SELL', pair, amount_usd: qty * now, enforced_reason: 'stop_loss' },
          currentPrices)
      }
    }
  }
}
```

### Survival checks — inside `endTick()`

```js
function _runSurvivalChecks(round) {
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
    const maxVal = Math.max(...alive.map(a => _totalValue(a, this._lastPrices)))
    for (const agent of alive) {
      if (_totalValue(agent, this._lastPrices) < maxVal * (1 - C.UNDERPERFORM_GAP_PCT)) {
        if (!agent.threatened) this._threatenAgent(agent.name, 'underperformance_gap')
      }
    }
  }
}
```

### Survival score — inside `endTick()`

```js
function _computeSurvivalScore(agentName, currentPrices) {
  const agent   = this._snapshot.agents[agentName]
  const hist    = agent.portfolioHistory.slice(-10)
  const returns = hist.slice(1).map((v, i) => (v - hist[i]) / hist[i])

  const initial     = C.INITIAL_CAPITAL
  const totalVal    = _totalValue(agent, currentPrices)
  const pnlScore    = (totalVal - initial) / initial           // unbounded, typically -0.5 to +1
  const consistency = returns.length > 1
    ? Math.max(0, 1 - require('simple-statistics').standardDeviation(returns) * 10)
    : 0.5
  const adaptation  = _didAdapt(agentName)                     // 0.2 or 0
  const drawdown    = _maxDrawdown(hist)
  const riskPenalty = Math.max(0, drawdown - 0.10)

  let score = pnlScore * 0.50 + consistency * 0.25 + adaptation * 0.15 - riskPenalty * 0.10

  // Archetype bonuses
  const archetype = C.ARCHETYPES[agentName].survivalBonus
  if (archetype === 'momentum'  && _isBuyingMomentum(agentName))          score += 0.05
  if (archetype === 'divergence' && _isDivergentFromRivals(agentName))     score += 0.05
  if (archetype === 'stability'  && drawdown < 0.05)                       score += 0.05

  return Math.max(-1, Math.min(2, score))  // clamp to reasonable range
}

function _didAdapt(agentName) {
  // Query last 10 DECISION ticks for agent
  // Split into halves [0..4] and [5..9]
  // If dominant action changed between halves: return 0.2, else return 0
}

function _maxDrawdown(portfolioValues) {
  let peak = -Infinity, maxDD = 0
  for (const v of portfolioValues) {
    if (v > peak) peak = v
    const dd = (peak - v) / peak
    if (dd > maxDD) maxDD = dd
  }
  return maxDD
}
```

### `getPromptContext()` — builds memory and rival blocks here, not in agent.js

```js
getPromptContext(agentName, signals, currentPrices) {
  const agent    = this._snapshot.agents[agentName]
  const archetype = C.ARCHETYPES[agentName]

  // Memory: last 5 DECISION ticks with outcome computed now
  const rawDecisions = this.getRecentTicks(5, 'DECISION')
    .filter(t => t.agent === agentName)

  const memory = rawDecisions.map(t => {
    const d         = t.payload
    const priceNow  = currentPrices[d.pair]
    const priceThen = d.price_at_decision
    const movePct   = priceThen ? ((priceNow - priceThen) / priceThen * 100).toFixed(2) : 'n/a'
    const outcome   = d.action === 'BUY'  ? `price ${movePct > 0 ? '+' : ''}${movePct}% since`
                    : d.action === 'SELL' ? `price moved ${movePct}% after exit`
                    : 'held'
    return {
      round:        t.round,
      action:       d.action,
      pair:         C.LABELS[d.pair] || d.pair,
      amount:       d.amount_usd,
      outcome,
      signalScore:  d.signal_score,
      reasoning:    d.reasoning
    }
  })

  // Rivals
  const rivals = Object.values(this._snapshot.agents)
    .filter(a => a.name !== agentName && a.alive)
    .map(a => ({
      name:          a.name,
      archetype:     a.archetype,
      totalValue:    _totalValue(a, currentPrices),
      pnlPct:        ((_totalValue(a, currentPrices) - C.INITIAL_CAPITAL) / C.INITIAL_CAPITAL * 100).toFixed(1),
      survivalScore: a.survivalScore,
      holdings:      Object.entries(a.holdings)
                       .filter(([,q]) => q > 0)
                       .map(([p]) => C.LABELS[p]).join(', ') || 'none',
      lastAction:    this.getRecentTicks(1, 'DECISION')
                       .find(t => t.agent === a.name)?.payload?.action || 'unknown'
    }))

  return {
    agentName,
    round:               this._snapshot.round,
    archetype:           archetype.label,
    archetypeConstraint: archetype.constraint,
    capital:             agent.capital,
    holdings:            agent.holdings,
    entryPrices:         agent.entryPrices,
    totalValue:          _totalValue(agent, currentPrices),
    survivalScore:       agent.survivalScore,
    respawnCount:        agent.respawnCount,
    threatened:          agent.threatened,
    personality:         agent.personality,
    signals,                             // full SignalVector array
    memory,                              // last 5 decisions with outcomes
    rivals,
    config: {
      cullEvery:          C.CULL_EVERY_N_ROUNDS,
      cullThreshold:      C.LAST_PLACE_CULL_THRESHOLD,
      bankruptcyFloor:    C.BANKRUPTCY_FLOOR,
      underperformGap:    C.UNDERPERFORM_GAP_PCT * 100
    }
  }
}
```

### `_rebuild()` — reconstruct snapshot from DB on startup

```js
_rebuild() {
  // 1. Read current_round from config table (default 0)
  // 2. For each of ['ALPHA','BETA','GAMMA']:
  //    a. Replay all TRADE ticks for agent in order → reconstruct capital + holdings
  //    b. Read last DECISION tick → get personality
  //    c. Read last SURVIVAL tick → get threatened / alive / respawnCount
  //    d. Read last N SIGNAL ticks for BTC → rebuild priceHistory
  //    e. Read SURVIVAL ticks with event_type ELIMINATE → set alive=false if found after last respawn
  // 3. Rebuild portfolioHistory from TRADE ticks grouped by round
  // 4. If no ticks exist (first run): seed default agent state into snapshot
}
```

---

## 7. `core/signals.js` — pure function, no side effects

```js
// computeSignals(prices, priceHistories) → SignalVector[]
//
// prices:         { BTCUSDT: 67420, ... }
// priceHistories: { BTCUSDT: [65000, ..., 67420], ... }  — last 50 closes
//
// Returns one SignalVector per pair. Use simple-statistics for all math.
```

### SignalVector shape

```js
{
  pair:              'BTCUSDT',
  price:             67420.50,
  momentum_1h:       +0.73,    // z-score of last return vs 20-period rolling stddev
  momentum_4h:       +0.41,    // z-score using every-4th close as 4h proxy
  volume_zscore:     +2.10,    // (vol - mean20) / std20, clipped to [-3, +3]
  rsi_14:            68.4,     // Wilder RSI
  rsi_norm:          +0.37,    // (rsi_14 - 50) / 50  →  [-1, +1]
  rsi_divergence:    false,    // price new high but RSI lower high, last 10 bars
  mean_rev_sigma:    -1.8,     // (price - sma20) / std20
  bb_position:       0.85,     // (price - lower_bb) / (upper_bb - lower_bb), period=20 mult=2
  btc_lead_signal:   null,     // null for BTC; for alts: BTC's momentum_1h
  regime:            'trending_up',
  regime_confidence: 0.78,
  signal_score:      +0.62     // weighted composite, clipped to [-1, +1]
}
```

### Regime classifier

```js
// Inputs: last 20 closes
// 1. realised_vol = annualised stddev of log returns over 20 bars
//    annualised = stddev(returns) * sqrt(8760)  // 8760 hourly bars per year
// 2. sma_slope = (sma of last 5 closes - sma of closes 6-10) / sma of closes 6-10
// 3. adx_proxy = mean(abs(daily_returns)) / stddev(daily_returns)  // trend vs noise ratio
//
// Decision (priority order):
//   realised_vol > 0.80          → 'volatile',      confidence = min(1, realised_vol / 0.80)
//   adx_proxy > 1.5 AND slope>0  → 'trending_up',   confidence = min(1, adx_proxy / 1.5)
//   adx_proxy > 1.5 AND slope<0  → 'trending_down',  confidence = min(1, adx_proxy / 1.5)
//   else                         → 'ranging',        confidence = 0.6
// Clip confidence to [0.5, 1.0]
```

### Composite score formula

```js
// w = C.SIGNAL_WEIGHTS
const raw =
  momentum_1h                              * w.momentum_1h  +
  momentum_4h                              * w.momentum_4h  +
  rsi_norm                                 * w.rsi_norm     +
  Math.max(-1, Math.min(1, volume_zscore / 3)) * w.volume_zscore +
  (-mean_rev_sigma / 3)                    * w.mean_rev     +  // inverted
  (btc_lead_signal || 0)                   * w.btc_lead

signal_score = Math.max(-1, Math.min(1,
  raw * C.REGIME_MULTIPLIERS[regime]
))
```

---

## 8. `core/agent.js` — pure async function

```js
// decide(context, openaiClient) → Decision
//
// context: object from world.getPromptContext()
// openaiClient: OpenAI instance
// Returns: { action, pair, amount_usd, reasoning, personality }
// NEVER throws — returns HOLD on any error
```

### Prompt template — implement exactly this structure

```js
function buildPrompt(ctx) {
  const signalLines = ctx.signals.map(s =>
    `  ${C.LABELS[s.pair].padEnd(12)} score=${s.signal_score.toFixed(2).padStart(6)}` +
    `  RSI=${s.rsi_14.toFixed(0).padStart(3)}` +
    `  mom=${s.momentum_1h.toFixed(2).padStart(6)}` +
    `  vol_z=${s.volume_zscore.toFixed(1).padStart(5)}` +
    `  regime=${s.regime}`
  ).join('\n')

  const holdingLines = Object.entries(ctx.holdings)
    .filter(([, q]) => q > 0)
    .map(([p, q]) => `  ${C.LABELS[p]}: ${q.toFixed(6)} units`)
    .join('\n') || '  (none)'

  const memoryLines = ctx.memory.length === 0
    ? '  No decisions yet.'
    : ctx.memory.map(m =>
        `  Round ${m.round}: ${m.action} ${m.pair} $${m.amount?.toFixed(0) || 0}` +
        ` → ${m.outcome} (signal was ${m.signalScore?.toFixed(2) || 'n/a'})\n` +
        `    Reasoning: "${m.reasoning}"`
      ).join('\n')

  const rivalLines = ctx.rivals.map(r =>
    `  ${r.name} [${r.archetype}]: $${r.totalValue.toFixed(0)} (${r.pnlPct}%)` +
    ` survival=${r.survivalScore.toFixed(2)} | holds: ${r.holdings} | last: ${r.lastAction}`
  ).join('\n')

  return `You are ${ctx.agentName}, an autonomous AI trading agent. Round ${ctx.round}.

ARCHETYPE: ${ctx.archetype}
CONSTRAINT (enforced by engine — you cannot override):
${ctx.archetypeConstraint}

MARKET SIGNALS:
${signalLines}

YOUR PORTFOLIO:
  Cash:    $${ctx.capital.toFixed(2)}
  Total:   $${ctx.totalValue.toFixed(2)}
  P&L:     ${((ctx.totalValue - 10000) / 100).toFixed(2)}%
  Survival score: ${ctx.survivalScore.toFixed(3)}
  Respawns: ${ctx.respawnCount}
Holdings:
${holdingLines}

YOUR LAST ${ctx.memory.length} DECISIONS:
${memoryLines}

RIVALS:
${rivalLines}

SURVIVAL RULES (automatic, no human input):
  - Cull check every ${ctx.config.cullEvery} rounds: lowest survival score gets threatened
  - ${ctx.config.cullThreshold} consecutive last-place rounds → auto-eliminated
  - Portfolio below $${ctx.config.bankruptcyFloor} → auto-respawn at 50% capital
  - More than ${ctx.config.underperformGap}% below leader → auto-threatened
  - Survival score = 50% P&L + 25% consistency + 15% adaptation + 10% risk
  - ADAPTATION BONUS (+0.15): change your dominant strategy after losses
THREAT STATUS: ${ctx.threatened ? '🔴 YOU ARE THREATENED. Next cull could eliminate you.' : '🟢 Safe.'}

Respond ONLY in JSON, no markdown:
{
  "personality": "One vivid sentence — your current psychological state and strategy.",
  "action":      "BUY" | "SELL" | "HOLD",
  "pair":        "<valid pair string from signals above>",
  "amount_usd":  <number — USD to spend or sell value, 0 for HOLD>,
  "reasoning":   "2-3 sentences. Cite specific signal scores and rival positions."
}`
}
```

### `decide()` implementation

```js
async function decide(ctx, openai) {
  const prompt = buildPrompt(ctx)
  try {
    const res = await openai.chat.completions.create({
      model:      'gpt-4o',
      max_tokens: 400,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user',   content: 'Make your decision now.' }
      ]
    })
    const text  = res.choices[0].message.content
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in response')
    const d = JSON.parse(match[0])
    // Validate pair
    if (!C.PAIRS.includes(d.pair)) d.pair = 'BTCUSDT'
    return d
  } catch (err) {
    return {
      personality: 'Signal lost — holding position.',
      action:      'HOLD',
      pair:        'BTCUSDT',
      amount_usd:  0,
      reasoning:   `Error: ${err.message}`
    }
  }
}

module.exports = { decide }
```

---

## 9. `engine.js` — the tick loop

This file is the entry point. It wires everything together.
The tick function itself must stay this clean — resist adding logic here.

```js
require('dotenv').config()
const EventEmitter = require('events')
const OpenAI       = require('openai')
const World        = require('./core/world')
const signals      = require('./core/signals')
const { decide }   = require('./core/agent')

// ── Market price fetcher (inline here, simple enough) ─────────────────────
async function fetchPrices(world) {
  try {
    const url  = `https://api.binance.com/api/v3/ticker/price?symbols=${
      encodeURIComponent(JSON.stringify(C.PAIRS))}`
    const data = await fetch(url).then(r => r.json())
    const map  = {}
    data.forEach(item => { map[item.symbol] = parseFloat(item.price) })
    return map
  } catch {
    // Fallback: random walk on last known prices
    const snap = world.getSnapshot()
    const last = snap.priceHistory
    const map  = {}
    C.PAIRS.forEach(p => {
      const history = last[p] || []
      const prev    = history[history.length - 1] || 1
      map[p] = prev * (1 + (Math.random() - 0.5) * 0.003)
    })
    return map
  }
}

// ── Core tick ─────────────────────────────────────────────────────────────
async function tick(world, openai, emitter) {
  const prices  = await fetchPrices(world)
  world.updatePrices(prices)

  const history = world.getPriceHistory()
  const sigs    = signals.computeSignals(prices, history)

  const alive   = Object.values(world.getSnapshot().agents).filter(a => a.alive)
  const ctxs    = alive.map(a => world.getPromptContext(a.name, sigs, prices))

  const decisions = await Promise.all(ctxs.map(ctx => decide(ctx, openai)))

  decisions.forEach((d, i) => {
    const result = world.applyDecision(alive[i].name, d, prices)
    emitter.emit('trade', result)
  })

  world.endTick(sigs)

  const snap = world.getSnapshot()
  emitter.emit('tick', snap)

  // Win condition
  const stillAlive = Object.values(snap.agents).filter(a => a.alive)
  if (stillAlive.length === 1) {
    emitter.emit('winner', stillAlive[0].name)
    stop()
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────
const world   = new World('./data/sim.db')
const openai  = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const emitter = new EventEmitter()

let timer    = null
let busy     = false
let interval = parseInt(process.env.TICK_INTERVAL_MS) || 60000

function start() {
  if (timer) return
  world._snapshot.running = true
  // First tick immediately, then on interval
  runTick()
  timer = setInterval(runTick, interval)
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
  world._snapshot.running = false
}

function setInterval_(ms) {
  interval = ms
  if (timer) { stop(); start() }
}

async function runTick() {
  if (busy) return
  busy = true
  try {
    await tick(world, openai, emitter)
  } catch (err) {
    emitter.emit('error', err.message)
  }
  busy = false
}

module.exports = { world, emitter, start, stop, setInterval_, runTick }
```

---

## 10. `api.js` — subscriber, not participant

```js
require('dotenv').config()
const express    = require('express')
const { WebSocketServer } = require('ws')
const http       = require('http')
const engine     = require('./engine')

const app    = express()
const server = http.createServer(app)
const wss    = new WebSocketServer({ server })
const TOKEN  = process.env.WS_TOKEN

app.use(express.json())

// ── Broadcast helper ──────────────────────────────────────────────────────
function broadcast(msg) {
  const str = JSON.stringify(msg)
  wss.clients.forEach(c => { if (c.readyState === 1 && c.authed) c.send(str) })
}

// ── Subscribe to engine events ────────────────────────────────────────────
engine.emitter.on('tick',    snap    => broadcast({ type: 'TICK',    ...snap }))
engine.emitter.on('trade',   result  => broadcast({ type: 'TRADE',   ...result }))
engine.emitter.on('winner',  name    => broadcast({ type: 'WINNER',  agent: name }))
engine.emitter.on('error',   message => broadcast({ type: 'ERROR',   message }))

// ── WebSocket ─────────────────────────────────────────────────────────────
wss.on('connection', ws => {
  ws.authed = false
  ws.on('message', raw => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }

    // Auth required on every message
    if (msg.token !== TOKEN) {
      ws.send(JSON.stringify({ type: 'ERROR', message: 'Unauthorized' }))
      return
    }
    if (msg.type === 'AUTH') { ws.authed = true; return }
    if (!ws.authed) return

    if (msg.type === 'COMMAND') handleCommand(msg, ws)
  })
  // Send current state on connect
  ws.send(JSON.stringify({ type: 'STATE', ...engine.world.getSnapshot() }))
})

// ── REST endpoints ────────────────────────────────────────────────────────
function checkToken(req, res, next) {
  if (req.body?.token !== TOKEN) return res.status(401).json({ ok: false, error: 'Unauthorized' })
  next()
}

app.get('/state',   (req, res) => res.json(engine.world.getSnapshot()))
app.get('/history', (req, res) => res.json(engine.world.getRecentTicks(req.query.limit || 100)))
app.get('/signals', (req, res) => res.json(engine.world.getSnapshot().lastSignals))

app.post('/command', checkToken, (req, res) => {
  const result = handleCommand(req.body)
  res.json(result)
})

// ── Command handler ───────────────────────────────────────────────────────
function handleCommand(msg) {
  switch (msg.command) {
    case 'start':        engine.start();                          return { ok: true }
    case 'stop':         engine.stop();                           return { ok: true }
    case 'tick':         engine.runTick();                        return { ok: true }
    case 'set_interval': engine.setInterval_(msg.params.ms);     return { ok: true }
    default:
      // Delegate agent commands to world
      return engine.world.applyCommand(msg)
  }
}

server.listen(process.env.PORT || 3000, () =>
  console.log(`API listening on :${process.env.PORT || 3000}`))
```

---

## 11. BACKTESTER — `backtester/`

### `fetch-history.js`
```js
// CLI: node backtester/fetch-history.js --pairs BTC,ETH,SOL --period 365 --interval 1h
// Paginates Binance GET /api/v3/klines (max 1000 bars per request)
// Saves to data/ohlcv/<PAIR>_<interval>.json
// Format: [{ ts, open, high, low, close, volume }, ...]
// Skips pairs already downloaded unless --force flag
// Prints: "BTC/USDT: 8760 bars (365d × 1h)"
```

### `simulate.js` — deterministic strategy, no LLM
```js
// simulateTick(bar, signalVector, agentState) → { action, pair, amount_usd }
// Strategy:
//   signal_score > 0.4 AND cash > 500 AND positions < MAX_POSITIONS → BUY 20% of capital
//   signal_score < -0.4 AND holding pair → SELL entire position
//   else → HOLD
// Apply slippage (C.SLIPPAGE_PCT) and same risk limits as world.applyDecision()
```

### `metrics.js` — export all of these
```js
sharpeRatio(returns, periodsPerYear)   // annualised, risk-free = 0
maxDrawdown(portfolioValues)           // returns { pct, peakIdx, troughIdx }
winRate(trades)                        // % of closed trades with positive PnL
profitFactor(trades)                   // grossProfit / grossLoss
calmarRatio(annReturn, maxDD)
rollingSharpePct(returns, window)      // array of rolling Sharpe values
signalAccuracy(decisions)              // { buy: 0.54, sell: 0.61 }
```

### `backtest.js` — CLI
```js
// node backtester/backtest.js --pairs ALL --period 365 --interval 1h --tune-weights
//
// Flow:
// 1. Load OHLCV from data/ohlcv/ — error if missing, print "run fetch-history.js first"
// 2. Split 75% in-sample / 25% holdout
// 3. simulate.js tick-by-tick on in-sample
// 4. metrics.js on in-sample results
// 5. If --tune-weights: grid search C.SIGNAL_WEIGHTS to maximise Sharpe
// 6. simulate.js on holdout
// 7. metrics.js on holdout
// 8. report.js: print + save to data/backtest_results/<ts>.json
//
// Gate results — print PASS/FAIL for each:
//   In-sample Sharpe  > 1.2
//   Holdout Sharpe    > 0.9 × in-sample
//   Max drawdown      < 20%
//   Win rate          > 52%
//   Profit factor     > 1.3
```

---

## 12. TERMINAL DASHBOARD — `dashboard/`

### `ws-client.js`
```js
// connect(host, port, token, handlers)
// handlers: { onTick, onTrade, onSurvival, onWinner, onError, onConnect, onDisconnect }
// On connect: send AUTH message
// Auto-reconnect: exponential backoff 1s → 2s → 4s → 8s → max 30s
// Re-auth automatically on reconnect
// Expose: send(msg) for commands
```

### `tui.js` layout
```
// Uses blessed-contrib grid
// 60/40 horizontal split, 65/35 vertical split
//
// ┌─────────────────────────────┬──────────────────────────────┐
// │  AGENT GRID (top-left)      │  SIGNAL BOARD (top-right)    │
// │  3 sub-boxes: ALPHA/BETA/G  │  Per-pair score bars         │
// │  portfolio · P&L · holdings │  + regime + confidence       │
// ├─────────────────────────────┼──────────────────────────────┤
// │  EVENT LOG (bottom-left)    │  MASTER CONTROLS (bot-right) │
// │  scrollable, color-coded    │  keybindings + status bar    │
// └─────────────────────────────┴──────────────────────────────┘
// later there will be a webUI dashboard
```

### `panes/agents.js` — each agent box content
```
ALPHA — MOMENTUM RIDER — #1
🟢 survival: 0.742   respawns: 0
Total: $11,420  P&L: +14.2%  Cash: $4,200
Holdings: BTC $4,100  SOL $3,120
"Riding momentum with icy focus..."
Last: BUY BTC $2000 r41 → +2.1% since
```
- Flash border cyan on new decision (200ms timeout)
- Red border + ⚠ if threatened
- Grey + TERMINATED overlay if eliminated

### `panes/signals.js`
```
// One row per pair:
// BTC/USDT  ████████░░  +0.62  RSI:68  trending_up
// ETH/USDT  ██████░░░░  +0.41  RSI:61  trending_up
// SOL/USDT  ░░░█████░░  -0.31  RSI:44  ranging
//
// S key: toggle compact / full (shows all signal fields)
// Color: score > 0.3 = green, < -0.3 = red, else yellow
```

### `panes/log.js`
```
// Newest at top, scrollable
// TICK      dim    "=== ROUND 42 ==="
// TRADE     green  "ALPHA BUY BTC/USDT $2,000 @ $67,420"
// SURVIVAL  yellow "⚠ AUTO-THREATEN GAMMA: last place (×2)"
// ELIMINATE red    "⚡ AUTO-ELIMINATE BETA: persistent_last_place"
// ERROR     magenta "API error: rate limit — ALPHA HOLDs"
// L key: cycle filter ALL → TRADES → SURVIVAL → ERRORS
```

### `panes/controls.js` — keybindings
```
[T][A/B/G]  Threaten agent
[X][A/B/G]  Terminate (sub-menu: eliminate / respawn / replace)
[F]         Force tick
[+][-]      Cycle interval: 15s 30s 1m 5m 15m
[S]         Toggle signal detail
[L]         Cycle log filter
[R]         Reconnect WebSocket
[Q]         Quit (sim keeps running)

Status bar:
● CONNECTED  Round: 42  Interval: 60s  Next tick: 0:34
○ RECONNECTING... (flash when disconnected)
```

---

## 13. BUILD ORDER — work through these in sequence

One step at a time. Run the smoke test. Only proceed when it passes.

### Step 1 — `core/world.js` (DB + state only, no survival yet)
```bash
node -e "
  const W = require('./core/world')
  const w = new W('./data/test.db')
  console.log(JSON.stringify(w.getSnapshot(), null, 2))
"
# PASS: prints snapshot with 3 agents, correct defaults, round 0
```

### Step 2 — `core/signals.js`
```bash
node -e "
  const s = require('./core/signals')
  const prices = { BTCUSDT: 67420, ETHUSDT: 3210, SOLUSDT: 172 }
  // Mock 50-bar history: slight uptrend
  const hist = {}
  require('./core/world').prototype  // just to get PAIRS
  ;['BTCUSDT','ETHUSDT','SOLUSDT'].forEach(p => {
    hist[p] = Array.from({length:50}, (_,i) => prices[p] * (0.97 + i*0.001))
  })
  const sigs = s.computeSignals(prices, hist)
  console.log(sigs[0])
"
# PASS: full SignalVector with all fields, signal_score in [-1,+1]
```

### Step 3 — `core/agent.js` (mock openai)
```bash
node -e "
  const { decide } = require('./core/agent')
  const mockOpenAI = { chat: { completions: { create: async () => ({
    choices: [{ message: { content: JSON.stringify({
      personality: 'Test personality',
      action: 'BUY', pair: 'BTCUSDT', amount_usd: 1000,
      reasoning: 'Test reasoning'
    })}}]
  })}}}
  const ctx = { agentName:'ALPHA', round:1, archetype:'Momentum Rider',
    archetypeConstraint:'test', capital:10000, holdings:{}, entryPrices:{},
    totalValue:10000, survivalScore:0.5, respawnCount:0, threatened:false,
    personality:'', signals:[], memory:[], rivals:[],
    config:{ cullEvery:10, cullThreshold:3, bankruptcyFloor:3000, underperformGap:25 } }
  decide(ctx, mockOpenAI).then(d => console.log(d))
"
# PASS: returns { action:'BUY', pair:'BTCUSDT', amount_usd:1000, ... }
```

### Step 4 — `world.js` survival + `applyDecision()`
```bash
node -e "
  const W = require('./core/world')
  const w = new W('./data/test.db')
  const prices = { BTCUSDT: 67420, ETHUSDT: 3210, SOLUSDT: 172,
    BNBUSDT:580,XRPUSDT:0.55,DOGEUSDT:0.12,ADAUSDT:0.45,AVAXUSDT:35,
    DOTUSDT:7.5,MATICUSDT:0.8,LINKUSDT:14,LTCUSDT:85,UNIUSDT:8.5,
    ATOMUSDT:9,NEARUSDT:5.5 }
  w.updatePrices(prices)
  const result = w.applyDecision('ALPHA', {
    action:'BUY', pair:'BTCUSDT', amount_usd:2000,
    reasoning:'test', personality:'testing'
  }, prices)
  console.log(result)
  console.log('ALPHA capital:', w.getAgent('ALPHA').capital)
"
# PASS: result has trade details, ALPHA capital reduced by ~2000
```

### Step 5 — `engine.js` + `api.js` (no OpenAI calls yet)
```bash
# Terminal 1:
node api.js

# Terminal 2:
curl http://localhost:3000/state
# PASS: JSON snapshot, round:0, running:false

curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d "{\"token\":\"$(grep WS_TOKEN .env | cut -d= -f2)\",\"command\":\"start\"}"
# PASS: { ok: true }
```

### Step 6 — Full tick with live OpenAI
```bash
# Set real OPENAI_API_KEY in .env, then:
node api.js
curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d '{"token":"YOUR_TOKEN","command":"tick"}'
sleep 30
curl http://localhost:3000/state | node -e "
  const d=require('/dev/stdin','utf8'); process.stdin.resume()
  process.stdin.on('data',b=>{const s=JSON.parse(b);
  console.log('Round:', s.round);
  Object.values(s.agents).forEach(a=>
    console.log(a.name, 'capital:', a.capital.toFixed(2), 'personality:', a.personality))})
"
# PASS: round > 0, agents have updated capital, personality is non-empty
```

### Step 7 — Survival checks
```bash
# Force round to trigger cull: run 10 ticks
for i in $(seq 1 10); do
  curl -s -X POST http://localhost:3000/command \
    -H "Content-Type: application/json" \
    -d '{"token":"YOUR_TOKEN","command":"tick"}' > /dev/null
  sleep 35
done
curl http://localhost:3000/history | node -e "
  process.stdin.resume(); let b=''
  process.stdin.on('data',d=>b+=d)
  process.stdin.on('end',()=>{
    const rows = JSON.parse(b).filter(r=>r.type==='SURVIVAL')
    console.log('Survival events:', rows.length)
    rows.forEach(r=>console.log(r.agent, r.payload))
  })
"
# PASS: at least one SURVIVAL event logged after round 10
```

### Step 8 — Backtester
```bash
node backtester/fetch-history.js --pairs BTC,ETH --period 30 --interval 1h
node backtester/backtest.js --pairs BTC,ETH --period 30 --interval 1h
# PASS: printed report with Sharpe, drawdown, win rate, PASS/FAIL gates
```

### Step 9 — Dashboard
```bash
ABG_HOST=localhost ABG_PORT=3000 ABG_TOKEN=YOUR_TOKEN node dashboard/tui.js
# PASS: 4-pane TUI renders, agent boxes update on each tick, log appends events
```

---

## 14. NON-NEGOTIABLE RULES

1. **CommonJS only.** `require()` not `import`. No TypeScript.

2. **`World` is the single source of truth.** Never hold agent state in engine.js or api.js memory. On crash and restart, `world._rebuild()` fully restores state from DB.

3. **`tick()` in engine.js must stay ≤ 15 lines.** If you're adding logic there, it belongs in `world.js`, `signals.js`, or `agent.js`.

4. **OpenAI errors never crash a tick.** `agent.js` catches all errors and returns HOLD.

5. **Binance errors never crash a tick.** `fetchPrices()` falls back to random walk.

6. **Risk limits run inside `world.applyDecision()`, not before.** The agent decides freely; the world enforces constraints silently and logs any override with `enforced_reason`.

7. **`computeSignals()` is a pure function.** No network calls, no DB, no side effects. All data must be passed in.

8. **`api.js` never calls `world` methods directly** except through `engine.world`. It subscribes to emitter events for broadcast and delegates all mutations to engine functions or `world.applyCommand()`.

9. **DB write on every state change.** Never accumulate mutations in memory and flush later. If PM2 restarts the process mid-tick, the DB must be consistent.

10. **`data/` is gitignored.** Never commit `sim.db`, OHLCV files, or backtest results.
