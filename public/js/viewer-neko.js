/**
 * viewer-neko.js - Client neko WebRTC mini (tự viết, không dùng bundle của neko).
 *
 * Vì sao tự viết? Vì ta cần điều khiển TẬN GỐC việc pause/resume:
 *   - tắt track nhận + pause <video>  -> không giải mã frame nữa
 *   - vẫn giữ phiên WebRTC để resume tức thì
 *
 * Giao thức (đối chiếu source neko v3):
 *   WS  : node.js proxy tới  <neko>/api/ws?token=...   , bản tin JSON {event, payload}
 *   RTC : server tạo offer (signal/provide) -> client trả answer -> ICE trickle
 *   DC  : server tạo data channel "data", header {Event u8, Length u16} BigEndian
 *         (nếu không có, client tự tạo & dùng định dạng legacy LittleEndian)
 */
import { eventToKeysym, mouseButton } from './keysyms.js'
import { api, fmtBytes } from './util.js'

const OP = {
  MOVE: 0x01,
  SCROLL: 0x02,
  KEY_DOWN: 0x03,
  KEY_UP: 0x04,
  BTN_DOWN: 0x05,
  BTN_UP: 0x06,
  PING: 0x07,
}

const MAX_UINT32 = 4294967295

export function createNekoViewer(root, { onStatus, onStats, onLog, autoReclaimControl = true } = {}) {
  const video = document.createElement('video')
  video.playsInline = true
  video.autoplay = true
  video.muted = true
  video.setAttribute('playsinline', '')
  root.append(video)

  const soundButton = document.createElement('button')
  soundButton.className = 'sound-toggle'
  soundButton.type = 'button'
  soundButton.textContent = '🔇 Bật tiếng'
  soundButton.hidden = true
  soundButton.addEventListener('click', () => {
    video.muted = false
    video.volume = 1
    video.play().catch(() => {})
    soundButton.hidden = true
  })
  root.append(soundButton)

  const state = {
    ws: null,
    pc: null,
    dc: null,
    dcMode: null,
    fallbackTimer: null,
    tracks: [],
    stream: null,
    connected: false,
    connecting: false,
    sessionId: null,
    isHost: false,
    hasHost: false,
    members: 0,
    resolution: null,
    screenSize: null,
    bytes: 0,
    fps: 0,
    latencyMs: null,
    rttMs: null,
    paused: false,
    destroyed: false,
    retry: 0,
    retryTimer: null,
    lastFrameAt: 0,
    frameCount: 0,
    statsTimer: null,
    heartbeatTimer: null,
    heartbeatMs: 20000,
    inputEl: null,
    lastControlRequest: 0,
    pendingMove: null,
    moveTimer: null,
  }

  const log = (message) => onLog?.(message)
  const setStatus = (patch) => onStatus?.({ ...getStatus(), ...patch })

  function getStatus() {
    return {
      connected: state.connected,
      connecting: state.connecting,
      message: state.connected
        ? `neko · ${state.isHost ? 'đang điều khiển' : 'đang xem'}`
        : state.connecting
          ? 'đang kết nối neko…'
          : 'chưa kết nối neko',
      fps: state.fps,
      resolution: state.resolution,
      latencyMs: state.latencyMs ?? state.rttMs,
      bytes: state.bytes,
      isHost: state.isHost,
      members: state.members,
      sessionId: state.sessionId,
      paused: state.paused,
    }
  }

  // ------------------------------------------------------------------ WS/RTC
  function send(event, payload) {
    if (state.ws?.readyState !== WebSocket.OPEN) return
    state.ws.send(JSON.stringify({ event, payload: payload ?? {} }))
  }

  async function connect() {
    if (state.destroyed || state.connecting) return
    state.connecting = true
    state.retry += 1
    setStatus({})

    try {
      const ticket = await api('/api/viewer/ticket', { method: 'GET' })
      if (!ticket.ok) throw new Error(ticket.message ?? 'không lấy được vé xem')

      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${proto}://${location.host}/viewer-ws?ticket=${encodeURIComponent(ticket.ticket)}`)
      state.ws = ws

      ws.onopen = () => {
        state.retry = 0
        log('neko: đã mở websocket tới neko')
        // yêu cầu neko tạo offer (video auto + audio bật)
        send('signal/request', { video: { auto: true }, audio: {} })
      }

      ws.onmessage = (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        handleMessage(message).catch((error) => log(`neko: lỗi xử lý ${message.event}: ${error.message}`))
      }

      ws.onclose = () => {
        state.connecting = false
        state.connected = false
        setStatus({ message: 'websocket tới neko đã đóng' })
        scheduleReconnect('websocket đóng')
      }

      ws.onerror = () => log('neko: lỗi websocket')
    } catch (error) {
      state.connecting = false
      setStatus({ message: error.message })
      scheduleReconnect(error.message)
      throw error
    }
  }

  async function handleMessage(message) {
    // neko gửi {event, payload}; một số bản cũ gửi phẳng
    const event = message.event
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : message

    switch (event) {
      case 'system/init': {
        state.sessionId = payload.session_id
        state.screenSize = payload.screen_size ?? null
        state.members = payload.sessions ? Object.keys(payload.sessions).length : state.members
        const host = payload.control_host ?? {}
        state.hasHost = Boolean(host.has_host)
        state.isHost = Boolean(host.has_host && host.host_id === state.sessionId)
        if (payload.settings?.heartbeat_interval) state.heartbeatMs = payload.settings.heartbeat_interval * 1000
        setStatus({})
        startHeartbeat()
        break
      }

      case 'signal/provide': {
        await createPeer(payload)
        break
      }

      case 'signal/offer': {
        if (!state.pc) await createPeer(payload)
        else {
          await state.pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
          const answer = await state.pc.createAnswer()
          await state.pc.setLocalDescription(answer)
          send('signal/answer', { sdp: answer.sdp })
        }
        break
      }

      case 'signal/answer': {
        if (state.pc) await state.pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
        break
      }

      case 'signal/candidate': {
        if (!state.pc) break
        try {
          const candidate = typeof payload.data === 'string' ? JSON.parse(payload.data) : payload
          if (candidate?.candidate) await state.pc.addIceCandidate(candidate)
        } catch (error) {
          log(`neko: bỏ qua ICE candidate (${error.message})`)
        }
        break
      }

      case 'signal/close': {
        log('neko: server đóng phiên WebRTC')
        teardownPeer()
        setStatus({ message: 'phiên WebRTC đã đóng, đang kết nối lại…' })
        scheduleReconnect('signal/close')
        break
      }

      case 'system/disconnect': {
        log(`neko: ${payload.message ?? 'bị ngắt kết nối'}`)
        setStatus({ message: payload.message ?? 'neko ngắt kết nối' })
        scheduleReconnect(payload.message ?? 'disconnected')
        break
      }

      case 'system/error': {
        log(`neko: ${payload.title ?? payload.message ?? 'lỗi'}`)
        break
      }

      case 'screen/resolution': {
        if (payload.width && payload.height) state.resolution = `${payload.width}×${payload.height}`
        setStatus({})
        break
      }

      case 'control/host': {
        state.hasHost = Boolean(payload.has_host)
        state.isHost = Boolean(payload.has_host && payload.host_id === state.sessionId)
        setStatus({})
        break
      }

      case 'control/locked': {
        log('neko: quyền điều khiển đang bị khoá')
        break
      }

      case 'member/list': {
        state.members = Array.isArray(payload.members) ? payload.members.length : state.members
        setStatus({})
        break
      }

      case 'session/created': {
        state.members += 1
        setStatus({})
        break
      }

      case 'session/deleted': {
        state.members = Math.max(0, state.members - 1)
        setStatus({})
        break
      }

      default:
        break
    }
  }

  async function createPeer(payload) {
    teardownPeer({ keepSession: true })

    const iceServers = payload.iceservers ?? payload.ice ?? []
    const pc = new RTCPeerConnection({ iceServers })
    state.pc = pc

    pc.ondatachannel = (event) => attachDataChannel(event.channel, 'new')

    pc.ontrack = (event) => {
      const [stream] = event.streams
      state.stream = stream
      state.tracks.push(event.track)
      video.srcObject = stream
      video.play().catch(() => {
        soundButton.hidden = false
        log('neko: trình duyệt chặn tự động phát, hãy bấm vào khung')
      })

      if (state.paused) {
        // nếu đang pause thì giữ nguyên trạng thái tắt track
        event.track.enabled = false
        video.pause()
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) send('signal/candidate', event.candidate.toJSON())
      else send('signal/candidate', {})
    }

    pc.oniceconnectionstatechange = () => {
      const ice = pc.iceConnectionState
      if (ice === 'connected' || ice === 'completed') {
        state.connected = true
        state.connecting = false
        setStatus({})
      } else if (ice === 'disconnected') {
        log('neko: ICE tạm mất kết nối')
      } else if (ice === 'failed') {
        log('neko: ICE thất bại, thử lại')
        scheduleReconnect('ice-failed')
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') scheduleReconnect('connection-failed')
    }

    await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    send('signal/answer', { sdp: answer.sdp })

    log('neko: đã gửi SDP answer, chờ ICE…')

    // Trường hợp server không tạo data channel (bản cũ) -> tự tạo theo chuẩn legacy
    state.fallbackTimer = setTimeout(() => {
      if (!state.dc && state.pc === pc) attachDataChannel(pc.createDataChannel('data'), 'legacy')
    }, 1500)

    startStats()
  }

  function attachDataChannel(channel, mode) {
    if (!channel) return
    clearTimeout(state.fallbackTimer)
    state.dc = channel
    state.dcMode = mode
    channel.binaryType = 'arraybuffer'
    channel.onmessage = (event) => onDataMessage(event.data)
    channel.onopen = () => log(`neko: data channel sẵn sàng (${mode === 'new' ? 'chuẩn v3' : 'legacy'})`)
    channel.onclose = () => log('neko: data channel đóng')
  }

  function onDataMessage(data) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 3) return
    const view = new DataView(data)
    const event = view.getUint8(0)
    if (event === 0x03 && data.byteLength >= 19) {
      // OP_PONG: clientTs1 u32 | clientTs2 u32 | serverTs1 u32 | serverTs2 u32
      const clientTs = view.getUint32(3) * MAX_UINT32 + view.getUint32(7)
      if (clientTs > 0) state.latencyMs = Math.max(0, Date.now() - clientTs)
    }
  }

  // --------------------------------------------------------------- gửi input
  function writeHeader(buffer, view, opcode, length, mode) {
    view.setUint8(0, opcode)
    if (mode === 'legacy') view.setUint16(1, length, true)
    else view.setUint16(1, length, false)
    return buffer
  }

  function sendBuffer(buffer) {
    if (state.dc?.readyState === 'open') state.dc.send(buffer)
  }

  function sendMove(x, y) {
    const mode = state.dcMode ?? 'new'
    const buffer = new ArrayBuffer(7)
    const view = new DataView(buffer)
    writeHeader(buffer, view, OP.MOVE, 4, mode)
    view.setUint16(3, Math.max(0, Math.min(65535, Math.round(x))), mode === 'legacy')
    view.setUint16(5, Math.max(0, Math.min(65535, Math.round(y))), mode === 'legacy')
    sendBuffer(buffer)
  }

  function sendScroll(dx, dy) {
    const mode = state.dcMode ?? 'new'
    if (mode === 'legacy') {
      const buffer = new ArrayBuffer(7)
      const view = new DataView(buffer)
      writeHeader(buffer, view, OP.SCROLL, 4, mode)
      view.setInt16(3, Math.max(-32768, Math.min(32767, dx)), true)
      view.setInt16(5, Math.max(-32768, Math.min(32767, dy)), true)
      sendBuffer(buffer)
      return
    }

    const buffer = new ArrayBuffer(8)
    const view = new DataView(buffer)
    writeHeader(buffer, view, OP.SCROLL, 5, mode)
    view.setInt16(3, Math.max(-32768, Math.min(32767, dx)), false)
    view.setInt16(5, Math.max(-32768, Math.min(32767, dy)), false)
    view.setUint8(7, 0)
    sendBuffer(buffer)
  }

  function sendKey(key, down) {
    const mode = state.dcMode ?? 'new'
    const opcode = down ? OP.KEY_DOWN : OP.KEY_UP

    if (mode === 'legacy') {
      const buffer = new ArrayBuffer(11)
      const view = new DataView(buffer)
      writeHeader(buffer, view, opcode, 8, mode)
      view.setBigUint64(3, BigInt(key), true)
      sendBuffer(buffer)
      return
    }

    const buffer = new ArrayBuffer(7)
    const view = new DataView(buffer)
    writeHeader(buffer, view, opcode, 4, mode)
    view.setUint32(3, key >>> 0, false)
    sendBuffer(buffer)
  }

  function sendButton(button, down) {
    const mode = state.dcMode ?? 'new'
    if (mode === 'legacy') {
      // legacy: key < 8 => nút chuột
      sendKey(button, down)
      return
    }

    const opcode = down ? OP.BTN_DOWN : OP.BTN_UP
    const buffer = new ArrayBuffer(7)
    const view = new DataView(buffer)
    writeHeader(buffer, view, opcode, 4, mode)
    view.setUint32(3, button >>> 0, false)
    sendBuffer(buffer)
  }

  function sendPing() {
    if (state.dcMode !== 'new' || state.dc?.readyState !== 'open') return
    const ts = Date.now()
    const buffer = new ArrayBuffer(11)
    const view = new DataView(buffer)
    writeHeader(buffer, view, OP.PING, 8, 'new')
    view.setUint32(3, Math.floor(ts / MAX_UINT32), false)
    view.setUint32(7, ts % MAX_UINT32, false)
    sendBuffer(buffer)
  }

  /** Đổi toạ độ chuột trong khung thành toạ độ màn hình máy ảo. */
  function toRemote(event) {
    const rect = video.getBoundingClientRect()
    const width = video.videoWidth || state.screenSize?.width || 1920
    const height = video.videoHeight || state.screenSize?.height || 1080

    // video dùng object-fit: contain -> tính vùng hiển thị thật
    const scale = Math.min(rect.width / width, rect.height / height)
    const shownW = width * scale
    const shownH = height * scale
    const offsetX = rect.left + (rect.width - shownW) / 2
    const offsetY = rect.top + (rect.height - shownH) / 2

    const x = ((event.clientX - offsetX) / shownW) * width
    const y = ((event.clientY - offsetY) / shownH) * height
    return { x: Math.max(0, Math.min(width - 1, x)), y: Math.max(0, Math.min(height - 1, y)) }
  }

  /** Nếu chưa phải host thì xin quyền điều khiển (giống neko implicit hosting). */
  function ensureControl() {
    if (state.isHost || state.paused) return
    const now = Date.now()
    if (now - state.lastControlRequest < 2000) return
    state.lastControlRequest = now
    send('control/request', {})
  }

  // --------------------------------------------------------------- vòng đời
  function startHeartbeat() {
    if (state.heartbeatTimer) clearInterval(state.heartbeatTimer)
    state.heartbeatTimer = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) send('client/heartbeat', {})
      sendPing()
    }, Math.max(5000, state.heartbeatMs))
  }

  function startStats() {
    if (state.statsTimer) clearInterval(state.statsTimer)
    state.statsTimer = setInterval(async () => {
      if (!state.pc || state.pc.connectionState === 'closed') return
      try {
        const report = await state.pc.getStats()
        let inbound = null
        let pair = null
        report.forEach((entry) => {
          if (entry.type === 'inbound-rtp' && entry.kind === 'video') inbound = entry
          if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated !== false) pair = entry
        })

        if (inbound) {
          state.bytes = inbound.bytesReceived ?? state.bytes
          state.fps = state.paused ? 0 : Math.round(inbound.framesPerSecond ?? state.fps ?? 0)
        }
        if (pair?.currentRoundTripTime) state.rttMs = Math.round(pair.currentRoundTripTime * 1000)

        onStats?.({
          fps: state.paused ? 0 : state.fps,
          resolution: state.resolution,
          latencyMs: state.latencyMs ?? state.rttMs,
          bytes: state.bytes,
          bitrate: 0,
          running: !state.paused,
          label: fmtBytes(state.bytes),
        })
      } catch {
        /* ignore */
      }
    }, 2000)
  }

  function teardownPeer({ keepSession = false } = {}) {
    clearTimeout(state.fallbackTimer)
    if (state.dc) {
      try {
        state.dc.close()
      } catch {
        /* ignore */
      }
    }
    state.dc = null
    state.dcMode = null

    if (state.pc) {
      try {
        state.pc.ontrack = null
        state.pc.onicecandidate = null
        state.pc.oniceconnectionstatechange = null
        state.pc.close()
      } catch {
        /* ignore */
      }
      state.pc = null
    }

    state.tracks = []
    state.stream = null
    if (!keepSession) {
      state.connected = false
      state.connecting = false
    }
  }

  function scheduleReconnect(reason) {
    if (state.destroyed || state.retryTimer) return
    const delay = Math.min(15000, 1500 * Math.max(1, state.retry))
    log(`neko: thử lại sau ${(delay / 1000).toFixed(1)}s (${reason})`)
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null
      if (state.destroyed) return
      teardownPeer()
      if (state.ws) {
        try {
          state.ws.close()
        } catch {
          /* ignore */
        }
        state.ws = null
      }
      connect().catch(() => {})
    }, delay)
  }

  // ------------------------------------------------------------ input events
  function attachInput(inputEl) {
    state.inputEl = inputEl
    inputEl.dataset.active = 'true'

    let movePending = false
    inputEl.addEventListener('pointermove', (event) => {
      if (state.paused) return
      ensureControl()
      const point = toRemote(event)
      if (movePending) {
        state.pendingMove = point
        return
      }
      movePending = true
      sendMove(point.x, point.y)
      setTimeout(() => {
        movePending = false
        if (state.pendingMove) {
          sendMove(state.pendingMove.x, state.pendingMove.y)
          state.pendingMove = null
        }
      }, 16)
    })

    inputEl.addEventListener('pointerdown', (event) => {
      if (state.paused) return
      ensureControl()
      inputEl.focus?.()
      const point = toRemote(event)
      sendMove(point.x, point.y)
      sendButton(mouseButton(event), true)
    })

    inputEl.addEventListener('pointerup', (event) => {
      if (state.paused) return
      sendButton(mouseButton(event), false)
    })

    inputEl.addEventListener('contextmenu', (event) => event.preventDefault())

    inputEl.addEventListener(
      'wheel',
      (event) => {
        if (state.paused) return
        ensureControl()
        event.preventDefault()
        const factor = event.deltaMode === 1 ? 19 : 1
        sendScroll(Math.round(event.deltaX * factor), Math.round(event.deltaY * factor))
      },
      { passive: false },
    )

    inputEl.addEventListener('keydown', (event) => {
      if (state.paused) return
      ensureControl()
      const keysym = eventToKeysym(event)
      if (!keysym) return
      event.preventDefault()
      if (event.repeat && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Backspace', 'Delete'].includes(event.key)) {
        sendKey(keysym, true)
        return
      }
      sendKey(keysym, true)
    })

    inputEl.addEventListener('keyup', (event) => {
      if (state.paused) return
      const keysym = eventToKeysym(event)
      if (!keysym) return
      event.preventDefault()
      sendKey(keysym, false)
    })

    inputEl.setAttribute('tabindex', '0')
  }

  return {
    name: 'webrtc',
    start: connect,
    attachInput,
    setPaused(next) {
      state.paused = next
      if (next) {
        video.pause()
        for (const track of state.tracks) track.enabled = false
        if (state.inputEl) state.inputEl.dataset.active = 'false'
        onStats?.({ fps: 0, bytes: state.bytes, latencyMs: state.latencyMs, running: false })
      } else {
        for (const track of state.tracks) track.enabled = true
        if (state.inputEl) state.inputEl.dataset.active = 'true'
        video.play().catch(() => {})
        if (!state.dc && state.pc) attachDataChannel(state.pc.createDataChannel('data'), 'legacy')
        if (autoReclaimControl) {
          state.lastControlRequest = 0
          ensureControl()
        }
      }
    },
    getStatus,
    destroy() {
      state.destroyed = true
      clearInterval(state.statsTimer)
      clearInterval(state.heartbeatTimer)
      clearTimeout(state.retryTimer)
      teardownPeer()
      try {
        state.ws?.close()
      } catch {
        /* ignore */
      }
      video.srcObject = null
      video.remove()
      soundButton.remove()
    },
  }
}
