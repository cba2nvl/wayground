/**
 * controlChannel.js - Kênh điều khiển thời gian thực giữa trình duyệt và node.js.
 *
 *  - Trình duyệt báo lên: chuột vào/ra khỏi khung, có thao tác, nhịp tim.
 *  - Node.js báo xuống: trạng thái pause/resume, bậc đang áp dụng, log, số liệu.
 *
 * Mọi quyết định pause/resume đều nằm ở server (PauseEngine) -> nhiều tab,
 * nhiều người xem vẫn nhất quán; trình duyệt chỉ "phản chiếu" trạng thái.
 */
import { WebSocketServer } from 'ws'
import { logHistory, onLog } from './log.js'

const MAX_MESSAGE_BYTES = 64 * 1024

export function isSameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true // client không phải trình duyệt (curl, test)
  try {
    const originHost = new URL(origin).host
    const host = req.headers.host
    return originHost === host
  } catch {
    return false
  }
}

export function attachControlChannel(server, ctx) {
  const { engine, logger } = ctx
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  const clients = new Map() // ws -> { id, auto, hidden, connectedAt, lastMessageAt, applied }

  const send = (ws, payload) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify(payload))
      } catch (error) {
        logger.debug('ws: gửi thất bại', { error: error.message })
      }
    }
  }

  const broadcast = (payload, { except } = {}) => {
    for (const ws of clients.keys()) {
      if (except && ws === except) continue
      send(ws, payload)
    }
  }

  // ---- engine -> tất cả client -------------------------------------------
  let pendingState = null
  const flushState = () => {
    if (!pendingState) return
    pendingState = null
    broadcast({ type: 'state', state: engine.snapshot(), at: Date.now() })
  }

  engine.on('change', () => {
    pendingState = true
    if (!flushState.timer) {
      flushState.timer = setTimeout(() => {
        flushState.timer = null
        flushState()
      }, 40)
      flushState.timer.unref?.()
    }
  })

  engine.on('action', (entry) => broadcast({ type: 'action', entry }))
  engine.on('pause', (state) => broadcast({ type: 'pause', state }))
  engine.on('resume', (state) => broadcast({ type: 'resume', state }))

  const unsubscribeLog = onLog((entry) => {
    if (entry.level === 'debug') return // nhật ký UI chỉ nhận info trở lên
    broadcast({ type: 'log', entry })
  })

  // ---- tick 1s: cập nhật đồng hồ đếm ngược ---------------------------------
  const tick = setInterval(() => {
    if (clients.size === 0) return
    const state = engine.snapshot()
    broadcast({
      type: 'tick',
      at: Date.now(),
      paused: state.paused,
      level: state.level,
      pausedForMs: state.pausedForMs,
      deadlines: state.deadlines,
      clients: state.clients.length,
      warnings: state.warnings,
      neko: { reachable: state.neko.reported.reachable, privateMode: state.neko.reported.privateMode },
      docker: { available: state.docker.available, container: state.docker.container },
    })
  }, 1000)
  tick.unref?.()

  // ---- xử lý kết nối -------------------------------------------------------
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    if (url.pathname.replace(/\/+$/, '') !== '/ws/control') return
    const authorize = ctx.app?.authorize
    if (!isSameOrigin(req) || (authorize && !authorize(req).ok)) {
      logger.warn('ws: từ chối kết nối control channel', { origin: req.headers.origin ?? null })
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const clientId = (url.searchParams.get('client') || '').slice(0, 64) || globalThis.crypto.randomUUID()
      const entry = {
        id: clientId,
        auto: url.searchParams.get('auto') !== '0',
        hidden: false,
        connectedAt: Date.now(),
        lastMessageAt: Date.now(),
        applied: null,
      }
      clients.set(ws, entry)
      engine.touchClient(clientId, { ua: req.headers['user-agent'] })

      send(ws, {
        type: 'hello',
        clientId,
        at: Date.now(),
        config: ctx.app?.publicConfig?.() ?? null,
        state: engine.snapshot(),
        log: logHistory().slice(-120),
      })
      logger.info('ws: control channel kết nối', { clientId: clientId.slice(0, 12), clients: clients.size })

      ws.on('message', (raw) => {
        if (raw.length > MAX_MESSAGE_BYTES) {
          logger.warn('ws: bỏ qua message quá lớn', { bytes: raw.length })
          return
        }

        entry.lastMessageAt = Date.now()
        let message
        try {
          message = JSON.parse(raw.toString())
        } catch {
          logger.debug('ws: message không phải JSON')
          return
        }

        handleClientMessage({ ws, entry, message, send, broadcast, engine })
      })

      ws.on('close', () => {
        clients.delete(ws)
        engine.dropClient(clientId)
        logger.info('ws: control channel đóng', { clientId: clientId.slice(0, 12), clients: clients.size })
      })

      ws.on('error', (error) => logger.debug('ws: lỗi', { error: error.message }))
    })
  })

  return {
    wss,
    clients,
    broadcast,
    get clientCount() {
      return clients.size
    },
    close: async () => {
      clearInterval(tick)
      unsubscribeLog()
      for (const ws of clients.keys()) {
        try {
          ws.close(1001, 'server shutdown')
        } catch {
          /* ignore */
        }
      }
      await new Promise((resolve) => wss.close(resolve))
    },
  }
}

/** Xử lý message từ trình duyệt (tách riêng để dễ test). */
export function handleClientMessage({ entry, message, send, broadcast, engine }) {
  const { type } = message ?? {}

  switch (type) {
    case 'pointer':
      engine.setClientPointer(entry.id, message.state)
      break

    case 'input':
      engine.noteInput(entry.id)
      break

    case 'heartbeat':
      if (typeof message.auto === 'boolean') entry.auto = message.auto
      if (typeof message.hidden === 'boolean') entry.hidden = message.hidden
      engine.heartbeat(entry.id, {
        auto: entry.auto,
        hidden: entry.hidden,
        input: message.input === true,
        pausedByClient: message.applied === 'soft',
      })
      if (message.applied) entry.applied = message.applied
      break

    case 'pause':
      engine.pause(message.source === 'api' ? 'api' : 'manual', { detail: message.detail ?? 'người dùng bấm tạm dừng' })
      break

    case 'resume':
      engine.resume(message.source === 'api' ? 'api' : 'manual', { detail: message.detail })
      break

    case 'toggle':
      engine.toggle('manual')
      break

    case 'auto':
      engine.updateSettings({ autoPause: Boolean(message.enabled) })
      break

    case 'settings':
      engine.updateSettings(message.patch ?? {})
      broadcast({ type: 'config', config: engine.snapshot().settings })
      break

    case 'ping':
      send({ type: 'pong', t: message.t ?? Date.now(), at: Date.now() })
      break

    default:
      send({ type: 'error', message: `loại message không hỗ trợ: ${String(type)}` })
  }
}

export default attachControlChannel
