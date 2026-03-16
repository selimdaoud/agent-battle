# agent-battle-gpt — Session Context

Last updated: 2026-03-14

---

## Project Overview

Live crypto trading simulation with 4 competing AI agents (ALPHA, BETA, GAMMA, MEGA) trading 15 Binance pairs. Node.js backend (`api.js` + `engine.js`), TUI dashboard (`dashboard/tui.js`), SQLite DB (`data/sim.db`).

- `npm run api` — starts the engine + API server
- `npm run dashboard` — starts the TUI (can run independently, engine keeps running if TUI closes)
- `npm run reset` — wipes DB and session files (requires typing RESET)
- `npm run shutdown` — sends HTTP shutdown to api.js (requires typing SHUTDOWN)

---

## Agent Profiles

| Agent | Archetype | Starting Capital | Notes |
|---|---|---|---|
| ALPHA | Momentum Rider | $1,000,000 | Must hold ≥1 position; high cash = survival penalty |
| BETA | Contrarian | $1,000,000 | Seeks oversold assets; avoids pairs ALPHA+GAMMA both hold |
| GAMMA | Risk Manager | $1,000,000 | High quality bar; tighter stop-loss; take-profit logic |
| MEGA | Autonomous | $500 (env: MEGA_INITIAL_CAPITAL) | Can do real Binance trading; separate P&L baseline |

Env: `INITIAL_CAPITAL=1000000`, `MEGA_INITIAL_CAPITAL` defaults to 500.

---

## Key Files

| File | Version | Role |
|---|---|---|
| `api.js` | 1.0.8 | Express + WebSocket server, AI assistant `/ask` endpoint |
| `engine.js` | — | Tick loop, macro trend refresh, intra-candle stop-loss |
| `core/world.js` | 1.0.4 | Agent state, DB persistence, `_rebuild()` on startup |
| `core/signals.js` | — | Signal computation, Fear & Greed fetch (cached 1h) |
| `core/strategy.js` | — | `decide()` per agent, `intraStopLoss()`, MEGA sizing |
| `core/agent.js` | — | LLM personality synthesis via OpenAI |
| `dashboard/tui.js` | 1.0.3 | Blessed TUI, overlays (shutdown, proposal, AI chat) |
| `dashboard/panes/agents.js` | 1.0.2 | Portfolio overview, per-agent P&L boxes |
| `dashboard/panes/signals.js` | 1.0.3 | Signal list, macro trend header with F&G |
| `dashboard/panes/controls.js` | 1.0.4 | Key bindings help, status bar |
| `dashboard/panes/ai-chat.js` | 1.0.1 | AI assistant overlay (SPACE key) |
| `agents/mega-config.json` | — | MEGA live strategy config, hot-reloadable |

---

## Architecture — State Persistence

- All trades written to SQLite `ticks` table (type: TRADE, DECISION, SIGNAL, SURVIVAL, PRICE)
- On restart, `world._rebuild()` replays TRADE ticks to restore `capital` + `holdings` using `capital_after` field
- `lastSignals` now restored from last round's SIGNAL ticks on startup (fixes blank holdings value on restart)
- MEGA state additionally persisted in `config` table as `mega_state` (survives DB reset between sessions)

---

## Recent Changes (this session)

### Macro Trend — Market Breadth
- `computeMacroTrend()` in `signals.js` now evaluates all 15 pairs (not just BTC)
- Returns `{ trend, bullCount, bearCount, neutralCount, total, breadth, btc }`
- `breadth = (bullCount - bearCount) / total`; threshold ±0.2 for bull/bear
- Refreshed every **1 hour** (was 24h) — line ~62 in `engine.js`

### MEGA Fixes
- **Sizing bug**: minimum trade was hardcoded $50 (10% of $500 capital). Now `Math.max(capital * 0.005, 1)`
- **Stale personality**: synthesis now runs AFTER `applyDecision()`, then patches `world._snapshot.agents['MEGA'].personality` and the emitted trade event

### Intra-Candle Stop-Loss
- `strategy.intraStopLoss(snapshot, prices, regime)` — runs on mid-candle ticks for GAMMA and MEGA
- Uses `sell_loss_pct` from strategy config + regime overrides

### Graceful Shutdown
- `waitIdle()` in `engine.js` — polls `busy` flag, max 30s wait
- `shutdown(signal)` in `api.js` — stops engine, waits idle, terminates WS clients, closes HTTP server, force-exits after 5s
- SIGINT/SIGTERM both handled
- **TUI Q key**: yellow/red overlay requires typing "SHUTDOWN" to confirm → sends WS COMMAND → `setImmediate(() => shutdown('TUI'))`
- `shutdown.sh` script: HTTP POST to `/command` with token (same pattern as `reset.sh`)

### WebSocket STATE on Reconnect
- STATE message now includes `intervalMs` and `nextTickAt` so TUI syncs interval display immediately on reconnect (was reverting to 15m default)

### lastSignals Restore on Startup
- `world._rebuild()` now queries last round's SIGNAL ticks and sets `lastSignals`
- Fixes: holdings showed $0 value immediately after restart (prices were unknown until first tick)

### P&L Baseline Fix
- MEGA P&L now uses `MEGA_INITIAL_CAPITAL` ($500) as baseline, not `INITIAL_CAPITAL` ($1M)
- `C.MEGA_SIM_CAPITAL` added to exported constants in `world.js`

### AI Assistant — 2-Step Prompt (api.js v1.0.8)
- **Step 1**: `gpt-4o-mini` (planner) receives question + menu of 10 context modules, returns JSON array of needed modules
- **Step 2**: `gpt-4o` receives only selected modules + question → focused answer
- Available modules: `agent_states`, `agent_personalities`, `agent_strategies`, `last_decisions`, `trade_history`, `market_signals`, `macro_trend`, `survival_status`, `session_ranking`, `mega_config`
- Falls back to default set if planner returns bad JSON
- Server logs: `[ASK] Modules selected: ...` and `[ASK] Context size: ~N chars`
- TUI shows "Thinking... Xs" → "Answering... Xs" (phase hint after 3s)

### Fear & Greed in Signals Pane
- Displayed in macro trend header: `F&G: 15 Extreme Fear` (colour-coded)
- Scale: ≤25 red, 26-45 yellow, 46-55 grey, 56-75 green, 76-100 green
- F&G fetch cached for 1 hour (was fetched every tick); falls back to last known value on error

---

## TUI Key Reference

| Key | Action |
|---|---|
| P | Play / Pause |
| F | Force single tick |
| +/- | Cycle interval: 15s 30s 1m 5m 15m |
| T/U/X then A/B/G/M | Threaten / Un-threaten / Terminate agent |
| O | Toggle MEGA real trading on/off |
| N | Force session export |
| S | Toggle signal detail (compact/expanded) |
| L | Cycle log filter |
| TAB | Cycle agent filter |
| R | Reconnect WebSocket |
| SPACE | Open AI Assistant |
| Esc | Quit TUI (engine keeps running) |
| Q | Shutdown simulation (confirmation overlay) |

---

## DB Schema (data/sim.db)

```sql
ticks(id, ts, round, type, agent, payload)
-- type: TRADE | DECISION | SIGNAL | SURVIVAL | PRICE

config(key, value)
-- keys: current_round, mega_state
```

---

## Environment Variables (.env)

```
INITIAL_CAPITAL=1000000
MEGA_INITIAL_CAPITAL=500        # optional, defaults to 500
TICK_INTERVAL_MS=900000         # 15m default
PORT=3000
WS_TOKEN=<secret>
OPENAI_API_KEY=<key>
REAL_TRADING=0                  # set to 1 to enable MEGA live Binance trading
SESSION_TRADES=0                # auto-export trigger (0 = disabled)
```

---

## Known Patterns / Gotchas

- `world._snapshot` and `world._db` are accessed directly from `engine.js` and `api.js` (private but intentional)
- `busy` flag in engine guards concurrent ticks — always check before any direct DB write outside tick
- `portfolioHistory` on rebuild only has values for rounds with actual trades (HOLD rounds missing) → survival scores slightly off after restart until enough new ticks accumulate
- MEGA real trading: `syncMegaState()` patches world snapshot from live Binance before each tick
- `sellCounts` is module-level in `api.js` (not in world snapshot); included in TICK/TRADE/STATE broadcasts
