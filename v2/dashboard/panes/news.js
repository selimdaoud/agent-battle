'use strict'

const blessed = require('blessed')

const DECAY_MS = (parseFloat(process.env.NEWS_DECAY_HOURS) || 2) * 3600 * 1000

function create(parent) {
  const box = blessed.box({
    parent,
    top: 0, left: 0, width: '100%', height: '100%',
    tags: true,
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    style: { scrollbar: { bg: 'cyan' } }
  })

  const _events = []
  const MAX = 50

  function render() {
    const now  = Date.now()
    const live = _events.filter(e => now - e.timestamp < (e.decay_ms || DECAY_MS))

    if (!live.length) {
      box.setContent('{grey-fg}No active signals.{/grey-fg}')
      return
    }

    // Group by pair: keep the most recent action per pair
    const byPair = {}
    for (const e of live) {
      const text = e.action || e.rationale
      if (!text) continue
      if (!byPair[e.pair] || e.timestamp > byPair[e.pair].timestamp) {
        byPair[e.pair] = e
      }
    }

    const pairs = Object.keys(byPair).sort()
    if (!pairs.length) {
      box.setContent('{grey-fg}No actions yet.{/grey-fg}')
      return
    }

    const lines = ['{cyan-fg}{bold}Engine actions:{/bold}{/cyan-fg}']
    for (const pair of pairs) {
      const e        = byPair[pair]
      const age      = now - e.timestamp
      const decayMs  = e.decay_ms || DECAY_MS
      const remainM  = Math.ceil((decayMs - age) / 60000)
      const color    = e.direction === 'bullish' ? '{green-fg}' : e.direction === 'bearish' ? '{red-fg}' : '{white-fg}'
      const colorEnd = e.direction === 'bullish' ? '{/green-fg}' : e.direction === 'bearish' ? '{/red-fg}' : '{/white-fg}'
      const conf     = (e.confidence || '?')[0].toUpperCase()
      lines.push(
        `${color}{bold}${pair}{/bold} ${conf}${colorEnd}` +
        `{grey-fg} ${remainM}m{/grey-fg}`
      )
      lines.push(`{white-fg}${e.action || e.rationale}{/white-fg}`)
      lines.push('')
    }

    box.setContent(lines.join('\n'))
  }

  return {
    onNews(event) {
      _events.push(event)
      if (_events.length > MAX) _events.shift()
      render()
    },
    tick() { render() },
    clear() { _events.length = 0; render() }
  }
}

module.exports = { create }
