'use strict'

const blessed = require('blessed')

const FILTERS = ['ALL', 'TRADES', 'SURVIVAL', 'ERRORS']

function create(parent) {
  const box = blessed.box({
    parent,
    label:  ' LOG ',
    top:    0,
    left:   0,
    width:  '100%',
    height: '100%-1',
    border: { type: 'line' },
    style:  { border: { fg: 'white' }, label: { fg: 'white', bold: true } },
    tags:       true,
    scrollable: true,
    alwaysScroll: true,
    keys:   true,
    mouse:  true
  })

  const entries   = []  // { text, type }
  let filterIdx   = 0

  function append(text, type) {
    entries.unshift({ text, type })
    if (entries.length > 500) entries.pop()
    render()
  }

  function onTick(snap) {
    const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    append(`{grey-fg}=== ROUND ${snap.round}  ${ts} ==={/grey-fg}`, 'TICK')
  }

  function onTrade(result) {
    if (!result) return
    const { trade, decision } = result
    const agent = result.agent || '?'

    if (trade) {
      const enforced = decision && decision.enforced_reason ? ` {yellow-fg}[${decision.enforced_reason}]{/yellow-fg}` : ''
      const label = `{green-fg}${agent} ${trade.action} ${trade.pair}` +
                    ` $${Math.round(trade.proceeds_or_cost).toLocaleString()}` +
                    ` @ $${trade.price?.toLocaleString()}{/green-fg}${enforced}`
      append(label, 'TRADE')
    } else if (decision) {
      const reason = decision.enforced_reason ? ` {yellow-fg}[${decision.enforced_reason}]{/yellow-fg}` : ''
      append(`{grey-fg}${agent} HOLD ${decision.pair || ''}${reason}{/grey-fg}`, 'TRADE')
    }
  }

  function onSurvival(data) {
    const { event_type, reason, new_status } = data.payload || {}
    if (event_type === 'AUTO_ELIMINATE' || new_status === 'eliminated') {
      append(`{red-fg}⚡ ${event_type} ${data.agent}: ${reason}{/red-fg}`, 'SURVIVAL')
    } else {
      append(`{yellow-fg}⚠ ${event_type} ${data.agent}: ${reason}{/yellow-fg}`, 'SURVIVAL')
    }
  }

  function onError(data) {
    append(`{magenta-fg}ERROR: ${data.message}{/magenta-fg}`, 'ERROR')
  }

  function cycleFilter() {
    filterIdx = (filterIdx + 1) % FILTERS.length
    box.setLabel(` LOG [${FILTERS[filterIdx]}] `)
    render()
  }

  function render() {
    const filter  = FILTERS[filterIdx]
    const visible = entries.filter(e => {
      if (filter === 'ALL')      return true
      if (filter === 'TRADES')   return e.type === 'TRADE'
      if (filter === 'SURVIVAL') return e.type === 'SURVIVAL'
      if (filter === 'ERRORS')   return e.type === 'ERROR'
      return true
    })
    box.setContent(visible.map(e => e.text).join('\n'))
    box.setScrollPerc(0)
    parent.screen.render()
  }

  return { append, onTick, onTrade, onSurvival, onError, cycleFilter }
}

module.exports = { create }
