# Adaptive Trading Agent — Architecture v2

**Status:** Live
**Date:** 2026-03-23
**Last updated:** 2026-03-29

---

## 0. Introduction

Cryptocurrency markets are volatile, regime-dependent, and structurally unstable. A trading strategy that works well in a trending market loses money in a choppy one. A threshold that filters noise today becomes too restrictive next week. Any system built on fixed rules will degrade — not because the rules were wrong, but because the market stopped resembling the conditions under which they were written.

This project builds a trading agent that adapts. Not manually, not through periodic human review, but continuously, as a function of its own observed outcomes. The agent trades a set of cryptocurrency pairs on Binance. It reads market signals, classifies the current market environment, and decides whether to open or close positions. After each trade, it updates its own behaviour based on what worked and what didn't. Over time, it finds the parameter configuration that produces the best risk-adjusted return in current conditions — and it keeps finding it as conditions change.

**What we are not building** is an agent with a fixed strategy that gets tuned once and deployed. We are building a system where the strategy is the output, not the input. The agent starts with a reasonable prior and learns its way to better behaviour. Human oversight is for reviewing what the agent learned, not for deciding what it should do next.

**The simulation context:** The agent runs alongside several other simulated trading agents on the same live market data. These companion agents are not competitors — they are parallel experiments. They trade the same pairs, generate the same kinds of data, and help the system explore different regions of the strategy space simultaneously. Some run with real simulated capital; others run in paper mode, taking no financial risk, purely to accumulate evidence about parameter regions that haven't been tried with real capital yet.

**Why simulate at all?** Real-money crypto trading at scale requires infrastructure, compliance, and risk management that are out of scope here. The simulation runs on real market data — live prices, real spreads, real funding rates — but executes trades against a virtual capital pool. This is as close to real as possible without actual exchange execution. The goal is to develop and validate the adaptive system to the point where its behaviour and learning dynamics are well understood, before any consideration of live deployment.

---

## 1. Core Principle

**The adaptation loop is the product. The trading strategy is the thing being adapted.**

The trading strategy is expressed as a config space — a set of parameters with defined ranges. The adaptation engine's job is to find the config that maximises risk-adjusted return in current market conditions. The strategy translates any valid config into executable decisions. Nothing more.

Everything else in this document follows from that inversion.

---

## 2. Mental Model

The system has three moving parts:

```
  OBSERVE               DECIDE                LEARN
  ───────               ──────                ─────

  Market Data    →    Agent Pool       →    Adaptation Engine
  + Signals           (N instances,         reads outcomes,
  + Regime probs       1 parameterized       writes better
                       class)                configs
                            │
                       Event Store
                    (append-only log of
                     everything that
                     happened)
```

All supporting infrastructure — replay, paper trading, evaluation — is just a configuration of these three parts, not additional components.

---

## 3. Operating Modes

The same three-part system runs in three modes:

| Mode | Market Data source | Agent capital | Adaptation |
|---|---|---|---|
| **Live** | Exchange APIs, real-time | Real | Enabled |
| **Paper** | Exchange APIs, real-time | Virtual | Enabled (separate posterior weight) |
| **Replay** | Stored tick log, N× speed | Virtual | Enabled |

**Live and Paper agents run simultaneously.** Paper agents share the same tick stream, emit the same event types, and feed the same adaptation engine — the only difference is the `paper` flag on their events and the absence of real capital consequences.

**Replay is not a separate component.** It is the Market Data Service reading from a stored tick log instead of an exchange API, with a configurable playback speed. All other components are identical. This constraint — that every component is mode-agnostic — is the single most important architectural rule. Any component that depends on wall clock time, external API calls, or mutable global state outside the event stream violates it. Time is always injected from the data source, never read.

The practical implication: before any component goes live, it must be validated against replayed data. The live deployment is a read-only consumer of a system that already works on history.

---

## 4. Components

### 4.1 Market Data Service

A single pipe from the outside world into the system. Ingests raw exchange data, emits a normalised tick stream. Does not transform. Does not compute signals.

In Live mode: polls exchange APIs, emits events in real time, writes every raw tick to the tick log.
In Replay mode: reads the tick log, emits events at the requested speed.

**Per-tick output (per pair):**
`mid_price, bid, ask, spread, volume, funding_rate, open_interest`

**Portfolio-wide per tick:**
`fear_greed_index` (daily, cached between updates)

---

### 4.2 Signal Pipeline

A stateless transform. Consumes the raw tick stream. Emits one market state vector per pair per tick.

The market state vector contains two things:

**1. Signal scores** (7 normalised sub-signals, all in [−1, +1]):

| Signal | What it measures |
|---|---|
| `cvd_norm` | Net taker buy/sell pressure, 20-bar rolling |
| `funding_signal` | Perpetual funding rate, inverted (crowding proxy) |
| `momentum_1h` | 1-bar return z-score against 20-bar history |
| `momentum_4h` | 4-bar return z-score |
| `rsi_norm` | RSI(14), normalised |
| `volume_zscore` | Volume vs 20-bar history |
| `fear_greed_signal` | F&G index, inverted (contrarian) |

Signal weights are **not hardcoded here**. They live in the agent config and are therefore adaptable. The pipeline outputs raw sub-signal values; agents apply their own weights.

**2. Regime probability distribution** (4 states, sums to 1.0):

```
p(volatile), p(trending_up), p(trending_down), p(ranging)
```

Regime is computed from the same price history: realised volatility, ADX proxy, and SMA slope. The output is continuous, not a discrete label. A pair sitting exactly at the trend/ranging boundary gets p=0.50 for each; a pair deep in an established uptrend gets p(trending_up) ≈ 1.0. As the market transitions, probabilities drift continuously — there is no snap between states.

**Effective entry threshold** for any parameter is the probability-weighted blend:
```
effective_threshold = Σ p(regime_i) × threshold_i
```

This eliminates the transition-window failure mode where the wrong threshold is applied at the moment of regime change.

**Signal uncertainty:** One additional metadata field — rolling standard deviation of the composite score over the last 10 ticks. Not a trading input. Used by the adaptation engine to discount evidence from high-noise periods.

---

### 4.2b News Signal (LLM-assisted leading indicator)

All seven signals above are **reactive** — they are derived from price, volume, and positioning data. They detect what has already moved in the market. This is a structural limitation: by the time CVD or momentum confirms a directional move, the first 30–60 minutes of it have already happened.

Certain events move crypto prices *before* any technical signal detects them: an exchange announcing the delisting of a token, a protocol exploit reported on-chain, a regulatory filing, a large liquidation cascade announced on social media. These are **leading indicators** — they precede price, not follow it. A language model is well-positioned to extract a directional signal from this kind of unstructured text. Rule-based parsers cannot.

**How it works:**

A separate lightweight process monitors a fixed set of high-signal sources:
- Binance official announcements (delisting notices, new listing approvals, maintenance windows)
- Major crypto news feeds (CoinDesk, The Block RSS)
- A small curated list of on-chain alert accounts (whale alerts, protocol security accounts)

When a new item arrives, it is passed to the OpenAI API with a structured prompt:

```
Given this news item, assess the directional impact on each of the following
trading pairs over the next 1–4 hours. For each affected pair, return:
  - direction: bullish | bearish | neutral
  - confidence: low | medium | high
  - rationale: one sentence

Pairs: [BTC/USDT, ETH/USDT, SOL/USDT, ...]
News: "{item text}"
```

The response is parsed into a `news_signal` score per affected pair, normalised to [−1, +1]:

```
high bearish   → −1.0
medium bearish → −0.6
low bearish    → −0.3
neutral        →  0.0
low bullish    → +0.3
medium bullish → +0.6
high bullish   → +1.0
```

**Decay:** The signal is not a point event — it persists and decays. After classification, the score is cached and decays linearly to zero over a configurable window (default: 2 hours). At each tick, the current decayed value is injected into the signal vector alongside the other 7 signals. This means a news event that happened 90 minutes ago still contributes 25% of its original weight to the composite score.

```
news_signal(t) = classified_score × max(0, 1 − (t − event_time) / decay_window)
```

Multiple events for the same pair accumulate additively (capped at [−1, +1]), so a second bearish event arriving 30 minutes after the first reinforces the signal rather than resetting it.

**Integration into the signal vector:**

`news_signal` becomes the 8th sub-signal in the pipeline output. It is treated identically to the other 7: it has an adaptable weight in the agent config (`news_signal_weight`), it contributes to the composite score through the same weighted sum, and its predictive value is evaluated by the adaptation engine like any other weight. If news events consistently have no predictive value on observed trade outcomes, the adaptation engine will converge its weight toward zero and it becomes a no-op. If it does have value, its weight will grow.

**What this changes in the strategy:**

Before a news event, the agent behaves normally — composite scores are driven entirely by technical signals. When a high-confidence bearish news event arrives for a pair the agent currently holds long, the news signal pulls the composite score downward. If it pulls the score below the exit threshold, the agent exits the position ahead of any technical confirmation. It acts on the event, not on the price reaction to the event.

Conversely, a bullish news event on a pair where the agent has no position but technical signals are borderline can tip the composite score above the entry threshold, opening a position that would otherwise have been filtered out.

The magnitude of this effect is controlled by `news_signal_weight`. At the v1 seed value (0.10), a high-confidence event moves the composite score by at most +/−0.10 — enough to influence borderline decisions but not enough to override strong opposing technical signals. The adaptation engine can raise or lower this weight based on whether news-influenced entries and exits outperform the baseline.

**What this does not change:**

The agent's decision logic is unchanged. The composite score is computed, thresholds are applied, decisions are made. The news signal is just one more input to that score. It does not create a separate fast-path or override mode. This is intentional — keeping a single decision path means the system remains auditable. Every entry and exit can be explained by the same score + threshold logic regardless of what triggered it.

**Operational constraints:**
- API calls happen on event arrival, not on each tick. At 20–50 news items per day, cost is negligible (~$0.01–0.05/day at current API pricing).
- If the API is unavailable, `news_signal` defaults to 0.0 for all pairs — the system degrades gracefully to 7-signal behaviour.
- In Replay mode, news signals must also be replayed from a stored event log. Every API response is cached with a timestamp; the replay harness injects them at the correct point in the timeline rather than calling the API again.

---

### 4.3 Agent Pool

N instances of a single parameterised `Agent` class. All instances have identical structure; they differ only in their config values and their mode (live or paper).

**Config space (~26 parameters):**

```
Signal weights (8)    cvd_norm_weight, funding_weight, momentum_1h_weight, ...,
                      news_signal_weight

Entry (5)             buy_signal_base
                      buy_signal_per_regime[volatile, trending_up,
                                            trending_down, ranging]

Gates (2)             cvd_buy_min          (flow confirmation)
                      funding_buy_max      (positioning filter)

Exit (5)              sell_signal, cvd_sell_max
                      sell_loss_pct_base, sell_loss_pct_trending_down
                      sell_profit_pct

Sizing (2)            buy_size_pct_base, cash_min_pct

Hold time (2)         deadweight_rounds_min, deadweight_pnl_threshold

Kelly (2)             kelly_min_trades, kelly_cap_multiplier
```

The agent's `decide()` function maps any valid config to a decision. No hardcoded values exist inside it.

**Entry modes:** Three distinct entry strategies are available via config flags:

| Mode | Flag | Behaviour |
|---|---|---|
| `trend_follow_mode` | `entry.trend_follow_mode: true` | Bypasses composite score. Entry gated by 4h macro regime, 15m regime, CVD dip, 1h momentum. Buys pullbacks within confirmed uptrends. |
| `spot_accum_mode` | `entry.spot_accum_mode: true` | BTC only. Buys when macro recovers from capitulation (macro was below threshold, now rising above floor). Long-term accumulation logic. |
| Standard mode | neither flag set | Composite score vs regime-blended threshold. CVD and funding gates applied. |

**Important:** `trend_follow_mode` bypasses most of the standard-mode PARAM_SPACE parameters at entry (buy_signal_per_regime, cvd_buy_min, funding_buy_max) and uses different exit logic (macro_exit instead of signal/cvd exit). See Section 4.5 for adaptation implications.

**Current pool (as of 2026-03-29):**

| Agent | Mode | Strategy | Role |
|---|---|---|---|
| A1 | Live | trend_follow | Primary live TF agent |
| A2 | Live | trend_follow | Primary live TF agent, most adapted (v31+) |
| A3 | Live | spot_accum | BTC accumulation on macro capitulation/recovery |
| A4 | Paper | trend_follow | Scalper variant — tight stops (3%), low TP (10%), short deadweight (10r), aggressive Kelly. Explores fast-exit region of PARAM_SPACE. |
| A5 | Paper | trend_follow | TF explorer |
| A6 | Paper | trend_follow | TF explorer |

Live agents (A1–A3): `LIVE_AGENTS=3`. State is persisted to `data/agent-states/` and reloaded on restart.
Paper agents (A4–A6): `PAPER_AGENTS=3`. State resets on restart by design. A3 was promoted to live specifically because `spot_accum_mode` accumulates positions over days — paper reset destroys this continuity.

**Correlation and diversification:** Empirically measured across ~235 ticks, A1 and A4 show r=0.977 pairwise return correlation; A1/A2/A4 all exit the same pairs at the same timestamps in 56–100% of cases. This is structural: all three see the same tick stream and share identical TF gate thresholds. To generate useful meta-adapt signal, paper agents must explore different regions of PARAM_SPACE — not just different config values near the same region. A4 was explicitly repositioned as a scalper variant (different exit behaviour profile) for this reason.

**Exploration / exploitation split:**
- Live agents exploit the current best-known config, updated via adaptation engine
- Paper agents explore PARAM_SPACE regions not yet tried with real capital, feeding the meta-adapt mechanism

Config updates from the adaptation engine are hot-reloaded. A backup is written before every change. All configs are versioned and tagged on every logged event.

**Config reload:** Hot-reload is via `fs.watch` on each config file. On macOS, atomic file writes (write-to-temp + rename) trigger a `rename` event rather than `change`, which the watcher filters out. For manual config updates, use `POST /config/:id` via the REST API to ensure the running engine receives the new config immediately.

---

### 4.4 Event Store

Append-only structured log. The single source of truth for the entire system. No component modifies or deletes events — corrections are new events that reference the originals.

**Event schema:**

| Type | Key fields |
|---|---|
| `TICK` | pair, timestamp, prices, sub-signals, regime_probs, signal_uncertainty |
| `ENTRY` | agent_id, mode, pair, price, size, entry_signal_score, config_version |
| `EXIT` | agent_id, mode, pair, exit_price, exit_reason, holding_rounds, pnl_pct, config_version |
| `REJECTED` | agent_id, pair, gate_failed, signal_score, regime_probs |
| `CONFIG_UPDATE` | agent_id, old_config, new_config, triggered_by, reason |

**`REJECTED` events** are as important as entries. They record every signal that passed the signal threshold but failed a gate (CVD, funding, max_positions). The adaptation engine uses these to evaluate whether each gate is earning its cost — without them, you cannot distinguish "this gate saved us from a bad trade" from "this gate blocked a good trade."

`config_version` is written on every ENTRY and EXIT so the adaptation engine can correctly attribute outcomes to the config that was active when the trade was taken.

---

### 4.5 Adaptation Engine

Reads from the Event Store. Writes updated configs back to the agent pool.

**Trigger:** Every N effective EXIT events for a given agent (default N=5), re-estimate the optimal config for that agent. Paper exits count as 0.7× (PAPER_DISCOUNT) to account for fill model imprecision.

**Reward signal:** Expectancy per round:
```
reward = weighted_avg(pnl_pct) / weighted_avg(holding_rounds)
```

Exponentially decay-weighted (EXP_DECAY=0.9) so recent trades count more. This penalises holding losers longer than winners and rewards fast, clean exits.

**Update method (Thompson Sampling):** For each parameter, maintain a Gaussian posterior over expected reward delta. At each cycle, sample from the posterior — if the sample is positive, nudge the parameter up by one step; if negative, nudge down; if near zero, skip. Step size is bounded per parameter. A parameter cannot be updated again for COOLDOWN_N cycles after a change.

**Posterior reset:** If the same direction is sampled for RESET_STREAK=3 consecutive cycles on a given parameter, the posterior is wiped and reset to the prior. This prevents stale evidence from locking the system into a config that was optimal under old conditions.

**Meta-adapt (paper → live promotion):** Every META_EVERY_N=3 poll cycles, the engine scores all agents by recent reward. When a paper agent consistently outperforms a live agent by META_MIN_DELTA=0.002 AND holds a meaningfully different value for a given PARAM_SPACE parameter, the live agent's config is stepped one step toward the paper agent's value. Requires META_STABILITY=2 consecutive meta cycles of the same winner before firing.

**PARAM_SPACE coverage and mode coherence:** The 26-parameter PARAM_SPACE was designed for standard-mode agents. For `trend_follow_mode` agents, 11 of these 26 parameters have no effect on behaviour at runtime:

```
No effect in TF mode:
  entry.buy_signal_per_regime.*  — TF bypasses composite score entirely
  entry.cvd_buy_min              — TF uses cvd_1c gate instead
  entry.funding_buy_max          — TF has no funding gate
  exit.sell_signal               — TF uses macro_exit not signal exit
  exit.cvd_sell_max              — same reason
```

This means the adaptation engine wastes cycles tuning these parameters for TF agents (any correlation with reward is spurious), and meta-adapt promotions of these values from a standard-mode paper agent to a TF live agent have no effect. The 15 cross-cutting parameters (signal weights, stop/TP, sizing, deadweight, Kelly) transfer validly across modes.

**Known gap:** TF-specific gate parameters (`trend_follow_macro_min`, `trend_follow_ranging_max`, `trend_follow_regime_min`, etc.) are not in PARAM_SPACE and therefore cannot be tuned by the adaptation engine. These are the most impactful levers for TF agents. Adding them to PARAM_SPACE is the correct structural fix.

Paper agent outcomes feed the same posteriors with a discounting factor (default 0.7×). This allows the engine to learn from paper trades before committing live capital to unexplored config regions.

---

## 5. Data Flow

```
Exchange APIs  (or stored tick log at N×)
      │
      ▼
 Market Data Service
      │  raw ticks
      ▼
 Signal Pipeline  ──────────────────────────────────────┐
      │  market state vectors                           │
      │  (sub-signals + regime probs)                   │
      ├──── Live Agents (exploit posterior mean)         │
      └──── Paper Agents (explore posterior tails)       │
                │                                       │
                ▼                                       │
           Event Store  ◄──────── TICK events ──────────┘
                │
                ├──── Adaptation Engine ──► hot-reload configs ──► Agent Pool
                │
                └──── Evaluation  ──► Dashboard
```

---

## 6. Evaluation

Not a separate component — a set of continuous queries against the Event Store.

**Per-agent (rolling 20-exit window):**
- Expectancy per round (the reward signal)
- Win rate and avg P&L, split by regime probability bucket
- Stop-loss rate and deadweight rate
- Average hold time: winners vs losers separately
- Capital utilisation (% of ticks with ≥1 open position)
- Rolling Sharpe and max drawdown

**Cross-agent:**
- Pairwise P&L correlation (diversification health — high correlation means the pool is not adding coverage)
- Regime overlap: are two agents frequently in the same pair at the same time?

**Benchmark:** Buy-and-hold BTC at the same initial capital. An agent that consistently underperforms this benchmark is destroying value, not preserving it. No inter-agent competition. No survival scoring.

---

## 7. Technology Stack

### 7.1 Reused from v1 (unchanged or minor updates)

| Component | v1 module | Reuse rationale |
|---|---|---|
| Runtime | Node.js | No reason to change. The async event loop maps cleanly to tick-driven trading. |
| Event Store DB | `better-sqlite3` | SQLite is sufficient for append-only structured logs at this data volume. Fast, embedded, no server. Replaces the JSON session files. |
| TUI framework | `blessed` + `blessed-contrib` | Mature, working. The pane architecture (each pane is a module) is clean and carries over directly. |
| Engine↔TUI transport | `ws` (WebSocket) | The pattern of engine pushing state to the dashboard over WebSocket works. Keep it. |
| REST API | `express` | Keep for external tooling (replay control, config inspection, manual overrides). |
| Signal math | `core/signals.js` | RSI, CVD, momentum z-score, volume z-score functions are correct and reusable. Needs two changes: (1) weights removed — callers pass them in from config; (2) regime output changes from label to probability vector. |
| Fill model | `core/executor.js` | Mid-price ± half-spread + taker fee is a reasonable sim fill model. Reuse for both live and paper agents. |
| OpenAI SDK | `openai` (already in package.json) | Used for news signal classification. Already installed. |
| Statistics | `simple-statistics` | Keep for standard deviation and other math helpers. |

### 7.2 Rebuilt from scratch

| Component | Replaces | Why rebuild |
|---|---|---|
| `core/agent.js` | `core/agent.js` + `core/strategy.js` + 4 agent-specific strategy files | v1 has structural differences per agent. v2 needs a single parameterized class where config drives all behaviour. |
| `core/regime.js` | Inline logic inside `world.js` | Regime classification is now a first-class component outputting a probability distribution, not a label embedded in the snapshot. |
| `core/event-store.js` | Sessions JSON files + partial DB logging | Append-only SQLite log with a defined schema covering all event types. Single source of truth. |
| `core/adaptation-engine.js` | `tools/detect-changes.js` | Online, rolling, posterior-based. Not batch. Not rule-based. |
| `core/config-store.js` | `mega-config.json` pattern | Generalised to N agents. Versioned. Hot-reload with backup. Config version tagged on every event. |
| `core/news-signal.js` | Nothing (new) | Event-driven OpenAI calls, decay cache, per-pair score injection into signal vector. |
| `engine.js` | `engine.js` | Engine must be mode-aware (live vs replay). Replay reads from tick log DB at configurable speed. Core tick loop structure is similar but replaces world.js snapshot model. |
| `dashboard/tui.js` + panes | Existing TUI | Layout redesigned for v2 data (agent pool, adaptation state, news feed, performance vs benchmark). Pane module pattern kept. |

### 7.3 Retired (not carried forward)

| v1 module | Reason |
|---|---|
| `core/world.js` | The snapshot/DB-rebuild model is too tightly coupled to v1's 4-agent structure. Replaced by Event Store + Config Store. |
| `tools/export-session.js` | Session boundaries disappear in v2. The Event Store is continuously updated; there is no post-session export step. |
| `tools/report-session.js` | Replaced by the Evaluation queries (continuous, not batch). |
| `tools/compare-sessions.js` | Replaced by the Adaptation Engine's rolling posterior, which tracks trends across all trades continuously. |
| `tools/detect-changes.js` | Replaced by the Adaptation Engine. |

---

## 8. File Structure

All v2 code lives under the `v2/` subdirectory of the repository root. v1 remains untouched alongside it.

```
v2/
  engine.js                        Main loop — tick source, candle detection, dispatch
  api.js                           Express REST + WebSocket server

  core/
    signals.js                     Signal computation (weights injected from config)
    regime.js                      Probabilistic regime classifier
    agent.js                       Parameterized Agent class (single class, all instances)
    executor.js                    Fill model — mid ± spread + fee
    event-store.js                 Append-only SQLite event log
    adaptation-engine.js           Posterior estimation + config update logic
    config-store.js                Versioned config management + hot-reload
    news-signal.js                 News event processor (OpenAI) + decay cache

  tools/
    replay.js                      Tick log replay at configurable speed

  data/
    ticks.db                       SQLite: raw tick log (one row per tick per pair)
    events.db                      SQLite: event store (TICK, ENTRY, EXIT, REJECTED, CONFIG_UPDATE, NEWS)
    configs/
      agent-{id}.json              Current config per agent
      agent-{id}.{timestamp}.json  Versioned backups

  dashboard/
    tui.js                         Screen layout + pane wiring
    ws-client.js                   WebSocket client
    panes/
      pool.js                      Agent pool overview
      signals.js                   Per-pair signal vectors + regime probs
      adaptation.js                Posterior state + recent config changes
      news.js                      News event feed + decay state
      performance.js               Rolling expectancy vs BTC benchmark
      log.js                       Event stream
      controls.js                  Mode controls + commands

  package.json                     Independent from v1 — own dependencies
  .env                             API keys, ports, config
```

---

## 9. TUI Layout

The TUI follows the same architectural pattern as v1 — `blessed` panes wired to WebSocket push from the engine — but redesigned for the new data model.

```
┌────────────────────────────────────┬──────────────────────┬──────────────────┐
│  AGENT POOL                         │  SIGNALS              │  ADAPTATION      │
│                                     │                       │                  │
│  ID   Mode   Cap      Pos  Expect.  │  Pair    Score  Reg%  │  Param  Val  Δ   │
│  A1   LIVE   $4,821   2    +0.12r   │  BTC     +0.31  T↑60  │  buy_s  .21  ↑   │
│  A2   LIVE   $5,103   1    +0.08r   │  ETH     +0.08  R 55  │  sl%    6.0  ~   │
│  A3   PAPER  –        0    +0.19r   │  SOL     -0.14  T↓70  │  dw_r   9    ↓   │
│  A4   PAPER  –        2    -0.03r   │  BNB     +0.22  V 40  │  news_w .10  ~   │
│  A5   PAPER  –        0    +0.14r   │  ...                  │                  │
│  A6   PAPER  –        1    +0.06r   │  [scrollable]         │  Last update:    │
│                                     │                       │  A1 buy_s 0.23→  │
│  BTC benchmark: +3.2% (30d)         │                       │  0.21  (12 exits)│
├────────────────────────────────────┤                       │                  │
│  PERFORMANCE                        │                       │                  │
│                                     ├───────────────────────┤                  │
│  ▁▂▃▄▃▅▆▅▆▇  Live agents (avg)      │  NEWS                 │                  │
│  ▁▁▂▁▂▂▃▂▃▄  BTC benchmark          │                       │                  │
│                                     │  14:32 BTC  bearish H │                  │
│  Expectancy:  +0.11r/round           │  ↳ Binance: BTC margin│                  │
│  Sharpe:      1.42                  │  requirements raised  │                  │
│  Max DD:      -4.1%                 │  Decay: 87min left    │                  │
│                                     │                       │                  │
├─────────────────────────────────────┴───────────────────────┴──────────────────┤
│  LOG                                                                            │
│  14:33:01  A1  ENTRY  BTC/USDT  $963 @ $84,210  score=+0.31  T↑0.60  cfg=v7   │
│  14:33:01  A3  ENTRY  BTC/USDT  $0 (paper)      score=+0.31  T↑0.60  cfg=v3   │
│  14:28:44  A2  EXIT   ETH/USDT  +2.3%  thesis_faded  held=6r  cfg=v5          │
│  14:15:00  ENGINE  CONFIG_UPDATE  A1  buy_signal 0.23→0.21  (12 exits, +0.14r) │
│  14:10:22  NEWS    BTC bearish HIGH  decay=120min  score=-1.0                  │
│  [scrollable, colour-coded by event type]                                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│  CONTROLS   [L] Live  [R] Replay  [+/-] Speed  [P] Pause  [Q] Quit             │
│  Mode: LIVE  │  Agents: 2 live / 4 paper  │  Uptime: 4h 23m  │  Events: 14,821 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**Pane responsibilities:**

`pool.js` — One row per agent. Columns: ID, mode (LIVE/PAPER), current capital (live only), open positions count, rolling expectancy per round, config version. BTC benchmark return shown below. Sorted by expectancy descending so best-performing config is always at top.

`signals.js` — One row per pair. Shows composite signal score, dominant regime + probability (e.g. `T↑60` = trending_up at 60%), and news signal contribution if active. Colour-coded: green = entry-eligible score, red = exit pressure, white = neutral.

`adaptation.js` — Current posterior mean per adaptable parameter, direction of last change (↑/↓/~), and the trigger that caused it (N exits, reward signal). Shows the last 3 config update events with full justification.

`news.js` — Feed of recent news events. Each entry shows: timestamp, affected pair, direction (bullish/bearish), confidence, source headline, and remaining decay time. Colour-coded by direction.

`performance.js` — Dual sparkline: live agent average expectancy vs BTC buy-and-hold, both rolling over the last 50 exits. Summary stats below: expectancy, Sharpe, max drawdown.

`log.js` — Scrollable event stream. Colour-coded: entries (green for live, grey for paper), exits (yellow for profit, red for loss), config updates (cyan/magenta for meta-adapt), news events, rejected signals (dim). Tabbed by agent (All / A1–A6 / Adapt / News). Entry and exit lines include the execution price (`@price`) for immediate context.

`controls.js` — Status bar at bottom. Mode toggle (Live/Replay), replay speed control, pause. In Replay mode, shows current replay timestamp and speed multiplier.

---

## 10. Implementation Phases

Each phase answers a specific question. The gate must be satisfied before the next phase begins. No phase is started on the live system until it passes on replay.

---

### Phase 1 — Can we observe?

**Goal:** A complete, replayable record of market state. No agents, no trading.

**Build:**
- `data/ticks.db` schema: one row per tick per pair (`pair, timestamp, mid, bid, ask, spread, volume, funding_rate, open_interest, fear_greed`)
- `core/signals.js` update: remove hardcoded weights; add `signal_uncertainty` output; add probabilistic regime output from `core/regime.js`
- `core/regime.js`: new. Takes price history per pair, outputs `{ p_volatile, p_trending_up, p_trending_down, p_ranging }`
- `engine.js`: live mode writes every tick to `ticks.db`. Candle detection logic carried over from v1.
- `tools/replay.js`: reads `ticks.db`, replays through Signal Pipeline at N× speed, prints signal vectors to stdout
- `data/events.db` schema: create all tables (`TICK, ENTRY, EXIT, REJECTED, CONFIG_UPDATE, NEWS`) even though only TICK is written in this phase
- TUI Phase 1: `signals.js` pane + `log.js` only. Verify regime probs display correctly as market moves.

**Gate:** Run `tools/replay.js` against 30 days of stored ticks. Every pair shows a complete signal vector including regime distribution at every candle. Signal uncertainty field populated. Regime probs sum to 1.0 at all times. The same replay run produces identical output on repeat (determinism check).

---

### Phase 2 — Can we trade?

**Goal:** Agents making decisions, every event logged, nothing hardcoded.

**Build:**
- `core/agent.js`: single parameterized class. Constructor takes `{ id, mode, config }`. `decide(marketStateVector)` returns action with no hardcoded values. `mode: 'live' | 'paper'` flag; paper agents skip executor.
- `core/config-store.js`: reads/writes `data/configs/agent-{id}.json`. Writes backup before every change. Exposes `getConfig(id)`, `setConfig(id, config)`, `getVersion(id)`.
- `core/executor.js`: reuse from v1. Minor update: accepts agent mode, skips real capital modification for paper agents but still returns a fill event.
- `core/event-store.js`: wrapper around `events.db`. Exposes `append(event)`, `query(filters)`. All event types write here.
- `engine.js`: initialise agent pool from config store. Each tick: compute market state vectors → dispatch to all agents → log decisions → execute fills → log entries/exits/rejected.
- TUI Phase 2: add `pool.js` pane. Add `performance.js` pane (BTC benchmark line only until enough exits exist).

**Gate:** After 10 live sessions: every ENTRY has a matching EXIT, every REJECTED has a `gate_failed` field, `config_version` on every event matches the config that was active at that timestamp. Verify by querying `events.db` directly. No hardcoded values remain in `agent.js` — confirmed by passing a deliberately bad config and verifying the agent behaves accordingly.

---

### Phase 3 — Can we learn?

**Goal:** Configs update automatically based on outcomes. Paper agents explore; live agents exploit.

**Build:**
- `core/adaptation-engine.js`: reads EXIT events from the event store, maintains per-parameter posteriors, writes CONFIG_UPDATE events, triggers config-store updates. Runs as a separate process polling the event store every 60 seconds (not in the main engine loop).
- Paper agent configs: on startup, sample N configs from the posterior tails for paper agents. Re-sample each time a paper agent's config converges toward the live agent's config (cosine similarity > 0.90).
- Config hot-reload in `engine.js`: watch `data/configs/` for changes, reload agent configs without restart.
- TUI Phase 3: add `adaptation.js` pane showing posterior state and recent CONFIG_UPDATE events.

**Gate (on replay before live):** Construct synthetic tick data where the true optimum is a known config (e.g. buy_signal=0.25 is best). Seed the adaptation engine with a deliberately bad starting config (buy_signal=0.15). Run 500 synthetic exits. Verify the engine converges buy_signal toward 0.25 within 300 exits. If it doesn't converge, the posterior update logic or reward signal is wrong — fix before live deployment.

**Gate (live):** After 20 sessions: at least one CONFIG_UPDATE event per agent. The config version on ENTRY events is advancing. Live agent expectancy in rolling window is not declining.

---

### Phase 4 — Can we lead?

**Goal:** News signal active, influencing composite scores, validated by replay.

**Build:**
- `core/news-signal.js`: monitors RSS feeds and curated sources. On new item: calls OpenAI API with structured prompt, parses response, stores `{ pair, score, timestamp, decay_window, source, rationale }` in the `NEWS` event table. Exposes `getScore(pair, now)` returning current decayed value.
- Signal pipeline update: inject `news_signal` as 8th sub-signal from the decay cache. If no news event active for a pair, value is 0.0.
- Agent config: add `news_signal_weight` (seed: 0.10). Adaptation engine can raise or lower it like any other weight.
- Replay support: `tools/replay.js` reads NEWS events from `events.db` and injects them at the correct timestamp instead of calling the API. Verify replay with news events produces identical composite scores to the original live run.
- TUI Phase 4: add `news.js` pane.

**Gate:** Run 10 sessions with news signal active. Query `events.db` for all ENTRY events where `news_signal != 0`. Compare win rate and avg P&L of news-influenced entries vs entries with `news_signal = 0` in the same regime bucket. If news-influenced entries have no measurable difference in outcome, the adaptation engine should converge `news_signal_weight` toward zero on its own — confirm this happens.

---

### Phase 5 — Does it compound?

**Goal:** Validate the full system over time. No new features — measurement and tuning only.

**Tasks:**
- Run 60+ sessions with full system active. Track rolling expectancy per agent vs BTC benchmark.
- Run signal weight logistic regression: from ENTRY + EXIT pairs in `events.db`, fit a logistic model of (win/loss) on the 8 sub-signal values at entry. Compare fitted coefficients to current `news_signal_weight` and the 7 technical weights. Propose weight adjustments if coefficients diverge significantly.
- Tune N (adaptation trigger), step sizes, and paper agent discount factor empirically based on Phase 3–4 data.
- Identify whether paper agent configs ever converge to the live agent's config without improvement — if so, increase exploration sampling variance.

**Gate:** Live agent rolling expectancy > 0 for 30 consecutive sessions, and > BTC benchmark over the same window on a risk-adjusted basis (Sharpe).

---

## 11. Path to Real Execution

The simulation system is designed so that transitioning to real Binance execution requires no architectural change — only a configuration of an existing layer.

### 11.1 Core Insight

The `live`/`paper` distinction already exists in the agent pool. Live agents run the adaptation engine's posterior mean (exploit best known config) and their exits carry full weight (1.0×) in the reward signal. They are already the "production candidates." Making one of them real is a one-line env var gate around the executor, not a new architectural layer.

No separate "real agent" slot is needed. No discrete promotion event. The system already has the right structure.

### 11.2 Agent Roles at Real Deployment

```
A1   live   balanced     ← REAL_TRADING=true → orders hit Binance
A2   live   momentum     ← staging: sim only, full-weight signal (1.0×)
A3   paper  flow         ← explore
A4   paper  contrarian   ← explore
A5   paper  aggressive   ← explore
A6   paper  conservative ← explore
```

**A1** is the production agent. Its config is continuously improved by the adaptation engine using real exit signal (no discount). It trades one position at a time within its configured max_positions and cash_min_pct limits.

**A2** is the staging agent. It runs alongside A1 with live-quality signal but no real execution. If A2 consistently outperforms A1 over a meaningful exit window, its config is copied to A1 (hot-reloaded). A2 then resets its posteriors and continues exploring. This is the only "promotion" mechanism, and it compares two live-quality agents — not paper vs real.

**Paper agents** explore parameter regions live agents haven't committed to. Their exits feed the same posteriors with a 0.7× discount. Over time, if a paper agent finds a better parameter direction, the adaptation engine propagates it to live agents naturally through the posterior update cycle — no explicit promotion needed.

### 11.3 What Changes in the Executor

`core/executor.js` (v1) already contains the full Binance integration: HMAC-signed requests, market BUY via `quoteOrderQty`, market SELL by fetching real balance, fee extraction from fills, and state reconciliation. The only changes needed for v2:

1. **Mode gate** — wrap execution in `if (agent.mode === 'live' && REAL_TRADING)`. Paper agents and non-real live agents continue using `simEntry`/`simExit` unchanged.
2. **State sync** — before each tick, call `syncRealState(agent, prices)` to reconcile A1's in-memory capital and positions from real Binance balances. This prevents drift between sim accounting and exchange reality.
3. **Fill events** — replace `simEntry`/`simExit` return values with actual fill data from the Binance order response (executed quantity, fill price, real fees). The event store schema is unchanged — the fill fields are the same whether sim or real.

### 11.4 Safety Controls

Carried forward directly from v1:

- **Per-order cap** (`REAL_TRADING_MAX_ORDER_USD`, default $50) — hard ceiling on any single order regardless of Kelly sizing
- **Daily loss circuit breaker** (`REAL_TRADING_DAILY_LOSS_PCT`, default 5%) — halts all real orders for the calendar day if total account value drops more than the threshold from the day's opening value
- **Runtime toggle** — `setRealTrading(true/false)` callable at runtime via TUI key, so execution can be suspended without stopping the engine or losing agent state
- **Minimum trade size** — skip BUY orders below $10 (Binance minimum notional)

### 11.5 What Does Not Change

The following components are entirely unaffected by real execution:

- Signal pipeline — same inputs, same outputs
- Agent `decide()` logic — same config format, same decision path
- Adaptation engine — sees real exit events as high-quality signal (1.0×), updates config naturally
- Event store — same schema; real fills populate the same fields as sim fills
- TUI — no changes needed; A1's real positions appear in the pool pane identically to sim positions
- Config hot-reload — config improvements from the adaptation engine apply to the real agent immediately

The system's design constraint — that every component is mode-agnostic — holds. Real execution is a property of the executor call site, not of the architecture.

---

## 12. Open Questions

**Q1: Paper agent discount factor**
The 0.7× discount on paper outcomes is a guess. The right value depends on how much the fill model diverges from real fills. Measure this after Phase 2 by comparing paper-projected P&L against the same trades executed live, and calibrate the discount empirically.

**Q2: How many paper agents?**
More paper agents = faster config space coverage but more noise in the posteriors from imprecise fills. Start with 4 paper agents to 2 live; adjust ratio once the fill model discount is calibrated.

**Q3: Joint vs independent parameter updates**
Treating parameters as independent is an approximation — `buy_signal` and `sell_loss_pct` interact. Independent updates are fast to implement and usually sufficient for well-separated parameters. If the adaptation engine is not converging after Phase 5, switch to joint updates (Bayesian optimisation over the full config vector). Don't build this complexity upfront.

---

*This document describes architecture and does not prescribe deployment environment beyond the technology stack in Section 7.*
