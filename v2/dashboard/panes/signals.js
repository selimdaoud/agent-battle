'use strict'

const blessed = require('blessed')

// Regime abbreviations
const REGIME_ABBREV = {
  p_trending_up:   '↑TRD ',
  p_trending_down: '↓TRD ',
  p_volatile:      ' VOL ',
  p_ranging:       ' RNG '
}

function dominantRegime(sv) {
  const keys = ['p_volatile', 'p_trending_up', 'p_trending_down', 'p_ranging']
  let best = keys[0]
  for (const k of keys) if ((sv[k] || 0) > (sv[best] || 0)) best = k
  return { key: best, prob: sv[best] || 0 }
}

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

  let _signals = []
  const _prevScores = {}   // pair → last composite score
  const _flash      = {}   // pair → 'up' | 'down' | null
  const _flashTimers = {}  // pair → timer

box.setContent('{grey-fg}Waiting for engine...{/grey-fg}')

  function render() {
    if (!_signals.length) { box.setContent('{grey-fg}Waiting...{/grey-fg}'); return }

    const hdr  = `{cyan-fg}{bold}${'Pair'.padEnd(10)} ${'Price'.padStart(10)} ${'Score'.padStart(6)} ${'Regime'.padEnd(10)} ${'CVD'.padStart(5)}{/bold}{/cyan-fg}`
    const sep  = '{grey-fg}' + '─'.repeat(45) + '{/grey-fg}'
    const lines = [hdr, sep]

    const sorted = [..._signals].sort((a, b) => a.pair.localeCompare(b.pair))

    for (const sv of sorted) {
      const composite = (
        sv.cvd_norm * 0.25 + sv.funding_signal * 0.22 + sv.momentum_1h * 0.18 +
        sv.momentum_4h * 0.05 + sv.rsi_norm * 0.12 + sv.volume_zscore * 0.10 +
        sv.fear_greed_signal * 0.08
      )
      const { key, prob } = dominantRegime(sv)
      const regimeStr  = `${REGIME_ABBREV[key] || '?'}${(prob * 100).toFixed(0).padStart(3)}%`
      const flash = _flash[sv.pair]
      const scoreStr = `${composite >= 0 ? '+' : ''}${composite.toFixed(3)}`
      const scoreFmt = flash === 'up'   ? `{black-fg}{green-bg} ${scoreStr} {/green-bg}{/black-fg}`
                     : flash === 'down' ? `{black-fg}{red-bg} ${scoreStr} {/red-bg}{/black-fg}`
                     : composite > 0.15 ? `{green-fg}${scoreStr}{/green-fg}`
                     : composite < -0.10 ? `{red-fg}${scoreStr}{/red-fg}`
                     :                     `{white-fg}${scoreStr}{/white-fg}`

      const priceStr = sv.price >= 1000  ? sv.price.toFixed(0)
                     : sv.price >= 1    ? sv.price.toFixed(2)
                     :                    sv.price.toFixed(4)

      lines.push(
        `${sv.pair.padEnd(10)}` +
        ` ${priceStr.padStart(10)}` +
        ` ${scoreFmt}` +
        ` ${regimeStr.padEnd(10)}` +
        ` ${sv.cvd_norm.toFixed(2).padStart(5)}`
      )
    }

    box.setContent(lines.join('\n'))
  }

  return {
    update(signals) {
      _signals = signals || []

      for (const sv of _signals) {
        const composite = (
          sv.cvd_norm * 0.25 + sv.funding_signal * 0.22 + sv.momentum_1h * 0.18 +
          sv.momentum_4h * 0.05 + sv.rsi_norm * 0.12 + sv.volume_zscore * 0.10 +
          sv.fear_greed_signal * 0.08
        )
        const prev = _prevScores[sv.pair]
        if (prev !== undefined && Math.abs(composite - prev) > 0.001) {
          _flash[sv.pair] = composite > prev ? 'up' : 'down'
          if (_flashTimers[sv.pair]) clearTimeout(_flashTimers[sv.pair])
          _flashTimers[sv.pair] = setTimeout(() => { _flash[sv.pair] = null; render() }, 1000)
        }
        _prevScores[sv.pair] = composite
      }

      render()
    }
  }
}

module.exports = { create }
