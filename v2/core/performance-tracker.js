'use strict'

const fs   = require('fs')
const path = require('path')

const HISTORY_MAX = 200   // rolling live exits kept
const SPARKLINE_MAX = 100 // cumPnl snapshots kept

class PerformanceTracker {
  constructor(dataDir) {
    this._file       = path.join(dataDir, 'perf-state.json')
    this._pnlHistory = []   // rolling live exit pnl_pct values
    this._cumPnlLog  = []   // cumulative pnl snapshot per candle (for sparkline)
    this._lastTs     = 0
    this._load()
  }

  // Called for each live EXIT event
  onExit(event) {
    if (event.mode !== 'live') return
    this._pnlHistory.push(event.pnl_pct || 0)
    if (this._pnlHistory.length > HISTORY_MAX) this._pnlHistory.shift()
    this._lastTs = Math.max(this._lastTs, event.timestamp || 0)
    this._save()
  }

  // Called once per candle — snapshots current cumulative P&L for sparkline
  onCandle() {
    const cum = this._pnlHistory.reduce((s, p) => s + p, 0)
    this._cumPnlLog.push(cum)
    if (this._cumPnlLog.length > SPARKLINE_MAX) this._cumPnlLog.shift()
    // no save here — candle ticks are frequent, pnlHistory didn't change
  }

  // Returns the full state for the REST endpoint and TUI seed
  getStats() {
    const h      = this._pnlHistory
    const n      = h.length
    const wins   = h.filter(p => p > 0)
    const losses = h.filter(p => p <= 0)
    const cumPnl = h.reduce((s, p) => s + p, 0)
    return {
      n,
      cumPnl,
      avg:      n ? cumPnl / n : 0,
      winRate:  n ? (wins.length / n) * 100 : 0,
      avgWin:   wins.length   ? wins.reduce((s, p)   => s + p, 0)           / wins.length   : 0,
      avgLoss:  losses.length ? losses.reduce((s, p) => s + Math.abs(p), 0) / losses.length : 0,
      pnlHistory: [...this._pnlHistory],
      cumPnlLog:  [...this._cumPnlLog],
      lastTs:     this._lastTs
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  _save() {
    try {
      fs.writeFileSync(this._file, JSON.stringify({
        pnlHistory: this._pnlHistory,
        cumPnlLog:  this._cumPnlLog,
        lastTs:     this._lastTs
      }))
    } catch { /* ignore */ }
  }

  _load() {
    try {
      if (!fs.existsSync(this._file)) return
      const s = JSON.parse(fs.readFileSync(this._file, 'utf8'))
      this._pnlHistory = s.pnlHistory || []
      this._cumPnlLog  = s.cumPnlLog  || []
      this._lastTs     = s.lastTs     || 0
    } catch { /* corrupt file — start fresh */ }
  }
}

module.exports = { PerformanceTracker }
