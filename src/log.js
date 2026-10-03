/**
 * log.js - Logger nhỏ gọn + ring-buffer để hiển thị "Nhật ký trực tiếp" trên UI.
 */
import { EventEmitter } from 'node:events'
import process from 'node:process'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 }
const COLORS = { debug: '\u001b[90m', info: '\u001b[36m', warn: '\u001b[33m', error: '\u001b[31m' }
const RESET = '\u001b[0m'

const BUS = new EventEmitter()
BUS.setMaxListeners(200)

const HISTORY_LIMIT = 500
const history = []

let minLevel = LEVELS.info

export function setLogLevel(level) {
  minLevel = LEVELS[String(level).toLowerCase()] ?? LEVELS.info
}

export function logHistory() {
  return history.slice()
}

export function onLog(listener) {
  BUS.on('entry', listener)
  return () => BUS.off('entry', listener)
}

function write(level, message, meta) {
  const entry = {
    t: new Date().toISOString(),
    level,
    message: String(message),
    meta: meta && Object.keys(meta).length ? meta : undefined,
  }

  history.push(entry)
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT)

  if (LEVELS[level] >= minLevel) {
    const stamp = new Date().toISOString().slice(11, 23)
    const color = COLORS[level] ?? ''
    const metaStr = entry.meta ? ` ${JSON.stringify(entry.meta)}` : ''
    const line = `${color}${stamp} ${level.toUpperCase().padEnd(5)}${RESET} ${message}${metaStr}`
    if (level === 'error') process.stderr.write(`${line}\n`)
    else process.stdout.write(`${line}\n`)
  }

  BUS.emit('entry', entry)
  return entry
}

export const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  child: () => logger,
}

export default logger
