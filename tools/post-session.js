'use strict'

/**
 * tools/post-session.js
 *
 * Orchestrator — runs after every session stop.
 * Chains: export → report → compare (if prior session exists) → detect-changes (Phase 3+)
 *
 * Spawned by api.js when the stop command is received.
 * Stdout is captured by api.js and broadcast to the TUI.
 */

const { execFileSync } = require('child_process')
const path             = require('path')
const fs               = require('fs')

const node      = process.execPath
const toolsDir  = __dirname
const sessionDir = path.join(__dirname, '../sessions')

function run(script, label, args = []) {
  try {
    const out = execFileSync(node, [path.join(toolsDir, script), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    console.log(`✓ ${label}`)
    return out.toString()
  } catch (err) {
    console.error(`✗ ${label}: ${err.message.split('\n')[0]}`)
    return null
  }
}

console.log('── Post-session analysis starting ──')

const exported = run('export-session.js', 'Session exported')
if (!exported) process.exit(1)

run('reset-db.js', 'DB reset for next session')

run('report-session.js', 'Report generated')

// compare-sessions and detect-changes are Phase 3 — skip if scripts don't exist yet
const compareScript = path.join(toolsDir, 'compare-sessions.js')
if (fs.existsSync(compareScript)) {
  run('compare-sessions.js', 'Sessions compared', ['--latest-two'])
}

const detectScript = path.join(toolsDir, 'detect-changes.js')
if (fs.existsSync(detectScript)) {
  const detectOut = run('detect-changes.js', 'Change detection complete')
  if (detectOut) {
    detectOut.trim().split('\n')
      .filter(l => l && !l.startsWith('✓'))
      .forEach(l => console.log(`  ↳ ${l}`))
  }
}

// Count trades from the latest session for the summary broadcast
try {
  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith('.meta.json'))
    .map(f => ({ f, mtime: fs.statSync(path.join(sessionDir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime)

  if (files.length) {
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir, files[0].f), 'utf8'))
    console.log(`── Analysis complete: ${meta.closedTradeCount} trades, ${meta.totalRounds} rounds (${meta.durationHours}h) ──`)
  }
} catch (_) {
  console.log('── Analysis complete ──')
}
