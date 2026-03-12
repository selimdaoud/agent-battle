'use strict'

const blessed = require('blessed')

const FILTERS       = ['ALL', 'TRADES', 'SURVIVAL', 'ERRORS']
const AGENT_FILTERS = ['ALL', 'ALPHA', 'BETA', 'GAMMA', 'MEGA']

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

  const entries   = []  // { text, type, agent }
  let filterIdx   = 0
  let agentIdx    = 0

  function _label() {
    const type  = FILTERS[filterIdx]
    const agent = AGENT_FILTERS[agentIdx]
    const parts = []
    if (type  !== 'ALL') parts.push(type)
    if (agent !== 'ALL') parts.push(agent)
    return parts.length ? ` LOG [${parts.join(' | ')}] ` : ' LOG '
  }

  function append(text, type, agent = null, hold = false) {
    entries.unshift({ text, type, agent, hold })
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
    const ts    = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

    if (trade) {
      const enforced = decision && decision.enforced_reason ? ` {yellow-fg}[${decision.enforced_reason}]{/yellow-fg}` : ''
      const feeStr   = trade.fee > 0 ? ` {magenta-fg}fee $${trade.fee.toFixed(3)}{/magenta-fg}` : ''
      const label = `{grey-fg}${ts}{/grey-fg} {green-fg}${agent} ${trade.action} ${trade.pair}` +
                    ` $${Math.round(trade.proceeds_or_cost).toLocaleString()}` +
                    ` @ $${trade.price?.toLocaleString()}{/green-fg}${feeStr}${enforced}`
      if (decision && decision.reasoning) {
        append(`  {cyan-fg}↳ ${decision.reasoning}{/cyan-fg}`, 'TRADE', agent)
      }
      append(label, 'TRADE', agent)
    } else if (decision) {
      const reason = decision.enforced_reason ? ` {yellow-fg}[${decision.enforced_reason}]{/yellow-fg}` : ''
      if (decision.reasoning) {
        append(`  {grey-fg}↳ ${decision.reasoning}{/grey-fg}`, 'TRADE', agent, true)
      }
      append(`{grey-fg}${ts} ${agent} HOLD ${decision.pair || ''}${reason}{/grey-fg}`, 'TRADE', agent, true)
    }
  }

  function onSurvival(data) {
    const { event_type, reason, new_status } = data.payload || {}
    if (event_type === 'AUTO_ELIMINATE' || new_status === 'eliminated') {
      append(`{red-fg}⚡ ${event_type} ${data.agent}: ${reason}{/red-fg}`, 'SURVIVAL', data.agent)
    } else {
      append(`{yellow-fg}⚠ ${event_type} ${data.agent}: ${reason}{/yellow-fg}`, 'SURVIVAL', data.agent)
    }
  }

  function onCandle(data) {
    const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    append(`{grey-fg}${ts}{/grey-fg} {blue-fg}▶ ${data.message}{/blue-fg}`, 'CANDLE')
  }

  function onError(data) {
    append(`{magenta-fg}ERROR: ${data.message}{/magenta-fg}`, 'ERROR')
  }

  function cycleFilter() {
    filterIdx = (filterIdx + 1) % FILTERS.length
    box.setLabel(_label())
    render()
  }

  function cycleAgentFilter() {
    agentIdx = (agentIdx + 1) % AGENT_FILTERS.length
    box.setLabel(_label())
    render()
  }

  function render() {
    const typeFilter  = FILTERS[filterIdx]
    const agentFilter = AGENT_FILTERS[agentIdx]
    const visible = entries.filter(e => {
      if (typeFilter === 'TRADES'   && e.type !== 'TRADE')    return false
      if (typeFilter === 'SURVIVAL' && e.type !== 'SURVIVAL') return false
      if (typeFilter === 'ERRORS'   && e.type !== 'ERROR')    return false
      if (agentFilter !== 'ALL' && e.agent !== agentFilter)   return false
      if (agentFilter !== 'ALL' && e.hold)                    return false
      return true
    })
    box.setContent(visible.map(e => e.text).join('\n'))
    box.setScrollPerc(0)
    parent.screen.render()
  }

  function clear() {
    entries.length = 0
    render()
  }

  return { append, clear, onTick, onTrade, onSurvival, onCandle, onError, cycleFilter, cycleAgentFilter }
}

module.exports = { create }
