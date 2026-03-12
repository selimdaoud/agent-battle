# build.md — Developer Activity Log

Running log of all code changes made to agent-battle-gpt. Most recent first.

---

## 2026-03-12

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
