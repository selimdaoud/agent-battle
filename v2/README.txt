agent-battle-gpt v2
===================

STARTING
--------
From the v2/ directory:

  npm start              # engine (WebSocket :3001 + REST API :3002)
  npm run tui            # terminal dashboard (separate terminal)

Both must be running. The engine starts first; the TUI connects automatically.


TUI KEYBINDINGS
---------------
  f              Force a candle tick (fetch + process signals immediately)
  a              Trigger an adaptation cycle (all agents)
  r              Reset all agent posteriors (Thompson Sampling priors)
  Q / Escape     Quit


REST API  (default: http://localhost:3002)
------------------------------------------

Health
  GET  /health
       Returns { ok, candleCount, uptime }

Engine state
  GET  /state
       Returns current prices and agent snapshots

Agent list
  GET  /agents
       Returns array of agent IDs (e.g. ["A1","A2","A3","A4","A5","A6"])

Activity log (entry + exit + rejected, merged and sorted newest first)
  GET  /activity/:id
  GET  /activity/:id?limit=50
       :id    — agent ID (e.g. A1)
       limit  — max rows returned (default 100, max 1000)

  Example:
    curl "http://localhost:3002/activity/A1?limit=50" | jq .
    curl "http://localhost:3002/activity/A1?limit=200" | jq '[.[] | select(.type=="exit")]'

Events (single table query)
  GET  /events?type=exit&agent_id=A1&limit=50
       type    — entry | exit | rejected | tick | config_update | news
       agent_id, pair, mode, from_ts, to_ts, config_version  (all optional filters)
       limit   — default 1000
       order   — asc | desc (default desc)

  Examples:
    curl "http://localhost:3002/events?type=exit&agent_id=A1&limit=20" | jq .
    curl "http://localhost:3002/events?type=entry&agent_id=A1" | jq .
    curl "http://localhost:3002/events?type=rejected&agent_id=A1&limit=50" | jq .

Config
  GET  /config/:id
       Returns current config + version for agent :id

  POST /config/:id
       Body: { "config": { ... }, "reason": "optional note" }
       Overwrites agent config, increments version, writes backup

Performance stats (cumulative P&L, win rate, avg win/loss — persisted by engine)
  GET  /performance
       Returns { n, cumPnl, avg, winRate, avgWin, avgLoss, pnlHistory, cumPnlLog, lastTs }

  Example:
    curl http://localhost:3002/performance | jq .

Adaptation log (config_updates — all parameter changes with source and reason)
  GET  /events?type=config_update&limit=50
  GET  /events?type=config_update&agent_id=A1&limit=50

  Examples:
    curl "http://localhost:3002/events?type=config_update&limit=50" | jq .
    curl "http://localhost:3002/events?type=config_update&agent_id=A1&limit=50" | jq .

  Each row contains: agent_id, param, old_value, new_value, triggered_by, reason, config_version
  triggered_by values: "adaptation-engine" | "meta-adapt" | (manual via API)

Adaptation triggers
  POST /adapt/trigger
       Runs one adaptation cycle for all agents

  POST /adapt/reset/:id
       Resets Thompson Sampling posteriors for agent :id
       Use "all" to reset every agent:
         curl -X POST http://localhost:3002/adapt/reset/all


SQLITE  (direct queries)
------------------------
Database: data/events.db

Useful queries:

  # Last 50 exits for A1
  sqlite3 data/events.db "SELECT datetime(timestamp/1000,'unixepoch') as time, pair, exit_reason, pnl_pct FROM exits WHERE agent_id='A1' ORDER BY timestamp DESC LIMIT 50;"

  # Entry + exit + rejected for A1 merged (UNION)
  sqlite3 data/events.db "
    SELECT datetime(timestamp/1000,'unixepoch') as time, 'ENTRY'    as type, pair, signal_score FROM entries  WHERE agent_id='A1'
    UNION ALL
    SELECT datetime(timestamp/1000,'unixepoch'),          'EXIT'     as type, pair, pnl_pct      FROM exits    WHERE agent_id='A1'
    UNION ALL
    SELECT datetime(timestamp/1000,'unixepoch'),          'REJECTED' as type, pair, gate_failed  FROM rejected WHERE agent_id='A1'
    ORDER BY time DESC LIMIT 100;"

  # Win rate per agent
  sqlite3 data/events.db "SELECT agent_id, COUNT(*) as trades, ROUND(100.0*SUM(CASE WHEN pnl_pct>0 THEN 1 ELSE 0 END)/COUNT(*),1) as win_pct FROM exits GROUP BY agent_id;"

  # Config version history for A1
  sqlite3 data/events.db "SELECT datetime(timestamp/1000,'unixepoch'), version, reason FROM config_updates WHERE agent_id='A1' ORDER BY timestamp DESC;"


BACKTESTING
-----------
Backtesting runs entirely offline in a separate database — the live engine and
its data are never touched.

Step 1 — fetch historical data  (~2-3 minutes, no engine required)

  npm run backfill

  This fetches 365 days of 15m candles + funding rates from Binance and
  Fear & Greed history from alternative.me, computes all signals, and stores
  everything in data/backtest.db.

  Options:
    --days 180                  shorter window (default: 365)
    --end 2025-01-31            end date (default: today); combine with --days to
                                target a specific window, e.g. the 2024 bull run:
                                  npm run backfill -- --days 120 --end 2025-01-31 --out ./data/backtest-bull.db
    --out ./data/bt2.db         custom output file
    --pairs BTCUSDT,ETHUSDT     specific pairs only

Step 2 — replay through agent pool

  npm run replay -- --src ./data/backtest.db

  Replays every historical candle through a fresh set of agents using current
  configs. Prints a full report at the end.

  With train/test split (recommended — prevents overfitting):
    npm run replay -- --src ./data/backtest.db --test-from 2025-09-01

  Options:
    --src ./data/backtest.db    source DB (default: data/events.db)
    --from 2025-01-01           start date (default: beginning of DB)
    --test-from 2025-07-01      freeze agents from this date onward (test period)
    --out ./data/replay.db      where to write replay events (default: data/replay.db)
    --dry-run                   print entries/exits, don't write to DB

Reading the report:

  Metric   Good       Acceptable   Bad
  -------  ---------  -----------  --------
  Sharpe   > 1.5      0.5 – 1.5    < 0.5
  MaxDD    < 10%      10% – 20%    > 20%
  WinRate  > 55%      45% – 55%    < 45%

  The test period numbers are what matter. If train looks good but test
  collapses, the strategy is overfitting to historical noise.

Step 3 — diagnose (optional but recommended)

  npm run analyze -- --src ./data/replay.db --ticks ./data/backtest.db

  Prints a 7-section diagnosis: per-agent summary, exit reason breakdown,
  entry-score vs win-rate, entry-time regime analysis, holding-time distribution,
  signal values at entry (winners vs losers), and auto-recommendations.

  Options:
    --src ./data/replay.db      replay DB to analyze (default: data/replay.db)
    --ticks ./data/backtest.db  original tick DB (for signal breakdown)
    --agent A1                  filter to one agent
    --mode live                 filter to live agents only

  Use a separate --config-dir for backtesting without touching live configs:
    npm run replay -- --src ./data/backtest.db --out ./data/replay-bt.db \
                      --config-dir ./data/configs-bt

Notes:
  - news_signal is set to 0 for all historical candles (no LLM calls)
  - MATICUSDT excluded (rebranded/delisted from Binance perps)
  - INSERT OR IGNORE: re-running backfill on the same DB never overwrites rows
  - Section 4 (regime analysis) reports ENTRY-time regime, not exit-time
  - agents carry 4h macro regime signals in live and backtest mode:
      macro_p_trending_up > 0.5 gate prevents entries during macro downtrends
  - For a bull market validation run (Oct 2024 – Jan 2025):
      npm run backfill -- --days 120 --end 2025-01-31 --out ./data/backtest-bull.db
      npm run replay   -- --src ./data/backtest-bull.db --out ./data/replay-bull.db \
                          --config-dir ./data/configs-bt
      npm run analyze  -- --src ./data/replay-bull.db --ticks ./data/backtest-bull.db


AGENT ARCHETYPES
----------------
  A1  balanced     — equal weight across all signals, moderate thresholds
  A2  momentum     — high momentum_1h/4h weight, loose CVD gate, lower thresholds
  A3  flow         — high CVD/funding weight, strict CVD gate, more positions allowed
  A4  contrarian   — high RSI/fear-greed weight, buys dips, longer hold period
  A5  aggressive   — lowest entry thresholds, larger position size, fast exit
  A6  conservative — highest thresholds, small sizing, high cash reserve


AGENT STATE PERSISTENCE
-----------------------
Capital, positions, trade history and tick count are saved to:
  data/agent-states/{id}.json
after every candle. On engine restart, state is reloaded automatically —
open positions survive crashes and restarts.


NEWS SIGNAL
-----------
Crypto news is polled every 5 minutes, classified by gpt-4o-mini, and injected
into the signal vector as `news_signal`. The weight starts at 0.0 and the
adaptation engine raises it if the signal proves predictive.

Available RSS sources (set in .env NEWS_SOURCES, comma-separated):
  coindesk      https://feeds.feedburner.com/CoinDesk
  cointelegraph https://cointelegraph.com/rss
  decrypt       https://decrypt.co/feed

View recent news events:
  curl "http://localhost:3002/events?type=news&limit=20" | jq .

Each row contains: pair, direction, confidence, score, headline, source, rationale

Requires OPENAI_API_KEY to be set in .env — news is silently disabled otherwise.


ENVIRONMENT VARIABLES
---------------------
  PORT=3001        WebSocket server port (default 3001)
  API_PORT=3002    REST API port (default 3002)
  REAL_TRADING=1   Enable real Binance order execution for live agents (default off)
  NEWS_SOURCES     Comma-separated source keys: coindesk,cointelegraph,decrypt (default: coindesk,cointelegraph)
  NEWS_DECAY_HOURS Score decay window in hours (default 2)
