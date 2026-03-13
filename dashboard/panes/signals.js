'use strict'

const VERSION = '1.0.2'

const blessed = require('blessed')
const { C }   = require('../../core/world')

const BAR_WIDTH   = 10
const FULL_BLOCK  = '█'
const EMPTY_BLOCK = '░'

function create(parent) {
  const box = blessed.box({
    parent,
    label:  ' SIGNALS ',
    top:    0,
    left:   0,
    width:  '100%',
    height: '100%-1',
    border: { type: 'line' },
    style:  { border: { fg: 'blue' }, label: { fg: 'blue', bold: true } },
    tags:   true,
    scrollable: true,
    keys:   true
  })

  let compact        = true
  let lastSigs       = []
  let lastMacroTrend = null

  function update(signals, macroTrend) {
    if (!signals || !signals.length) return
    lastSigs = signals
    if (macroTrend !== undefined) lastMacroTrend = macroTrend
    render()
  }

  function render() {
    const header = formatMacroTrend(lastMacroTrend)
    const lines  = lastSigs.map(s => formatSignal(s, compact))
    box.setContent((header ? header + '\n' : '') + lines.join('\n'))
    parent.screen.render()
  }

  function toggleCompact() {
    compact = !compact
    render()
  }

  return { update, toggleCompact }
}

function formatMacroTrend(macro) {
  if (!macro) return ''

  const label = macro.trend === 'bull'
    ? '{green-fg}↑ BULL{/green-fg}'
    : macro.trend === 'bear'
      ? '{red-fg}↓ BEAR{/red-fg}'
      : '{grey-fg}~ NEUTRAL{/grey-fg}'

  // Breadth-based (new format)
  if (macro.btc !== undefined) {
    const { bullCount, bearCount, neutralCount, total, btc } = macro
    const breadthStr = `  {green-fg}${bullCount}▲{/green-fg} {red-fg}${bearCount}▼{/red-fg} {grey-fg}${neutralCount}~{/grey-fg}/${total}`
    let btcStr = ''
    if (btc && btc.price != null) {
      const pctSign    = btc.pct >= 0 ? '+' : ''
      const slopeColor = btc.slopeDir === 'rising' ? 'green' : btc.slopeDir === 'falling' ? 'red' : 'grey'
      btcStr = `BTC $${Math.round(btc.price).toLocaleString()}  SMA${btc.period} $${Math.round(btc.sma).toLocaleString()}  {bold}${pctSign}${btc.pct}%{/bold}  slope:{${slopeColor}-fg}${btc.slopeDir}{/${slopeColor}-fg}`
    }
    return `{bold}Market:{/bold} ${label}${breadthStr}\n${btcStr}\n${'─'.repeat(52)}`
  }

  // Legacy BTC-only format (backward compat)
  const { trend, price, sma, pct, slopeDir, period } = macro
  const slopeColor = slopeDir === 'rising' ? 'green' : slopeDir === 'falling' ? 'red' : 'grey'
  const pctSign    = pct != null && pct >= 0 ? '+' : ''
  const priceStr   = price  != null ? `  BTC $${Math.round(price).toLocaleString()}` : ''
  const smaStr     = sma    != null ? `  SMA${period} $${Math.round(sma).toLocaleString()}` : ''
  const pctStr     = pct    != null ? `  {bold}${pctSign}${pct}%{/bold}` : ''
  const slopeStr   = slopeDir       ? `  slope: {${slopeColor}-fg}${slopeDir}{/${slopeColor}-fg}` : ''
  return `{bold}BTC Macro:{/bold} ${label}${priceStr}${smaStr}${pctStr}${slopeStr}\n${'─'.repeat(52)}`
}

function formatSignal(s, compact) {
  const score   = s.signal_score
  const filled  = Math.round(Math.abs(score) * BAR_WIDTH)
  const empty   = BAR_WIDTH - filled
  const bar     = FULL_BLOCK.repeat(filled) + EMPTY_BLOCK.repeat(empty)
  const scoreStr = (score >= 0 ? '+' : '') + score.toFixed(2)

  let color
  if      (score >  0.3) color = 'green'
  else if (score < -0.3) color = 'red'
  else                   color = 'yellow'

  const label    = (C.LABELS[s.pair] || s.pair).padEnd(10)
  const rsi      = s.rsi_14 != null ? `RSI:${Math.round(s.rsi_14)}` : 'RSI:---'
  const priceStr = s.price != null ? fmtPrice(s.price).padStart(12) : ''.padStart(12)

  const main = `{${color}-fg}${label}{/${color}-fg} {grey-fg}${priceStr}{/grey-fg}  {${color}-fg}${bar} ${scoreStr.padStart(6)}{/${color}-fg}  ${rsi.padEnd(7)}  ${s.regime}`

  if (compact) return main

  return [
    main,
    `  mom1h=${fmtN(s.momentum_1h)}  mom4h=${fmtN(s.momentum_4h)}  vol_z=${fmtN(s.volume_zscore)}`,
    `  mean_rev=${fmtN(s.mean_rev_sigma)}  bb_pos=${fmtN(s.bb_position)}  btc_lead=${s.btc_lead_signal != null ? fmtN(s.btc_lead_signal) : 'null'}`,
    `  conf=${s.regime_confidence != null ? s.regime_confidence.toFixed(2) : 'n/a'}  divergence=${s.rsi_divergence}`,
    ''
  ].join('\n')
}

function fmtN(v) {
  return v != null ? Number(v).toFixed(2) : 'n/a'
}

function fmtPrice(p) {
  if (p >= 1000)  return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (p >= 1)     return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 })
  return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 5 })
}

module.exports = { create, VERSION }
