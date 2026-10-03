/**
 * routes.js - Toàn bộ HTTP API + phục vụ giao diện web.
 *
 * Nhóm endpoint:
 *   /api/state /api/config            - trạng thái & cấu hình cho UI
 *   /api/pause /api/resume /api/toggle- điều khiển thủ công (có chống CSRF)
 *   /api/settings                     - chỉnh tham số pause ngay khi đang chạy
 *   /api/viewer/ticket                - vé vào khung xem WebRTC
 *   /api/pointer /api/beacon/resume   - cho client không dùng WebSocket
 *   /neko-api/*  /neko-ui/*           - proxy tới neko
 *   /metrics /healthz                 - giám sát
 */
import crypto from 'node:crypto'
import express from 'express'
import { logHistory } from './log.js'
import { publicConfig as buildPublicConfig } from './config.js'
import { createHttpProxy } from './proxy.js'

const SESSION_COOKIE = 'wg_session'
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

export function createApp(ctx) {
  const { config, logger, engine, neko, proxy, control, startedAt } = ctx
  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) app.set('trust proxy', true)
  app.use(express.json({ limit: '256kb' }))

  // -------------------------------------------------------------------------
  // Xác thực (tuỳ chọn) + chống CSRF
  // -------------------------------------------------------------------------
  const sessions = new Map()
  const randomToken = () => crypto.randomBytes(32).toString('base64url')

  const readCookie = (req, name) => {
    const raw = req.headers.cookie
    if (!raw) return null
    for (const part of raw.split(';')) {
      const [key, ...rest] = part.trim().split('=')
      if (key === name) return decodeURIComponent(rest.join('='))
    }
    return null
  }

  const pruneSessions = () => {
    const deadline = Date.now() - SESSION_TTL_MS
    for (const [token, entry] of sessions) if (entry.createdAt < deadline) sessions.delete(token)
  }

  const authorize = (req) => {
    if (!config.appPassword) return { ok: true }

    const header = req.headers['x-wayground-token'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (header && timingSafeEqual(header, config.appPassword)) return { ok: true, via: 'header' }

    const cookie = readCookie(req, SESSION_COOKIE)
    if (cookie && sessions.has(cookie)) {
      sessions.get(cookie).lastSeen = Date.now()
      return { ok: true, via: 'cookie' }
    }

    return { ok: false }
  }

  const requireAuth = (req, res, next) => {
    const result = authorize(req)
    if (result.ok) return next()
    if (req.accepts(['html', 'json']) === 'html') return res.redirect('/login')
    return res.status(401).json({ error: 'unauthorized', message: 'Cần đăng nhập bảng điều khiển (APP_PASSWORD)' })
  }

  /** Chặn CSRF: chỉ nhận request cùng origin hoặc có header riêng của ứng dụng. */
  const csrfGuard = (req, res, next) => {
    if (req.headers['x-wayground'] === '1') return next()

    const fetchSite = req.headers['sec-fetch-site']
    if (fetchSite === 'same-origin' || fetchSite === 'none') return next()

    const origin = req.headers.origin
    if (origin) {
      try {
        if (new URL(origin).host === req.headers.host) return next()
      } catch {
        /* ignore */
      }
      logger.warn('csrf: từ chối request khác origin', { origin, host: req.headers.host, path: req.path })
      return res.status(403).json({ error: 'cross_origin_blocked' })
    }

    // sendBeacon/curl: không có Origin & không có Sec-Fetch-Site
    return next()
  }

  const applySettings = (patch) => {
    const clean = {}
    if (patch && typeof patch === 'object') {
      const numeric = [
        'leaveDebounceMs',
        'enterDebounceMs',
        'idleMs',
        'hardAfterMs',
        'dockerAfterMs',
        'maxFreezeMs',
        'leaseMs',
        'maxPauseMs',
      ]
      for (const key of numeric) {
        if (patch[key] === undefined) continue
        const value = Number(patch[key])
        if (Number.isFinite(value) && value >= 0) clean[key] = Math.min(value, 86400000)
      }
      if (typeof patch.multiClientAllMustLeave === 'boolean') clean.multiClientAllMustLeave = patch.multiClientAllMustLeave
      if (typeof patch.autoPause === 'boolean') clean.autoPause = patch.autoPause
      if (patch.leaveScope === 'viewport' || patch.leaveScope === 'document') clean.leaveScope = patch.leaveScope
      if (typeof patch.autoReclaimControl === 'boolean') clean.autoReclaimControl = patch.autoReclaimControl
      if (patch.strategies && typeof patch.strategies === 'object') {
        clean.strategies = {}
        for (const key of ['client', 'server', 'docker']) {
          if (typeof patch.strategies[key] === 'boolean') clean.strategies[key] = patch.strategies[key]
        }
      }
    }
    return engine.updateSettings(clean)
  }

  // -------------------------------------------------------------------------
  // Đăng nhập bảng điều khiển (chỉ khi có APP_PASSWORD)
  // -------------------------------------------------------------------------
  app.post('/api/login', (req, res) => {
    if (!config.appPassword) return res.json({ ok: true, required: false })

    const { password } = req.body ?? {}
    if (!password || !timingSafeEqual(String(password), config.appPassword)) {
      logger.warn('đăng nhập thất bại', { ip: req.ip })
      return res.status(401).json({ error: 'invalid_password' })
    }

    pruneSessions()
    const token = randomToken()
    sessions.set(token, { createdAt: Date.now(), lastSeen: Date.now(), ip: req.ip })
    const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https'
    res.setHeader(
      'set-cookie',
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`,
    )
    logger.info('đăng nhập thành công', { ip: req.ip })
    return res.json({ ok: true })
  })

  app.post('/api/logout', csrfGuard, (req, res) => {
    const cookie = readCookie(req, SESSION_COOKIE)
    if (cookie) sessions.delete(cookie)
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`)
    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Trạng thái
  // -------------------------------------------------------------------------
  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'))

  app.get('/api/health', (req, res) => {
    const state = engine.snapshot()
    res.json({ ok: true, mode: config.mode, paused: state.paused, level: state.level, uptimeMs: Date.now() - startedAt })
  })

  app.get('/api/config', (req, res) => {
    res.json({ ...buildPublicConfig(), state: engine.snapshot(), warnings: engine.snapshot().warnings })
  })

  app.get('/api/state', (req, res) => {
    res.json({
      state: engine.snapshot(),
      clients: control.clientCount,
      proxy: {
        viewerConnections: proxy.stats.viewerConnections,
        viewerActive: proxy.stats.viewerActive,
        bytesToClient: proxy.stats.bytesToClient,
        bytesToNeko: proxy.stats.bytesToNeko,
        lastError: proxy.stats.lastError,
      },
      uptimeMs: Date.now() - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      demo: config.mode === 'demo' ? ctx.fakeNeko?.snapshot() ?? null : null,
    })
  })

  app.get('/api/log', requireAuth, (req, res) => res.json(logHistory().slice(-300)))

  // -------------------------------------------------------------------------
  // Điều khiển pause/resume
  // -------------------------------------------------------------------------
  app.post('/api/pause', csrfGuard, (req, res) => {
    const { reason, detail, debounceMs } = req.body ?? {}
    engine.pause(reason === 'api' ? 'api' : 'manual', { detail: detail ?? 'API', debounceMs })
    res.json({ ok: true, state: engine.snapshot() })
  })

  app.post('/api/resume', csrfGuard, (req, res) => {
    engine.resume(req.body?.reason === 'api' ? 'api' : 'manual', { detail: req.body?.detail ?? 'API' })
    res.json({ ok: true, state: engine.snapshot() })
  })

  app.post('/api/toggle', csrfGuard, (req, res) => {
    engine.toggle('manual')
    res.json({ ok: true, state: engine.snapshot() })
  })

  app.post('/api/auto', csrfGuard, (req, res) => {
    const enabled = Boolean(req.body?.enabled)
    const state = engine.updateSettings({ autoPause: enabled })
    res.json({ ok: true, autoPause: enabled, state })
  })

  app.post('/api/pointer', csrfGuard, (req, res) => {
    const { state, clientId } = req.body ?? {}
    engine.setClientPointer(clientId ?? req.ip ?? 'http-client', state)
    res.json({ ok: true, state: engine.snapshot() })
  })

  app.post('/api/settings', csrfGuard, (req, res) => {
    const state = applySettings(req.body ?? {})
    control.broadcast({ type: 'config', config: state.settings })
    res.json({ ok: true, settings: state.settings })
  })

  /** Dùng với navigator.sendBeacon khi đóng tab -> không để máy ảo "quên" ở trạng thái pause. */
  app.post('/api/beacon/resume', (req, res) => {
    const state = engine.snapshot()
    if (state.paused && state.clients.length <= 1) {
      logger.info('nhận beacon khi đóng tab -> resume')
      engine.resume('page-unload', { force: true })
    }
    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Khung xem
  // -------------------------------------------------------------------------
  app.get('/api/viewer/ticket', requireAuth, csrfGuard, async (req, res) => {
    const viewer = buildPublicConfig().viewer
    if (config.mode === 'demo' || !neko.enabled) {
      return res.json({ ok: true, demo: true, viewer })
    }

    if (viewer === 'embed' || viewer === 'novnc') {
      return res.json({
        ok: true,
        viewer,
        embedUrl: viewer === 'embed' ? `${nekoUiUrl(config)}` : novncUrl(config),
      })
    }

    try {
      const session = await neko.viewerTicket()
      const ticket = proxy.issueTicket({ token: session.token, id: session.id })
      res.json({ ok: true, ticket: ticket.ticket, viewerId: session.id, expiresAt: ticket.expiresAt, viewer: 'webrtc' })
    } catch (error) {
      logger.error('không tạo được vé xem neko', { error: error.message })
      res.status(502).json({ ok: false, error: 'neko_unavailable', message: error.message })
    }
  })

  // -------------------------------------------------------------------------
  // Số liệu cho Prometheus
  // -------------------------------------------------------------------------
  app.get('/metrics', (req, res) => {
    const s = engine.snapshot()
    const lines = [
      '# HELP wayground_paused Đang tạm dừng (1) hay đang chạy (0).',
      '# TYPE wayground_paused gauge',
      `wayground_paused ${s.paused ? 1 : 0}`,
      ...['soft', 'hard', 'deep'].map((level) => `wayground_level{level="${level}"} ${s.level === level ? 1 : 0}`),
      '# HELP wayground_pauses_total Số lần pause.',
      '# TYPE wayground_pauses_total counter',
      `wayground_pauses_total ${s.stats.pauses}`,
      '# HELP wayground_paused_seconds_total Tổng thời gian đã pause (giây).',
      '# TYPE wayground_paused_seconds_total counter',
      `wayground_paused_seconds_total ${(s.stats.totalPausedMs / 1000).toFixed(3)}`,
      ...['soft', 'hard', 'deep'].map(
        (level) => `wayground_level_seconds_total{level="${level}"} ${((s.stats.levelDurations[level] ?? 0) / 1000).toFixed(3)}`,
      ),
      '# HELP wayground_clients Số trình duyệt đang mở bảng điều khiển.',
      '# TYPE wayground_clients gauge',
      `wayground_clients ${s.clients.length}`,
      '# HELP wayground_neko_reachable Kết nối được neko (1/0).',
      '# TYPE wayground_neko_reachable gauge',
      `wayground_neko_reachable ${s.neko.reported.reachable ? 1 : 0}`,
      '# HELP wayground_neko_private_mode private_mode hiện tại của neko.',
      '# TYPE wayground_neko_private_mode gauge',
      `wayground_neko_private_mode ${s.neko.reported.privateMode ? 1 : 0}`,
      '# HELP wayground_docker_actions_total Số hành động docker đã thực hiện.',
      '# TYPE wayground_docker_actions_total counter',
      ...Object.entries(s.docker.actions).map(([action, count]) => `wayground_docker_actions_total{action="${action}"} ${count}`),
      '# HELP wayground_actions_total Số hành động theo bậc.',
      '# TYPE wayground_actions_total counter',
      ...['soft', 'hard', 'deep'].map((level) => `wayground_actions_total{level="${level}"} ${s.stats.levelCounts[level] ?? 0}`),
    ]
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`)
  })

  // -------------------------------------------------------------------------
  // Proxy tới neko & noVNC
  // -------------------------------------------------------------------------
  if (config.mode === 'live') {
    app.use('/neko-api', requireAuth, createHttpProxy({ config, logger, targetBase: `${config.neko.baseUrl}/api` }))

    if (buildPublicConfig().viewer === 'embed') {
      app.use('/neko-ui', requireAuth, createHttpProxy({ config, logger, targetBase: config.neko.baseUrl }))
    }
  }

  if (buildPublicConfig().viewer === 'novnc') {
    const target = new URL(config.novnc.url)
    app.use(
      '/novnc',
      requireAuth,
      createHttpProxy({ config, logger, targetBase: `${target.origin}${target.pathname.replace(/\/[^/]*$/, '')}` }),
    )
  }

  // -------------------------------------------------------------------------
  // Giao diện
  // -------------------------------------------------------------------------
  app.get('/login', (req, res) => {
    if (!config.appPassword || authorize(req).ok) return res.redirect('/')
    res.sendFile('login.html', { root: config.publicDir })
  })

  app.get('/', requireAuth, (req, res) => {
    res.setHeader('cache-control', 'no-store')
    res.sendFile('index.html', { root: config.publicDir })
  })

  app.use(
    express.static(config.publicDir, {
      index: false,
      etag: true,
      maxAge: '1h',
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) res.setHeader('cache-control', 'no-store')
      },
    }),
  )

  app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }))

  app.use((error, req, res, _next) => {
    logger.error('lỗi express', { error: error.message, path: req.path })
    if (res.headersSent) return
    res.status(500).json({ error: 'internal_error', message: error.message })
  })

  return { app, authorize, applySettings, sessions, csrfGuard, SESSION_COOKIE }
}

/** So sánh chuỗi theo thời gian hằng định. */
export function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a))
  const bufB = Buffer.from(String(b))
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function nekoUiUrl(config) {
  const user = encodeURIComponent(config.neko.username || 'neko')
  // Mật khẩu ở đây chỉ để giao diện neko tự kết nối; node.js tự đăng nhập
  // phía server (xem /neko-ui/ws trong proxy.js) nên không lộ mật khẩu thật.
  return `/neko-ui/?usr=${user}&pwd=server-side-auth&embed=1`
}

export function novncUrl(config) {
  const target = new URL(config.novnc.url)
  return `/novnc${target.pathname}?autoconnect=1&resize=scale&path=novnc-ws&reconnect=1&reconnect_delay=2000`
}

export default createApp
