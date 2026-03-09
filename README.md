# Agent Battle GPT

A multi-agent AI trading simulation where three autonomous GPT-4o agents — **ALPHA**, **BETA**, and **GAMMA** — compete for survival on live crypto markets. Each agent has a fixed archetype, decision memory, and a survival score. The engine automatically threatens and eliminates underperformers. A human Master supervises via a terminal TUI dashboard.

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
- An **OpenAI API key** with GPT-4o access
- Internet access to Binance public API (no key required)

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

| Constant | Default | Description |
|---|---|---|
| `BANKRUPTCY_FLOOR` | 3000 | Auto-respawn threshold |
| `CULL_EVERY_N_ROUNDS` | 10 | Survival check cadence |
| `LAST_PLACE_CULL_THRESHOLD` | 3 | Consecutive last-place rounds before elimination |
| `STOP_LOSS_PCT` | 0.08 | Auto-sell if position drops 8% from entry |
| `TICK_INTERVAL_MS` | 60000 | Also settable via `.env` |

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

ALPHA is an aggressive trend-follower. Its mandate is to always be invested.

**Behaviour:**
- Must hold at least one position at all times
- Actively seeks assets with a composite `signal_score > 0.3` (bullish momentum)
- Holding more than 60% cash for two or more consecutive rounds penalises its survival score
- Tends to accumulate during uptrends and ride them until signals reverse

**Survival bonus:** ALPHA scores +0.05 if it holds positions aligned with the momentum direction. It is rewarded for conviction, not caution.

**Risk profile:** Highest — ALPHA is fully exposed in downturns and is often the first to take a large drawdown. It compensates with outsized gains during trending markets.

---

#### BETA — Contrarian

BETA is a counter-trend hunter. It profits by going where others won't.

**Behaviour:**
- Targets oversold assets: `signal_score < -0.3` and `RSI < 40`
- When ALPHA and GAMMA both hold a given pair, BETA treats that as a contrarian signal to *avoid* it
- Explicitly instructed to differentiate its holdings from both rivals
- Tends to buy into weakness and sell into strength

**Survival bonus:** BETA scores +0.05 when its holdings differ from both ALPHA and GAMMA simultaneously — rewarding genuine divergence, not accidental difference.

**Risk profile:** Medium — BETA can catch reversals early and profit when the market turns, but it regularly buys falling assets and requires patience. It thrives in ranging or reverting markets and struggles in sustained trends.

---

#### GAMMA — Risk Manager

GAMMA is a disciplined capital preserver. Stability over returns.

**Behaviour:**
- Hard limit of **2 open positions** at any time (engine-enforced)
- Must keep **at least 40% cash** at all times (engine-enforced — BUY orders are blocked if this would be violated)
- Prioritises low-drawdown assets; avoids volatile or speculative pairs
- Tends to hold for longer and trade less frequently than ALPHA or BETA

**Survival bonus:** GAMMA scores +0.05 when its maximum drawdown is below the threshold — rewarding capital preservation over raw P&L.

**Risk profile:** Lowest — GAMMA rarely leads the portfolio value rankings but rarely crashes either. It acts as a floor in bear markets and is the hardest to eliminate through bankruptcy.

---

---

## Playbook

This section describes the complete decision cycle — everything that happens from the moment a tick fires to the moment an agent's trade is recorded.

---

### 1. Signal Computation (`core/signals.js`)

At the start of every tick the engine fetches live Binance prices for all 15 pairs and passes them through the signal pipeline. For each pair, five sub-signals are computed and combined into a single `signal_score` in the range **−1 to +1**:

| Sub-signal | Weight | What it measures |
|---|---|---|
| `momentum_1h` | 35% | Short-term price momentum over the last hour |
| `rsi_norm` | 25% | Normalised 14-period RSI (overbought/oversold) |
| `mean_reversion` | 20% | Distance from 20-period moving average |
| `volume_zscore` | 10% | Volume relative to its 20-period average |
| `btc_leadership` | 10% | Whether BTC is leading the broader market up or down |

The resulting `SignalVector` per pair also includes a **regime** classification (`trending_up`, `trending_down`, `ranging`, `volatile`). In ranging or volatile regimes the composite score is dampened — rewarding agents that trade less aggressively in uncertain conditions.

---

### 2. Context Assembly (`core/world.js → getPromptContext`)

For each agent the world assembles a rich context object. This is the information the agent will reason over:

| Context field | Contents |
|---|---|
| `signals` | All 15 `SignalVector` objects — scores, RSI, momentum, volume z-score, regime |
| `capital` | Current uninvested cash |
| `holdings` | All open positions (pair → quantity) |
| `totalValue` | Cash + mark-to-market value of all positions at live prices |
| `survivalScore` | Computed this tick from P&L, consistency, adaptation, and drawdown |
| `threatened` | Boolean — whether this agent is currently under threat of elimination |
| `memory` | Last **10** decisions, each with action, pair, amount, outcome (WIN/LOSS), signal score at the time, and the agent's own reasoning |
| `losingStreak` | Count of consecutive losing decisions |
| `pairPerformance` | Per-pair win rate over the last 20 trades for this agent |
| `rivals` | For each of the other two agents: name, archetype, total value, P&L%, survival score, current holdings, and **last 3 actions** |
| `archetype` | The agent's fixed role (Momentum Rider / Contrarian / Risk Manager) |
| `archetypeConstraint` | Engine-enforced rules the agent cannot override (e.g. GAMMA's 40% cash floor) |
| `config` | Simulation parameters: cull cadence, bankruptcy floor, underperform gap threshold |

---

### 3. Prompt Construction (`core/agent.js → buildPrompt`)

The context is rendered into a structured natural language prompt that becomes the **system message** sent to GPT-4o. It is divided into clearly labelled sections:

```
You are ALPHA, an autonomous AI trading agent. Round 42.

ARCHETYPE: Momentum Rider
CONSTRAINT: Must hold at least one position at all times...

MARKET SIGNALS:
  BTCUSDT  (BTC/USDT)   score= +0.62  RSI= 68  mom= +1.84  vol_z= +2.1  regime=trending_up
  ETHUSDT  (ETH/USDT)   score= +0.41  RSI= 61  mom= +1.12  vol_z= +1.3  regime=trending_up
  ...

YOUR PORTFOLIO:
  Cash:    $4,200.00
  Total:   $11,430.00
  P&L:     +14.30%
  Survival score: 0.742
Holdings:
  BTC/USDT: 0.120000 units

YOUR LAST 10 DECISIONS:
  Round 38: BUY ETHUSDT $2,000 → WIN (signal was +0.55)
    Reasoning: "Strong momentum aligned with BTC leadership..."
  Round 37: SELL SOLUSDT $1,500 → LOSS (signal was +0.12)
  ...

PERFORMANCE INSIGHTS:
  ⚠ LOSING STREAK: 2 consecutive losses — adapt now.
Per-pair win rates (last 20 trades):
  SOLUSDT      win rate: 25% (4 trades) ← AVOID
  ETHUSDT      win rate: 75% (4 trades) ← STRONG
  BTCUSDT      win rate: 50% (8 trades)

RIVALS:
  BETA [Contrarian]: $9,840 (-1.6%) survival=0.38 | holds: ETH/USDT | recent: BUY→HOLD→SELL
  GAMMA [Risk Manager]: $10,120 (+1.2%) survival=0.61 | holds: BTC/USDT,ETH/USDT | recent: HOLD→HOLD→BUY

PORTFOLIO RULES:
  - You can hold UP TO 5 different pairs simultaneously
  - A BUY does NOT require selling existing holdings
  - Spreading across 2-4 uncorrelated pairs reduces risk

SURVIVAL RULES:
  - Cull check every 10 rounds: lowest survival score gets threatened
  - 3 consecutive last-place rounds → auto-eliminated
  ...

🟢 THREAT STATUS: Safe.
```

If the agent is threatened, the final line expands into the full **Threat Response Playbook** (see [Threat Response Playbook](#5-threat-response-playbook) above).

---

### 4. GPT-4o Decision (`core/agent.js → decide`)

The prompt is sent to GPT-4o as the `system` message. The user message is always the same: `"Make your decision now."` GPT-4o must respond **only in JSON** — no markdown, no prose:

```json
{
  "personality": "Riding the BTC surge, doubling down before rivals catch up.",
  "action":      "BUY",
  "pair":        "BTCUSDT",
  "amount_usd":  2000,
  "reasoning":   "BTC signal_score +0.62 is the strongest on the board, RSI at 68 with volume z-score +2.1 confirms real buying pressure. BETA is going contrarian on ETH so I'll stay differentiated."
}
```

| Field | Constraints |
|---|---|
| `personality` | One sentence — the agent's psychological state this round. Shown on the dashboard. |
| `action` | Must be `"BUY"`, `"SELL"`, or `"HOLD"` |
| `pair` | Must be a valid pair symbol from the signal list (e.g. `BTCUSDT`). Invalid pairs default to `BTCUSDT`. |
| `amount_usd` | USD value to spend (BUY) or exit (SELL). `0` for HOLD. |
| `reasoning` | 2–3 sentences citing specific signal scores and rival positions. Stored in memory and shown in the log. |

If the OpenAI call fails (timeout, rate limit, JSON parse error), the agent automatically HOLDs and logs the error.

---

### 5. Decision Validation & Execution (`core/world.js → applyDecision`)

Before any trade executes, the engine validates and enforces archetype rules:

- **BUY**: deducted from cash; quantity calculated at current live price; position opened or added to
- **SELL**: position closed or reduced; proceeds returned to cash; outcome (WIN/LOSS) computed vs. average entry price
- **HOLD**: no change; decision still stored in memory with the current market price as context
- **GAMMA cash floor**: BUY orders that would push cash below 40% of total value are **blocked** — the trade becomes a HOLD
- **GAMMA position cap**: BUY orders that would push open positions above 2 pairs are **blocked**
- **Stop-loss**: if any open position is down more than 8% from average entry, it is auto-sold before the agent's decision is processed

---

### 6. Survival Scoring (`core/world.js → endTick`)

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
BTC/USDT   ████████░░  +0.62  RSI:68  trending_up
ETH/USDT   ██████░░░░  +0.41  RSI:61  trending_up
SOL/USDT   ░░░█████░░  -0.31  RSI:44  ranging
```

| Column | What it means |
|---|---|
| Pair name | The trading pair, e.g. `BTC/USDT` |
| Bar `████░░░░` | Visual representation of signal strength. Full blocks = stronger signal. The bar fills left-to-right for the absolute magnitude — a score of -0.8 fills 8/10 blocks just like +0.8. |
| Score `+0.62` | **Composite signal score**, range -1 to +1. Positive = bullish signal, negative = bearish. This is the weighted combination of momentum, RSI, mean reversion, and BTC leadership. Agents use this to decide whether to BUY, SELL, or HOLD. |
| `RSI:68` | **14-period RSI.** Above 70 = overbought (potential reversal down). Below 30 = oversold (potential reversal up). Around 50 = neutral. |
| Regime | **Market regime** classifier for the pair: `trending_up`, `trending_down`, `ranging`, or `volatile`. In volatile or ranging markets the signal score is dampened — agents should trade less aggressively. |

**Colour coding:**
- 🟢 Green — score > 0.3 (bullish — ALPHA will likely buy)
- 🔴 Red — score < -0.3 (bearish — positions may be sold)
- 🟡 Yellow — score between -0.3 and +0.3 (neutral, agents likely HOLD)

Press **S** to toggle between compact view (one line per pair) and full view (shows all individual signal components: momentum, volume z-score, mean reversion, Bollinger position, RSI divergence).

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
- The agent's own reasoning from that round

This lets GPT-4o identify patterns: *"I bought DOGE on a +0.4 signal three times and lost each time."*

#### 2. Losing Streak Counter
The prompt explicitly states the number of consecutive losses:
- 1 loss → neutral notice
- 2+ losses → `⚠ LOSING STREAK: N consecutive losses — your current approach is not working, adapt now.`

This directly triggers the **Adaptation Bonus (+0.15)** in the survival score when the agent changes its dominant strategy after a streak.

#### 3. Per-Pair Win Rate (last 20 trades)
A table of win rates per pair is injected into every prompt:
```
SOLUSDT      win rate: 25% (4 trades) ← AVOID
ETHUSDT      win rate: 75% (4 trades) ← STRONG
BTCUSDT      win rate: 50% (6 trades)
```
Pairs below 40% win rate are flagged `← AVOID`. Pairs above 60% are flagged `← STRONG`. Agents are expected to rotate away from losing pairs and concentrate on their historical winners.

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

Test the signal strategy against historical data without spending OpenAI credits.

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

### Step 2 — Run backtest

```bash
node backtester/backtest.js --pairs BTC,ETH --period 30 --interval 1h
```

Output:
```
── IN-SAMPLE (540 bars) ──
  Sharpe:        1.84
  Max drawdown:  12.3%
  Win rate:      54.2%
  Profit factor: 1.41
  Total return:  +8.7%

── GATES ──
  [PASS]  In-sample Sharpe  > 1.2
  [PASS]  Holdout Sharpe    > 0.9×IS
  [PASS]  Max drawdown      < 20%
  [PASS]  Win rate          > 52%
  [PASS]  Profit factor     > 1.3
```

Results are saved to `data/backtest_results/<timestamp>.json`.

### Tune signal weights

```bash
node backtester/backtest.js --pairs ALL --period 365 --interval 1h --tune-weights
```

Grid-searches `momentum_1h` and `rsi_norm` weights to maximise in-sample Sharpe, then validates on the holdout set.

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
| OpenAI rate limit errors | Increase `TICK_INTERVAL_MS` to 120000 or higher |

---

## Architecture

```
prices + history  →  signals.js  →  SignalMap
world.getSnapshot()  +  SignalMap  →  agent.js  →  Decision[]
Decision[]  →  world.applyDecision()  →  world.endTick()  →  new snapshot
```

| File | Role |
|---|---|
| `core/world.js` | Single source of truth. Owns SQLite DB + all state. |
| `core/signals.js` | Pure function: `(prices, history) → SignalVector[]` |
| `core/agent.js` | Pure async function: `(context, openai) → Decision` |
| `engine.js` | Tick loop — wires world + signals + agent together |
| `api.js` | WebSocket + REST — subscribes to engine events |
| `backtester/` | Offline strategy testing against Binance OHLCV data |
| `dashboard/` | Terminal TUI — connects via WebSocket, never mutates state |
| `data/sim.db` | SQLite — append-only event ledger (never commit this) |

### Event-sourced DB

All state changes are logged as rows in the `ticks` table. Agent portfolios are reconstructed by replaying `TRADE` rows — like a ledger. This means:

- Full crash recovery with zero code changes
- Time-travel debugging: replay any past state
- The backtester reuses the exact same logic as the live engine

### Stack

- **Node.js 20 LTS** · CommonJS · no TypeScript
- **better-sqlite3** — synchronous SQLite
- **openai** — GPT-4o for agent decisions
- **express + ws** — REST + WebSocket API
- **blessed** — terminal TUI
- **simple-statistics** — signal math
