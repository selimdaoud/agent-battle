'use strict'

const fs   = require('fs')
const path = require('path')

const GATES = {
  inSampleSharpe:  { label: 'In-sample Sharpe  > 1.2',   pass: v => v > 1.2 },
  holdoutSharpe:   { label: 'Holdout Sharpe    > 0.9×IS', pass: (v, ctx) => v > 0.9 * ctx.inSampleSharpe },
  maxDrawdown:     { label: 'Max drawdown      < 20%',    pass: v => v < 0.20 },
  winRate:         { label: 'Win rate          > 52%',    pass: v => v > 0.52 },
  profitFactor:    { label: 'Profit factor     > 1.3',    pass: v => v > 1.3 }
}

function print(results) {
  const { inSample, holdout, pairs, period, interval } = results

  console.log('\n' + '═'.repeat(56))
  console.log('  BACKTEST REPORT')
  console.log('  Pairs:    ' + pairs.join(', '))
  console.log('  Period:   ' + period + 'd  |  Interval: ' + interval)
  console.log('═'.repeat(56))

  console.log('\n── IN-SAMPLE (' + inSample.bars + ' bars) ──')
  printMetrics(inSample)

  console.log('\n── HOLDOUT (' + holdout.bars + ' bars) ──')
  printMetrics(holdout)

  console.log('\n── GATES ──')
  const ctx = { inSampleSharpe: inSample.sharpe }
  let allPass = true

  for (const [key, gate] of Object.entries(GATES)) {
    let value
    if      (key === 'inSampleSharpe') value = inSample.sharpe
    else if (key === 'holdoutSharpe')  value = holdout.sharpe
    else if (key === 'maxDrawdown')    value = holdout.maxDrawdown
    else if (key === 'winRate')        value = holdout.winRate
    else if (key === 'profitFactor')   value = holdout.profitFactor

    const ok = gate.pass(value, ctx)
    if (!ok) allPass = false
    console.log(`  [${ok ? 'PASS' : 'FAIL'}]  ${gate.label}`)
  }

  console.log('\n  Overall: ' + (allPass ? '✅ ALL PASS' : '❌ SOME FAILED'))
  console.log('═'.repeat(56) + '\n')
}

function printMetrics(m) {
  console.log(`  Sharpe:        ${fmt(m.sharpe, 3)}`)
  console.log(`  Max drawdown:  ${pct(m.maxDrawdown)}`)
  console.log(`  Win rate:      ${pct(m.winRate)}`)
  console.log(`  Profit factor: ${fmt(m.profitFactor, 2)}`)
  console.log(`  Total return:  ${pct(m.totalReturn)}`)
  console.log(`  Trades:        ${m.trades}`)
}

function printWalkForward(results) {
  const { walkForward: wf, pairs, trainDays, testDays, interval } = results
  const { windows, avgSharpe, avgDrawdown, avgReturn, posWindowsPct } = wf

  console.log('\n' + '═'.repeat(56))
  console.log('  WALK-FORWARD REPORT')
  console.log('  Pairs:      ' + pairs.join(', '))
  console.log('  Train/Test: ' + trainDays + 'd / ' + testDays + 'd  |  Interval: ' + interval)
  console.log('  Windows:    ' + windows.length)
  console.log('═'.repeat(56))

  console.log('\n── PER-WINDOW (out-of-sample) ──')
  for (const w of windows) {
    const pass = w.sharpe > 0 && w.totalReturn > 0
    console.log(
      `  [${pass ? 'PASS' : 'FAIL'}]  W${String(w.window).padStart(2)}` +
      `  Sharpe=${fmt(w.sharpe, 2).padStart(6)}` +
      `  Ret=${pct(w.totalReturn).padStart(8)}` +
      `  DD=${pct(w.maxDrawdown).padStart(7)}` +
      `  WR=${pct(w.winRate).padStart(7)}` +
      `  trades=${w.trades}`
    )
  }

  console.log('\n── AGGREGATE ──')
  console.log(`  Avg out-of-sample Sharpe: ${fmt(avgSharpe, 3)}`)
  console.log(`  Avg out-of-sample return: ${pct(avgReturn)}`)
  console.log(`  Avg max drawdown:         ${pct(avgDrawdown)}`)
  console.log(`  Profitable windows:       ${(posWindowsPct * 100).toFixed(0)}% (${Math.round(posWindowsPct * windows.length)}/${windows.length})`)

  const edgeHolds = avgSharpe > 0.5 && posWindowsPct >= 0.6
  console.log('\n  Verdict: ' + (edgeHolds
    ? '✅  Edge appears consistent — avg Sharpe > 0.5 and ≥60% profitable windows'
    : '❌  Edge is not consistent — do NOT trade this live'))
  console.log('═'.repeat(56) + '\n')
}

function save(results) {
  const dir  = path.join(__dirname, '../data/backtest_results')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${Date.now()}.json`)
  fs.writeFileSync(file, JSON.stringify(results, null, 2))
  console.log(`  Saved → ${file}`)
}

function fmt(v, d) {
  return v == null ? 'n/a' : (typeof v === 'number' ? v.toFixed(d) : String(v))
}

function pct(v) {
  return v == null ? 'n/a' : (v * 100).toFixed(2) + '%'
}

module.exports = { print, printWalkForward, save }
