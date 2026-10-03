/** Tiện ích dùng chung cho giao diện. */

export const $ = (selector, scope = document) => scope.querySelector(selector)
export const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector))

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'html') node.innerHTML = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value !== undefined && value !== null) node.setAttribute(key, value)
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  if (totalSeconds > 0) return `${totalSeconds}s`
  return `${Math.max(0, Math.round(ms))}ms`
}

export function fmtClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function fmtBytes(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value < 10 && index > 0 ? 2 : 1)} ${units[index]}`
}

export function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString('vi-VN', { hour12: false })
  } catch {
    return '--:--:--'
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const clamp = (value, min, max) => Math.min(Math.max(value, min), max)

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID()
  return `c_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

export function store(key, value) {
  try {
    if (value === undefined) {
      const raw = localStorage.getItem(`wayground.${key}`)
      return raw === null ? undefined : JSON.parse(raw)
    }
    localStorage.setItem(`wayground.${key}`, JSON.stringify(value))
    return value
  } catch {
    return undefined
  }
}

export function toast(message, { timeout = 2600 } = {}) {
  const node = document.getElementById('toast')
  if (!node) return
  node.textContent = message
  node.hidden = false
  clearTimeout(toast._timer)
  toast._timer = setTimeout(() => (node.hidden = true), timeout)
}

/** Gửi POST kèm header chống CSRF của ứng dụng. */
export async function api(path, { method = 'POST', body, headers = {} } = {}) {
  const response = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'X-Wayground': '1', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  let payload = null
  try {
    payload = await response.json()
  } catch {
    /* ignore */
  }

  if (!response.ok) {
    const error = new Error(payload?.message ?? payload?.error ?? `HTTP ${response.status}`)
    error.status = response.status
    error.payload = payload
    throw error
  }

  return payload
}

export function levelLabel(level) {
  return (
    {
      running: 'đang chạy',
      soft: 'bậc mềm (client)',
      hard: 'bậc neko (private mode)',
      deep: 'bậc sâu (docker pause)',
    }[level] ?? level
  )
}
