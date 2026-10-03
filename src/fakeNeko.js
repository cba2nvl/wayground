/**
 * fakeNeko.js - neko "giả lập" chạy trong tiến trình node.js.
 *
 * Dùng cho:
 *  - MODE=demo     : để toàn bộ đường đi của code phía server (đăng nhập, đổi
 *                    private_mode, kiểm tra settings) được chạy y như thật.
 *  - bài test tích hợp (test/): không cần docker/neko thật vẫn kiểm chứng được
 *                    logic pause gọi đúng API nào.
 *
 * Nó cài đúng những endpoint mà NekoClient dùng, kể cả quy tắc quyền admin.
 */
import http from 'node:http'

const json = (res, status, body) => {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

export function createFakeNeko({ adminUsername = 'admin', adminPassword = 'admin', userPassword = 'neko' } = {}) {
  const state = {
    settings: {
      private_mode: false,
      locked_logins: false,
      locked_controls: false,
      control_protection: false,
      implicit_hosting: true,
      inactive_cursors: false,
      merciful_reconnect: true,
      heartbeat_interval: 20,
    },
    sessions: new Map(),
    calls: [],
    privateModeChanges: [],
    startedAt: new Date().toISOString(),
  }

  let counter = 0

  const record = (req, path, body) => {
    const entry = {
      at: new Date().toISOString(),
      method: req.method,
      path,
      body: body === undefined ? undefined : body,
      authorization: req.headers.authorization ? maskToken(req.headers.authorization) : null,
    }
    state.calls.push(entry)
    if (state.calls.length > 500) state.calls.shift()
    return entry
  }

  const maskToken = (value) => {
    const token = String(value).replace(/^Bearer\s+/i, '')
    return `Bearer ${token.slice(0, 6)}…`
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        if (!raw) return resolve(undefined)
        try {
          resolve(JSON.parse(raw))
        } catch {
          resolve(raw)
        }
      })
    })

  const requireAdmin = (req, res) => {
    const header = req.headers.authorization ?? ''
    const token = header.replace(/^Bearer\s+/i, '')
    const session = state.sessions.get(token)
    if (!session) {
      json(res, 401, { message: 'session not found' })
      return null
    }
    if (!session.profile.is_admin) {
      json(res, 403, { message: 'admin only' })
      return null
    }
    return session
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method ?? '') ? await readBody(req) : undefined
    record(req, path, body)

    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('true')
      return
    }

    if (path === '/api/login' && req.method === 'POST') {
      const { username = '', password = '' } = body ?? {}
      const isAdmin = password === adminPassword
      const isUser = password === userPassword
      if (!isAdmin && !isUser) {
        json(res, 401, { message: 'invalid password' })
        return
      }

      const id = `${username || (isAdmin ? 'admin' : 'neko')}-${(counter += 1).toString(36)}`
      const token = `fake-${id}-token`
      const profile = {
        name: username || (isAdmin ? adminUsername : 'neko'),
        is_admin: isAdmin,
        can_login: true,
        can_connect: true,
        can_watch: true,
        can_host: true,
        can_access_clipboard: true,
      }
      state.sessions.set(token, { id, token, profile })
      json(res, 200, { id, token, profile, state: { is_connected: false } })
      return
    }

    if (path === '/api/whoami') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const session = state.sessions.get(token)
      if (!session) {
        json(res, 401, { message: 'session not found' })
        return
      }
      json(res, 200, { id: session.id, profile: session.profile, state: { is_connected: true } })
      return
    }

    if (path === '/api/logout' && req.method === 'POST') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      state.sessions.delete(token)
      json(res, 200, true)
      return
    }

    // neko dùng chi router: đường dẫn thật có dấu `/` cuối; chấp nhận cả hai
    // để bắt được client gọi sai (test sẽ phát hiện).
    if ((path === '/api/room/settings/' || path === '/api/room/settings') && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      json(res, 200, state.settings)
      return
    }

    if ((path === '/api/room/settings/' || path === '/api/room/settings') && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      const before = state.settings.private_mode
      Object.assign(state.settings, body ?? {})
      if (before !== state.settings.private_mode) {
        state.privateModeChanges.push({
          at: new Date().toISOString(),
          enabled: state.settings.private_mode,
          via: `POST ${path}`,
        })
      }
      json(res, 200, true)
      return
    }

    if ((path === '/api/room/control/' || path === '/api/room/control') && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      json(res, 200, { has_host: false })
      return
    }

    if (path === '/api/room/control/reset' && req.method === 'POST') {
      if (!requireAdmin(req, res)) return
      json(res, 200, true)
      return
    }

    if (path === '/api/sessions' && req.method === 'GET') {
      if (!requireAdmin(req, res)) return
      json(res, 200, [...state.sessions.values()].map((s) => ({ id: s.id, profile: s.profile, state: { is_connected: false } })))
      return
    }

    if (path === '/__fake/state') {
      json(res, 200, {
        startedAt: state.startedAt,
        settings: state.settings,
        privateModeChanges: state.privateModeChanges,
        sessionCount: state.sessions.size,
        calls: state.calls.slice(-60),
      })
      return
    }

    json(res, 404, { message: `fake neko: không có endpoint ${req.method} ${path}` })
  })

  let baseUrl = null

  return {
    server,
    state,
    async start(port = 0, host = '127.0.0.1') {
      await new Promise((resolve) => server.listen(port, host, resolve))
      const address = server.address()
      baseUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`
      return baseUrl
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve))
    },
    get baseUrl() {
      return baseUrl
    },
    snapshot() {
      return {
        baseUrl,
        settings: state.settings,
        privateModeChanges: state.privateModeChanges,
        calls: state.calls.slice(-30),
      }
    },
  }
}

export default createFakeNeko
