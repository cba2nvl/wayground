/**
 * nekoClient.js - Client REST tới neko server (m1k1o/neko v3).
 *
 * Những API được dùng (đã đối chiếu source neko v3):
 *   POST /api/login                 -> { id, profile, state } + Set-Cookie (hoặc token trong body)
 *   GET  /api/room/settings/        -> Settings (cần admin)     <- CÓ dấu / cuối
 *   POST /api/room/settings/        -> đổi setting, body partial (merge)
 *   POST /api/room/control/reset    -> nhả phím đang giữ + trả quyền điều khiển
 *   GET  /api/room/control/         -> { has_host, host_id }
 *   GET  /api/sessions              -> danh sách session
 *   GET  /health                    -> "true"
 *
 * ⚠️ neko dùng chi router với `r.Route("/settings", r.Get("/"))` nên đường dẫn
 *    ĐÚNG là `/api/room/settings/` (có `/` cuối). Gọi thiếu `/` sẽ bị 404.
 *
 * Xác thực: neko ưu tiên cookie `neko_session` (mặc định cookie.enabled=true,
 * khi đó /api/login KHÔNG trả token trong body mà chỉ Set-Cookie), sau đó tới
 * header `Authorization: Bearer <token>`, cuối cùng là `?token=`.
 * Vì vậy client này giữ một "lọ cookie" riêng cho từng loại session.
 *
 * Ghi chú quan trọng về PAUSE phía neko:
 *   neko pause WebRTC khi `settings.private_mode = true` (xem session.updateSettings
 *   -> webrtcPeer.SetPaused), NHƯNG chỉ áp dụng cho session KHÔNG phải admin:
 *       PrivateModeEnabled() = settings.PrivateMode && !profile.IsAdmin
 *   => khung xem nên đăng nhập bằng tài khoản người dùng thường, còn việc bật/tắt
 *      private_mode cần quyền admin (router dùng auth.AdminsOnly).
 */
import { EventEmitter } from 'node:events'

export class NekoError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message)
    this.name = 'NekoError'
    this.status = status
    this.body = body
    this.path = path
  }
}

export class NekoClient extends EventEmitter {
  /**
   * @param {import('./config.js').config} config
   * @param {import('./log.js').logger} logger
   */
  constructor(config, logger) {
    super()
    this.config = config
    this.logger = logger
    this.lastViewerConnection = null
    this.baseUrl = config.neko.baseUrl
    this.sessions = { admin: null, viewer: null }
    // Lọ cookie riêng cho từng session (neko mặc định xác thực bằng cookie).
    this.cookies = new Map()
    this.stats = {
      requests: 0,
      errors: 0,
      privateModeSet: 0,
      lastError: null,
      lastRequestAt: null,
      reachable: null,
    }
  }

  get enabled() {
    return Boolean(this.baseUrl)
  }

  // -------------------------------------------------------------------------
  // HTTP core
  // -------------------------------------------------------------------------
  async request(path, { method = 'GET', body, token, cookie, headers = {}, timeoutMs } = {}) {
    if (!this.enabled) {
      throw new NekoError('Chưa cấu hình NEKO_URL', { path })
    }

    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs ?? this.config.neko.requestTimeoutMs)

    const finalHeaders = {
      accept: 'application/json',
      ...headers,
    }
    if (body !== undefined) finalHeaders['content-type'] = 'application/json'
    if (token) finalHeaders.authorization = `Bearer ${token}`
    if (cookie) finalHeaders.cookie = cookie

    this.stats.requests += 1
    this.stats.lastRequestAt = new Date().toISOString()

    try {
      const response = await fetch(url, {
        method,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })

      const text = await response.text()
      let payload = text
      try {
        payload = text ? JSON.parse(text) : null
      } catch {
        /* neko trả text thuần ở một số endpoint (/health) */
      }

      // giữ cookie phiên (nếu neko dùng cookie thay vì token trong body)
      const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
      const sessionCookie = setCookie
        .map((value) => value.split(';')[0])
        .find((value) => /^neko_session=/i.test(value) || /^NEKO_SESSION=/i.test(value))

      if (!response.ok) {
        const message =
          (payload && typeof payload === 'object' && (payload.message || payload.error)) ||
          (typeof payload === 'string' && payload) ||
          `HTTP ${response.status}`
        throw new NekoError(`${method} ${path} -> ${response.status}: ${message}`, {
          status: response.status,
          body: payload,
          path,
        })
      }

      this.stats.reachable = true
      if (sessionCookie && cookie !== undefined) this.cookies.set(cookie, sessionCookie)
      return payload
    } catch (error) {
      if (error instanceof NekoError) {
        this.stats.errors += 1
        this.stats.lastError = error.message
        if (error.status === 0 || error.status >= 500 || error.status === 404) this.stats.reachable = false
        throw error
      }

      this.stats.errors += 1
      const reason = error?.name === 'AbortError' ? `timeout sau ${timeoutMs ?? this.config.neko.requestTimeoutMs}ms` : error.message
      const wrapped = new NekoError(`Không gọi được neko (${method} ${path}): ${reason}`, { status: 0, path })
      this.stats.lastError = wrapped.message
      this.stats.reachable = false
      throw wrapped
    } finally {
      clearTimeout(timeout)
    }
  }

  // -------------------------------------------------------------------------
  // Đăng nhập / session
  // -------------------------------------------------------------------------
  async login({ username, password, role = 'admin', force = false }) {
    if (!force && this.sessions[role]) return this.sessions[role]

    this.logger.debug(`neko: đăng nhập (${role})`, { username })
    const data = await this.request('/api/login', {
      method: 'POST',
      body: { username, password },
      cookie: role, // nhận Set-Cookie nếu neko bật session.cookie.enabled
    })
    const session = {
      id: data?.id,
      token: data?.token,
      profile: data?.profile ?? {},
      role,
      cookie: this.cookies.get(role) ?? null,
      createdAt: Date.now(),
    }
    this.sessions[role] = session
    if (role === 'viewerConnection') this.lastViewerConnection = session
    this.logger.info(`neko: đăng nhập thành công (${role})`, { id: session.id, admin: Boolean(session.profile?.is_admin) })
    return session
  }

  /** Session admin (dùng cho /api/room/settings). Ưu tiên API token nếu có. */
  async adminSession({ force = false } = {}) {
    if (!force && this.sessions.admin) return this.sessions.admin

    if (this.config.neko.apiToken) {
      this.sessions.admin = {
        id: 'API_TOKEN',
        token: this.config.neko.apiToken,
        profile: { name: 'API Session', is_admin: true },
        role: 'admin',
        createdAt: Date.now(),
      }
      return this.sessions.admin
    }

    return this.login({
      username: this.config.neko.adminUsername,
      password: this.config.neko.adminPassword,
      role: 'admin',
      force,
    })
  }

  /** Session người dùng thường - session này mới bị private_mode pause. */
  async viewerSession({ force = false } = {}) {
    if (!force && this.sessions.viewer) return this.sessions.viewer
    return this.login({
      username: this.config.neko.username,
      password: this.config.neko.password,
      role: 'viewer',
      force,
    })
  }

  /**
   * Tạo session mới hoàn toàn (mỗi kết nối WebSocket là 1 session riêng).
   *
   * Với member provider `multiuser` (mặc định), mỗi lần login sinh một id ngẫu
   * nhiên nên 2 tab = 2 session độc lập. Với provider khác (file/object/oauth)
   * neko có thể trả 422 "session already connected"; khi đó ta thử lại sau 1s
   * rồi (nếu vẫn bận) dùng lại session gần nhất để trình duyệt vẫn xem được.
   */
  async createViewerSession({ retries = 1 } = {}) {
    try {
      return await this.login({
        username: this.config.neko.username,
        password: this.config.neko.password,
        role: 'viewerConnection',
        force: true,
      })
    } catch (error) {
      if (error.status === 422 && retries > 0) {
        this.logger.warn('neko: session đang được dùng, thử lại sau 1s')
        await new Promise((resolve) => setTimeout(resolve, 1000))
        return this.createViewerSession({ retries: retries - 1 })
      }
      if (error.status === 422 && this.lastViewerConnection) {
        this.logger.warn('neko: dùng lại session viewer gần nhất (session cũ chưa đóng)')
        return this.lastViewerConnection
      }
      throw error
    }
  }

  async withAdminRetry(path, options) {
    const session = await this.adminSession()
    try {
      return await this.request(path, { ...options, token: session.token, cookie: this.cookies.get('admin') })
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        this.logger.warn('neko: token admin hết hiệu lực, đăng nhập lại')
        const fresh = await this.adminSession({ force: true })
        return this.request(path, { ...options, token: fresh.token, cookie: this.cookies.get('admin') })
      }
      throw error
    }
  }

  // -------------------------------------------------------------------------
  // Settings / điều khiển
  // -------------------------------------------------------------------------
  async getSettings() {
    // chi router đăng ký "/settings/" nên PHẢI có dấu / cuối, thiếu là 404.
    return this.withAdminRetry('/api/room/settings/', { method: 'GET' })
  }

  async getControlStatus() {
    return this.withAdminRetry('/api/room/control/', { method: 'GET' })
  }

  async getSessions() {
    return this.withAdminRetry('/api/sessions', { method: 'GET' })
  }

  async health() {
    try {
      await this.request('/health')
      return true
    } catch {
      return false
    }
  }

  /**
   * Bật/tắt private mode = TẠM DỪNG / TIẾP TỤC phía neko server.
   * Khi bật, neko đóng subscription của track video/audio -> không encode/gửi
   * frame nữa; client nhận frame cuối cùng và hình "đứng".
   */
  async setPrivateMode(enabled, reason = 'api') {
    if (!this.enabled) return { skipped: true, reason: 'neko chưa được cấu hình' }

    const result = await this.withAdminRetry('/api/room/settings/', {
      method: 'POST',
      body: { private_mode: Boolean(enabled) },
    })

    this.stats.privateModeSet += 1
    this.logger.info(`neko: private_mode=${Boolean(enabled)} (${reason})`)
    this.emit('private-mode', { enabled: Boolean(enabled), reason })
    return result
  }

  /** Nhả phím đang giữ + trả quyền điều khiển (gọi khi pause để tránh phím kẹt). */
  async releaseControl(reason = 'pause') {
    if (!this.enabled) return
    try {
      await this.withAdminRetry('/api/room/control/reset', { method: 'POST' })
      this.logger.debug(`neko: đã reset control (${reason})`)
    } catch (error) {
      this.logger.debug(`neko: reset control thất bại (${reason})`, { error: error.message })
    }
  }

  /** Cấu hình cho client WebRTC mini: trả token + ice servers (chỉ ở server). */
  async viewerTicket() {
    const session = await this.createViewerSession()
    return { token: session.token, id: session.id, profile: session.profile }
  }

  snapshot() {
    return {
      enabled: this.enabled,
      baseUrl: this.baseUrl || null,
      reachable: this.stats.reachable,
      requests: this.stats.requests,
      errors: this.stats.errors,
      privateModeSet: this.stats.privateModeSet,
      lastError: this.stats.lastError,
      lastRequestAt: this.stats.lastRequestAt,
      sessions: {
        admin: this.sessions.admin ? { id: this.sessions.admin.id, isAdmin: Boolean(this.sessions.admin.profile?.is_admin) } : null,
        viewer: this.sessions.viewer ? { id: this.sessions.viewer.id, isAdmin: Boolean(this.sessions.viewer.profile?.is_admin) } : null,
      },
    }
  }
}

export default NekoClient
