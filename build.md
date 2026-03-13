# build.md — Developer Activity Log

Running log of all code changes made to agent-battle-gpt. Most recent first.

---

## 2026-03-13

### Observation — MEGA sitting flat due to over-tightened ranging threshold
MEGA's `regime_overrides.ranging.buy_signal` is currently **0.31** (raised from 0.28 over multiple proposals).
In the current predominantly ranging market, no pair's `signal_score` is crossing that bar, so MEGA holds 100% cash and issues HOLDs every tick.

This is the loosen rules (Rule 6/7) failing to fire in time — they need 3 sessions of A/B/G win rate > 70% or avg PnL > 0.50% to trigger, but by the time that data accumulates, MEGA has been idle for many sessions and has generated zero stop-loss or PnL data of its own.

The `trending_up` override is 0.21 after recent proposals, but the market has stayed predominantly ranging since those proposals were applied.

**Root cause**: the proposal loop keeps tightening `ranging.buy_signal` based on A/B/G struggling (low win rates), but doesn't loosen it fast enough when MEGA becomes so selective it never enters.
**To watch**: whether Rule 6/7 fires to loosen `ranging.buy_signal` after a session where A/B/G combined ranging win rate > 70%.

---

### Fix — Proposal overlay reappears after applying/rejecting (api.js → v1.0.6)
`_applyMegaChange` never deleted `mega-changes-proposed.json`. After Y or N, the file remained on disk, so every subsequent TICK broadcast included `proposalReady: true`, and the next P keypress re-showed the same stale overlay.

Fixed by adding `fs.unlinkSync(PROPOSED_FILE)` at the end of `_applyMegaChange` (both approved and rejected paths).

| File | Version |
|---|---|
| `api.js` | `1.0.5` → `1.0.6` |

---

### Feature — Stop-loss exit rate metrics + Rule 8 (report-session.js, compare-sessions.js, detect-changes.js)
Extends the proposal pipeline to detect when MEGA's `sell_loss_pct` is too tight.

**report-session.js** — `regimeStats` per agent now includes:
- `stopLossRate`: % of trades in that regime that exited via stop_loss
- `avgHoldRounds`: average rounds held per trade in that regime
Both fields appear in the regime breakdown table of the markdown report (⚠ flag when stop_loss > 50%).

**compare-sessions.js** — two new trend arrays added to `trends.json`:
- `agentRegimeStopLossRate[agent][regime]` — per-session stop-loss rate
- `agentRegimeAvgHoldRounds[agent][regime]` — per-session avg hold duration
Also updated the latest-diff.md regime table to show SL% and Avg Hold columns.

**detect-changes.js** — Rule 8 added:
- A/B/G combined stop_loss exit rate > 50% for 3+ sessions in a regime
  → propose raising `regime_overrides.{regime}.sell_loss_pct` by 1pp
- Confidence level: `REGIME_SESSIONS_MIN + 1` (higher than buy_signal rules — stop-loss changes carry more risk)
- Hard ceiling at 12% (never propose above that)
- New constants: `STOP_LOSS_HIGH_THRESHOLD=50`, `SELL_LOSS_STEP=1`, `SELL_LOSS_CEILING=12`

Old analysis files that pre-date this change will simply have no `stopLossRate` in their `regimeStats` —
`buildCombined` handles shorter arrays gracefully, so new sessions populate the arrays going forward.

| File | Version |
|---|---|
| `tools/report-session.js` | no version constant |
| `tools/compare-sessions.js` | no version constant |
| `tools/detect-changes.js` | no version constant |

---

### Feature — Macro trend in SIGNALS panel (signals.js → v1.0.0, tui.js → v1.0.1)
`BTC Macro: ↑ BULL / ↓ BEAR / ~ NEUTRAL` header row added to the top of the SIGNALS pane.
`signals.update()` now accepts a second `macroTrend` argument — tui.js passes `snap.macroTrend`.
A separator line follows the macro header before the per-pair signal rows.
signals pane VERSION introduced at `1.0.0`; added to the boot log line.

| File | Version |
|---|---|
| `dashboard/panes/signals.js` | introduced `1.0.0` |
| `dashboard/tui.js` | `1.0.1` (no bump — boot log only) |

---

### Feature — Macro bull/bear signal + proposal hint in status bar (core/signals.js → v1.0.1, engine.js → v1.0.6, api.js → v1.0.5, controls.js → v1.0.3)
The system previously had no macro market direction awareness — only short-term per-pair regime.

**Macro trend**: BTC 200-day SMA vs current price. Price > SMA200 by >2% → `bull`. Price < SMA200 by >2% → `bear`. Within ±2% buffer → `neutral`. Falls back to SMA50 if < 200 daily bars available.

**Implementation**:
- `signals.js`: added `computeMacroTrend(dailyCloses)` — pure function, exported
- `engine.js`: fetches BTC `1d` 200-bar klines at warmup (parallel with price history warm). Re-fetches once every 24h on candle close. Stores `_macroTrend` string, exposes `getMacroTrend()`
- `api.js`: adds `macroTrend` and `proposalReady` to every TICK and initial STATE broadcast
- `controls.js`: status bar now shows `BTC: ↑ BULL` / `↓ BEAR` / `~ NEUTRAL` and `★ Proposal ready — press [P]` when a proposal file exists

| File | Version |
|---|---|
| `core/signals.js` | `1.0.0` → `1.0.1` |
| `engine.js` | `1.0.5` → `1.0.6` |
| `api.js` | `1.0.4` → `1.0.5` |
| `dashboard/panes/controls.js` | `1.0.2` → `1.0.3` |

---

## 2026-03-12

### Fix — Proposal overlay shown immediately after pipeline finishes (api.js → v1.0.4)
Previously the `PROPOSAL` event was only broadcast inside `case 'stop'` (manual P key pause).
After an auto-stop triggered by SESSION_TRADES, the pipeline ran and wrote the proposed file but
the engine restarted without ever showing the overlay. Same for forced `run_pipeline` (N key).

Added `_broadcastProposalIfReady()` helper that reads and broadcasts the proposed file if it exists.
Called at the end of `_runPostSession`'s `close` handler — after PIPELINE done is broadcast, before
`engine.start()`. The `case 'stop'` check is kept for when the server restarts with a stale file.

| File | Version |
|---|---|
| `api.js` | `1.0.3` → `1.0.4` |

---

### Fix — detect-changes.js now uses A/B/G combined data instead of MEGA (detect-changes.js)
MEGA has sparse session data (only accumulates entries when it actually trades in a given regime).
Using MEGA's own data meant rules almost never fired.

Changed to use a session-aligned combined mean across A/B/G agents as the regime performance signal.
A/B/G trade every session, making them a reliable proxy for market regime conditions.
The logic: if A/B/G collectively struggle in a regime → raise MEGA's entry bar; if they thrive → lower it.

**`buildCombined(dataByAgent)`** helper: for each regime, aligns each A/B/G agent's array to the right
(shorter arrays = agent didn't trade that regime in early sessions) and computes a per-session mean
across all agents that have data for each position.

Rule 3 (peer-vs-MEGA comparison) removed — no longer applicable without a MEGA baseline.
Rules 1, 2, 6, 7 now use `combinedWinRates` and `combinedAvgPnl` instead of MEGA-specific arrays.

| File | Version |
|---|---|
| `tools/detect-changes.js` | no version constant |

---

### Fix — MEGA badge not updating on O keypress; template literal crash (agents.js → v1.0.3, tui.js → v1.0.1, controls.js → v1.0.2, api.js → v1.0.3)
Two separate bugs prevented the `⚡ LIVE` / `○ SIM` badge from updating when pressing `O`:

**Bug 1 — Template literal typo in agents.js** (crash, `ReferenceError: yellow is not defined`)
`{/${yellow-fg}` in the MEGA LIVE summary line was a broken template expression — JS tried to evaluate `${yellow-fg}` as `yellow - fg`. Only triggered when `realTrading=true` caused the MEGA LIVE line to render. Fixed: changed to `{/yellow-fg}`.

**Bug 2 — Badge update required server round-trip** (silent, no crash)
The badge update path was: O keypress → WS command → server → broadcast TICK → TUI render.
This worked but was async, and the initial `STATE` message sent on connection didn't include `realTrading`, so the badge was always `○ SIM` after reconnect until the next real tick.
Fixed by:
- `controls.js`: calls `callbacks.onRealTradingToggle(megaOnline)` immediately on O keypress
- `tui.js`: caches `lastSnap` on every tick; `onRealTradingToggle` callback calls `agents.update({ ...lastSnap, realTrading: enabled }, lastPrices, [])` immediately
- `api.js`: `STATE` message on new WS connection now includes `realTrading`, `sellCounts`, `sessionTrades`

| File | Version |
|---|---|
| `dashboard/panes/agents.js` | `1.0.2` → `1.0.3` |
| `dashboard/tui.js` | `1.0.0` → `1.0.1` |
| `dashboard/panes/controls.js` | `1.0.1` → `1.0.2` |
| `api.js` | `1.0.2` → `1.0.3` |

---

### Feature — TUI keys O/M to toggle MEGA real trading at runtime (executor.js → v1.0.2, api.js → v1.0.2, controls.js → v1.0.1)
Keys `O` (online) and `M` (offline) toggle MEGA real trading without restarting. Session export moved to `N`.

| File | Version |
|---|---|
| `core/executor.js` | `1.0.1` → `1.0.2` |
| `api.js` | `1.0.1` → `1.0.2` |
| `dashboard/panes/controls.js` | `1.0.0` → `1.0.1` |

Changes:
- `executor.js`: `REAL_TRADING` is now a mutable runtime flag. `setRealTrading(bool)` updates it and mutates `module.exports.REAL_TRADING` so callers reading it dynamically see the new value.
- `api.js`: `set_real_trading` command calls `executor.setRealTrading()` and immediately broadcasts a TICK so the TUI `⚡ LIVE` badge updates. Reads `executor.REAL_TRADING` dynamically on every TICK.
- `controls.js`: `O` = MEGA online, `M` = MEGA offline, `N` = force session export (was `M`).

---

### Fix — MEGA always excluded from Portfolio Overview; sim start capital $500 (world.js → v1.0.2, agents.js → v1.0.1)
MEGA's funds were being mixed into the A/B/G combined P&L when `REAL_TRADING=0`.

| File | Version |
|---|---|
| `core/world.js` | `1.0.1` → `1.0.2` |
| `dashboard/panes/agents.js` | `1.0.0` → `1.0.1` |

Changes:
- `world.js`: MEGA starts at `$500` (sim mode) instead of `INITIAL_CAPITAL`. Configurable via `MEGA_INITIAL_CAPITAL` env var. `totalInjected` updated in both first-run seed and DB rebuild paths.
- `agents.js`: `simAgents` always excludes MEGA regardless of `realTrading`. `simStart` always uses `SIM_START` ($30k). `(A/B/G sim)` label in Portfolio Overview now always visible.

---

### Feature — MEGA LIVE display in Portfolio Overview (agents.js v1.0.0, api.js → v1.0.1, engine.js → v1.0.3, executor.js → v1.0.1)
When `REAL_TRADING=1`, the Portfolio Overview separates real MEGA from simulated A/B/G.

| File | Version |
|---|---|
| `dashboard/panes/agents.js` | introduced `1.0.0` |
| `api.js` | `1.0.0` → `1.0.1` |
| `engine.js` | `1.0.2` → `1.0.3` |
| `core/executor.js` | `1.0.0` → `1.0.1` |

Changes:
- `executor.js`: added `syncMegaState(world, prices)` — fetches real Binance balances and patches MEGA's capital/holdings in the world snapshot before each tick so strategy decisions use real state
- `engine.js`: calls `syncMegaState` before building agent contexts; bumped version
- `api.js`: broadcasts `realTrading: REAL_TRADING` in every TICK message so TUI knows the mode
- `agents.js`: when `realTrading`:
  - Sim P&L (Committed/Total Assets/P&L) excludes MEGA — shows A/B/G only with $30k base
  - Summary bar shows dedicated `MEGA LIVE: $X  P&L: X%  USDT:$X  Crypto:$X` line
  - MEGA box shows `⚡ LIVE` badge instead of the green dot

---

### Fix — detect-changes.js missing loosening rules (detect-changes.js — no version)
The change detection pipeline only had rules to tighten MEGA's thresholds (raise buy_signal,
downweight signals). There was no mechanism to loosen thresholds when MEGA was being too selective.
Added two new rules:
- **Rule 6**: Win rate > 70% for 3+ sessions → lower buy_signal (too selective, missing volume)
- **Rule 7**: Avg PnL > 0.50% for 3+ sessions → lower buy_signal (strong edge, room to capture more)
Added `looseRegimeCandidate()` helper with a floor at 0.05 (never propose going below that).
Added constants: `REGIME_HIGH_THRESHOLD=70`, `EXPECTANCY_HIGH=0.50`, `BUY_SIGNAL_FLOOR=0.05`.

| File | Version |
|---|---|
| `tools/detect-changes.js` | no version constant |

---

### Feature — Real Binance execution for MEGA (executor.js v1.0.0, engine.js → v1.0.2)
New `core/executor.js` module executes MEGA's decisions as real Binance market orders.
Off by default — requires `REAL_TRADING=1` in `.env` to activate.

| File | Version |
|---|---|
| `core/executor.js` | introduced `1.0.0` |
| `engine.js` | `1.0.1` → `1.0.2` |

`.env` variables:
- `REAL_TRADING=0` — set to `1` to enable (default off)
- `BINANCE_API_KEY` / `BINANCE_API_SECRET` — required when enabled
- `REAL_TRADING_MAX_ORDER_USD=50` — hard cap per order
- `REAL_TRADING_DAILY_LOSS_PCT=0.05` — halt all orders if account drops 5% in a day

Safety controls:
- BUY uses `quoteOrderQty` (spend exactly X USDT, capped at MAX_ORDER_USD)
- SELL fetches real Binance balance and liquidates full position
- Daily loss tracker halts all orders if account value drops ≥ limit vs start-of-day
- Never crashes the sim — all errors are caught and logged with `[EXECUTOR]` prefix
- MEGA config changes always require manual Y/N approval (proposal overlay unchanged)

---

### Fix — Warmup must complete before first tick (engine.js → v1.0.1)
Signals on the first tick were computed against empty/flat price history because `_warmHistory`
ran in the background with no guarantee it finished before the user hit [P]. This caused RSI=50
for all pairs and astronomical momentum z-scores (e.g. 1898) due to near-zero stddev.
Fixed by storing the warmup promise and `await`ing it inside `runTick`. After the first tick
the promise is already resolved so subsequent ticks pay zero overhead.

| File | Version |
|---|---|
| `engine.js` | `1.0.0` → `1.0.1` |

---

### Fix — TUI duplicate entries when filtering by agent (log.js → v1.0.1)
When filtering by agent (e.g. ALPHA), each trade showed twice: the trade label line and the reasoning
sub-line (↳) both had `agent` set and `hold=false`, so both passed the agent filter.
Fixed by marking the reasoning line `hold=true` — it now appears in ALL view but is suppressed in
agent-filtered view, matching the same behaviour as HOLD entry sub-lines.

| File | Version |
|---|---|
| `dashboard/panes/log.js` | `1.0.0` → `1.0.1` |

---

### Tuning — agent cash deployment (world.js → v1.0.1)
Agents were holding too much cash due to overly conservative thresholds and signal dampening in ranging regime.

| File | Version |
|---|---|
| `core/world.js` | `1.0.0` → `1.0.1` |

Changes:
- `REGIME_MULTIPLIERS.ranging`: `0.9` → `1.0` — stop dampening signals in ranging market
- ALPHA `ranging` regime `buy_signal`: `0.18` → `0.12` — same bar as trending_up
- BETA `funding_buy_min`: `0.40` → `0.20` — enter on moderate crowded shorts, not just extremes
- BETA `fear_buy_max`: `25` → `40` — enter on moderate fear (F&G < 40), not just extreme fear
- GAMMA `cash_min_pct`: `0.40` → `0.30` — allow up to 70% deployment (was 60%)
- GAMMA archetype constraint text updated to reflect 30% cash floor

---

## 2026-03-11 (previous session)

### Feature — VERSION constants across all files
Added `const VERSION = '1.0.0'` to every modified file. Logged at startup:
- Server console: `[BOOT] api@x  engine@x  world@x  strategy@x  signals@x`
- TUI log pane: `versions — tui@x  log@x  controls@x`

| File | Version |
|---|---|
| `api.js` | introduced `1.0.0` |
| `engine.js` | introduced `1.0.0` |
| `core/world.js` | introduced `1.0.0` |
| `core/strategy.js` | introduced `1.0.0` |
| `core/signals.js` | introduced `1.0.0` |
| `dashboard/tui.js` | introduced `1.0.0` |
| `dashboard/panes/log.js` | introduced `1.0.0` |
| `dashboard/panes/controls.js` | introduced `1.0.0` |
| `dashboard/ws-client.js` | introduced `1.0.0` |

### Feature — Combined sell-count session trigger (api.js)
Changed session export trigger from 2-of-3 quorum to combined A+B+G total.
- `SESSION_TRADES` env var now means total sells across all agents combined
- Easier/faster to reach quorum in slow markets

### Feature — CANDLE event (engine.js, api.js, dashboard/*)
When a new candle closes, a `CANDLE` event is emitted, logged to console `[CANDLE]`, broadcast to TUI log pane in blue.
- Added `case 'CANDLE'` to `ws-client.js` dispatch
- Added `onCandle()` to `log.js` (blue `▶ message` with timestamp)
- Added `onLogHistory` replay support for CANDLE events

### Fix — MEGA config hot-reload (world.js, strategy.js, api.js)
`mega-config.json` was loaded once at startup with `const`. Config changes written to disk were not applied until restart.
- Changed to `let` in both `world.js` and `strategy.js`
- Added exported `reloadMegaConfig()` to both
- Called from `_applyMegaChange()` in `api.js` after writing config

### Fix — Regime misclassification (core/signals.js)
`ranging` was returned for slow downtrends because `adxProxy > 1.5` was too strict.
- Lowered threshold from `1.5` to `1.1`
- Added slope-based fallback: `|smaSlope| > 0.003` counts as trending
- Added interval-aware volatility annualisation via `BARS_PER_YEAR` table

### Fix — TUI log duplicates on reconnect (dashboard/panes/log.js)
`onLogHistory` was appending on top of existing entries, causing duplicates.
- Added `log.clear()` call before replaying history

### Feature — `ts` timestamp in events.jsonl (api.js)
`_appendEventLog` now stamps every entry with `ts: Date.now()`.
