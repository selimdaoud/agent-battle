'use strict'

const WebSocket = require('ws')

const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]

function connect(host, port, token, handlers) {
  let ws        = null
  let attempt   = 0
  let destroyed = false
  let sendQueue = []

  function getUrl() { return `ws://${host}:${port}` }

  function dispatch(msg) {
    try {
      const data = JSON.parse(msg)
      switch (data.type) {
        case 'STATE':
        case 'TICK':      handlers.onTick     && handlers.onTick(data);     break
        case 'TRADE':     handlers.onTrade    && handlers.onTrade(data);    break
        case 'SURVIVAL':  handlers.onSurvival && handlers.onSurvival(data); break
        case 'WINNER':    handlers.onWinner   && handlers.onWinner(data);   break
        case 'ERROR':     handlers.onError    && handlers.onError(data);    break
      }
    } catch (_) {}
  }

  function doSend(msg) {
    const withToken = { ...msg, token }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(withToken))
    } else {
      sendQueue.push(withToken)
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
    ws = new WebSocket(getUrl())

    ws.on('open', () => {
      attempt = 0
      // Auth first
      ws.send(JSON.stringify({ type: 'AUTH', token }))
      // Drain queued messages
      while (sendQueue.length) ws.send(JSON.stringify(sendQueue.shift()))
      handlers.onConnect && handlers.onConnect()
    })

    ws.on('message', raw => dispatch(raw.toString()))

    ws.on('close', () => reconnect())

    ws.on('error', () => {
      ws.terminate()
      reconnect()
    })
  }

  open()

  return {
    send:    doSend,
    destroy: () => { destroyed = true; ws && ws.terminate() }
  }
}

module.exports = { connect }
