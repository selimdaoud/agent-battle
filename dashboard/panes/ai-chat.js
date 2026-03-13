'use strict'

const VERSION = '1.0.1'

const blessed = require('blessed')
const http    = require('http')

function create(screen, host, port, token) {
  // ── Overlay ────────────────────────────────────────────────────────────────
  const box = blessed.box({
    parent:  screen,
    top:     'center',
    left:    'center',
    width:   '72%',
    height:  '72%',
    label:   ' ◆ AI Assistant ',
    border:  { type: 'line' },
    style:   { border: { fg: 'magenta' }, label: { fg: 'magenta', bold: true }, bg: 'black', fg: 'white' },
    hidden:  true,
    tags:    true
  })

  // ── Response area ──────────────────────────────────────────────────────────
  const responseBox = blessed.box({
    parent:       box,
    top:          0,
    left:         1,
    right:        1,
    bottom:       4,
    tags:         true,
    scrollable:   true,
    alwaysScroll: true,
    keys:         true,
    style:        { bg: 'black', fg: 'white' },
    content:      '{grey-fg}Ask a question about the platform — agents, signals, positions, metrics, acronyms.{/grey-fg}'
  })

  // ── Input row ──────────────────────────────────────────────────────────────
  blessed.text({
    parent:  box,
    bottom:  2,
    left:    1,
    width:   4,
    content: 'ai> ',
    style:   { fg: 'magenta', bold: true }
  })

  const inputBox = blessed.textbox({
    parent:       box,
    bottom:       2,
    left:         5,
    right:        1,
    height:       1,
    inputOnFocus: true,
    style:        { fg: 'white', bg: 'black' }
  })

  blessed.text({
    parent:  box,
    bottom:  0,
    left:    1,
    tags:    true,
    style:   { bg: 'black', fg: 'white' },
    content: '{grey-fg}[Enter] Send   [Esc] Cancel request / Close{/grey-fg}'
  })

  // ── State ──────────────────────────────────────────────────────────────────
  let activeReq = null
  let timerInt  = null
  let timerSecs = 0

  function _stopTimer() {
    if (timerInt) { clearInterval(timerInt); timerInt = null }
  }

  function _startTimer() {
    timerSecs = 0
    _stopTimer()
    responseBox.setContent('{grey-fg}Thinking... 0s{/grey-fg}')
    timerInt = setInterval(() => {
      timerSecs++
      const phase = timerSecs <= 3 ? 'Thinking' : 'Answering'
      responseBox.setContent(`{grey-fg}${phase}... ${timerSecs}s{/grey-fg}`)
      screen.render()
    }, 1000)
  }

  function _cancel() {
    if (!activeReq) return
    _stopTimer()
    activeReq.destroy()
    activeReq = null
    responseBox.setContent('{yellow-fg}Cancelled.{/yellow-fg}')
    screen.render()
  }

  function _wrap(text, width) {
    const words = text.split(' ')
    const lines = []
    let   line  = ''
    for (const w of words) {
      if (line.length + w.length + 1 > Math.max(width, 20)) { lines.push(line.trimEnd()); line = '' }
      line += w + ' '
    }
    if (line.trim()) lines.push(line.trimEnd())
    return lines.join('\n')
  }

  function _submit(question) {
    if (!question.trim()) return
    if (activeReq) _cancel()
    _startTimer()

    const body = JSON.stringify({ token, question })
    const req  = http.request({
      hostname: host,
      port:     parseInt(port),
      path:     '/ask',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        _stopTimer()
        activeReq = null
        if (!data.trim()) return  // empty body = server-side cancel, already handled
        try {
          const parsed   = JSON.parse(data)
          const text     = parsed.answer || parsed.error || 'No response.'
          const boxWidth = Math.floor((screen.width || 80) * 0.72) - 6
          responseBox.setContent(`{white-fg}${_wrap(text, boxWidth)}{/white-fg}`)
        } catch (_) {
          responseBox.setContent(`{red-fg}Unexpected response (status ${res.statusCode}):\n${data.slice(0, 300)}{/red-fg}`)
        }
        screen.render()
      })
    })

    req.on('error', err => {
      // ECONNRESET / socket hang up = user cancelled — already handled
      if (err.code === 'ECONNRESET' || err.message.includes('socket hang up')) return
      _stopTimer()
      activeReq = null
      responseBox.setContent(`{red-fg}Error: ${err.message}{/red-fg}`)
      screen.render()
    })

    req.write(body)
    req.end()
    activeReq = req
  }

  // ── Key bindings on the textbox ────────────────────────────────────────────
  inputBox.key('enter', () => {
    const q = inputBox.getValue().trim()
    inputBox.clearValue()
    screen.render()
    if (q) _submit(q)
  })

  // ── Public API ─────────────────────────────────────────────────────────────
  function open() {
    box.show()
    box.setFront()
    inputBox.clearValue()
    inputBox.focus()
    screen.render()
  }

  function close() {
    _cancel()
    box.hide()
    screen.render()
  }

  function handleEsc() {
    if (activeReq) {
      _cancel()
    } else {
      close()
    }
  }

  function isOpen() { return !box.hidden }

  return { open, close, handleEsc, isOpen, VERSION }
}

module.exports = { create, VERSION }
