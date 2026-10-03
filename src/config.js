/**
 * config.js - Đọc & chuẩn hoá toàn bộ cấu hình từ biến môi trường (.env).
 *
 * Triết lý: mọi thứ đều có mặc định hợp lý để `npm start` là chạy được ngay
 * ở chế độ DEMO (không cần neko, không cần Docker).
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

// ---------------------------------------------------------------------------
// .env loader đơn giản (không cần thư viện dotenv)
// ---------------------------------------------------------------------------
/**
 * Chuẩn hoá giá trị bên phải dấu "=" của một dòng .env.
 *   value            -> 'value'
 *   "a # b"          -> 'a # b'   (dấu # trong nháy không phải comment)
 *   'x'  # chú thích -> 'x'
 *   '  giữ  '        -> '  giữ  ' (khoảng trắng trong nháy được giữ nguyên)
 */
export function parseEnvValue(raw) {
  const value = String(raw ?? '').trim()

  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0]
    const end = value.indexOf(quote, 1)
    if (end !== -1) {
      const inner = value.slice(1, end)
      const rest = value.slice(end + 1).trim()
      // Chỉ nhận phần trong nháy khi phần còn lại rỗng hoặc là comment.
      if (rest === '' || rest.startsWith('#')) return inner
      return value // chuỗi dị dạng -> giữ nguyên
    }
    return value
  }

  return value.replace(/\s+#.*$/, '').trim()
}

export function loadEnvFile(file = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(file)) return false

  const raw = fs.readFileSync(file, 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue

    const key = match[1]
    const value = parseEnvValue(match[2])

    // Biến môi trường thật luôn thắng file .env.
    if (process.env[key] === undefined) process.env[key] = value
  }

  return true
}

// Nạp .env NGAY khi module này được đọc - trước khi các biến bên dưới đọc
// process.env. (Nếu để index.js gọi sau khi import thì đã quá muộn.)
export const envFileLoaded = loadEnvFile()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const parseBool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback
  return ['1', 'true', 'yes', 'y', 'on', 'bat', 'bật'].includes(String(value).trim().toLowerCase())
}

const parseIntSafe = (value, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) => {
  if (value === undefined || value === null || value === '') return fallback
  const num = Number.parseInt(String(value).trim(), 10)
  if (!Number.isFinite(num)) return fallback
  return Math.min(Math.max(num, min), max)
}

const str = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value).trim())

const trimTrailingSlash = (value) => value.replace(/\/+$/, '')

/** http(s)://host:port -> ws(s)://host:port */
export function httpToWs(url) {
  return url.replace(/^http/i, 'ws')
}

/**
 * Kiểm tra tính hợp lệ của tên container Docker (chống chèn tham số).
 */
export const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const nekoUrl = trimTrailingSlash(str(process.env.NEKO_URL))
const requestedMode = str(process.env.MODE, 'auto').toLowerCase()
const mode = requestedMode === 'auto' || requestedMode === '' ? (nekoUrl ? 'live' : 'demo') : requestedMode

const requestedViewer = str(process.env.VIEWER, 'auto').toLowerCase()

export const config = {
  // ---- web server
  port: parseIntSafe(process.env.PORT, 8080, { min: 0, max: 65535 }),
  host: str(process.env.HOST, '0.0.0.0'),
  logLevel: str(process.env.LOG_LEVEL, 'info').toLowerCase(),
  appPassword: str(process.env.APP_PASSWORD),
  trustProxy: parseBool(process.env.TRUST_PROXY, true),
  publicDir: path.resolve(process.cwd(), 'public'),

  // ---- mode
  mode, // 'demo' | 'live'
  requestedViewer, // 'auto' | 'demo' | 'webrtc' | 'embed' | 'novnc'

  // ---- neko
  neko: {
    baseUrl: nekoUrl,
    wsUrl: '',
    username: str(process.env.NEKO_USERNAME, 'neko') || 'neko',
    password: str(process.env.NEKO_PASSWORD, 'neko'),
    adminUsername: str(process.env.NEKO_ADMIN_USERNAME, 'admin') || 'admin',
    adminPassword: str(process.env.NEKO_ADMIN_PASSWORD, 'admin'),
    apiToken: str(process.env.NEKO_API_TOKEN),
    container: str(process.env.NEKO_CONTAINER),
    requestTimeoutMs: parseIntSafe(process.env.NEKO_REQUEST_TIMEOUT_MS, 15000, { min: 1000, max: 120000 }),
  },

  docker: {
    bin: str(process.env.DOCKER_BIN, 'docker'),
    timeoutMs: parseIntSafe(process.env.DOCKER_TIMEOUT_MS, 20000, { min: 1000, max: 120000 }),
  },

  novnc: {
    url: str(process.env.NOVNC_URL, 'http://localhost:6080/vnc.html'),
    wsUrl: str(process.env.NOVNC_WS_URL, 'ws://localhost:6080/websockify'),
  },

  // ---- cơ chế pause
  pause: {
    leaveDebounceMs: parseIntSafe(process.env.PAUSE_LEAVE_DEBOUNCE_MS, 600, { min: 0, max: 60000 }),
    enterDebounceMs: parseIntSafe(process.env.PAUSE_ENTER_DEBOUNCE_MS, 120, { min: 0, max: 60000 }),
    idleMs: parseIntSafe(process.env.PAUSE_IDLE_MS, 0, { min: 0, max: 3600000 }),
    hardAfterMs: parseIntSafe(process.env.PAUSE_HARD_AFTER_MS, 3000, { min: 0, max: 3600000 }),
    dockerAfterMs: parseIntSafe(process.env.PAUSE_DOCKER_AFTER_MS, 60000, { min: 0, max: 86400000 }),
    maxFreezeMs: parseIntSafe(process.env.PAUSE_MAX_FREEZE_MS, 120000, { min: 0, max: 86400000 }),
    leaseMs: parseIntSafe(process.env.PAUSE_LEASE_MS, 600000, { min: 0, max: 86400000 }),
    maxPauseMs: parseIntSafe(process.env.PAUSE_MAX_MS, 1800000, { min: 0, max: 86400000 }),
    multiClientAllMustLeave: parseBool(process.env.MULTI_CLIENT_ALL_MUST_LEAVE, true),
  },

  strategies: {
    client: parseBool(process.env.STRATEGY_CLIENT, true),
    server: parseBool(process.env.STRATEGY_SERVER, true),
    docker: parseBool(process.env.STRATEGY_DOCKER, false),
  },

  autoReclaimControl: parseBool(process.env.AUTO_RECLAIM_CONTROL, true),

  // runtime (có thể đổi qua POST /api/settings)
  runtime: {
    autoPause: parseBool(process.env.AUTO_PAUSE, true),
    leaveScope: str(process.env.PAUSE_LEAVE_SCOPE, 'viewport'), // 'viewport' | 'document'
  },
}

/** Chế độ viewer thực tế sau khi phân giải 'auto'. */
export function resolveViewerMode() {
  if (config.requestedViewer && config.requestedViewer !== 'auto') return config.requestedViewer
  return config.mode === 'demo' ? 'demo' : 'webrtc'
}

/** Cấu hình an toàn để gửi xuống trình duyệt (không chứa mật khẩu). */
export function publicConfig() {
  return {
    mode: config.mode,
    viewer: resolveViewerMode(),
    requestedViewer: config.requestedViewer,
    pause: { ...config.pause },
    strategies: { ...config.strategies },
    autoReclaimControl: config.autoReclaimControl,
    runtime: { ...config.runtime },
    novnc: config.requestedViewer === 'novnc' ? { url: '/novnc/vnc.html' } : null,
    neko: {
      container: config.neko.container || null,
      baseUrlConfigured: Boolean(config.neko.baseUrl),
      apiTokenConfigured: Boolean(config.neko.apiToken),
    },
    requirePassword: Boolean(config.appPassword),
    version: '1.0.0',
  }
}

export function validateConfig(logger) {
  const warnings = []

  if (!['demo', 'live'].includes(config.mode)) {
    throw new Error(`MODE không hợp lệ: "${config.mode}" (chỉ nhận "demo", "live" hoặc "auto")`)
  }

  const viewer = resolveViewerMode()
  if (!['demo', 'webrtc', 'embed', 'novnc'].includes(viewer)) {
    throw new Error(`VIEWER không hợp lệ: "${config.requestedViewer}"`)
  }

  if (config.mode === 'live' && !config.neko.baseUrl) {
    throw new Error('MODE=live yêu cầu NEKO_URL (ví dụ: NEKO_URL=http://127.0.0.1:8080)')
  }

  if (viewer === 'demo' && config.mode === 'live') {
    warnings.push('VIEWER=demo nhưng MODE=live: khung xem sẽ là máy ảo mô phỏng, neko thật vẫn được điều khiển.')
  }

  if (viewer === 'webrtc' && !config.neko.password && config.mode === 'live' && !config.neko.apiToken) {
    warnings.push('Chưa cấu hình NEKO_PASSWORD/NEKO_API_TOKEN: không thể tạo session xem.')
  }

  if (config.strategies.docker && !config.neko.container) {
    warnings.push('STRATEGY_DOCKER=true nhưng NEKO_CONTAINER trống: chiến lược đóng băng Docker sẽ bị bỏ qua.')
  }

  if (config.neko.container && !CONTAINER_NAME_RE.test(config.neko.container)) {
    throw new Error(`NEKO_CONTAINER không hợp lệ: "${config.neko.container}"`)
  }

  if (config.mode === 'live' && viewer === 'webrtc' && config.neko.username === config.neko.adminUsername) {
    warnings.push(
      'NEKO_USERNAME trùng NEKO_ADMIN_USERNAME: neko không pause session có quyền admin ' +
        '(PrivateModeEnabled = private_mode && !IsAdmin). Hãy dùng tài khoản người dùng thường cho khung xem.',
    )
  }

  if (config.mode === 'live') {
    config.neko.wsUrl = httpToWs(config.neko.baseUrl)
  }

  logger?.warn && warnings.forEach((w) => logger.warn(`[config] ${w}`))

  return warnings
}
