/**
 * config.test.js - Kiểm tra việc nạp file .env và thứ tự ưu tiên.
 *
 * Mỗi ca chạy trong một tiến trình Node riêng (import config.js ở cwd tạm) vì
 * config.js đọc process.env ngay khi được import.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseEnvValue } from '../src/config.js'

const CONFIG_URL = new URL('../src/config.js', import.meta.url).href
const REPO = fileURLToPath(new URL('..', import.meta.url))

/** Các biến có thể lẫn vào tiến trình con -> xoá để test tất định. */
const SCRUB = [
  'PORT',
  'HOST',
  'MODE',
  'VIEWER',
  'APP_PASSWORD',
  'NEKO_URL',
  'NEKO_USERNAME',
  'NEKO_PASSWORD',
  'PAUSE_LEAVE_DEBOUNCE_MS',
  'PAUSE_HARD_AFTER_MS',
  'PAUSE_MAX_MS',
  'STRATEGY_DOCKER',
]

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wayground-config-'))
  return {
    dir,
    write(name, content) {
      fs.writeFileSync(path.join(dir, name), content)
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

function readConfig(cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv }
  for (const key of SCRUB) if (!(key in extraEnv)) delete env[key]

  const script = `
    const m = await import(${JSON.stringify(CONFIG_URL)})
    process.stdout.write(JSON.stringify({
      envFileLoaded: m.envFileLoaded,
      port: m.config.port,
      host: m.config.host,
      appPassword: m.config.appPassword,
      mode: m.config.mode,
      requestedViewer: m.config.requestedViewer,
      resolvedViewer: m.resolveViewerMode(),
      username: m.config.neko.username,
      hardAfterMs: m.config.pause.hardAfterMs,
      leaveDebounceMs: m.config.pause.leaveDebounceMs,
      maxPauseMs: m.config.pause.maxPauseMs,
      docker: m.config.strategies.docker,
      autoPause: m.config.runtime.autoPause,
      nekoUrl: m.config.neko.baseUrl,
      apiToken: m.config.neko.apiToken,
    }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20000,
  })
  assert.equal(result.status, 0, `tiến trình con lỗi: ${result.stderr}`)
  return JSON.parse(result.stdout)
}

test('.env trong thư mục làm việc được nạp trước khi đọc biến môi trường', () => {
  const box = sandbox()
  try {
    box.write(
      '.env',
      [
        '# cấu hình thử',
        'PORT=8123',
        'PAUSE_HARD_AFTER_MS=4321',
        'NEKO_USERNAME=nguoidung',
        'STRATEGY_DOCKER=bat',
        'MODE=demo',
      ].join('\n'),
    )
    const cfg = readConfig(box.dir)
    assert.equal(cfg.envFileLoaded, true)
    assert.equal(cfg.port, 8123)
    assert.equal(cfg.hardAfterMs, 4321)
    assert.equal(cfg.username, 'nguoidung')
    assert.equal(cfg.docker, true)
    assert.equal(cfg.leaveDebounceMs, 600, 'giá trị không khai báo vẫn dùng mặc định')
  } finally {
    box.cleanup()
  }
})

test('biến môi trường thật thắng giá trị trong .env', () => {
  const box = sandbox()
  try {
    box.write('.env', 'PORT=8123\nPAUSE_HARD_AFTER_MS=4321\n')
    const cfg = readConfig(box.dir, { PORT: '9000', PAUSE_HARD_AFTER_MS: '77' })
    assert.equal(cfg.port, 9000)
    assert.equal(cfg.hardAfterMs, 77)
  } finally {
    box.cleanup()
  }
})

test('không có .env thì mặc định kết nối Neko thật trên localhost', () => {
  const box = sandbox()
  try {
    const cfg = readConfig(box.dir)
    assert.equal(cfg.envFileLoaded, false)
    assert.equal(cfg.port, 3000)
    assert.equal(cfg.mode, 'live')
    assert.equal(cfg.nekoUrl, 'http://127.0.0.1:8080')
    assert.equal(cfg.resolvedViewer, 'embed')
  } finally {
    box.cleanup()
  }
})

test('MODE=auto chỉ rơi về demo khi NEKO_URL được để trống', () => {
  const box = sandbox()
  try {
    const cfg = readConfig(box.dir, { MODE: 'auto', NEKO_URL: '' })
    assert.equal(cfg.mode, 'demo')
    assert.equal(cfg.resolvedViewer, 'demo')
  } finally {
    box.cleanup()
  }
})

test('VIEWER=auto dùng giao diện gốc Neko ở live và canvas chỉ ở demo', () => {
  const box = sandbox()
  try {
    const live = readConfig(box.dir, { MODE: 'live', NEKO_URL: 'http://neko:8080' })
    assert.equal(live.requestedViewer, 'auto')
    assert.equal(live.resolvedViewer, 'embed')

    const custom = readConfig(box.dir, { MODE: 'live', NEKO_URL: 'http://neko:8080', VIEWER: 'webrtc' })
    assert.equal(custom.resolvedViewer, 'webrtc', 'viewer WebRTC mini vẫn có thể bật tường minh')

    const demo = readConfig(box.dir, { MODE: 'demo' })
    assert.equal(demo.resolvedViewer, 'demo')
  } finally {
    box.cleanup()
  }
})

test('.env hiểu dấu nháy, khoảng trắng và comment cuối dòng', () => {
  const box = sandbox()
  try {
    box.write('.env', ['APP_PASSWORD="mật khẩu #1"', "HOST='127.0.0.1'   # chỉ local", 'PAUSE_MAX_MS=30000'].join('\n'))
    const cfg = readConfig(box.dir)
    assert.equal(cfg.appPassword, 'mật khẩu #1')
    assert.equal(cfg.host, '127.0.0.1')
    assert.equal(cfg.maxPauseMs, 30000)
  } finally {
    box.cleanup()
  }
})

test('parseEnvValue: nháy, comment, khoảng trắng', () => {
  assert.equal(parseEnvValue('value'), 'value')
  assert.equal(parseEnvValue('  value  '), 'value')
  assert.equal(parseEnvValue('value # chú thích'), 'value')
  assert.equal(parseEnvValue('"a # b"'), 'a # b')
  assert.equal(parseEnvValue("'x'   # chú thích"), 'x')
  assert.equal(parseEnvValue("'  giữ  '"), '  giữ  ')
  assert.equal(parseEnvValue('=a=b'), '=a=b')
  assert.equal(parseEnvValue(''), '')
  assert.equal(parseEnvValue('"thiếu nháy'), '"thiếu nháy')
})

test('.env.example chứa các biến quan trọng của cơ chế pause', () => {
  const example = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8')
  for (const key of ['MODE', 'NEKO_URL', 'APP_PASSWORD', 'PAUSE_HARD_AFTER_MS', 'PAUSE_MAX_MS', 'STRATEGY_DOCKER', 'NEKO_CONTAINER']) {
    assert.match(example, new RegExp(`^${key}=`, 'm'), `.env.example thiếu ${key}`)
  }
})
