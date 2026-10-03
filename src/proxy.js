/**
 * proxy.js - Reverse proxy HTTP + WebSocket tới neko (và noVNC).
 *
 * Vì sao cần proxy?
 *  1. Trình duyệt chỉ nói chuyện với 1 origin duy nhất -> không CORS, không
 *     mixed-content, chạy tốt sau reverse proxy/HTTPS.
 *  2. neko kiểm tra `Origin` khi nâng cấp WebSocket (`config.AllowOrigin`).
 *     Node.js tự nâng cấp hộ với Origin rỗng -> luôn hợp lệ.
 *  3. Giấu mật khẩu neko: mỗi kết nối `/viewer-ws` được node.js đăng nhập
 *     riêng và gắn token vào `?token=` khi nói chuyện với neko.
 */
import { Readable } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import { httpToWs } from './config.js'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'content-encoding',
])

function isSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true // client không phải trình duyệt (curl/test)
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Bỏ thuộc tính Domain của cookie để cookie gắn với origin của chúng ta
 * (vì trình duyệt chỉ nói chuyện với node.js, không nói chuyện với neko).
 * Nhận 1 chuỗi cookie -> trả về 1 chuỗi cookie.
 */
export function rewriteSetCookie(value) {
  return String(value)
    .split(';')
    .filter((part) => !/^\s*domain=/i.test(part))
    .map((part) => (/^\s*path=/i.test(part) ? ' Path=/' : part))
    .join(';')
}

/** Nhận mảng (hoặc chuỗi) set-cookie -> mảng cookie đã chuẩn hoá. */
export function rewriteSetCookies(value) {
  if (!value) return []
  return (Array.isArray(value) ? value : [value]).map(rewriteSetCookie)
}

/**
 * Tạo middleware proxy HTTP.
 * @param {{config:any, logger:any, prefix?:string, targetBase:string}} options
 */
export function createHttpProxy({ logger, targetBase, stripPrefix = true, rewriteQuery }) {
  return async function httpProxy(req, res) {
    const started = Date.now()
    // Express app.use('/prefix', middleware) đã rút prefix khỏi req.url;
    // dùng originalUrl để stripPrefix không vô tình làm rơi segment đầu của
    // các asset (ví dụ /neko-ui/js/app.js -> /js/app.js).
    const sourceUrl = stripPrefix ? (req.originalUrl ?? req.url) : req.url
    const targetPath = stripPrefix ? sourceUrl.replace(/^\/[^/]+/, '') || '/' : sourceUrl || '/'
    const target = new URL(`${targetBase}${targetPath.startsWith('/') ? '' : '/'}${targetPath}`)
    // vd: thay pwd giả bằng mật khẩu thật trước khi chuyển tiếp
    if (typeof rewriteQuery === 'function') rewriteQuery(target.searchParams, req)

    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase()
      if (HOP_BY_HOP.has(lower) || lower === 'host' || lower === 'origin' || lower === 'referer') continue
      if (lower === 'accept-encoding') continue // tránh nén 2 lớp
      headers[key] = Array.isArray(value) ? value.join(', ') : value
    }
    headers.host = target.host
    headers['accept-encoding'] = 'identity'
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
    headers['x-forwarded-proto'] = req.protocol

    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method)

    try {
      const response = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(60000),
      })

      res.status(response.status)
      for (const [key, value] of response.headers.entries()) {
        const lower = key.toLowerCase()
        if (HOP_BY_HOP.has(lower)) continue
        if (lower === 'set-cookie') continue
        if (lower === 'location') {
          // giữ nguyên đường dẫn tương đối, tuyệt đối thì trỏ về neko
          res.setHeader('location', value)
          continue
        }
        res.setHeader(key, value)
      }

      const cookies =
        typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : response.headers.get('set-cookie')
            ? [response.headers.get('set-cookie')]
            : []
      if (cookies.length) res.setHeader('set-cookie', rewriteSetCookies(cookies))

      if (response.body) {
        await new Promise((resolve, reject) => {
          Readable.fromWeb(response.body).pipe(res).on('finish', resolve).on('error', reject)
        })
      } else {
        res.end()
      }

      logger.debug(`proxy ${req.method} ${req.url} -> ${target.pathname} ${response.status} (${Date.now() - started}ms)`)
    } catch (error) {
      logger.error(`proxy lỗi ${req.method} ${req.url}`, { error: error.message })
      if (!res.headersSent) res.status(502).json({ error: 'upstream_unreachable', message: error.message, target: target.origin })
      else res.end()
    }
  }
}

/**
 * Gắn các WS proxy vào http server.
 *
 * @param {import('node:http').Server} server
 * @param {{config:any, logger:any}} deps
 * @returns {{wss: WebSocketServer, stats: any, close: () => Promise<void>}}
 */
export function attachWebSocketProxies(server, { config, logger, authorize }) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const stats = {
    viewerConnections: 0,
    viewerActive: 0,
    bytesToClient: 0,
    bytesToNeko: 0,
    lastError: null,
    tickets: new Map(), // ticket -> { token, id, expiresAt, used }
  }

  // ---------------------------------------------------------------------
  // Ticket: trình duyệt xin 1 "vé" ngắn hạn, node.js giữ token neko.
  // ---------------------------------------------------------------------
  const TICKET_TTL_MS = 60000

  function issueTicket({ token, id }) {
    const cleanup = () => {
      const deadline = Date.now() - TICKET_TTL_MS
      for (const [key, value] of stats.tickets) if (value.issuedAt < deadline) stats.tickets.delete(key)
    }
    if (stats.tickets.size > 200) cleanup()

    const ticket = globalThis.crypto.randomUUID()
    stats.tickets.set(ticket, { token, id, issuedAt: Date.now(), expiresAt: Date.now() + TICKET_TTL_MS, used: false })
    return { ticket, expiresAt: Date.now() + TICKET_TTL_MS }
  }

  function consumeTicket(ticket) {
    const entry = stats.tickets.get(ticket)
    if (!entry) return null
    if (entry.used || entry.expiresAt < Date.now()) {
      stats.tickets.delete(ticket)
      return null
    }
    entry.used = true
    stats.tickets.delete(ticket)
    return entry
  }

  /** Kết nối tới neko WS và bơm dữ liệu 2 chiều. */
  function bridge(client, { targetUrl, label }) {
    // che token/mật khẩu khi ghi log
    const safeTarget = targetUrl.replace(/(token|password|pwd)=[^&]*/gi, '$1=***')
    logger.info(`ws: mở cầu ${label}`, { target: safeTarget })

    const upstream = new WebSocket(targetUrl, {
      perMessageDeflate: false,
      handshakeTimeout: 15000,
      // Không gửi Origin -> neko CheckOrigin luôn cho qua
      headers: {},
    })

    let closed = false
    const fail = (side, error) => {
      if (closed) return
      closed = true
      stats.lastError = `${side}: ${error}`
      logger.warn(`ws: ${label} kết thúc (${side})`, { error })
      try {
        client.close(1011, 'upstream error')
      } catch {
        /* ignore */
      }
      try {
        upstream.close()
      } catch {
        /* ignore */
      }
      stats.viewerActive = Math.max(0, stats.viewerActive - 1)
    }

    upstream.on('open', () => {
      stats.viewerActive += 1
      stats.viewerConnections += 1
      logger.info(`ws: ${label} đã kết nối neko`)
    })

    upstream.on('message', (data, isBinary) => {
      stats.bytesToClient += data.length ?? 0
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
    })

    client.on('message', (data, isBinary) => {
      stats.bytesToNeko += data.length ?? 0
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary })
    })

    upstream.on('close', (code, reason) => {
      logger.debug(`ws: neko đóng ${label}`, { code, reason: reason?.toString?.() })
      if (closed) return
      closed = true
      stats.viewerActive = Math.max(0, stats.viewerActive - 1)
      try {
        client.close(code === 1000 ? 1000 : 1011, reason?.toString?.() ?? '')
      } catch {
        /* ignore */
      }
    })

    upstream.on('error', (error) => fail('neko', error.message))
    client.on('error', (error) => fail('browser', error.message))
    client.on('close', () => {
      if (closed) return
      closed = true
      stats.viewerActive = Math.max(0, stats.viewerActive - 1)
      logger.debug(`ws: trình duyệt đóng ${label}`)
      try {
        upstream.close()
      } catch {
        /* ignore */
      }
    })

    return upstream
  }

  // ---------------------------------------------------------------------
  // Nâng cấp kết nối
  // ---------------------------------------------------------------------
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    const isProxyPath = ['/viewer-ws', '/neko-ui/ws', '/neko-ui/api/ws', '/novnc-ws'].includes(pathname)
    const authResult = isProxyPath ? authorize?.(req) : null
    if (isProxyPath && (!isSameOrigin(req) || (authorize && !authResult?.ok))) {
      logger.warn('ws: từ chối kết nối proxy', { path: pathname, origin: req.headers.origin ?? null })
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    // ---- 1) khung xem neko WebRTC của chúng ta (/viewer-ws?ticket=...)
    if (pathname === '/viewer-ws') {
      const ticket = url.searchParams.get('ticket')
      const entry = consumeTicket(ticket)
      if (!entry) {
        logger.warn('ws: /viewer-ws với vé không hợp lệ hoặc đã dùng')
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      wss.handleUpgrade(req, socket, head, (client) => {
        const target = `${httpToWs(config.neko.baseUrl)}/api/ws?token=${encodeURIComponent(entry.token)}`
        bridge(client, { targetUrl: target, label: `viewer:${entry.id}` })
      })
      return
    }

    // ---- 2) giao diện neko nhúng iframe (VIEWER=embed) -> /neko-ui/ws
    //
    // Giao diện kèm theo của neko nói "giao thức cũ" qua `/ws` (legacy adapter,
    // chỉ có khi neko chạy với `legacy`, xem NEKO_LEGACY ở docker-compose).
    // Trình duyệt gửi ?username=&password= (mật khẩu giả), ta thay bằng tài
    // khoản thật cấu hình ở server -> mật khẩu neko không bao giờ tới browser.
    if (pathname === '/neko-ui/ws' || pathname === '/neko-ui/api/ws') {
      wss.handleUpgrade(req, socket, head, (client) => {
        const query = new URLSearchParams({
          username: config.neko.username,
          password: config.neko.password,
        })
        const target = `${httpToWs(config.neko.baseUrl)}/ws?${query.toString()}`
        bridge(client, { targetUrl: target, label: 'embed' })
      })
      return
    }

    // ---- 3) noVNC (tuỳ chọn): /novnc-ws -> websockify
    if (pathname === '/novnc-ws') {
      if (!config.novnc.wsUrl) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        bridge(client, { targetUrl: config.novnc.wsUrl, label: 'novnc' })
      })
      return
    }

    // các đường dẫn khác do controlChannel.js tự xử lý
  })

  return {
    wss,
    stats,
    issueTicket,
    consumeTicket,
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) {
          try {
            client.terminate()
          } catch {
            /* ignore */
          }
        }
        wss.close(() => resolve())
      }),
  }
}

export default { createHttpProxy, attachWebSocketProxies, rewriteSetCookie, rewriteSetCookies }
