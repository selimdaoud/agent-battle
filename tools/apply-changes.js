'use strict'

/**
 * tools/apply-changes.js
 *
 * Interactive CLI to review and approve proposed MEGA config changes.
 * Reads:  agents/mega-changes-proposed.json
 * Writes: agents/mega-config.json  (on approval)
 *         sessions/change-history.json  (audit trail)
 *
 * Usage: node tools/apply-changes.js
 */

const readline = require('readline')
const fs       = require('fs')
const path     = require('path')

const proposedFile = path.join(__dirname, '../agents/mega-changes-proposed.json')
const configFile   = path.join(__dirname, '../agents/mega-config.json')
const historyFile  = path.join(__dirname, '../sessions/change-history.json')

// ── Load files ────────────────────────────────────────────────────────────────
if (!fs.existsSync(proposedFile)) {
  console.log('No proposals found. Run the pipeline first (press P to pause session).')
  process.exit(0)
}

const proposed = JSON.parse(fs.readFileSync(proposedFile, 'utf8'))
const megaCfg  = JSON.parse(fs.readFileSync(configFile, 'utf8'))
const history  = fs.existsSync(historyFile)
  ? JSON.parse(fs.readFileSync(historyFile, 'utf8'))
  : { applied: [], rejected: [], sessionCount: 0 }

const proposals = proposed.proposals || []

if (!proposals.length) {
  console.log('No proposals in file.')
  process.exit(0)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Set a nested field by dot-path: 'regime_overrides.ranging.buy_signal' */
function setNestedField(obj, dotPath, value) {
  const keys = dotPath.split('.')
  let cur = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) cur[keys[i]] = {}
    cur = cur[keys[i]]
  }
  cur[keys[keys.length - 1]] = value
}

/** Get a nested field by dot-path */
function getNestedField(obj, dotPath) {
  return dotPath.split('.').reduce((o, k) => o?.[k], obj)
}

/** Renormalize signal_weights so they sum to 1.0 */
function renormalizeWeights(cfg) {
  const w    = cfg.signal_weights
  const total = Object.values(w).reduce((s, v) => s + v, 0)
  if (Math.abs(total - 1.0) < 0.001) return
  for (const k of Object.keys(w)) {
    w[k] = parseFloat((w[k] / total).toFixed(4))
  }
}

// ── Interactive prompt ────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function prompt(question) {
  return new Promise(resolve => rl.question(question, resolve))
}

const DIVIDER = '─'.repeat(60)

async function run() {
  console.log(`\nSession analysis: ${proposed.sessionsAnalyzed} session(s) analyzed`)
  console.log(`Generated: ${proposed.generatedAt}`)
  console.log(`${proposals.length} proposal(s) to review\n`)

  let anyApplied = false

  for (const p of proposals) {
    console.log(DIVIDER)
    console.log(`PROPOSAL: ${p.field}`)
    console.log(`  Current:  ${p.current}`)
    console.log(`  Proposed: ${p.proposed}`)
    console.log(`  Basis:    ${p.confidence}`)
    console.log(``)
    // Word-wrap justification at ~70 chars
    const words = p.justification.split(' ')
    let line = '  '
    for (const word of words) {
      if (line.length + word.length > 72) {
        console.log(line)
        line = '  ' + word + ' '
      } else {
        line += word + ' '
      }
    }
    if (line.trim()) console.log(line)

    if (p.deferred?.length) {
      console.log(`\n  Deferred (will surface next session): ${p.deferred.map(d => d.field).join(', ')}`)
    }

    console.log(``)
    const answer = await prompt('  Apply this change? (y/n/skip-all): ')
    const a = answer.trim().toLowerCase()

    if (a === 'skip-all' || a === 's') {
      console.log('  Skipped — all proposals deferred to next session.')
      break
    }

    if (a === 'y') {
      setNestedField(megaCfg, p.field, p.proposed)

      // Renormalize signal weights if we changed one
      if (p.field.startsWith('signal_weights.')) {
        renormalizeWeights(megaCfg)
        console.log(`  ✓ Applied. Signal weights renormalized.`)
      } else {
        console.log(`  ✓ Applied.`)
      }

      history.applied.push({
        sessionIndex:  proposed.sessionsAnalyzed,
        appliedAt:     new Date().toISOString(),
        field:         p.field,
        from:          p.current,
        to:            p.proposed,
        basis:         p.confidence
      })
      anyApplied = true

    } else {
      console.log(`  ✗ Rejected — will not re-propose for ${3} sessions.`)
      history.rejected.push({
        sessionIndex: proposed.sessionsAnalyzed,
        rejectedAt:   new Date().toISOString(),
        field:        p.field,
        proposed:     p.proposed,
        basis:        p.confidence
      })
    }
  }

  console.log(DIVIDER)

  if (anyApplied) {
    // Bump meta version
    megaCfg.meta.version = (megaCfg.meta.version || 1) + 1
    megaCfg.meta.lastUpdated = new Date().toISOString()
    megaCfg.meta.note = `Updated after session ${proposed.sessionsAnalyzed} — ${history.applied[history.applied.length - 1].field} changed`

    fs.writeFileSync(configFile, JSON.stringify(megaCfg, null, 2))
    console.log(`\n✓ mega-config.json updated (version ${megaCfg.meta.version})`)
    console.log(`  Press P on the TUI to resume — MEGA will load the new config.\n`)
  } else {
    console.log(`\nNo changes applied.\n`)
  }

  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2))
  rl.close()
}

run().catch(err => {
  console.error(err)
  rl.close()
  process.exit(1)
})
