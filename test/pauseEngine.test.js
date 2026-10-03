/**
 * Kiểm thử PauseEngine - máy trạng thái pause/resume.
 * Chạy: npm test   (node --test)
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { PauseEngine } from '../src/pauseEngine.js'

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, child: () => silentLogger }

function makeConfig(overrides = {}) {
  return {
    mode: 'demo',
    neko: { baseUrl: 'http://127.0.0.1:1', container: '', apiToken: '' },
    pause: {
      leaveDebounceMs: 0,
      enterDebounceMs: 0,
      idleMs: 0,
      hardAfterMs: 50,
      dockerAfterMs: 60,
      maxFreezeMs: 0,
      leaseMs: 0,
      maxPauseMs: 0,
      multiClientAllMustLeave: true,
      ...(overrides.pause ?? {}),
    },
    strategies: { client: true, server: true, docker: false, ...(overrides.strategies ?? {}) },
    autoReclaimControl: true,
    runtime: { autoPause: true, leaveScope: 'viewport', ...(overrides.runtime ?? {}) },
  }
}

function makeNeko() {
  const calls = []
  const client = new EventEmitter()
  client.enabled = true
  client.calls = calls
  client.sessions = {}
  client.setPrivateMode = async (enabled, reason) => {
    calls.push({ action: 'setPrivateMode', enabled, reason })
  }
  client.releaseControl = async () => calls.push({ action: 'releaseControl' })
  client.getSettings = async () => ({ private_mode: calls.filter((call) => call.action === 'setPrivateMode').at(-1)?.enabled ?? false })
  client.snapshot = () => ({ enabled: true, reported: {} })
  return client
}

function makeDocker({ available = true } = {}) {
  const calls = []
  const driver = {
    enabled: true,
    available,
    container: 'neko-test',
    lastError: null,
    detect: async () => ({ available, version: available ? '27.0.0' : null }),
    pause: async () => {
      calls.push('pause')
      return { ok: available }
    },
    unpause: async () => {
      calls.push('unpause')
      return { ok: available }
    },
    inspect: async () => ({ ok: true, running: true, paused: calls.at(-1) === 'pause' }),
    start: async () => ({ ok: true }),
    snapshot: () => ({ enabled: true, container: 'neko-test', available, version: '27.0.0', actions: {}, lastError: null }),
    calls,
  }
  return driver
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('pause theo chuột: rời khung -> paused, quay lại -> running', async () => {
  const config = makeConfig()
  const neko = makeNeko()
  const engine = new PauseEngine({ config, neko, docker: makeDocker(), logger: silentLogger })

  engine.touchClient('c1', { pointer: 'in' })
  engine.setClientPointer('c1', 'out')
  await sleep(20)

  assert.equal(engine.snapshot().paused, true, 'phải pause khi chuột rời khung')
  assert.equal(engine.snapshot().level, 'soft', 'bậc đầu tiên là soft')

  engine.setClientPointer('c1', 'in')
  await sleep(20)

  assert.equal(engine.snapshot().paused, false, 'phải resume khi chuột quay lại')
  assert.equal(engine.snapshot().level, 'running')
})

test('debounce: huỷ pause nếu chuột quay lại trước khi hết trễ', async () => {
  const config = makeConfig({ pause: { leaveDebounceMs: 120 } })
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })

  engine.touchClient('c1', { pointer: 'in' })
  engine.setClientPointer('c1', 'out')
  await sleep(50)
  assert.equal(engine.snapshot().paused, false, 'chưa hết debounce thì chưa pause')

  engine.setClientPointer('c1', 'in')
  await sleep(150)
  assert.equal(engine.snapshot().paused, false, 'quay lại kịp thì không pause')
})

test('leo thang bậc: soft -> hard (neko private_mode)', async () => {
  const config = makeConfig({ pause: { hardAfterMs: 30 } })
  const neko = makeNeko()
  const engine = new PauseEngine({ config, neko, docker: makeDocker(), logger: silentLogger })

  engine.pause('manual', { detail: 'test' })
  assert.equal(engine.snapshot().level, 'soft')
  await sleep(90)

  assert.equal(engine.snapshot().level, 'hard')
  assert.deepEqual(
    neko.calls.filter((call) => call.action === 'setPrivateMode'),
    [{ action: 'setPrivateMode', enabled: true, reason: 'pause-engine' }],
    'phải gọi neko private_mode=true',
  )

  engine.resume('manual')
  await sleep(30)
  assert.equal(engine.snapshot().level, 'running')
  assert.equal(neko.calls.filter((call) => call.action === 'setPrivateMode').at(-1).enabled, false, 'khi resume phải tắt private_mode')
})

test('leo thang bậc sâu: docker pause/unpause', async () => {
  const config = makeConfig({ strategies: { docker: true }, pause: { hardAfterMs: 10, dockerAfterMs: 30 } })
  const neko = makeNeko()
  const docker = makeDocker()
  const engine = new PauseEngine({ config, neko, docker, logger: silentLogger })

  engine.pause('manual')
  await sleep(130)
  assert.equal(engine.snapshot().level, 'deep')
  assert.deepEqual(docker.calls, ['pause'], 'đã đóng băng container')

  engine.resume('manual')
  await sleep(60)
  assert.deepEqual(docker.calls, ['pause', 'unpause'], 'đã bỏ đóng băng khi resume')
  assert.equal(engine.snapshot().level, 'running')
})

test('hết hạn đóng băng: tự bỏ docker pause nhưng vẫn giữ bậc hard', async () => {
  const config = makeConfig({
    strategies: { docker: true },
    pause: { hardAfterMs: 10, dockerAfterMs: 20, maxFreezeMs: 60 },
  })
  const docker = makeDocker()
  const engine = new PauseEngine({ config, neko: makeNeko(), docker, logger: silentLogger })

  engine.pause('manual')
  await sleep(160)
  assert.deepEqual(docker.calls, ['pause', 'unpause'], 'phải tự bỏ đóng băng')
  assert.equal(engine.snapshot().level, 'hard', 'vẫn giữ pause ở bậc hard để không mất phiên WebRTC')
  assert.equal(engine.snapshot().freezeExpired, true)
})

test('nhiều client: chỉ pause khi TẤT CẢ rời khung', async () => {
  const config = makeConfig()
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })

  engine.touchClient('a', { pointer: 'in' })
  engine.touchClient('b', { pointer: 'in' })
  engine.setClientPointer('a', 'out')
  await sleep(20)
  assert.equal(engine.snapshot().paused, false, 'còn client b đang xem thì chưa pause')

  engine.setClientPointer('b', 'out')
  await sleep(20)
  assert.equal(engine.snapshot().paused, true, 'tất cả rời khung -> pause')

  engine.setClientPointer('a', 'in')
  await sleep(20)
  assert.equal(engine.snapshot().paused, false, 'một client quay lại là resume')
})

test('multiClientAllMustLeave=false: chỉ cần một client rời khung', async () => {
  const config = makeConfig({ pause: { multiClientAllMustLeave: false } })
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })

  engine.touchClient('a', { pointer: 'in' })
  engine.touchClient('b', { pointer: 'in' })
  engine.setClientPointer('a', 'out')

  await sleep(20)
  assert.equal(engine.snapshot().paused, true)
})

test('pause thủ công không bị resume bởi sự kiện chuột', async () => {
  const config = makeConfig()
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })

  engine.touchClient('c1', { pointer: 'in' })
  engine.pause('manual', { detail: 'bấm nút' })
  engine.setClientPointer('c1', 'out')
  engine.setClientPointer('c1', 'in')

  await sleep(20)
  assert.equal(engine.snapshot().paused, true, 'lý do manual vẫn còn')
  assert.equal(engine.snapshot().reasons[0].kind, 'manual')

  engine.resume('manual')
  await sleep(20)
  assert.equal(engine.snapshot().paused, false)
})

test('autoPause=false: bỏ qua sự kiện chuột', async () => {
  const config = makeConfig({ runtime: { autoPause: false } })
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })

  engine.touchClient('c1', { pointer: 'in' })
  engine.setClientPointer('c1', 'out')
  await sleep(20)
  assert.equal(engine.snapshot().paused, false)

  // bật lại thì áp dụng ngay trạng thái hiện tại
  engine.updateSettings({ autoPause: true })
  await sleep(20)
  assert.equal(engine.snapshot().paused, true)
})

test('tab bị ẩn (hidden) coi như chuột rời khung', async () => {
  const config = makeConfig()
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })

  engine.touchClient('c1', { pointer: 'in' })
  await sleep(10)
  assert.equal(engine.snapshot().paused, false)

  engine.heartbeat('c1', { hidden: true })
  await sleep(20)
  assert.equal(engine.snapshot().paused, true, 'ẩn tab -> pause')

  engine.heartbeat('c1', { hidden: false })
  await sleep(20)
  assert.equal(engine.snapshot().paused, false, 'hiện lại tab -> resume')
})

test('lease: client im lặng quá lâu thì tự resume', async () => {
  const config = makeConfig({ pause: { leaseMs: 60 } })
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })

  engine.touchClient('c1', { pointer: 'out' })
  await sleep(20)
  assert.equal(engine.snapshot().paused, true)

  engine.start()
  try {
    await sleep(1400)
  } finally {
    await engine.shutdown()
  }
  assert.equal(engine.snapshot().paused, false, 'hết lease -> resume')
})

test('đóng tab: hết client thì resume sau khoảng ân hạn', async () => {
  const config = makeConfig()
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })
  engine.orphanGraceMs = 60

  engine.touchClient('c1', { pointer: 'out' })
  await sleep(20)
  assert.equal(engine.snapshot().paused, true)

  engine.dropClient('c1')
  // ân hạn tối thiểu là 1s (đủ để tab reload mà không bị nhấp nháy)
  await sleep(1300)
  assert.equal(engine.snapshot().paused, false, 'không còn client -> resume')
})

test('shutdown luôn resume để không bỏ quên máy ảo', async () => {
  const config = makeConfig({ pause: { hardAfterMs: 5 } })
  const neko = makeNeko()
  const engine = new PauseEngine({ config, neko, docker: makeDocker(), logger: silentLogger })

  engine.pause('manual')
  await sleep(40)
  assert.equal(engine.snapshot().level, 'hard')

  await engine.shutdown()
  assert.equal(engine.snapshot().paused, false)
  assert.equal(neko.calls.at(-1).enabled, false)
})

test('thống kê: đếm số lần pause và tổng thời gian', async () => {
  const config = makeConfig()
  const engine = new PauseEngine({ config, neko: makeNeko(), docker: makeDocker(), logger: silentLogger })

  engine.pause('manual')
  await sleep(60)
  engine.resume('manual')
  await sleep(20)
  engine.pause('manual')
  await sleep(20)
  engine.resume('manual')

  const snapshot = engine.snapshot()
  assert.equal(snapshot.stats.pauses, 2)
  assert.equal(snapshot.stats.resumes, 2)
  assert.ok(snapshot.stats.totalPausedMs >= 60, `tổng thời gian pause = ${snapshot.stats.totalPausedMs}`)
})

test('updateSettings: đổi mốc leo thang khi đang pause', async () => {
  const config = makeConfig({ pause: { hardAfterMs: 100000 } })
  const neko = makeNeko()
  const engine = new PauseEngine({ config, neko, docker: makeDocker(), logger: silentLogger })

  engine.pause('manual')
  await sleep(20)
  assert.equal(engine.snapshot().level, 'soft')

  engine.updateSettings({ hardAfterMs: 10 })
  await sleep(80)
  assert.equal(engine.snapshot().level, 'hard', 'mốc mới phải được áp dụng ngay')
})
