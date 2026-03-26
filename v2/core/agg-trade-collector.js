'use strict'

/**
 * AggTradeCollector
 *
 * Subscribes to Binance aggTrade WebSocket streams for a set of pairs.
 * Accumulates per-candle buy/sell volume in real time, providing:
 *
 *   getCvd1c(pair)       — CVD of the completed last candle (normalised [-1,+1])
 *   getCvdIntra(pair)    — CVD of the current in-progress candle
 *   getCvdAccel(pair)    — acceleration: last-5m CVD vs first-10m CVD of current candle
 *   getTakerRatio(pair)  — raw takerBuy/total ratio for last completed candle [0,1]
 *
 * Each pair gets one stream: wss://stream.binance.com:9443/ws/<pair>@aggTrade
 *
 * Usage:
 *   const collector = new AggTradeCollector(pairs, { candleMs: 900000 })
 *   await collector.start()
 *   // ... at candle close:
 *   const cvd1c = collector.getCvd1c('BTCUSDT')
 *   collector.onCandleClose('BTCUSDT')   // rotate current → last
 */

const WebSocket = require('ws')

const BINANCE_WS_BASE = 'wss://stream.binance.com:9443/ws'

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

class AggTradeCollector {
  /**
   * @param {string[]} pairs      — e.g. ['BTCUSDT', 'ETHUSDT', ...]
   * @param {object}  [opts]
   * @param {number}  [opts.candleMs=900000]   — candle duration in ms (default 15m)
   * @param {number}  [opts.reconnectDelayMs=5000]
   * @param {boolean} [opts.verbose=false]
   */
  constructor(pairs, opts = {}) {
    this.pairs          = pairs
    this.candleMs       = opts.candleMs        ?? 900_000
    this.reconnectDelay = opts.reconnectDelayMs ?? 5_000
    this.verbose        = opts.verbose          ?? false

    // Per-pair accumulators
    // current: in-progress candle (reset at candle open)
    // last:    just-completed candle (set when current is rotated)
    // early:   first (candleMs * 2/3) of current candle (for accel)
    this._state = {}
    for (const pair of pairs) {
      this._state[pair] = {
        current:      { buyVol: 0, sellVol: 0, startMs: 0 },
        last:         { buyVol: 0, sellVol: 0 },
        earlyBuyVol:  0,
        earlySellVol: 0,
        earlyFrozen:  false   // true once early window is closed
      }
    }

    this._sockets = new Map()   // pair → WebSocket
    this._started = false
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * CVD of the last COMPLETED candle, normalised to [-1, +1].
   * 0 = equal buy/sell.  +1 = all buys.  -1 = all sells.
   */
  getCvd1c(pair) {
    const s = this._state[pair]
    if (!s) return 0
    const total = s.last.buyVol + s.last.sellVol
    if (total === 0) return 0
    return clamp(2 * s.last.buyVol / total - 1, -1, 1)
  }

  /**
   * CVD of the CURRENT in-progress candle.
   * Useful as a leading indicator — check this before candle close.
   */
  getCvdIntra(pair) {
    const s = this._state[pair]
    if (!s) return 0
    const c     = s.current
    const total = c.buyVol + c.sellVol
    if (total === 0) return 0
    return clamp(2 * c.buyVol / total - 1, -1, 1)
  }

  /**
   * CVD acceleration: difference between late-candle CVD and early-candle CVD.
   *
   * Positive = buying pressure building toward close (momentum continuation).
   * Negative = buying pressure fading (potential reversal).
   *
   * Early window = first 2/3 of candle duration.
   * Late window  = remaining 1/3 (current state − early).
   */
  getCvdAccel(pair) {
    const s = this._state[pair]
    if (!s || !s.earlyFrozen) return 0

    const c = s.current
    const lateBuy  = c.buyVol  - s.earlyBuyVol
    const lateSell = c.sellVol - s.earlySellVol
    const lateTotal  = lateBuy  + lateSell
    const earlyTotal = s.earlyBuyVol + s.earlySellVol

    const lateCvd  = lateTotal  > 0 ? clamp(2 * lateBuy  / lateTotal  - 1, -1, 1) : 0
    const earlyCvd = earlyTotal > 0 ? clamp(2 * s.earlyBuyVol / earlyTotal - 1, -1, 1) : 0

    return clamp(lateCvd - earlyCvd, -2, 2) / 2  // normalise to [-1,+1]
  }

  /**
   * Raw taker buy ratio of the last completed candle [0, 1].
   * 0.5 = balanced.  > 0.5 = net buying.
   */
  getTakerRatio(pair) {
    const s = this._state[pair]
    if (!s) return 0.5
    const total = s.last.buyVol + s.last.sellVol
    if (total === 0) return 0.5
    return s.last.buyVol / total
  }

  /**
   * Called by the engine at candle close for a given pair.
   * Rotates current → last and resets current accumulator.
   */
  onCandleClose(pair) {
    const s = this._state[pair]
    if (!s) return
    s.last        = { buyVol: s.current.buyVol, sellVol: s.current.sellVol }
    s.current     = { buyVol: 0, sellVol: 0, startMs: Date.now() }
    s.earlyBuyVol  = 0
    s.earlySellVol = 0
    s.earlyFrozen  = false
  }

  /**
   * Check if the collector has data for a pair (has seen at least one trade).
   */
  hasData(pair) {
    const s = this._state[pair]
    if (!s) return false
    return (s.current.buyVol + s.current.sellVol + s.last.buyVol + s.last.sellVol) > 0
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async start() {
    if (this._started) return
    this._started = true
    for (const pair of this.pairs) {
      this._connect(pair)
    }
    this._log(`started  pairs=${this.pairs.length}`)
  }

  stop() {
    this._started = false
    for (const ws of this._sockets.values()) {
      try { ws.close() } catch {}
    }
    this._sockets.clear()
    this._log('stopped')
  }

  // ── Internal ─────────────────────────────────────────────────────────────────

  _connect(pair) {
    const url = `${BINANCE_WS_BASE}/${pair.toLowerCase()}@aggTrade`

    const ws = new WebSocket(url)
    this._sockets.set(pair, ws)

    ws.on('open', () => {
      if (this.verbose) this._log(`connected  ${pair}`)
      // Seed current candle start time
      const s = this._state[pair]
      if (s && s.current.startMs === 0) s.current.startMs = Date.now()
    })

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw)
        if (msg.e !== 'aggTrade') return
        const qty      = parseFloat(msg.q) || 0
        const isSell   = msg.m  // m=true → buyer is maker → taker is seller
        this._onTrade(pair, qty, isSell)
      } catch {}
    })

    ws.on('close', () => {
      this._sockets.delete(pair)
      if (this._started) {
        if (this.verbose) this._log(`reconnecting ${pair} in ${this.reconnectDelay}ms`)
        setTimeout(() => { if (this._started) this._connect(pair) }, this.reconnectDelay)
      }
    })

    ws.on('error', err => {
      if (this.verbose) this._log(`error ${pair}: ${err.message}`)
      ws.terminate()
    })
  }

  _onTrade(pair, qty, isSell) {
    const s = this._state[pair]
    if (!s) return

    if (isSell) {
      s.current.sellVol += qty
    } else {
      s.current.buyVol += qty
    }

    // Freeze early window at 2/3 of candle duration
    if (!s.earlyFrozen && s.current.startMs > 0) {
      const elapsed = Date.now() - s.current.startMs
      if (elapsed >= this.candleMs * (2 / 3)) {
        s.earlyBuyVol  = s.current.buyVol
        s.earlySellVol = s.current.sellVol
        s.earlyFrozen  = true
      }
    }
  }

  _log(msg) {
    process.stdout.write(new Date().toISOString() + ' [AGG-TRADE] ' + msg + '\n')
  }
}

module.exports = AggTradeCollector
