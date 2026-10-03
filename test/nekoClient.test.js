/**
 * Kiểm thử NekoClient với một "neko" giả đúng như hành vi thật:
 *  - chi router: đường dẫn có dấu `/` cuối (`/api/room/settings/`), gọi thiếu
 *    dấu `/` trả 404 (đây là lỗi rất dễ mắc).
 *  - `session.cookie.enabled=true` -> /api/login KHÔNG trả token trong body mà
 *    chỉ Set-Cookie; client phải giữ cookie và gửi lại.
 *  - provider khác multiuser có thể trả 422 "session already connected".
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test, { after, before } from 'node:test'
import { NekoClient } from '../src/nekoClient.js'

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger }

let server
let baseUrl
let mode = 'token'
let loginCount = 0
const calls = []

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : null)
      } catch {
        resolve(raw)
      }
    })
  })
}

function isAuthorized(req, token) {
  if (req.headers.authorization === `Bearer ${token}`) return true
  return String(req.headers.cookie ?? '').includes(`NEKO_SESSION=${token}`)
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://neko')
    const body = await readBody(req)
    calls.push({ method: req.method, path: url.pathname, body, authorization: req.headers.authorization ?? null })

    const json = (status, payload, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(payload))
    }

    if (url.pathname === '/health') return res.writeHead(200).end('true')

    if (url.pathname === '/api/login') {
      loginCount += 1
      if (mode === '422' && loginCount <= 1) return json(422, { message: 'session already connected' })
      if (body.username === 'admin' && body.password !== 'admin') return json(401, { message: 'unauthorized' })
      const token = `${body.username}-token${loginCount}`
      const session = { id: `${body.username}-${loginCount}`, profile: { name: body.username, is_admin: body.username === 'admin' }, state: {} }
      if (mode === 'cookie') return json(200, session, { 'set-cookie': `NEKO_SESSION=${token}; Path=/; HttpOnly` })
      return json(200, { ...session, token })
    }

    // chỉ chấp nhận đường dẫn có dấu `/` cuối, giống chi router của neko
    if (url.pathname === '/api/room/settings/' || url.pathname === '/api/room/control/') {
      const cookieToken = String(req.headers.cookie ?? '').match(/NEKO_SESSION=([^;]+)/)?.[1]
      const bearer = req.headers.authorization?.replace(/^Bearer /, '')
      const token = cookieToken ?? bearer
      if (!token || !isAuthorized(req, token)) return json(401, { message: 'unauthorized' })
      if (req.method === 'GET') return json(200, { private_mode: true, locked_controls: false })
      return json(200, true)
    }

    if (url.pathname === '/api/room/control/reset' && req.method === 'POST') {
      const cookieToken = String(req.headers.cookie ?? '').match(/NEKO_SESSION=([^;]+)/)?.[1]
      if (!cookieToken && !req.headers.authorization) return json(401, { message: 'unauthorized' })
      return json(200, true)
    }

    return json(404, { message: `404 page not found: ${url.pathname}` })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
})

function makeClient(overrides = {}) {
  const config = {
    neko: {
      baseUrl,
      username: 'viewer',
      password: 'neko',
      adminUsername: 'admin',
      adminPassword: 'admin',
      apiToken: '',
      requestTimeoutMs: 5000,
      ...overrides,
    },
  }
  return new NekoClient(config, silentLogger)
}

test('đăng nhập bằng token rồi bật private_mode qua đúng đường dẫn có dấu / cuối', async () => {
  mode = 'token'
  calls.length = 0
  const neko = makeClient()

  const settings = await neko.setPrivateMode(true, 'test')
  assert.equal(settings, true)

  const paths = calls.map((call) => `${call.method} ${call.path}`)
  assert.ok(paths.includes('POST /api/room/settings/'), `phải gọi đường dẫn có / cuối: ${paths.join(', ')}`)
  assert.ok(
    !calls.some((call) => call.path === '/api/room/settings'),
    'không được gọi bản thiếu dấu / (neko trả 404)',
  )
  const call = calls.find((item) => item.path === '/api/room/settings/')
  assert.deepEqual(call.body, { private_mode: true })
  assert.equal(neko.stats.privateModeSet, 1)
})

test('neko bật cookie: client giữ NEKO_SESSION và dùng lại cho request sau', async () => {
  mode = 'cookie'
  calls.length = 0
  const neko = makeClient()

  const session = await neko.adminSession()
  assert.equal(session.token, undefined, 'neko bật cookie thì body không có token')
  assert.match(neko.cookies.get('admin'), /^NEKO_SESSION=admin-token/)

  await neko.setPrivateMode(false, 'test')
  const call = calls.at(-1)
  assert.equal(call.authorization, null, 'không có token thì không gửi header Bearer')
  assert.match(String(calls.at(-1).authorization), /^null$/)
  assert.match(neko.cookies.get('admin'), /^NEKO_SESSION=admin-token/)
})

test('422 (session đang kết nối) được thử lại rồi thành công', async () => {
  mode = '422'
  loginCount = 0
  const neko = makeClient()
  const session = await neko.createViewerSession()
  assert.ok(session.id, 'vẫn phải lấy được session')
  assert.equal(loginCount, 2, 'login lần 1 trả 422, lần 2 (thử lại) thành công')
})

test('/health trả true khi neko sống', async () => {
  const neko = makeClient()
  assert.equal(await neko.health(), true)
})
