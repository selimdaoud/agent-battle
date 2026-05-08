'use strict'

const Database = require('better-sqlite3')
const path     = require('path')
const fs       = require('fs')

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ticks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        INTEGER NOT NULL,
    pair             TEXT    NOT NULL,
    mid              REAL,
    bid              REAL,
    ask              REAL,
    spread           REAL,
    volume           REAL,
    funding_rate     REAL,
    fear_greed       INTEGER,
    cvd_norm         REAL,
    funding_signal   REAL,
    momentum_1h      REAL,
    momentum_4h      REAL,
    rsi_norm         REAL,
    volume_zscore    REAL,
    fear_greed_signal REAL,
    signal_uncertainty REAL,
    news_signal      REAL DEFAULT 0,
    p_volatile           REAL,
    p_trending_up        REAL,
    p_trending_down      REAL,
    p_ranging            REAL,
    macro_p_trending_up  REAL
  );

  CREATE TABLE IF NOT EXISTS entries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    agent_id        TEXT    NOT NULL,
    mode            TEXT    NOT NULL,
    pair            TEXT    NOT NULL,
    price           REAL    NOT NULL,
    size_usd        REAL    NOT NULL,
    entry_score     REAL,
    p_volatile      REAL,
    p_trending_up   REAL,
    p_trending_down REAL,
    p_ranging       REAL,
    config_version  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS exits (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    agent_id        TEXT    NOT NULL,
    mode            TEXT    NOT NULL,
    pair            TEXT    NOT NULL,
    exit_price      REAL    NOT NULL,
    exit_reason     TEXT    NOT NULL,
    holding_rounds  INTEGER,
    pnl_pct         REAL,
    entry_score     REAL,
    p_volatile      REAL,
    p_trending_up   REAL,
    p_trending_down REAL,
    p_ranging       REAL,
    config_version  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rejected (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    agent_id        TEXT    NOT NULL,
    pair            TEXT    NOT NULL,
    gate_failed     TEXT    NOT NULL,
    signal_score    REAL,
    p_volatile      REAL,
    p_trending_up   REAL,
    p_trending_down REAL,
    p_ranging       REAL,
    config_version  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS config_updates (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    agent_id        TEXT    NOT NULL,
    param           TEXT    NOT NULL,
    old_value       REAL,
    new_value       REAL,
    reason          TEXT,
    triggered_by    TEXT,
    config_version  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS news (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp       INTEGER NOT NULL,
    pair            TEXT,
    direction       TEXT    NOT NULL,
    confidence      TEXT    NOT NULL,
    score           REAL    NOT NULL,
    decay_ms        INTEGER NOT NULL,
    headline        TEXT,
    source          TEXT,
    rationale       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ticks_pair_ts    ON ticks    (pair, timestamp);
  CREATE INDEX IF NOT EXISTS idx_entries_agent    ON entries  (agent_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_exits_agent      ON exits    (agent_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_rejected_agent   ON rejected (agent_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_news_pair_ts     ON news     (pair, timestamp);
`

// ── Prepared statement cache ────────────────────────────────────────────────

const INSERTS = {
  ticks: `INSERT INTO ticks
    (timestamp, pair, mid, bid, ask, spread, volume, funding_rate, fear_greed,
     cvd_norm, funding_signal, momentum_1h, momentum_4h, rsi_norm, volume_zscore,
     fear_greed_signal, signal_uncertainty, news_signal,
     p_volatile, p_trending_up, p_trending_down, p_ranging, macro_p_trending_up)
    VALUES
    (@timestamp, @pair, @mid, @bid, @ask, @spread, @volume, @funding_rate, @fear_greed,
     @cvd_norm, @funding_signal, @momentum_1h, @momentum_4h, @rsi_norm, @volume_zscore,
     @fear_greed_signal, @signal_uncertainty, @news_signal,
     @p_volatile, @p_trending_up, @p_trending_down, @p_ranging, @macro_p_trending_up)`,

  entries: `INSERT INTO entries
    (timestamp, agent_id, mode, pair, price, size_usd, entry_score,
     p_volatile, p_trending_up, p_trending_down, p_ranging, config_version)
    VALUES
    (@timestamp, @agent_id, @mode, @pair, @price, @size_usd, @entry_score,
     @p_volatile, @p_trending_up, @p_trending_down, @p_ranging, @config_version)`,

  exits: `INSERT INTO exits
    (timestamp, agent_id, mode, pair, exit_price, exit_reason,
     holding_rounds, pnl_pct, entry_score,
     p_volatile, p_trending_up, p_trending_down, p_ranging, config_version)
    VALUES
    (@timestamp, @agent_id, @mode, @pair, @exit_price, @exit_reason,
     @holding_rounds, @pnl_pct, @entry_score,
     @p_volatile, @p_trending_up, @p_trending_down, @p_ranging, @config_version)`,

  rejected: `INSERT INTO rejected
    (timestamp, agent_id, pair, gate_failed, signal_score,
     p_volatile, p_trending_up, p_trending_down, p_ranging, config_version)
    VALUES
    (@timestamp, @agent_id, @pair, @gate_failed, @signal_score,
     @p_volatile, @p_trending_up, @p_trending_down, @p_ranging, @config_version)`,

  config_updates: `INSERT INTO config_updates
    (timestamp, agent_id, param, old_value, new_value, reason, triggered_by, config_version)
    VALUES
    (@timestamp, @agent_id, @param, @old_value, @new_value, @reason, @triggered_by, @config_version)`,

  news: `INSERT INTO news
    (timestamp, pair, direction, confidence, score, decay_ms, headline, source, rationale)
    VALUES
    (@timestamp, @pair, @direction, @confidence, @score, @decay_ms, @headline, @source, @rationale)`
}

// ── EventStore ──────────────────────────────────────────────────────────────

class EventStore {
  constructor(dbPath) {
    const dir = path.dirname(dbPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')  // concurrent reads while writing
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(SCHEMA)
    // Migration: add macro_p_trending_up column to ticks if it doesn't exist yet
    try { this.db.exec('ALTER TABLE ticks ADD COLUMN macro_p_trending_up REAL') } catch (_) {}

    // Pre-compile all insert statements
    this._stmts = {}
    for (const [table, sql] of Object.entries(INSERTS)) {
      this._stmts[table] = this.db.prepare(sql)
    }
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * append({ type, ...fields })
   * type must be one of: 'tick' | 'entry' | 'exit' | 'rejected' | 'config_update' | 'news'
   * Fields must match the schema for that type (extra fields are silently ignored).
   */
  append(event) {
    const { type, ...data } = event
    const table = type === 'tick'          ? 'ticks'
                : type === 'entry'         ? 'entries'
                : type === 'exit'          ? 'exits'
                : type === 'rejected'      ? 'rejected'
                : type === 'config_update' ? 'config_updates'
                : type === 'news'          ? 'news'
                : null

    if (!table) throw new Error(`EventStore: unknown event type "${type}"`)

    // Add timestamp if not provided
    if (data.timestamp == null) data.timestamp = Date.now()

    this._stmts[table].run(data)
  }

  /**
   * appendBatch(events[]) — writes multiple events in a single transaction.
   * More efficient than calling append() in a loop when writing multiple events per tick.
   */
  appendBatch(events) {
    const tx = this.db.transaction(evts => {
      for (const e of evts) this.append(e)
    })
    tx(events)
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * query(type, filters) — returns matching rows as plain objects.
   *
   * filters:
   *   agent_id      — exact match
   *   pair          — exact match
   *   mode          — 'live' | 'paper'
   *   from_ts       — timestamp >= from_ts
   *   to_ts         — timestamp <= to_ts
   *   config_version — exact match
   *   limit         — max rows (default 1000)
   *   order         — 'asc' | 'desc' (default 'desc')
   */
  query(type, filters = {}) {
    const table = type === 'tick'          ? 'ticks'
                : type === 'entry'         ? 'entries'
                : type === 'exit'          ? 'exits'
                : type === 'rejected'      ? 'rejected'
                : type === 'config_update' ? 'config_updates'
                : type === 'news'          ? 'news'
                : null
    if (!table) throw new Error(`EventStore: unknown event type "${type}"`)

    const conditions = []
    const params     = {}

    if (filters.agent_id)       { conditions.push('agent_id = @agent_id');             params.agent_id       = filters.agent_id }
    if (filters.pair)           { conditions.push('pair = @pair');                     params.pair           = filters.pair }
    if (filters.mode)           { conditions.push('mode = @mode');                     params.mode           = filters.mode }
    if (filters.from_ts != null){ conditions.push('timestamp >= @from_ts');            params.from_ts        = filters.from_ts }
    if (filters.to_ts   != null){ conditions.push('timestamp <= @to_ts');              params.to_ts          = filters.to_ts }
    if (filters.config_version) { conditions.push('config_version = @config_version'); params.config_version = filters.config_version }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const order = filters.order === 'asc' ? 'ASC' : 'DESC'
    const limit = filters.limit ?? 1000

    const sql = `SELECT * FROM ${table} ${where} ORDER BY timestamp ${order} LIMIT ${limit}`
    return this.db.prepare(sql).all(params)
  }

  /** Count events matching filters — cheaper than query() when you only need the count. */
  count(type, filters = {}) {
    const rows = this.query(type, { ...filters, limit: 1000000 })
    return rows.length
  }

  /** Latest N exits for a given agent — used by the adaptation engine. */
  recentExits(agentId, n = 50, mode = null) {
    return this.query('exit', {
      agent_id: agentId,
      mode:     mode || undefined,
      limit:    n,
      order:    'desc'
    })
  }

  close() {
    this.db.close()
  }
}

module.exports = EventStore
