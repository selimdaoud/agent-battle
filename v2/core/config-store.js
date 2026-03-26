'use strict'

const fs   = require('fs')
const path = require('path')

// Default config — seeded from v1 values, all parameters present
const DEFAULT_CONFIG = {
  weights: {
    cvd_norm:          0.25,
    funding_signal:    0.22,
    momentum_1h:       0.18,
    momentum_4h:       0.05,
    rsi_norm:          0.12,
    volume_zscore:     0.10,
    fear_greed_signal: 0.08,
    news_signal:       0.00   // starts at zero — adaptation engine raises if predictive
  },
  entry: {
    buy_signal_base:        0.15,
    buy_signal_per_regime: {
      volatile:      0.30,
      trending_up:   0.21,
      trending_down: 0.25,
      ranging:       0.34
    },
    cvd_buy_min:     0.02,
    funding_buy_max: 0.55
  },
  exit: {
    sell_signal:                  -0.12,
    cvd_sell_max:                 -0.25,
    sell_loss_pct_base:            6,
    sell_loss_pct_trending_down:   4,
    sell_profit_pct:              12,
    take_profit_requires_cvd_turn: true
  },
  sizing: {
    buy_size_pct_base: 0.20,
    max_positions:     3,
    cash_min_pct:      0.25
  },
  hold: {
    deadweight_rounds_min:    7,
    deadweight_pnl_threshold: 3     // exit if |unrealised P&L| < this %
  },
  kelly: {
    kelly_min_trades:    6,
    kelly_cap_multiplier: 2
  }
}

// ── ConfigStore ────────────────────────────────────────────────────────────────

class ConfigStore {
  constructor(configsDir) {
    this.dir      = configsDir
    this._configs  = {}   // id → { config, version }
    this._watchers = {}   // id → fs.FSWatcher

    if (!fs.existsSync(configsDir)) fs.mkdirSync(configsDir, { recursive: true })
  }

  // ── Read ───────────────────────────────────────────────────────────────────

  getConfig(id) {
    if (!this._configs[id]) this._load(id)
    return this._configs[id].config
  }

  getVersion(id) {
    if (!this._configs[id]) this._load(id)
    return this._configs[id].version
  }

  getPersonality(id) {
    if (!this._configs[id]) this._load(id)
    return this._configs[id].personality || ''
  }

  listAgents() {
    return fs.readdirSync(this.dir)
      .filter(f => /^agent-[^.]+\.json$/.test(f))
      .map(f => f.replace(/^agent-/, '').replace(/\.json$/, ''))
  }

  // ── Write ──────────────────────────────────────────────────────────────────

  /**
   * setConfig(id, config, reason)
   * Writes a backup of the current config, then writes the new one.
   * Increments version. Returns the new version number.
   */
  setConfig(id, config, reason = '') {
    if (!this._configs[id]) this._load(id)

    const current = this._configs[id]
    const newVersion = current.version + 1

    // Write timestamped backup
    const backupName = `agent-${id}.v${current.version}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    fs.writeFileSync(
      path.join(this.dir, backupName),
      JSON.stringify({ version: current.version, config: current.config, reason }, null, 2)
    )

    // Write new config
    const newData = { version: newVersion, config, reason }
    fs.writeFileSync(this._filePath(id), JSON.stringify(newData, null, 2))

    this._configs[id] = { config, version: newVersion }
    return newVersion
  }

  /**
   * reload(id) — re-read from disk. Called by the hot-reload watcher
   * when the file changes externally (e.g. adaptation engine wrote it).
   */
  reload(id) {
    this._load(id)
    return this._configs[id]
  }

  /**
   * watchForChanges(id, onChange)
   * Sets up an fs.watch on the agent's config file.
   * onChange(id, config, version) is called whenever the file is updated.
   * Safe to call multiple times — existing watcher is replaced.
   */
  watchForChanges(id, onChange) {
    if (this._watchers[id]) this._watchers[id].close()

    const filePath = this._filePath(id)
    // Ensure the file exists before watching
    if (!fs.existsSync(filePath)) this._initDefault(id)

    this._watchers[id] = fs.watch(filePath, (event) => {
      if (event !== 'change') return
      try {
        const prev = this._configs[id]?.version ?? -1
        this._load(id)
        const { config, version } = this._configs[id]
        if (version !== prev) {
          onChange(id, config, version)
        }
      } catch { /* ignore transient write conflicts */ }
    })
  }

  stopWatching(id) {
    if (this._watchers[id]) { this._watchers[id].close(); delete this._watchers[id] }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _filePath(id) {
    return path.join(this.dir, `agent-${id}.json`)
  }

  _load(id) {
    const filePath = this._filePath(id)
    if (!fs.existsSync(filePath)) {
      this._initDefault(id)
      return
    }
    const raw  = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    // Deep-merge with DEFAULT_CONFIG so new keys added to defaults are always present
    this._configs[id] = {
      config:      deepMerge(DEFAULT_CONFIG, raw.config || {}),
      version:     raw.version     ?? 0,
      personality: raw.personality ?? ''
    }
  }

  _initDefault(id) {
    const data = { version: 0, config: DEFAULT_CONFIG, reason: 'initial default' }
    fs.writeFileSync(this._filePath(id), JSON.stringify(data, null, 2))
    this._configs[id] = { config: DEFAULT_CONFIG, version: 0 }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

// Deep merge: target values take precedence over source (defaults).
// Only merges plain objects; arrays and primitives in target win.
function deepMerge(defaults, overrides) {
  const result = { ...defaults }
  for (const key of Object.keys(overrides)) {
    if (
      overrides[key] !== null &&
      typeof overrides[key] === 'object' &&
      !Array.isArray(overrides[key]) &&
      typeof defaults[key] === 'object'
    ) {
      result[key] = deepMerge(defaults[key], overrides[key])
    } else {
      result[key] = overrides[key]
    }
  }
  return result
}

module.exports = { ConfigStore, DEFAULT_CONFIG }
