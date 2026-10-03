/**
 * viewer-demo.js - "Máy ảo" mô phỏng vẽ bằng canvas.
 *
 * Dùng khi MODE=demo: không cần neko/docker mà vẫn thấy đúng hành vi:
 *   - đang chạy: hoạt ảnh 60fps, đồng hồ nhảy, chart động, FPS/bitrate > 0
 *   - bị pause : vòng lặp vẽ DỪNG hẳn, khung hình đóng băng, FPS/bitrate = 0
 * Con trỏ chuột vẽ bên trong canvas để giống một máy ảo thật.
 */
import { fmtBytes } from './util.js'

const W = 1920
const H = 1080

export function createDemoViewer(root, { onStats, onLog } = {}) {
  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  root.append(canvas)

  const ctx = canvas.getContext('2d')
  let dpr = Math.min(window.devicePixelRatio || 1, 2)
  let raf = null
  let running = true
  let paused = false
  let pausedLevel = 'soft'
  let frames = 0
  let fps = 0
  let lastFpsAt = performance.now()
  let lastFrameAt = performance.now()
  let bytes = 0
  let elapsed = 0
  let w = canvas.clientWidth || 960
  let h = canvas.clientHeight || 540
  const mouse = { x: -1, y: -1, inside: false }
  const ripples = []
  const logLines = []
  const messages = []

  const COLORS = {
    bg1: '#101c30',
    bg2: '#070c14',
    win: 'rgba(15, 21, 31, 0.92)',
    winBorder: 'rgba(255,255,255,0.10)',
    chrome: '#1b2432',
    text: '#e6eef8',
    muted: '#8fa2ba',
    accent: '#4bd0ff',
    green: '#35e0a1',
    amber: '#ffb638',
    violet: '#a78bfa',
    red: '#ff6b6b',
  }

  // ------------------------------------------------------------------ setup
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2)
    w = canvas.clientWidth || root.clientWidth || 960
    h = canvas.clientHeight || root.clientHeight || 540
    canvas.width = Math.max(2, Math.round(w * dpr))
    canvas.height = Math.max(2, Math.round(h * dpr))
    if (paused) drawFrozen()
  }

  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  resize()

  // ------------------------------------------------------------- primitives
  const rr = (x, y, cw, ch, r) => {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + cw, y, x + cw, y + ch, r)
    ctx.arcTo(x + cw, y + ch, x, y + ch, r)
    ctx.arcTo(x, y + ch, x, y, r)
    ctx.arcTo(x, y, x + cw, y, r)
    ctx.closePath()
  }

  const windowFrame = (x, y, cw, ch, title, accent = COLORS.accent) => {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.55)'
    ctx.shadowBlur = 28
    ctx.shadowOffsetY = 14
    ctx.fillStyle = COLORS.win
    rr(x, y, cw, ch, 14)
    ctx.fill()
    ctx.restore()

    ctx.strokeStyle = COLORS.winBorder
    ctx.lineWidth = 2
    rr(x, y, cw, ch, 14)
    ctx.stroke()

    ctx.fillStyle = COLORS.chrome
    rr(x, y, cw, 42, 14)
    ctx.fill()
    ctx.fillStyle = COLORS.chrome
    ctx.fillRect(x, y + 28, cw, 14)

    ctx.fillStyle = '#ff5f57'
    ctx.beginPath()
    ctx.arc(x + 22, y + 21, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#febc2e'
    ctx.beginPath()
    ctx.arc(x + 42, y + 21, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#28c840'
    ctx.beginPath()
    ctx.arc(x + 62, y + 21, 6, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = COLORS.muted
    ctx.font = '500 16px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(title, x + cw / 2, y + 27)
    ctx.textAlign = 'left'

    ctx.fillStyle = accent
    ctx.fillRect(x, y + 40, cw, 2)
  }

  // ------------------------------------------------------------------ scene
  function drawWallpaper() {
    const gradient = ctx.createLinearGradient(0, 0, W, H)
    gradient.addColorStop(0, COLORS.bg1)
    gradient.addColorStop(0.6, '#0a1220')
    gradient.addColorStop(1, COLORS.bg2)
    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, W, H)

    const glow = ctx.createRadialGradient(W * 0.2, H * 0.15, 40, W * 0.2, H * 0.15, 900)
    glow.addColorStop(0, 'rgba(75, 208, 255, 0.16)')
    glow.addColorStop(1, 'transparent')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, W, H)

    const glow2 = ctx.createRadialGradient(W * 0.85, H * 0.85, 40, W * 0.85, H * 0.85, 800)
    glow2.addColorStop(0, 'rgba(167, 139, 250, 0.14)')
    glow2.addColorStop(1, 'transparent')
    ctx.fillStyle = glow2
    ctx.fillRect(0, 0, W, H)

    ctx.fillStyle = 'rgba(255,255,255,0.05)'
    for (let gx = 0; gx < W; gx += 64) {
      for (let gy = 0; gy < H; gy += 64) {
        ctx.fillRect(gx, gy, 1.5, 1.5)
      }
    }
  }

  function drawBrowser(t) {
    const x = 90
    const y = 78
    const cw = 1180
    const ch = 720
    windowFrame(x, y, cw, ch, 'Firefox — n.eko virtual browser')

    // thanh địa chỉ
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    rr(x + 20, y + 52, cw - 40, 38, 10)
    ctx.fill()
    ctx.fillStyle = COLORS.muted
    ctx.font = '15px ui-monospace, monospace'
    ctx.fillText('🔒 neko.m1k1o.net/docs/v3', x + 36, y + 77)

    // tiêu đề trang
    ctx.fillStyle = COLORS.text
    ctx.font = '600 34px system-ui, sans-serif'
    ctx.fillText('Bảng điều khiển máy ảo', x + 40, y + 152)

    ctx.fillStyle = COLORS.muted
    ctx.font = '16px system-ui, sans-serif'
    const shimmer = 0.35 + 0.25 * Math.sin(t / 600)
    ctx.globalAlpha = shimmer
    ctx.fillText('Chuỗi khung hình này chỉ vẽ khi máy ảo đang chạy.', x + 40, y + 184)
    ctx.globalAlpha = 1

    // "ảnh" hero
    const heroGradient = ctx.createLinearGradient(x + 40, y + 210, x + 520, y + 400)
    heroGradient.addColorStop(0, 'rgba(75,208,255,0.55)')
    heroGradient.addColorStop(1, 'rgba(167,139,250,0.5)')
    ctx.fillStyle = heroGradient
    rr(x + 40, y + 210, 470, 190, 12)
    ctx.fill()
    ctx.fillStyle = 'rgba(4,8,14,0.35)'
    rr(x + 60, y + 300, 240, 22, 6)
    ctx.fill()
    rr(x + 60, y + 332, 370, 14, 6)
    ctx.fill()
    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.font = '600 22px system-ui, sans-serif'
    ctx.fillText('n.eko', x + 68, y + 262)

    // đồ thị động
    const chartX = x + 540
    const chartY = y + 210
    const chartW = cw - 600
    const chartH = 190
    ctx.fillStyle = 'rgba(255,255,255,0.04)'
    rr(chartX, chartY, chartW, chartH, 12)
    ctx.fill()

    ctx.strokeStyle = COLORS.accent
    ctx.lineWidth = 2.5
    ctx.beginPath()
    for (let i = 0; i <= 60; i += 1) {
      const px = chartX + 14 + (i / 60) * (chartW - 28)
      const value =
        0.5 +
        0.28 * Math.sin(i / 5 + t / 700) +
        0.14 * Math.sin(i / 2.4 + t / 260) +
        0.06 * Math.sin(i / 1.1 + t / 120)
      const py = chartY + chartH - 18 - value * (chartH - 40)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
    ctx.stroke()

    ctx.fillStyle = COLORS.muted
    ctx.font = '13px ui-monospace, monospace'
    ctx.fillText('bitrate · 60 fps mô phỏng', chartX + 14, chartY + 24)

    // "video" đang phát
    const vidY = y + 424
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    rr(x + 40, vidY, cw - 80, 200, 12)
    ctx.fill()

    const bars = 42
    const barW = (cw - 120) / bars
    for (let i = 0; i < bars; i += 1) {
      const amp = Math.abs(Math.sin(i / 3 + t / 220)) * 0.7 + Math.abs(Math.sin(i / 7 + t / 400)) * 0.3
      const barH = 14 + amp * 150
      const hue = 190 + (i / bars) * 90
      ctx.fillStyle = `hsla(${hue}, 85%, 62%, 0.85)`
      rr(x + 60 + i * barW, vidY + 180 - barH, Math.max(3, barW - 6), barH, 3)
      ctx.fill()
    }

    ctx.fillStyle = 'rgba(255,255,255,0.9)'
    ctx.font = '600 15px system-ui, sans-serif'
    ctx.fillText('▶ Đang phát · neko stream', x + 64, vidY + 28)
  }

  function drawTerminal(t) {
    const x = 1320
    const y = 130
    const cw = 520
    const ch = 470
    windowFrame(x, y, cw, ch, 'Terminal — neko@container', COLORS.green)

    ctx.fillStyle = 'rgba(0,0,0,0.62)'
    rr(x + 16, y + 54, cw - 32, ch - 74, 10)
    ctx.fill()

    ctx.font = '14px ui-monospace, monospace'
    const visible = logLines.slice(-18)
    visible.forEach((line, index) => {
      ctx.fillStyle = index === visible.length - 1 ? '#d7ffe9' : '#7ce8b6'
      ctx.fillText(line, x + 32, y + 84 + index * 22)
    })

    // con trỏ nhấp nháy
    if (Math.floor(t / 500) % 2 === 0) {
      ctx.fillStyle = '#7ce8b6'
      ctx.fillRect(x + 32, y + 84 + visible.length * 22 - 12, 9, 16)
    }
  }

  function drawChat() {
    const x = 1320
    const y = 636
    const cw = 520
    const ch = 240

    ctx.fillStyle = 'rgba(15,21,31,0.92)'
    rr(x, y, cw, ch, 14)
    ctx.fill()
    ctx.strokeStyle = COLORS.winBorder
    ctx.lineWidth = 2
    rr(x, y, cw, ch, 14)
    ctx.stroke()

    ctx.fillStyle = COLORS.text
    ctx.font = '600 18px system-ui, sans-serif'
    ctx.fillText('Phòng • 3 người', x + 24, y + 36)

    ctx.font = '14px system-ui, sans-serif'
    messages.slice(-5).forEach((message, index) => {
      const my = y + 70 + index * 32
      ctx.fillStyle = index % 2 === 0 ? 'rgba(75,208,255,0.18)' : 'rgba(167,139,250,0.18)'
      rr(x + 20, my - 20, cw - 40, 26, 8)
      ctx.fill()
      ctx.fillStyle = COLORS.text
      ctx.fillText(message, x + 32, my)
    })
  }

  function drawTaskbar(t) {
    const barH = 62
    const y = H - barH
    ctx.fillStyle = 'rgba(6,10,16,0.86)'
    ctx.fillRect(0, y, W, barH)
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(0, y, W, 1)

    // nút start
    ctx.fillStyle = 'rgba(75,208,255,0.22)'
    rr(24, y + 12, 46, 38, 10)
    ctx.fill()
    ctx.fillStyle = COLORS.accent
    ctx.font = '600 18px system-ui, sans-serif'
    ctx.fillText('n', 42, y + 38)

    // ứng dụng đang mở
    const apps = ['Firefox', 'Terminal', 'Files']
    let ax = 92
    apps.forEach((app, index) => {
      const active = index === 0
      ctx.fillStyle = active ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)'
      rr(ax, y + 12, 150, 38, 10)
      ctx.fill()
      ctx.fillStyle = active ? COLORS.text : COLORS.muted
      ctx.font = '500 15px system-ui, sans-serif'
      ctx.fillText(app, ax + 16, y + 37)
      ax += 162
    })

    // số liệu "máy ảo"
    const cpu = running ? 38 + Math.round(Math.sin(t / 900) * 9) : 0
    const encoder = running ? 62 + Math.round(Math.sin(t / 700) * 12) : 0
    ctx.font = '13px ui-monospace, monospace'
    ctx.fillStyle = running ? COLORS.green : COLORS.faint ?? '#5c6b7e'
    ctx.fillText(`CPU ${cpu}%`, W - 460, y + 36)
    ctx.fillStyle = running ? COLORS.amber : '#5c6b7e'
    ctx.fillText(`ENC ${encoder}%`, W - 350, y + 36)
    ctx.fillStyle = running ? COLORS.accent : '#5c6b7e'
    ctx.fillText(running ? `FPS ${frames ? fps : 0}` : 'FPS 0', W - 240, y + 36)

    const clock = new Date().toLocaleTimeString('vi-VN', { hour12: false })
    ctx.fillStyle = COLORS.text
    ctx.font = '500 16px ui-monospace, monospace'
    ctx.fillText(clock, W - 110, y + 38)
  }

  function drawCursor() {
    if (mouse.x < 0) return
    const x = (mouse.x / w) * W
    const y = (mouse.y / h) * H

    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.6)'
    ctx.shadowBlur = 8
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + 16, y + 15)
    ctx.lineTo(x + 8, y + 16)
    ctx.lineTo(x + 13, y + 26)
    ctx.lineTo(x + 9, y + 28)
    ctx.lineTo(x + 4, y + 18)
    ctx.lineTo(x, y + 23)
    ctx.closePath()
    ctx.fill()
    ctx.restore()

    ripples.forEach((ripple) => {
      const age = (performance.now() - ripple.at) / 700
      if (age > 1) return
      ctx.strokeStyle = `rgba(75, 208, 255, ${1 - age})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(ripple.x, ripple.y, 6 + age * 42, 0, Math.PI * 2)
      ctx.stroke()
    })
  }

  function drawPausedStamp() {
    const label = { soft: 'BẬC MỀM (CLIENT)', hard: 'BẬC NEKO · PRIVATE MODE', deep: 'BẬC SÂU · DOCKER PAUSE' }[pausedLevel] ?? 'PAUSED'
    ctx.save()
    ctx.fillStyle = 'rgba(4,6,10,0.35)'
    ctx.fillRect(0, 0, W, H)

    ctx.fillStyle = 'rgba(255,182,56,0.10)'
    ctx.fillRect(0, H / 2 - 110, W, 220)
    ctx.strokeStyle = 'rgba(255,182,56,0.55)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(0, H / 2 - 110)
    ctx.lineTo(W, H / 2 - 110)
    ctx.moveTo(0, H / 2 + 110)
    ctx.lineTo(W, H / 2 + 110)
    ctx.stroke()

    ctx.fillStyle = '#ffb638'
    ctx.font = '700 54px ui-monospace, monospace'
    ctx.textAlign = 'center'
    ctx.fillText('MÁY ẢO ĐÃ TẠM DỪNG', W / 2, H / 2 - 20)
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    ctx.font = '22px ui-monospace, monospace'
    ctx.fillText(`${label} · khung hình đóng băng · 0 fps`, W / 2, H / 2 + 30)
    ctx.fillText('di chuyển chuột trở lại khung để tiếp tục', W / 2, H / 2 + 70)
    ctx.textAlign = 'left'
    ctx.restore()
  }

  // ------------------------------------------------------------------- loop
  function draw(t) {
    const dt = Math.max(1, t - lastFrameAt)
    lastFrameAt = t
    elapsed += dt
    frames += 1

    const sinceFps = t - lastFpsAt
    if (sinceFps > 500) {
      fps = Math.round((frames * 1000) / sinceFps)
      frames = 0
      lastFpsAt = t
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const scale = Math.min(w / W, h / H)
    const offsetX = (w - W * scale) / 2
    const offsetY = (h - H * scale) / 2
    ctx.translate(offsetX, offsetY)
    ctx.scale(scale, scale)

    drawWallpaper(t)
    drawBrowser(t)
    drawTerminal(t)
    drawChat()
    drawTaskbar(t)
    drawCursor()

    if (!running) drawPausedStamp()

    // log cuộn
    if (logLines.length === 0) {
      logLines.push('neko@container:~$ ./neko --capture.video.codec=vp8')
      logLines.push('neko: capture pipeline started (ximagesrc -> vp8enc)')
    }
    if (running && logLines.length < 200) {
      const idx = logLines.length
      const sample = [
        'gst: pushing buffer 1920x1080 · vp8enc',
        'webrtc: keyframe requested by peer',
        'session: viewer heartbeat ok',
        'desktop: cursor moved (xdotool)',
        'capture: bitrate estimate updated',
        'neko: settings synced with controller',
      ]
      if (idx % 3 === 0) logLines.push(`[${new Date().toLocaleTimeString('vi-VN', { hour12: false })}] ${sample[idx % sample.length]}`)
    }

    if (messages.length === 0) messages.push('Neko: khung máy ảo đã sẵn sàng')
    if (running && messages.length < 40 && Math.random() < 0.004) {
      const samples = ['Neko: đang tải trang…', 'Neko: đã đồng bộ clipboard', 'Bạn: mở tab mới', 'API: private_mode', 'Neko: nhận sự kiện bàn phím']
      messages.push(samples[Math.floor(Math.random() * samples.length)])
    }

    if (running) bytes += (fps || 30) * 12 * 1024 * (dt / 1000)
    onStats?.({
      fps: running ? fps : 0,
      resolution: `${W}×${H}`,
      latencyMs: running ? 3 + Math.random() * 6 : null,
      bytes,
      bitrate: running ? 2.4 + Math.random() * 0.8 : 0,
      running,
    })

    if (running) raf = requestAnimationFrame(draw)
  }

  function drawFrozen() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    const scale = Math.min(w / W, h / H)
    ctx.translate((w - W * scale) / 2, (h - H * scale) / 2)
    ctx.scale(scale, scale)
    drawWallpaper(elapsed)
    drawBrowser(elapsed)
    drawTerminal(elapsed)
    drawChat()
    drawTaskbar(elapsed)
    drawCursor()
    drawPausedStamp()
  }

  function start() {
    if (raf) cancelAnimationFrame(raf)
    running = true
    lastFrameAt = performance.now()
    lastFpsAt = performance.now()
    raf = requestAnimationFrame(draw)
  }

  function stop() {
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = null
    drawFrozen()
    onStats?.({ fps: 0, resolution: `${W}×${H}`, latencyMs: null, bytes, bitrate: 0, running: false })
  }

  // sự kiện chuột (do app.js chuyển vào từ lớp input)
  const handlers = {
    move(event) {
      const rect = canvas.getBoundingClientRect()
      mouse.x = event.clientX - rect.left
      mouse.y = event.clientY - rect.top
      mouse.inside = true
    },
    down() {
      if (mouse.x >= 0) ripples.push({ x: (mouse.x / w) * W, y: (mouse.y / h) * H, at: performance.now() })
      if (ripples.length > 12) ripples.shift()
    },
    leave() {
      mouse.inside = false
      mouse.x = -1
    },
  }

  start()
  onLog?.('khung xem demo đã sẵn sàng')

  function attachInput(inputEl) {
    inputEl.dataset.active = 'true'
    inputEl.addEventListener('pointermove', handlers.move)
    inputEl.addEventListener('pointerdown', (event) => {
      handlers.move(event)
      handlers.down(event)
    })
    inputEl.addEventListener('pointerleave', handlers.leave)
    inputEl.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault()
        handlers.down(event)
      },
      { passive: false },
    )
  }

  return {
    name: 'demo',
    virtual: true,
    handlers,
    attachInput,
    setPaused(next, level = 'soft') {
      pausedLevel = level
      paused = next
      if (next) stop()
      else start()
    },
    getStatus() {
      return {
        connected: true,
        message: paused ? 'máy ảo mô phỏng · đang tạm dừng' : 'máy ảo mô phỏng · đang chạy',
        fps: running ? fps : 0,
        resolution: `${W}×${H}`,
        bytes,
        running,
      }
    },
    destroy() {
      running = false
      paused = true
      if (raf) cancelAnimationFrame(raf)
      observer.disconnect()
      canvas.remove()
    },
  }
}

export const demoBytesLabel = fmtBytes
