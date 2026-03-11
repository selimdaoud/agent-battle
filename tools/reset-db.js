'use strict'

/**
 * tools/reset-db.js
 *
 * Clears the ticks table and resets current_round to 0 in sim.db.
 * Run after export-session.js so each new session starts with a clean DB.
 * Agent capital/holdings persist in memory across sessions (carried over by engine.js).
 *
 * Usage: node tools/reset-db.js [--db <path>]
 */

const Database = require('better-sqlite3')
const path     = require('path')

const args   = process.argv.slice(2)
const dbPath = args[args.indexOf('--db') + 1] || path.join(__dirname, '../data/sim.db')

const db = new Database(dbPath)
db.exec(`DELETE FROM ticks`)
db.prepare("UPDATE config SET value='0' WHERE key='current_round'").run()
db.close()

console.log('✓ DB reset: ticks cleared, current_round=0')
