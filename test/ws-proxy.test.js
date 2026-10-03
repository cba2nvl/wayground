/**
 * Kiểm thử proxy WebSocket tới neko:
 *  - /viewer-ws?ticket=...  : node.js tự đăng nhập neko và gắn token (?token=)
 *    vào kết nối tới `/api/ws` (giao thức mới).
 *  - /neko-ui/ws            : iframe giao diện neko nói giao thức cũ, node.js
 *    chuyển tiếp tới `/ws` (legacy adapter) với tài khoản thật lấy từ cấu hình.
 * Dùng một "neko" giả bằng WebSocket server thật.
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import test, { after, before } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { attachWebSocketProxies } from '../src/proxy.js'

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger }

let upstreamServer
let gatewayServer
let proxy
const upstreamConnections = []

const config = {
  neko: { baseUrl: 'http://127.0.0.1:1', username: 'neko', password: 'bi-mat-that' },
  novnc: { url: '', wsUrl: '' },
}

before(async () => {
  // 1) "neko" giả: chỉ cần nhận websocket và ghi lại token trong query
  upstreamServer = http.createServer((req, res) => res.writeHead(404).end())
  const upstreamWss = new WebSocketServer({ noServer: true })
  upstreamServer.on('upgrade', (req, socket, head) => {
    upstreamWss.handleUpgrade(req, socket, head, (ws) => {
      const url = new URL(req.url, 'http://upstream')
      upstreamConnections.push({
        path: url.pathname,
        token: url.searchParams.get('token'),
        query: Object.fromEntries(url.searchParams.entries()),
        origin: req.headers.origin ?? null,
      })
      ws.send(JSON.stringify({ event: 'system/init', payload: { session_id: `s${upstreamConnections.length}`, from: 'fake-neko' } }))
      ws.on('message', (raw) => ws.send(JSON.stringify({ event: 'echo', payload: { got: raw.toString() } })))
    })
  })

  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstreamServer.address().port
  config.neko.baseUrl = `http://127.0.0.1:${upstreamPort}`

  // 2) gateway của chúng ta
  gatewayServer = http.createServer((req, res) => res.writeHead(404).end())
  proxy = attachWebSocketProxies(gatewayServer, { config, logger: silentLogger })
  await new Promise((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve))
})

after(async () => {
  await proxy?.close()
  await new Promise((resolve) => gatewayServer?.close(resolve))
  await new Promise((resolve) => upstreamServer?.close(resolve))
})

function openGatewaySocket(path) {
  const port = gatewayServer.address().port
  return new WebSocket(`ws://127.0.0.1:${port}${path}`)
}

test('/viewer-ws dùng token lấy từ neko (không lộ ra trình duyệt)', async () => {
  const ticket = proxy.issueTicket({ token: 'pre-minted-token', id: 'pre-session' })
  const ws = openGatewaySocket(`/viewer-ws?ticket=${ticket.ticket}`)

  const message = await new Promise((resolve, reject) => {
    ws.on('message', (raw) => resolve(JSON.parse(raw.toString())))
    ws.on('error', reject)
    setTimeout(() => reject(new Error('không nhận được bản tin')), 5000)
  })

  assert.equal(message.event, 'system/init')
  assert.equal(upstreamConnections.at(-1).path, '/api/ws')
  assert.equal(upstreamConnections.at(-1).token, 'pre-minted-token')
  assert.equal(upstreamConnections.at(-1).origin, null, 'không gửi Origin để qua được kiểm tra của neko')

  // hai chiều hoạt động
  ws.send('xin chào')
  const echo = await new Promise((resolve) => ws.on('message', (raw) => resolve(JSON.parse(raw.toString()))))
  assert.equal(echo.event, 'echo')
  assert.equal(echo.payload.got, 'xin chào')

  ws.close()
  await new Promise((resolve) => setTimeout(resolve, 150))
})

test('/viewer-ws từ chối vé sai hoặc dùng lại', async () => {
  const failure = await new Promise((resolve) => {
    const ws = openGatewaySocket('/viewer-ws?ticket=khong-ton-tai')
    ws.on('unexpected-response', (_req, res) => resolve(`status-${res.statusCode}`))
    ws.on('error', (error) => resolve(error.message))
    ws.on('open', () => resolve('opened'))
    setTimeout(() => resolve('timeout'), 3000)
  })

  assert.ok(failure !== 'opened' && failure !== 'timeout', `phải bị từ chối, nhận: ${failure}`)

  const ticket = proxy.issueTicket({ token: 'dùng-một-lần', id: 'once' })
  assert.ok(proxy.consumeTicket(ticket.ticket), 'lần đầu dùng được')
  assert.equal(proxy.consumeTicket(ticket.ticket), null, 'vé không dùng lại được')
})

test('/neko-ui/ws: chuyển tiếp iframe neko sang /ws legacy bằng tài khoản thật', async () => {
  const before = upstreamConnections.length
  const ws = openGatewaySocket('/neko-ui/ws?password=mat-khau-gia&username=ai-do')

  await new Promise((resolve, reject) => {
    ws.on('message', resolve)
    ws.on('error', reject)
    setTimeout(() => reject(new Error('không nhận được bản tin')), 5000)
  })

  assert.equal(upstreamConnections.length, before + 1)
  const upstream = upstreamConnections.at(-1)
  assert.equal(upstream.path, '/ws', 'phải đi qua adapter legacy /ws mà giao diện neko dùng')
  assert.equal(upstream.query.username, 'neko')
  assert.equal(upstream.query.password, 'bi-mat-that', 'mật khẩu giả của trình duyệt bị thay bằng mật khẩu thật ở server')

  ws.close()
  await new Promise((resolve) => setTimeout(resolve, 150))
})
