/**
 * Kiểm thử tích hợp: khởi động server thật (MODE=demo) rồi kiểm tra
 * REST API + kênh WebSocket /ws/control + neko giả lập.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import test, { after, before } from 'node:test'
import { WebSocket } from 'ws'

const PORT = 8100 + Math.floor(Math.random() * 400)
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let child
let logs = ''

before(async () => {
  child = spawn(process.execPath, ['src/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      MODE: 'demo',
      LOG_LEVEL: 'warn',
      // mốc thời gian nhanh để test chạy nhanh
      PAUSE_LEAVE_DEBOUNCE_MS: '50',
      PAUSE_HARD_AFTER_MS: '250',
      PAUSE_DOCKER_AFTER_MS: '60000',
      PAUSE_MAX_MS: '0',
      PAUSE_LEASE_MS: '0',
      STRATEGY_DOCKER: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => (logs += chunk.toString()))
  child.stderr.on('data', (chunk) => (logs += chunk.toString()))

  const deadline = Date.now() + 15000
  for (;;) {
    try {
      const response = await fetch(`${BASE}/healthz`)
      if (response.ok) break
    } catch {
      /* chưa lên */
    }
    if (Date.now() > deadline) throw new Error(`server không khởi động được:\n${logs}`)
    await sleep(150)
  }
})

after(async () => {
  if (!child) return
  child.kill('SIGTERM')
  await sleep(400)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})

const api = (path, options = {}) =>
  fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', 'X-Wayground': '1', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

test('GET / trả về giao diện điều khiển', async () => {
  const response = await fetch(`${BASE}/`)
  assert.equal(response.status, 200)
  const html = await response.text()
  assert.match(html, /Wayground/i)
  assert.match(html, /screen-frame/)
})

test('GET /api/state trả về snapshot của engine', async () => {
  const data = await (await api('/api/state')).json()
  assert.equal(data.state.paused, false)
  assert.equal(data.state.level, 'running')
  assert.ok(data.state.settings.leaveDebounceMs >= 0)
  assert.equal(data.state.neko.enabled, true, 'chế độ demo vẫn chạy neko giả lập')
})

test('POST /api/pause -> soft rồi tự leo lên hard và gọi neko private_mode', async () => {
  const paused = await (await api('/api/pause', { method: 'POST', body: { reason: 'manual', detail: 'test' } })).json()
  assert.equal(paused.ok, true)

  await sleep(60)
  let state = (await (await api('/api/state')).json()).state
  assert.equal(state.paused, true)
  assert.equal(state.level, 'soft')

  await sleep(700)
  state = (await (await api('/api/state')).json()).state
  assert.equal(state.level, 'hard', 'phải leo lên bậc hard sau PAUSE_HARD_AFTER_MS')

  const demo = (await (await api('/api/state')).json()).demo
  // neko (chi router) đăng ký "/settings/" nên đường dẫn thật có dấu / cuối.
  const privateModeCall = demo.calls.find(
    (call) => call.path.replace(/\/$/, '') === '/api/room/settings' && call.body?.private_mode === true,
  )
  assert.ok(privateModeCall, `neko giả lập phải nhận POST /api/room/settings/ {private_mode:true}; nhận được: ${JSON.stringify(demo.calls)}`)
  assert.equal(demo.settings.private_mode, true)

  const metrics = await (await fetch(`${BASE}/metrics`)).text()
  assert.match(metrics, /wayground_paused 1/)
  assert.match(metrics, /wayground_pauses_total 1/)
})

test('POST /api/resume -> tắt private_mode và quay lại trạng thái chạy', async () => {
  await api('/api/resume', { method: 'POST', body: { detail: 'test' } })
  await sleep(150)

  const data = await (await api('/api/state')).json()
  assert.equal(data.state.paused, false)
  assert.equal(data.state.level, 'running')
  assert.equal(data.demo.settings.private_mode, false, 'phải tắt private_mode khi resume')

  const metrics = await (await fetch(`${BASE}/metrics`)).text()
  assert.match(metrics, /wayground_paused 0/)
})

test('chặn CSRF: request từ origin khác bị từ chối', async () => {
  const response = await fetch(`${BASE}/api/pause`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ reason: 'hack' }),
  })
  assert.equal(response.status, 403)
  const state = (await (await api('/api/state')).json()).state
  assert.equal(state.paused, false, 'không được pause vì request giả')
})

test('POST /api/settings đổi tham số và được phản ánh vào state', async () => {
  const result = await (await api('/api/settings', { method: 'POST', body: { leaveDebounceMs: 1234, autoPause: false } })).json()
  assert.equal(result.settings.leaveDebounceMs, 1234)
  assert.equal(result.settings.autoPause, false)

  const state = (await (await api('/api/state')).json()).state
  assert.equal(state.settings.leaveDebounceMs, 1234)

  await api('/api/settings', { method: 'POST', body: { leaveDebounceMs: 50, autoPause: true } })
})

test('kênh /ws/control: nhận hello, gửi pointer out -> pause, pointer in -> resume', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/control?client=test-${Date.now()}&auto=1`, {
    headers: { origin: BASE },
  })

  const messages = []
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())))

  await new Promise((resolve, reject) => {
    ws.on('open', resolve)
    ws.on('error', reject)
    setTimeout(() => reject(new Error('không mở được websocket')), 5000)
  })

  // chỉ tìm trong các bản tin MỚI (sau con trỏ) để tránh khớp lại bản tin cũ
  let cursor = 0
  const waitFor = async (predicate, timeout = 6000) => {
    const deadline = Date.now() + timeout
    for (;;) {
      for (let index = cursor; index < messages.length; index += 1) {
        if (predicate(messages[index])) {
          cursor = index + 1
          return messages[index]
        }
      }
      if (Date.now() > deadline) throw new Error(`hết thời gian chờ; đã nhận: ${JSON.stringify(messages.slice(-6))}`)
      await sleep(60)
    }
  }

  const hello = await waitFor((message) => message.type === 'hello')
  assert.ok(hello.clientId, 'hello phải kèm clientId')
  assert.equal(hello.state.paused, false)

  ws.send(JSON.stringify({ type: 'pointer', state: 'out' }))
  const pausedState = await waitFor((message) => message.type === 'state' && message.state.paused === true)
  assert.equal(pausedState.state.paused, true)

  await sleep(500)
  ws.send(JSON.stringify({ type: 'pointer', state: 'in' }))
  const resumed = await waitFor((message) => message.type === 'state' && message.state.paused === false)
  assert.equal(resumed.state.paused, false)

  // heartbeat + pause/resume qua websocket
  ws.send(JSON.stringify({ type: 'pause', detail: 'từ websocket' }))
  const manual = await waitFor((message) => message.type === 'state' && message.state.paused === true)
  assert.ok(manual.state.reasons.some((reason) => reason.kind === 'manual'))

  ws.send(JSON.stringify({ type: 'resume' }))
  await waitFor((message) => message.type === 'state' && message.state.paused === false)

  ws.close()
  await sleep(150)
})

test('/ws/control từ chối origin lạ', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/control`, { headers: { origin: 'https://evil.example' } })
  const failed = await new Promise((resolve) => {
    ws.on('open', () => resolve(false))
    ws.on('error', () => resolve(true))
    setTimeout(() => resolve(false), 2000)
  })
  assert.equal(failed, true, 'phải bị từ chối')
})

test('beacon resume khi đóng tab', async () => {
  await api('/api/pause', { method: 'POST', body: { detail: 'beacon' } })
  await sleep(60)
  assert.equal((await (await api('/api/state')).json()).state.paused, true)

  const response = await fetch(`${BASE}/api/beacon/resume`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: BASE },
    body: 'x',
  })
  assert.equal(response.status, 200)

  await sleep(150)
  assert.equal((await (await api('/api/state')).json()).state.paused, false)
})

test('/api/viewer/ticket trả về chế độ demo', async () => {
  const ticket = await (await api('/api/viewer/ticket')).json()
  assert.equal(ticket.ok, true)
  assert.equal(ticket.demo, true)
  assert.equal(ticket.viewer, 'demo')
})
