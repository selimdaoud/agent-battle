'use strict'

const WebSocket = require('ws')

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]

/**
 * connect(host, port, token, handlers) → { send, destroy }
 *
 * handlers:
 *   onConnect()
 *   onDisconnect(delayMs)
 *   onCandle(data)   — { type:'candle', candleCount, timestamp, signals, agents }
 *   onTick(data)     — { type:'tick', timestamp, prices, signals }
 */
function connect(host, port, token, handlers) {
  let ws        = null
  let attempt   = 0
  let destroyed = false

  function dispatch(raw) {
    let data
    try { data = JSON.parse(raw) } catch { return }
    switch (data.type) {
      case 'candle':           handlers.onCandle       && handlers.onCandle(data);       break
      case 'tick':             handlers.onTick         && handlers.onTick(data);         break
      case 'adapt_result':     handlers.onAdaptResult  && handlers.onAdaptResult(data);  break
      case 'adapt_reset_done': handlers.onAdaptReset   && handlers.onAdaptReset(data);   break
      case 'dxy_update':       handlers.onDxyUpdate    && handlers.onDxyUpdate(data);    break
      case 'manual_buy_result':  handlers.onManualBuyResult  && handlers.onManualBuyResult(data);  break
      case 'manual_sell_result':         handlers.onManualSellResult        && handlers.onManualSellResult(data);        break
      case 'manual_toggle_block_result': handlers.onManualToggleBlockResult && handlers.onManualToggleBlockResult(data); break
    }
  }

  function reconnect() {
    if (destroyed) return
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
    attempt++
    handlers.onDisconnect && handlers.onDisconnect(delay)
    setTimeout(open, delay)
  }

  function open() {
    if (destroyed) return
    const url = token
      ? `ws://${host}:${port}/?token=${encodeURIComponent(token)}`
      : `ws://${host}:${port}/`

    ws = new WebSocket(url)

    ws.on('open', () => {
      attempt = 0
      handlers.onConnect && handlers.onConnect()
    })

    ws.on('message', raw => dispatch(raw.toString()))
    ws.on('close',   ()  => reconnect())
    ws.on('error',   ()  => ws.terminate())  // close event fires after terminate → reconnect()
  }

  open()

  return {
    send:    (msg) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)) },
    destroy: () => { destroyed = true; ws && ws.terminate() }
  }
}

module.exports = { connect }
