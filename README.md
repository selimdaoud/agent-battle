# Agent Battle GPT

A multi-agent trading simulation where three autonomous agents — **ALPHA**, **BETA**, and **GAMMA** — compete for survival on live crypto markets. Each agent runs a **deterministic rules-based strategy** driven by real market flow data (funding rates, CVD, Fear & Greed, volume). GPT-4o is used only for periodic personality synthesis, not for trading decisions. The engine automatically threatens and eliminates underperformers. A human Master supervises via a terminal TUI dashboard.

```
┌─────────────────────────────┬──────────────────────────────┐
│  AGENT GRID                 │  SIGNAL BOARD                │
│  ALPHA · BETA · GAMMA       │  Per-pair score bars         │
│  portfolio · P&L · holdings │  regime + confidence         │
├─────────────────────────────┼──────────────────────────────┤
│  EVENT LOG                  │  MASTER CONTROLS             │
│  scrollable, color-coded    │  keybindings + status bar    │
└─────────────────────────────┴──────────────────────────────┘
```

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Configuration](#configuration)
4. [Running Locally](#running-locally)
5. [User Tutorial](#user-tutorial)
6. [Playbook](#playbook)
7. [Backtester](#backtester)
8. [Deployment Guide](#deployment-guide)
9. [Architecture](#architecture)

---

## Prerequisites

- **Node.js 20 LTS** or newer (tested on Node 25)
- **npm** 9+
- An **OpenAI API key** with GPT-4o access (used only for periodic personality synthesis — not required for core trading logic)
- Internet access to Binance public API and `api.alternative.me` (both free, no key required)

---

## Installation

```bash
git clone <your-repo-url>
cd agent-battle-gpt
npm install
```

Copy the example environment file and fill in your values:

```bash
cp .env.example .env
```

---

## Configuration

Edit `.env`:

```env
OPENAI_API_KEY=sk-...          # Your OpenAI API key
PORT=3000                       # API + WebSocket port
WS_TOKEN=change_me_32_chars    # Secret token for dashboard auth (pick any long random string)
TICK_INTERVAL_MS=900000         # How often agents trade (ms). 900000 = 15 minutes
INITIAL_CAPITAL=10000           # Starting USD per agent (delete sim.db after changing)
```

> **Never commit `.env`.** It is gitignored by default. `.env.example` is safe to commit.

Key constants (edit in `core/world.js` → `const C`):

**Risk & execution**

| Constant | Default | Description |
|---|---|---|
| `STOP_LOSS_PCT` | `0.08` | Engine auto-sells a position when it drops this fraction (8%) below entry |
| `SLIPPAGE_PCT` | `0.001` | Simulated slippage applied to every BUY and SELL (0.1%) |
| `MAX_POSITIONS` | `5` | Maximum number of different pairs an agent can hold simultaneously |
| `MAX_POSITION_PCT` | `0.30` | Maximum fraction of portfolio in a single position (30%) |
| `MAX_EXPOSURE_PCT` | `0.80` | Maximum fraction of portfolio deployed as holdings (80%) |
| `BANKRUPTCY_FLOOR` | `3000` | Portfolio value below which agent is auto-respawned |

**Sell-decision flags shown to the agent in the prompt**

| Constant | Default | Description |
|---|---|---|
| `TAKE_PROFIT_FLAG_PCT` | `20` | % unrealised gain at which the `← TAKE PROFIT?` flag appears on a holding |
| `NEAR_STOP_WARN_PCT` | `6` | % unrealised loss at which the `← NEAR STOP-LOSS` warning flag appears (2% before the 8% auto-stop) |
| `DEADWEIGHT_ROUNDS` | `5` | Rounds a position can be held with no movement before it is flagged as deadweight in the prompt |

**Position sizing by volatility tier**

| Constant | Default | Applies to |
|---|---|---|
| `VOL_TIER_LOW_MAX_PCT` | `30` | Max allocation % per position for low-vol pairs (BTC, ETH, LTC) |
| `VOL_TIER_MED_MAX_PCT` | `20` | Max allocation % per position for med-vol pairs (BNB, XRP, ADA, LINK, ATOM) |
| `VOL_TIER_HIGH_MAX_PCT` | `10` | Max allocation % per position for high-vol pairs (SOL, DOGE, AVAX, DOT, MATIC, UNI, NEAR) |

**Archetype signal thresholds**

| Constant | Default | Description |
|---|---|---|
| `ALPHA_MOMENTUM_THRESHOLD` | `0.3` | signal_score above which ALPHA (Momentum Rider) biases toward buying |
| `BETA_OVERSOLD_SIGNAL` | `-0.3` | signal_score below which BETA (Contrarian) looks for oversold entries |
| `BETA_OVERSOLD_RSI` | `40` | RSI below which BETA considers an asset oversold |

**Survival & culling**

| Constant | Default | Description |
|---|---|---|
| `CULL_EVERY_N_ROUNDS` | `10` | How often the survival check runs |
| `LAST_PLACE_CULL_THRESHOLD` | `3` | Consecutive last-place finishes before elimination |
| `UNDERPERFORM_GAP_PCT` | `0.25` | Portfolio gap vs leader (25%) that triggers threatened status |
| `UNDERPERFORM_MIN_ROUND` | `20` | Earliest round at which underperformance culling can trigger |

**Realistic execution costs**

| Constant | Default | Description |
|---|---|---|
| `TAKER_FEE_PCT` | `0.001` | Binance standard taker fee (0.10%) applied to every BUY and SELL |
| `BID_ASK_SPREAD.LOW` | `0.0003` | Full bid-ask spread for low-vol pairs: BTC, ETH, LTC (~0.03%) |
| `BID_ASK_SPREAD.MEDIUM` | `0.0008` | Full spread for mid-vol pairs: BNB, XRP, ADA, LINK, ATOM (~0.08%) |
| `BID_ASK_SPREAD.HIGH` | `0.0015` | Full spread for high-vol pairs: SOL, DOGE, AVAX, DOT, MATIC, UNI, NEAR (~0.15%) |
| `MAX_TRADE_VOLUME_PCT` | `0.005` | Maximum single-trade size as a fraction of the pair's 20h USD volume (0.5%) |

**Signal weights** (sum to 1.0 — edit `C.SIGNAL_WEIGHTS` in `core/world.js`)

| Signal | Weight | Source |
|---|---|---|
| `funding_signal` | 25% | Binance perpetuals funding rate — contrarian: crowded longs → bearish |
| `cvd_norm` | 20% | Cumulative Volume Delta from Binance klines taker buy/sell data |
| `momentum_1h` | 15% | Z-score of last 1h return vs 20-bar rolling stddev |
| `rsi_norm` | 15% | Normalised Wilder RSI-14: `(RSI − 50) / 50` |
| `fear_greed_signal` | 10% | Crypto Fear & Greed Index (alternative.me) — contrarian |
| `volume_zscore` | 10% | Last-bar volume vs rolling mean, clamped to ±3 |
| `momentum_4h` | 5% | Medium-term momentum (every 4th bar of the 1h history) |

**Strategy engine thresholds** (edit `C.STRATEGY` in `core/world.js`)

| Constant | Default | Description |
|---|---|---|
| `STRATEGY.SYNTHESIS_EVERY_N_ROUNDS` | `20` | How often GPT-4o runs to generate personality text |
| `STRATEGY.ALPHA.buy_signal` | `0.30` | Minimum signal_score for ALPHA to enter a new position |
| `STRATEGY.ALPHA.sell_signal` | `-0.15` | signal_score threshold at which ALPHA exits a position |
| `STRATEGY.ALPHA.cvd_buy_min` | `0.10` | Minimum CVD required to confirm buy flow for ALPHA |
| `STRATEGY.ALPHA.cvd_sell_max` | `-0.30` | CVD below this triggers an ALPHA exit regardless of price |
| `STRATEGY.ALPHA.funding_buy_max` | `0.50` | Max funding_signal — ALPHA won't buy already-crowded longs |
| `STRATEGY.BETA.funding_buy_min` | `0.40` | Min funding_signal (crowded shorts) for BETA contrarian entry |
| `STRATEGY.BETA.fear_buy_max` | `25` | F&G below this triggers BETA fear-based entry |
| `STRATEGY.BETA.greed_sell_min` | `75` | F&G above this triggers BETA greed-based exit |
| `STRATEGY.BETA.sell_signal` | `0.50` | BETA exits when signal normalises above this (thesis complete) |
| `STRATEGY.GAMMA.buy_signal` | `0.50` | High-quality bar — GAMMA only enters on strong conviction |
| `STRATEGY.GAMMA.cvd_buy_min` | `0.20` | GAMMA requires strong confirmed buy flow |
| `STRATEGY.GAMMA.sell_loss_pct` | `5` | GAMMA exits at 5% loss (tighter than the global 8% auto-stop) |
| `STRATEGY.GAMMA.sell_profit_pct` | `10` | GAMMA takes profit at 10% gain when flow is turning |
| `STRATEGY.GAMMA.cash_min_pct` | `0.40` | GAMMA must hold at least 40% cash (engine-enforced) |
| `STRATEGY.GAMMA.max_positions` | `2` | GAMMA hard cap on simultaneous open positions |

**Backtester**

| Constant | Default | Description |
|---|---|---|
| `BACKTEST_BUY_SIGNAL` | `0.4` | signal_score above which the backtester enters a long |
| `BACKTEST_SELL_SIGNAL` | `-0.4` | signal_score below which the backtester exits a long |
| `BACKTEST_BUY_SIZE_PCT` | `0.20` | Fraction of capital deployed per BUY in the backtester (20%) |
| `BACKTEST_MIN_CAPITAL` | `500` | Minimum capital required to allow a BUY in the backtester |
| `BACKTEST_TRAIN_DAYS` | `30` | Default training window for walk-forward validation (days) |
| `BACKTEST_TEST_DAYS` | `7` | Default out-of-sample test window per walk-forward fold (days) |

---

## Running Locally

You need **two terminals**.

### Terminal 1 — Start the engine + API

```bash
node api.js
```

Output: `API listening on :3000`

This starts the simulation engine and exposes:
- `GET  /state`    — current snapshot
- `GET  /history`  — recent tick log
- `GET  /signals`  — latest signal board
- `POST /command`  — send commands (requires `WS_TOKEN`)
- `WS   ws://localhost:3000` — live event stream

### Terminal 2 — Start the dashboard

```bash
ABG_HOST=localhost ABG_PORT=3000 ABG_TOKEN=<your WS_TOKEN> node dashboard/tui.js
```

The TUI connects, shows the agent grid, and begins receiving live updates.

### Starting the simulation

The engine starts **paused**. To begin trading:

```bash
curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d '{"token":"<your WS_TOKEN>","command":"start"}'
```

Or press **F** in the dashboard to force a single tick.

---

## User Tutorial

### The Agents

| Agent | Archetype | Survival bonus |
|---|---|---|
| **ALPHA** | Momentum Rider | Playing with the trend |
| **BETA** | Contrarian | Diverging from rivals |
| **GAMMA** | Risk Manager | Low drawdown / stability |

---

#### ALPHA — Momentum Rider

ALPHA is an aggressive trend-follower driven by a deterministic momentum engine.

**Entry rules:**
- Requires `signal_score > 0.30` AND `cvd_norm > 0.10` — both price momentum and confirmed buy flow
- Won't enter if `funding_signal > 0.50` (already-crowded long, contrarian risk)
- Position size is Kelly-adjusted based on per-pair historical win rate and avg win/loss ratio

**Exit rules:**
- Exits when `signal_score < −0.15` (momentum reversal)
- Exits when `cvd_norm < −0.30` (selling pressure regardless of price)
- Exits deadweight positions held for 5+ rounds with less than 3% unrealised move

**Threat mode:** Both entry and exit thresholds loosen by 0.08 when threatened — ALPHA takes more risk to recover rank.

**Survival bonus:** +0.05 if ALPHA holds at least one position aligned with positive momentum.

**Risk profile:** Highest — ALPHA is fully exposed in downturns and often takes the largest drawdowns. It compensates with outsized gains during trending markets.

---

#### BETA — Contrarian

BETA is a counter-trend hunter. It profits from crowded positioning extremes.

**Entry rules:**
- Enters when `funding_signal > 0.40` (crowded shorts = contrarian bullish) OR `Fear & Greed < 25` (extreme fear = buy zone)
- Will not enter if signal_score is below −0.80 (absolute freefall — not just oversold)
- Will not enter pairs that both rivals currently hold (divergence would be lost)

**Exit rules:**
- Exits when both rivals hold the pair AND `signal_score > 0` (contrarian thesis exhausted)
- Exits when `Fear & Greed > 75` (extreme greed — contrarian sell zone)
- Exits when `signal_score > 0.50` (asset has normalised — no longer an oversold play)

**Threat mode:** Entry threshold on `funding_signal` lowers by 0.15 when threatened.

**Survival bonus:** +0.05 when BETA's holdings differ from both ALPHA and GAMMA simultaneously.

**Risk profile:** Medium — BETA buys into weakness and sells into strength. It thrives in ranging or reverting markets and struggles in sustained trends.

---

#### GAMMA — Risk Manager

GAMMA is a disciplined capital preserver with the strictest entry criteria of the three agents.

**Entry rules:**
- Requires `signal_score > 0.50`, `cvd_norm > 0.20`, `funding_signal < 0.60`, AND `Fear & Greed < 65` — all four filters must pass simultaneously
- Hard cap of **2 open positions** at any time (engine-enforced)
- Must keep **at least 40% cash** at all times; BUY orders are blocked if they would breach this floor — even after the trade passes all other filters

**Exit rules:**
- **Stop-loss at −5%** (tighter than the global 8% auto-stop) — exits immediately on crossing this threshold
- Exits any position where `signal_score < 0` (signal turned bearish — exits before drawdown deepens)
- **Take-profit at +10%** if `cvd_norm < 0` (flow is turning against the position)

**Threat mode:** All thresholds loosen by 0.10 when threatened; cash floor is also temporarily overridden.

**Survival bonus:** +0.05 when GAMMA's maximum drawdown stays below the threshold — rewarding capital preservation over raw P&L.

**Risk profile:** Lowest — GAMMA rarely leads in portfolio value but rarely crashes. It is the hardest to eliminate through bankruptcy.

---

---

## Playbook

This section describes the complete decision cycle — everything that happens from the moment a tick fires to the moment an agent's trade is recorded.

---

### 1. Signal Computation (`core/signals.js`)

At the start of every tick the engine fetches live data from three external sources in parallel, then computes seven sub-signals per pair combined into a single `signal_score` in **−1 to +1**:

**Live data fetched every tick:**

| Source | Endpoint | What it provides |
|---|---|---|
| Binance spot klines | `api.binance.com/api/v3/klines` | Volume, taker buy volume, price bars — all 15 pairs in parallel |
| Binance perpetuals | `fapi.binance.com/fapi/v1/premiumIndex` | Funding rates for all perpetual contracts |
| Alternative.me | `api.alternative.me/fng/?limit=1` | Crypto Fear & Greed Index (0–100) |

All fetches have a 4-second timeout and neutral fallbacks — a failed fetch never blocks the tick.

**Signal weights:**

| Sub-signal | Weight | What it measures |
|---|---|---|
| `funding_signal` | 25% | Contrarian funding rate: high positive → crowded longs → bearish; high negative → crowded shorts → bullish |
| `cvd_norm` | 20% | Cumulative Volume Delta: `sum(takerBuyVol − takerSellVol) / totalVol` ∈ [−1, +1]. Positive = net buy pressure |
| `momentum_1h` | 15% | Z-score of last 1h return vs 20-bar rolling stddev of returns |
| `rsi_norm` | 15% | Normalised Wilder RSI-14: `(RSI − 50) / 50` |
| `fear_greed_signal` | 10% | Contrarian: extreme fear (+1) = buy zone; extreme greed (−1) = sell zone |
| `volume_zscore` | 10% | Last-bar volume vs rolling mean, clamped to ±3 (real Binance kline data) |
| `momentum_4h` | 5% | Medium-term momentum computed over every 4th bar of the 1h history |

The composite score is multiplied by a **regime damper** before clamping to [−1, +1]: `trending_up/down × 1.0`, `ranging × 0.6`, `volatile × 0.3`. This reduces false signals in choppy or high-volatility regimes.

The `SignalVector` also carries `vol_usd_20h` (20h USD volume, used by the risk limit to cap trade size at 0.5% of market volume) and `rsi_divergence` (bearish divergence flag when price makes a new high but RSI does not).

---

### 2. Context Assembly (`core/world.js → getPromptContext`)

For each agent the world assembles a context object used by both the strategy engine and the periodic LLM synthesis:

| Context field | Contents |
|---|---|
| `signals` | All 15 `SignalVector` objects — score, funding_signal, cvd_norm, RSI, momentum, volume z-score, vol_usd_20h, regime |
| `capital` | Current uninvested cash |
| `holdings` | All open positions (pair → quantity) |
| `entryPrices` | Average entry price per held pair (used for unrealised PnL calculation) |
| `entryRounds` | Round in which each position was opened (used for deadweight detection) |
| `currentPrices` | Live mark-to-market price per pair |
| `totalValue` | Cash + mark-to-market value of all positions |
| `survivalScore` | Computed this tick from P&L, consistency, adaptation, and drawdown |
| `threatened` | Boolean — whether this agent is currently under threat of elimination |
| `memory` | Last 10 decisions — action, pair, amount, outcome (WIN/LOSS), signal score, and reasoning |
| `losingStreak` | Count of consecutive losing decisions |
| `pairPerformance` | Per-pair stats over the last 20 trades: `winRate`, `trades`, `avgWin`, `avgLoss`, `rawPair` — used directly by Kelly sizing |
| `rivals` | For each rival: name, archetype, total value, P&L%, survival score, current holdings (label string), last 3 actions |
| `archetype` | The agent's fixed role |
| `archetypeConstraint` | Engine-enforced rules the agent cannot override |
| `personality` | The agent's current personality sentence (updated every N rounds by GPT-4o) |
| `agentName` | `'ALPHA'`, `'BETA'`, or `'GAMMA'` — used by `strategy.decide()` to dispatch the right rules |
| `round` | Current round number |

---

### 3. Prompt Construction (`core/agent.js → buildPrompt`)

The context is rendered into a prompt used **only** for the periodic LLM personality synthesis (every 20 rounds). The signal columns now show flow data instead of raw volume:

```
You are ALPHA, an autonomous AI trading agent. Round 42.

ARCHETYPE: Momentum Rider
CONSTRAINT: Must hold at least one position at all times...

MARKET SIGNALS:
  BTCUSDT  (BTC/USDT)   score= +0.62  RSI= 68  mom= +1.84  fund= -0.12  cvd= +0.41  regime=trending_up
  ETHUSDT  (ETH/USDT)   score= +0.41  RSI= 61  mom= +1.12  fund= +0.05  cvd= +0.22  regime=trending_up
  ...

SIGNAL LEGEND:
  score = composite signal (−1 bearish → +1 bullish)
  mom   = 1h price momentum z-score
  fund  = funding rate signal: >0 crowded shorts (contrarian bullish), <0 crowded longs (contrarian bearish)
  cvd   = cumulative volume delta: >0 net buy pressure, <0 net sell pressure

YOUR PORTFOLIO:
  Cash:    $4,200.00
  Total:   $11,430.00
  P&L:     +14.30%
  Survival score: 0.742
Holdings:
  BTC/USDT: 0.120000 units  [entry $67,200 | +2.1% | held 3 rounds]

RIVALS:
  BETA [Contrarian]: $9,840 (-1.6%) survival=0.38 | holds: ETH/USDT | recent: BUY→HOLD→SELL
  GAMMA [Risk Manager]: $10,120 (+1.2%) survival=0.61 | holds: BTC/USDT,ETH/USDT | recent: HOLD→HOLD→BUY

🟢 THREAT STATUS: Safe.
```

The LLM is instructed to respond with **a single plain-text sentence** (≤80 tokens) describing the agent's current psychological state. No JSON, no trading decision — only personality flavour.

---

### 4. Deterministic Strategy Engine (`core/strategy.js → decide`)

Every tick each agent's decision is made by a deterministic rules engine — no LLM involved. The engine dispatches to an archetype-specific function based on `ctx.agentName`:

**ALPHA** (`alphaDecide`):
1. Scans held positions for exit conditions (momentum reversed, selling pressure, deadweight)
2. Selects the worst-scoring qualifying exit and executes it
3. If no exit needed, searches for the highest-scoring BUY candidate passing all entry filters
4. Returns `HOLD` if no qualifying signal exists

**BETA** (`betaDecide`):
1. Checks existing positions for exhausted-thesis exits (rivals caught up, greed extreme, signal normalised)
2. Ranks potential entries by `funding_signal` descending (most crowded shorts first)
3. Enters the top candidate when it passes funding or fear filter and rivals don't already hold it

**GAMMA** (`gammaDecide`):
1. Stops out at −5% loss (before checking anything else)
2. Exits any position where the signal is bearish or the profit target is met with flow turning
3. Only considers a BUY if cash ratio, Fear & Greed, and all four signal filters pass
4. Verifies post-trade cash ratio before executing

**Kelly position sizing** (`kellyFraction`):
- Once a pair has ≥6 historical trades, size is determined by Half-Kelly:
  `f_half = 0.5 × (b×p − q) / b` where `b = avgWin/avgLoss`, `p = winRate`
- Negative Kelly (negative expectancy) → position size = 0 (skip the trade entirely)
- Capped at 2× the base `buy_size_pct` to prevent over-betting
- Falls back to the archetype's `buy_size_pct` when fewer than 6 trades exist

**Conviction scaling:** size is further multiplied by `clamp(|signal_score| / 0.5, 0.5, 1.0)` — weaker signals get smaller positions.

The decision returned is: `{ action, pair, amount_usd, reasoning, signal_score, personality }` — identical interface to the old GPT-4o response.

---

### 5. Periodic LLM Synthesis (`core/agent.js → synthesize`)

Every `SYNTHESIS_EVERY_N_ROUNDS` (default: 20) rounds, GPT-4o is called **once per agent** to generate a personality sentence:

```
Input:  full context (signals, portfolio, rivals, last decision reasoning)
Output: one plain-text sentence, ≤80 tokens
        e.g. "Riding BTC's surge with conviction — rivals are behind and I'm not slowing down."
```

This sentence is attached to the next decision broadcast and displayed on the dashboard. It has no effect on the trading decision itself.

If the OpenAI call fails, the previous personality sentence is retained — the simulation continues unaffected.

---

### 6. Decision Validation & Execution (`core/world.js → applyDecision`)

Before any trade executes, the engine validates and enforces archetype rules, then applies realistic execution costs:

**Execution model:**
- **BUY**: filled at **ask price** (`price × (1 + halfSpread)`); cash deducted is `amount_usd × (1 + TAKER_FEE_PCT)`
- **SELL**: filled at **bid price** (`price × (1 − halfSpread)`); proceeds are `qty × bidPrice × (1 − TAKER_FEE_PCT)`
- Half-spread is tier-dependent: LOW 0.015%, MEDIUM 0.04%, HIGH 0.075% (per side)

**Validation:**
- **HOLD**: no change; decision stored in memory
- **GAMMA cash floor**: BUY orders that would push cash below 40% of total value are blocked — becomes HOLD
- **GAMMA position cap**: BUY orders that would push open positions above 2 pairs are blocked
- **Volume limit**: BUY is capped so the trade is no more than 0.5% of the pair's 20h USD volume (`vol_usd_20h`)
- **Global exposure**: BUY is blocked if total invested already exceeds `MAX_EXPOSURE_PCT` (80%) of portfolio
- **Stop-loss**: if any open position is down more than 8% from average entry, it is auto-sold before the agent's decision is processed

---

### 7. Survival Scoring (`core/world.js → endTick`)

After all three agents have decided, the engine computes survival scores and runs survival checks:

```
survival_score = P&L_component×50%
              + consistency_component×25%
              + adaptation_component×15%
              − risk_component×10%
              + archetype_bonus (0 or +0.05)
```

| Component | How it is calculated |
|---|---|
| **P&L** | Portfolio value vs. starting capital, normalised |
| **Consistency** | Rolling win rate across recent decisions |
| **Adaptation** | +0.15 bonus if the agent changed its dominant strategy after a losing streak; 0 otherwise |
| **Risk** | Maximum drawdown penalty — higher drawdown reduces the score |
| **Archetype bonus** | +0.05 if the agent's behaviour matches its archetype (e.g. ALPHA held a position, BETA held a pair different from rivals, GAMMA stayed within its drawdown limit) |

Every `CULL_EVERY_N_ROUNDS` (default: 10) rounds, the engine checks all three scores. The lowest scorer is threatened. Every tick, a threatened agent that has recovered (no longer last-place and within 25% of the leader) has its threat **automatically cleared**.

---

### Reading the Dashboard

---

#### Agent Grid (top-left)

Three boxes side by side, one per agent. Example:

```
⚠ THREATENED #3
survival: 0.214   respawns: 1
Total: $8,430  P&L: -15.7%
Cash: $6,200
─────────────────────
Holdings:
  BTC/USDT: $2,230
─────────────────────
"Desperate, doubling down on momentum..."
```

| Field | What it means |
|---|---|
| `● #1` / `⚠ #3` | **Status icon + rank.** `●` = safe, `⚠` = threatened. The rank `#1/#2/#3` is by current total portfolio value — who is winning right now. |
| `survival: 0.742` | **Survival score** — the number the engine uses to decide who gets threatened and eliminated. Range is roughly -1 to +2. Higher is better. Calculated each round from P&L, consistency, adaptation, and drawdown (see Survival Rules below). This is *not* the same as portfolio performance — an agent can be profitable but score low if it's volatile or not adapting. |
| `respawns: 0` | How many times this agent has been respawned from bankruptcy or manual intervention. Each respawn resets holdings to cash and cuts capital in half. A high respawn count means this agent has been struggling. |
| `Total: $11,420` | **Total portfolio value** — cash + current market value of all open positions at live prices. This is the real performance number. |
| `P&L: +14.2%` | Percentage gain or loss vs the starting capital of $10,000. Positive = the agent has grown its portfolio. Negative = it has lost money overall. |
| `Cash: $4,200` | Uninvested USD held by the agent. A very high cash balance means the agent is sitting on the sidelines (HOLD decisions). A very low cash balance means it is nearly fully invested. GAMMA is forced to keep at least 40% cash at all times. |
| `Holdings: BTC/USDT: $4,100` | Open positions at current market value. Each line shows the pair name and its current USD value (qty × live price). If this section is empty, the agent holds only cash. |
| `"Riding momentum..."` | **Personality** — a one-sentence psychological state written by GPT-4o each round. It reflects the agent's current mindset and strategy. It changes every tick based on market conditions, memory of past decisions, and rival positions. |

**Border colours:**
- **Cyan** — normal, safe
- **Yellow flash** — agent just made a decision this tick
- **Red + ⚠** — agent is threatened; next cull could eliminate it
- **Grey + TERMINATED** — agent has been eliminated

---

#### Signal Board (top-right)

One row per trading pair, updated each tick:

```
BTC/USDT   ████████░░  +0.62  RSI:68  fund=-0.12  cvd=+0.41  trending_up
ETH/USDT   ██████░░░░  +0.41  RSI:61  fund=+0.05  cvd=+0.22  trending_up
SOL/USDT   ░░░█████░░  -0.31  RSI:44  fund=+0.38  cvd=-0.15  ranging
```

| Column | What it means |
|---|---|
| Pair name | The trading pair, e.g. `BTC/USDT` |
| Bar `████░░░░` | Visual representation of signal strength. The bar fills for the absolute magnitude — ±0.8 both fill 8/10 blocks. |
| Score `+0.62` | **Composite signal score**, range −1 to +1. Positive = bullish, negative = bearish. Weighted combination of funding rate, CVD, momentum, RSI, and Fear & Greed. |
| `RSI:68` | **14-period Wilder RSI.** Above 70 = overbought. Below 30 = oversold. Around 50 = neutral. |
| `fund=` | **Funding signal** in [−1, +1]. Positive = crowded shorts (contrarian bullish). Negative = crowded longs (contrarian bearish). BETA and ALPHA use this as a primary filter. |
| `cvd=` | **Cumulative Volume Delta** in [−1, +1]. Positive = net taker buy pressure. Negative = net taker sell pressure. Required for ALPHA and GAMMA entries. |
| Regime | **Market regime** classifier: `trending_up`, `trending_down`, `ranging`, or `volatile`. Signal score is dampened in ranging (×0.6) and volatile (×0.3) regimes. |

**Colour coding:**
- 🟢 Green — score > 0.3 (bullish — ALPHA will likely buy)
- 🔴 Red — score < −0.3 (bearish — ALPHA/GAMMA may exit)
- 🟡 Yellow — score between −0.3 and +0.3 (neutral)

Press **S** to toggle between compact view (one line per pair) and full view (shows all individual signal components: funding, CVD, momentum, volume z-score, Bollinger position, RSI divergence).

---

#### Event Log (bottom-left)

Scrollable, newest event at the top. Color-coded by event type:

| Colour | Event type | Example |
|---|---|---|
| Grey | Round marker | `=== ROUND 42 ===` |
| Green | Trade executed | `ALPHA BUY ETHUSDT $2,000 @ $3,420` |
| Green | Threat cleared | `AUTO_CLEAR_THREAT GAMMA: recovered` |
| Yellow | Survival warning | `⚠ AUTO-THREATEN GAMMA: last_place` |
| Red | Elimination | `⚡ AUTO-ELIMINATE BETA: persistent_last_place` |
| Magenta | Error | `ERROR: OpenAI timeout — ALPHA HOLDs` |

Press **L** to cycle the filter: `ALL → TRADES → SURVIVAL → ERRORS`.

---

#### Status Bar (bottom)

```
● CONNECTED   ▶ RUNNING  Next: 47s   Round: 12   Interval: 1m
```

| Field | What it means |
|---|---|
| `● CONNECTED` / `○ RECONNECTING` | Dashboard WebSocket connection to the engine |
| `▶ RUNNING` / `⏸ PAUSED` | Whether the engine is automatically ticking. Press **P** to toggle. |
| `Next: 47s` | Seconds until the next automatic tick fires |
| `Round: 12` | How many ticks have completed since the simulation started |
| `Interval: 1m` | Current tick interval. Press `+`/`-` to change it. |

**Controls (bottom-right):** Keybindings + live status bar.

### Keyboard Controls

| Key | Action |
|---|---|
| `T` then `A`/`B`/`G` | Threaten an agent manually |
| `U` then `A`/`B`/`G` | **Un-threaten** an agent manually |
| `X` then `A`/`B`/`G` then `E`/`R` | Terminate → Eliminate or Respawn |
| `F` | Force an immediate tick |
| `+` / `-` | Cycle tick interval: 15s → 30s → 1m → 5m → 15m |
| `S` | Toggle signal detail (compact ↔ full) |
| `L` | Cycle log filter: ALL → TRADES → SURVIVAL → ERRORS |
| `R` | Reconnect WebSocket |
| `Q` or `Esc` | Quit dashboard (simulation keeps running) |

### Survival Rules

Every 10 rounds:
1. The agent with the **lowest survival score** gets threatened
2. Three consecutive last-place rounds → **auto-eliminated**
3. Portfolio below **$3,000** → **auto-respawn** (30% of combined portfolio value, minimum $6,000)
4. More than **25% below the leader** (after round 20) → auto-threatened
5. **Every tick**: if a threatened agent is no longer in last place AND no longer underperforming → **threat automatically cleared** (`AUTO_CLEAR_THREAT` logged)

Survival score formula:
```
score = P&L×50% + consistency×25% + adaptation×15% − risk×10%
```
Each archetype also earns a **+0.05 bonus** for playing to type.

---

### Agent Adaptation System

Each agent receives a rich context every tick designed to force strategic adaptation:

#### 1. Deep Memory (last 10 decisions)
Each decision record includes:
- The action taken, pair, and USD amount
- **Explicit WIN/LOSS label** based on price movement since entry (BUY) or after exit (SELL)
- The signal score at the time of the decision
- The agent's reasoning from that round

This memory is surfaced in the periodic LLM synthesis so GPT-4o can write personality text that reflects genuine performance history.

#### 2. Losing Streak Counter
The context tracks consecutive losses. When the survival score drops due to a losing streak, the **Adaptation Bonus (+0.15)** is awarded if the agent's dominant strategy shifts — e.g. from mostly BUY to mostly SELL or HOLD.

#### 3. Per-Pair Win Rate and Kelly Sizing (last 20 trades)
Per-pair stats (win rate, avgWin, avgLoss, trade count) feed directly into the Kelly position sizer in `core/strategy.js`:
```
SOLUSDT   win rate: 25% (4 trades)  → Kelly negative → position size = 0 (no trade)
ETHUSDT   win rate: 75% (4 trades)  → Kelly positive → larger position
BTCUSDT   win rate: 50% (6 trades)  → moderate Kelly → standard size
```
Pairs with fewer than 6 trades fall back to the archetype's default `buy_size_pct`.

#### 4. Rival Action History (last 3 ticks)
Instead of only the last action, each rival now shows their recent pattern:
```
BETA [Contrarian]: $9,840 (-1.6%) | holds: ETH/USDT | recent: BUY→HOLD→SELL
```
This allows ALPHA to detect if BETA has been consistently selling (a bearish signal from a contrarian perspective), or if GAMMA has been holding cash for multiple rounds (risk-off signal).

#### 5. Threat Response Playbook
When an agent is threatened, its prompt is replaced with an archetype-specific survival directive:

```
🔴 THREAT STATUS: YOU ARE THREATENED.
  You are 18.4% behind the leader. The next cull could eliminate you.
  Your survival score is -0.312 — you must improve it THIS tick.

  SURVIVAL PLAYBOOK FOR MOMENTUM RIDER:
  1. Switch to the pair with the highest signal_score right now.
  2. Consolidate into 1-2 high-conviction positions.
  3. If your current holdings have negative momentum, SELL them and rotate.

  CRITICAL: HOLDing while threatened accelerates elimination.
```

Each archetype receives different instructions:
- **ALPHA (Momentum Rider)**: rotate into the strongest momentum pair immediately
- **BETA (Contrarian)**: find the most oversold pair, sell any holdings that rivals share
- **GAMMA (Risk Manager)**: cut losing positions, protect cash, only buy the most stable pair

#### Threat lifecycle
| Event | Trigger | How cleared |
|---|---|---|
| Threatened | Lowest survival score at cull, or >25% behind leader | Auto-cleared when no longer last-place AND within gap threshold |
| Manual threaten | `T` + `A/B/G` in dashboard | `U` + `A/B/G` to manually clear |
| Auto-clear | Every tick — engine checks recovery | Logged as `AUTO_CLEAR_THREAT: recovered` in event log |

### REST API

```bash
# Current state
curl http://localhost:3000/state

# Last 100 events
curl http://localhost:3000/history?limit=100

# Latest signals
curl http://localhost:3000/signals

# Force tick
curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d '{"token":"YOUR_TOKEN","command":"tick"}'

# Stop simulation
curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d '{"token":"YOUR_TOKEN","command":"stop"}'

# Threaten ALPHA
curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d '{"token":"YOUR_TOKEN","command":"threaten","agent":"ALPHA"}'

# Change tick interval to 5 minutes
curl -X POST http://localhost:3000/command \
  -H "Content-Type: application/json" \
  -d '{"token":"YOUR_TOKEN","command":"set_interval","params":{"ms":300000}}'
```

---

## Backtester

Test the signal strategy against historical data without spending OpenAI credits. All backtests use the same realistic execution model as the live engine: bid-ask spreads by vol tier and taker fees on every fill.

### Step 1 — Download historical data

```bash
# Download 30 days of BTC + ETH hourly bars
node backtester/fetch-history.js --pairs BTC,ETH --period 30 --interval 1h

# Download all 15 pairs, 365 days
node backtester/fetch-history.js --pairs ALL --period 365 --interval 1h

# Re-download (overwrite cached data)
node backtester/fetch-history.js --pairs BTC --period 90 --interval 1h --force
```

Data is cached in `data/ohlcv/`. Re-runs skip download unless `--force` is passed.

> **Note:** Backtests run with `backtest: true` — all external API calls (funding rates, CVD, Fear & Greed) are skipped and those signals default to neutral. The backtest validates the price-based signals (momentum, RSI, volume z-score) plus the execution model.

### Step 2 — Run in-sample / holdout backtest

```bash
node backtester/backtest.js --pairs BTC,ETH --period 30 --interval 1h
```

The data is split 75% in-sample / 25% holdout. Five quality gates are evaluated on the holdout set:

```
── IN-SAMPLE (540 bars) ──
  Sharpe:        1.84
  Max drawdown:  12.3%
  Win rate:      54.2%
  Profit factor: 1.41
  Total return:  +8.7%

── HOLDOUT (180 bars) ──
  Sharpe:        1.61
  Max drawdown:  14.1%
  Win rate:      52.8%
  Profit factor: 1.33
  Total return:  +3.2%

── GATES ──
  [PASS]  In-sample Sharpe  > 1.2
  [PASS]  Holdout Sharpe    > 0.9×IS
  [PASS]  Max drawdown      < 20%
  [PASS]  Win rate          > 52%
  [PASS]  Profit factor     > 1.3

  Overall: ✅ ALL PASS
```

Results are saved to `data/backtest_results/<timestamp>.json`.

### Step 3 — Walk-forward validation (recommended)

Walk-forward testing is the gold standard for avoiding overfitting. It rolls a training + test window forward through the full dataset and measures out-of-sample performance in each fold:

```bash
# Default: 30-day train / 7-day test windows, all 15 pairs
node backtester/backtest.js --pairs ALL --period 365 --interval 1h --walk-forward

# Custom windows
node backtester/backtest.js --pairs BTC,ETH --period 180 --interval 1h \
  --walk-forward --train-days 45 --test-days 10
```

Output:
```
── PER-WINDOW (out-of-sample) ──
  [PASS]  W 1  Sharpe=  1.12  Ret=  +2.3%  DD=  -8.1%  WR= 54.0%  trades=18
  [PASS]  W 2  Sharpe=  0.88  Ret=  +1.1%  DD= -11.2%  WR= 51.3%  trades=14
  [FAIL]  W 3  Sharpe= -0.21  Ret=  -0.9%  DD= -16.4%  WR= 44.8%  trades=9
  ...

── AGGREGATE ──
  Avg out-of-sample Sharpe: 0.72
  Avg out-of-sample return: +1.4%
  Avg max drawdown:         -10.2%
  Profitable windows:       75% (9/12)

  Verdict: ✅  Edge appears consistent — avg Sharpe > 0.5 and ≥60% profitable windows
```

A strategy is considered to have a **consistent edge** only when `avgSharpe > 0.5` AND at least 60% of windows are profitable. Do not trade a strategy that fails this check live.

### Tune signal weights

```bash
node backtester/backtest.js --pairs ALL --period 365 --interval 1h --tune-weights
```

Grid-searches `momentum_1h` and `rsi_norm` weights to maximise in-sample Sharpe, then validates on the holdout set. Walk-forward can be combined with `--tune-weights` to verify that the optimised weights also generalise.

---

## Deployment Guide

Deploy the engine + API on a remote server so the simulation runs 24/7 and you connect via the dashboard from anywhere.

### Requirements

- A Linux VPS (Ubuntu 22.04 recommended), 1 GB RAM minimum
- Node.js 20 LTS installed
- `pm2` for process management
- A domain name (optional, for HTTPS/WSS)

### 1. Provision your server

```bash
# On the server — install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pm2 globally
sudo npm install -g pm2
```

### 2. Copy the project

```bash
# From your local machine
rsync -avz --exclude node_modules --exclude data --exclude .env \
  "/path/to/agent-battle-gpt/" user@your-server:/home/user/agent-battle-gpt/

# On the server
cd /home/user/agent-battle-gpt
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env
```

Set real values:
```env
OPENAI_API_KEY=sk-...
PORT=3000
WS_TOKEN=generate_a_strong_random_secret_here
TICK_INTERVAL_MS=60000
```

Generate a strong `WS_TOKEN`:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 4. Configure pm2

The `ecosystem.config.js` is already in the project:

```bash
# Create it if missing
cat > ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name:        'agent-battle-api',
    script:      'api.js',
    watch:       false,
    env: {
      NODE_ENV: 'production'
    }
  }]
}
EOF
```

Start with pm2:
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

Check status:
```bash
pm2 status
pm2 logs agent-battle-api
```

### 5. Open firewall port

```bash
# Allow port 3000 (or whatever PORT you set)
sudo ufw allow 3000/tcp
sudo ufw reload
```

### 6. (Recommended) Reverse proxy with Nginx + TLS

Install Nginx and Certbot:
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/agentbattle`:
```nginx
server {
    server_name yourdomain.com;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and get a certificate:
```bash
sudo ln -s /etc/nginx/sites-available/agentbattle /etc/nginx/sites-enabled/
sudo certbot --nginx -d yourdomain.com
sudo systemctl reload nginx
```

Your API is now at `https://yourdomain.com` and WebSocket at `wss://yourdomain.com`.

### 7. Connect the dashboard remotely

```bash
# From your local machine
ABG_HOST=yourdomain.com ABG_PORT=443 ABG_TOKEN=<your WS_TOKEN> node dashboard/tui.js
```

> If using plain HTTP (no TLS), use port 3000 and the server's IP address.

### 8. Persist simulation data

The SQLite database lives at `data/sim.db`. Back it up periodically:

```bash
# Simple daily backup via cron
crontab -e
# Add:
0 2 * * * cp /home/user/agent-battle-gpt/data/sim.db /home/user/backups/sim_$(date +\%Y\%m\%d).db
```

On restart, `world._rebuild()` fully restores all agent state from the DB — no data is lost if pm2 restarts the process.

### 9. Update the simulation

```bash
# From your local machine
rsync -avz --exclude node_modules --exclude data --exclude .env \
  "/path/to/agent-battle-gpt/" user@your-server:/home/user/agent-battle-gpt/

# On the server
cd /home/user/agent-battle-gpt
npm install
pm2 restart agent-battle-api
```

### Troubleshooting

| Problem | Fix |
|---|---|
| `EADDRINUSE: port 3000` | `pm2 delete agent-battle-api && pm2 start ecosystem.config.js` |
| Dashboard shows `RECONNECTING` | Check `pm2 logs` and verify `WS_TOKEN` matches |
| Agents always HOLD | Not enough price history yet — signals need ≥20 bars to compute |
| `better-sqlite3` build fails | Ensure Node.js 20 LTS is installed, not a newer version |
| OpenAI rate limit errors | LLM only runs every 20 rounds — rate limits are unlikely. Increase `SYNTHESIS_EVERY_N_ROUNDS` in `core/world.js` if needed |
| Funding/CVD signals all zero | Binance API unreachable — check internet access. Signals default to neutral; trading continues |

---

## Architecture

```
Binance prices + klines + funding rates + Fear & Greed
    │
    ▼
core/signals.js  →  SignalVector[] (per pair, per tick)
    │
    ▼
core/world.js → getPromptContext()  →  AgentContext (per agent)
    │
    ├─► core/strategy.js → decide()  →  Decision (deterministic, every tick)
    │
    └─► core/agent.js → synthesize()  →  personality string (LLM, every N rounds)
    │
    ▼
core/world.js → applyDecision()  →  world.endTick()  →  new snapshot → SQLite
```

| File | Role |
|---|---|
| `core/world.js` | Single source of truth. Owns SQLite DB, all agent state, execution model. |
| `core/signals.js` | Async: fetches funding rates, CVD, F&G; computes `SignalVector[]` |
| `core/strategy.js` | Deterministic rules engine: `decide(ctx)` → `Decision` |
| `core/agent.js` | Periodic LLM synthesis: `synthesize(ctx, openai)` → personality string |
| `engine.js` | Tick loop — wires world + signals + strategy + synthesize |
| `api.js` | WebSocket + REST — subscribes to engine events |
| `backtester/backtest.js` | In-sample/holdout + walk-forward backtester |
| `backtester/simulate.js` | Single-tick simulation with identical execution model to live engine |
| `backtester/report.js` | Formatted backtest and walk-forward output with quality gates |
| `dashboard/` | Terminal TUI — connects via WebSocket, never mutates state |
| `data/sim.db` | SQLite — append-only event ledger (never commit this) |

### Event-sourced DB

All state changes are logged as rows in the `ticks` table. Agent portfolios are reconstructed by replaying `TRADE` rows — like a ledger. This means:

- Full crash recovery with zero code changes
- Time-travel debugging: replay any past state
- `capital_after` is stored in each trade payload so state reconstruction is always accurate regardless of fee model changes

### Stack

- **Node.js 20 LTS** · CommonJS · no TypeScript
- **better-sqlite3** — synchronous SQLite
- **openai** — GPT-4o for periodic personality synthesis
- **express + ws** — REST + WebSocket API
- **blessed** — terminal TUI
- **simple-statistics** — signal math (RSI, stddev, Sharpe)
