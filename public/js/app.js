/**
 * app.js - Bộ não giao diện: nối khung xem, cảm biến chuột và node.js.
 *
 * Luồng chính:
 *  1. Tải cấu hình + trạng thái ban đầu (/api/config).
 *  2. Dựng khung xem theo VIEWER (demo | webrtc | embed | novnc).
 *  3. Mở WebSocket /ws/control để hai chiều với PauseEngine.
 *  4. Cảm biến chuột gửi "in/out" của khung xem lên server (server quyết định).
 */
import { $, $$, api, clamp, fmtBytes, fmtClock, fmtDuration, fmtTime, levelLabel, store, toast } from './util.js'
import { createPauseSensor } from './pause-sensor.js'
import { createDemoViewer } from './viewer-demo.js'
import { createNekoViewer } from './viewer-neko.js'
import { createEmbedViewer } from './viewer-embed.js'

const els = {
  body: document.body,
  badgeMode: $('#badge-mode'),
  badgeViewer: $('#badge-viewer'),
  badgeConn: $('#badge-conn'),
  connText: $('#conn-text'),
  statePill: $('#state-pill'),
  stateText: $('#state-text'),
  stateTimer: $('#state-timer'),
  btnAuto: $('#btn-auto'),
  autoValue: $('#auto-value'),
  btnHelp: $('#btn-tab-help'),
  helpModal: $('#help-modal'),
  helpClose: $('#help-close'),
  stageSub: $('#stage-sub'),
  hudRes: $('#hud-res'),
  hudFps: $('#hud-fps'),
  hudLatency: $('#hud-latency'),
  hudControl: $('#hud-control'),
  hudBytes: $('#hud-bytes'),
  frame: $('#screen-frame'),
  viewerRoot: $('#viewer-root'),
  screenInput: $('#screen-input'),
  overlay: $('#paused-overlay'),
  pausedTitle: $('#paused-title'),
  pausedReason: $('#paused-reason'),
  pausedLevel: $('#paused-level'),
  pausedNext: $('#paused-next'),
  pausedRing: $('#paused-ring'),
  notice: $('#screen-notice'),
  noticeTitle: $('#notice-title'),
  noticeText: $('#notice-text'),
  noticeRetry: $('#notice-retry'),
  btnPause: $('#btn-pause'),
  btnResume: $('#btn-resume'),
  inpDebounce: $('#inp-debounce'),
  outDebounce: $('#out-debounce'),
  tabs: $('#tabs'),
  ladder: $('#ladder'),
  badgeHard: $('#badge-hard'),
  badgeDeep: $('#badge-deep'),
  reasons: $('#reasons'),
  btnSimOut: $('#btn-sim-out'),
  btnSimIn: $('#btn-sim-in'),
  clients: $('#clients'),
  clientsCount: $('#clients-count'),
  warnCard: $('#warn-card'),
  warns: $('#warns'),
  log: $('#log'),
  logAutoscroll: $('#log-autoscroll'),
  btnLogClear: $('#btn-log-clear'),
  metrics: $('#metrics'),
  bars: $('#bars'),
  actions: $('#actions'),
  nekoInfo: $('#neko-info'),
  nekoCallsCard: $('#neko-calls-card'),
  nekoCalls: $('#neko-calls'),
  curlHint: $('#curl-hint'),
  settings: $('#settings'),
  btnSettingsReset: $('#btn-settings-reset'),
  settingsNote: $('#settings-note'),
  strategyToggles: $('#strategy-toggles'),
  statusLeft: $('#status-left'),
  statusUptime: $('#status-uptime'),
  statusWs: $('#status-ws'),
  statusClock: $('#status-clock'),
}

const app = {
  config: null,
  state: null,
  ws: null,
  wsRetry: 0,
  wsTimer: null,
  clientId: globalThis.crypto?.randomUUID?.() ?? `c${Date.now().toString(36)}`,
  auto: store('auto', true) !== false,
  viewer: null,
  sensor: null,
  paused: false,
  level: 'running',
  connectedViewer: null,
  logCount: 0,
  actions: [],
  lastSettings: null,
  settingsTimer: null,
  uptimeMs: 0,
  startedAt: Date.now(),
}

// ===========================================================================
// 1) Khởi động
// ===========================================================================
init().catch((error) => {
  toast(`Không khởi động được giao diện: ${error.message}`)
  console.error(error)
})

async function init() {
  app.config = await fetch('/api/config', { headers: { accept: 'application/json' } }).then((response) => response.json())
  app.state = app.config.state
  app.lastSettings = app.state.settings

  els.badgeMode.textContent = app.config.mode === 'demo' ? 'DEMO' : 'LIVE'
  els.badgeMode.title = app.config.mode === 'demo' ? 'Chạy không cần neko (neko giả lập nội bộ)' : 'Kết nối neko thật'
  els.badgeViewer.textContent = app.config.viewer.toUpperCase()

  syncAutoUi()
  renderSettings(app.state.settings)
  renderState(app.state)
  renderCurlHint()
  bindUi()
  startClocks()

  await mountViewer(app.config.viewer)
  setupSensor()
  connectControl()
  refreshExtras()
  setInterval(refreshExtras, 2500)
  setInterval(updateCountdowns, 250)
}

// ===========================================================================
// 2) Khung xem
// ===========================================================================
async function mountViewer(mode) {
  const common = {
    onLog: (message) => addLog({ level: 'info', message, t: new Date().toISOString(), local: true }),
    onStatus: (status) => renderViewerStatus(status),
    onStats: (stats) => renderViewerStats(stats),
    autoReclaimControl: app.config?.autoReclaimControl !== false,
  }

  try {
    if (mode === 'demo') {
      app.viewer = createDemoViewer(els.viewerRoot, common)
    } else if (mode === 'webrtc') {
      app.viewer = createNekoViewer(els.viewerRoot, common)
    } else {
      // embed / novnc: xin URL nhúng từ server rồi dựng iframe
      let url = app.config.novnc?.url ?? '/neko-ui/'
      try {
        const ticket = await api('/api/viewer/ticket', { method: 'GET' })
        if (ticket.embedUrl) url = ticket.embedUrl
      } catch (error) {
        addLog({ level: 'warn', message: `không lấy được URL nhúng: ${error.message}`, t: new Date().toISOString() })
      }
      app.viewer = createEmbedViewer(els.viewerRoot, { ...common, url, kind: mode })
    }
  } catch (error) {
    showNotice('Không dựng được khung xem', error.message, true)
    return
  }

  app.viewer.attachInput?.(els.screenInput)

  if (app.viewer.start) {
    app.viewer.start().catch((error) => {
      showNotice('Không kết nối được neko', error.message, true)
    })
  } else {
    hideNotice()
  }

  renderViewerStatus(app.viewer.getStatus?.() ?? { connected: true, message: `${mode} · sẵn sàng` })

  els.noticeRetry.onclick = () => {
    hideNotice()
    app.viewer.start?.().catch((error) => showNotice('Vẫn không kết nối được', error.message, true))
  }
}

function renderViewerStatus(status) {
  app.viewerStatus = status
  const hudControl = els.hudControl
  hudControl.textContent = status.isHost ? 'host · điều khiển' : status.connected ? 'xem' : 'chưa nối'
  hudControl.classList.toggle('hud--on', Boolean(status.isHost))
  els.connText.textContent = status.message ?? '—'

  const alive = status.connected && !status.connecting
  els.badgeConn.classList.toggle('badge--ok', alive)
  els.badgeConn.classList.toggle('badge--warn', Boolean(status.connecting))
  els.badgeConn.classList.toggle('badge--bad', !alive && !status.connecting)

  if (app.config?.mode === 'live' && app.config?.viewer === 'webrtc') {
    if (status.connected) hideNotice()
    else if (status.connecting) showNotice('Đang kết nối tới neko…', 'Node.js đang proxy phiên WebRTC (signal → ICE → data channel).', false)
    else if (!status.connected && status.message) showNotice('Chưa kết nối được neko', status.message, true)
  }

  if (typeof status.bytes === 'number') els.hudBytes.textContent = fmtBytes(status.bytes)
}

function renderViewerStats(stats) {
  if (stats.resolution) els.hudRes.textContent = stats.resolution
  els.hudFps.textContent = stats.fps ? `${stats.fps} fps` : '0 fps'
  els.hudLatency.textContent = stats.latencyMs ? `${Math.round(stats.latencyMs)} ms` : '—'
  if (typeof stats.bytes === 'number') els.hudBytes.textContent = fmtBytes(stats.bytes)
}

function showNotice(title, text, retry) {
  els.noticeTitle.textContent = title
  els.noticeText.textContent = text ?? ''
  els.noticeRetry.hidden = !retry
  els.notice.hidden = false
}

function hideNotice() {
  els.notice.hidden = true
}

// ===========================================================================
// 3) Cảm biến chuột -> gửi lên server
// ===========================================================================
function setupSensor() {
  app.sensor = createPauseSensor({
    element: els.frame,
    onChange: (pointer, meta) => {
      sendControl({ type: 'pointer', state: pointer, detail: meta?.reason })
      addLog({
        level: 'info',
        t: new Date().toISOString(),
        message: pointer === 'out' ? `chuột rời khung (${meta?.reason ?? 'pointerleave'}) → gửi yêu cầu pause` : `chuột vào khung (${meta?.reason ?? 'pointerenter'}) → gửi yêu cầu resume`,
        meta: { local: true },
      })
      els.frame.dataset.pointer = pointer
    },
    onInput: () => {
      const now = Date.now()
      if (now - (app.lastInputSent ?? 0) < 1000) return
      app.lastInputSent = now
      sendControl({ type: 'input' })
    },
    onHiddenChange: (hidden) => {
      sendControl({ type: 'heartbeat', auto: app.auto, hidden })
    },
  })
}

// ===========================================================================
// 4) Kênh điều khiển với node.js
// ===========================================================================
function connectControl() {
  clearTimeout(app.wsTimer)
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws/control?client=${app.clientId}&auto=${app.auto ? 1 : 0}`)
  app.ws = ws
  els.statusWs.textContent = 'ws: đang kết nối…'

  ws.onopen = () => {
    app.wsRetry = 0
    els.statusWs.textContent = 'ws: đã kết nối'
    sendControl({ type: 'heartbeat', auto: app.auto, hidden: document.hidden })
    // gửi lại trạng thái chuột hiện tại để server biết
    if (app.sensor) sendControl({ type: 'pointer', state: app.sensor.state })
  }

  ws.onmessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    handleControlMessage(message)
  }

  ws.onclose = () => {
    els.statusWs.textContent = 'ws: mất kết nối, thử lại…'
    app.wsRetry += 1
    const delay = Math.min(8000, 800 * app.wsRetry)
    app.wsTimer = setTimeout(connectControl, delay)
  }

  ws.onerror = () => {
    els.statusWs.textContent = 'ws: lỗi'
  }
}

function handleControlMessage(message) {
  switch (message.type) {
    case 'hello': {
      if (message.config) app.config = { ...app.config, ...message.config }
      els.statusLeft.textContent = `đã nối node.js · client ${message.clientId.slice(0, 8)}`
      addLog({ level: 'info', t: new Date().toISOString(), message: 'đã kết nối kênh điều khiển với node.js' })
      for (const entry of message.log ?? []) addLog(entry, { silent: true })
      renderState(message.state)
      break
    }

    case 'state':
      renderState(message.state)
      break

    case 'tick': {
      const state = app.state ?? {}
      app.state = {
        ...state,
        pausedForMs: message.pausedForMs,
        deadlines: message.deadlines,
        warnings: message.warnings ?? state.warnings,
        paused: message.paused,
        level: message.level,
        neko: { ...(state.neko ?? {}), reported: { ...(state.neko?.reported ?? {}), ...message.neko } },
        docker: { ...(state.docker ?? {}), available: message.docker?.available, container: message.docker?.container },
      }
      updateCountdowns()
      renderWarnings(message.warnings ?? [])
      break
    }

    case 'log':
      addLog(message.entry)
      break

    case 'action':
      app.actions.unshift(message.entry)
      app.actions = app.actions.slice(0, 20)
      renderActions()
      break

    case 'config':
      app.lastSettings = message.config
      renderSettings(message.config)
      break

    case 'pong':
      break

    case 'error':
      toast(message.message)
      break

    default:
      break
  }
}

function sendControl(payload) {
  if (app.ws?.readyState === WebSocket.OPEN) app.ws.send(JSON.stringify(payload))
}

// ===========================================================================
// 5) Hiển thị trạng thái
// ===========================================================================
function renderState(state) {
  if (!state) return
  const previous = app.state
  app.state = state
  app.paused = state.paused
  app.level = state.level

  const uiState = state.paused ? state.level : 'running'
  els.body.dataset.state = uiState
  els.frame.dataset.state = uiState
  els.frame.dataset.pending = String(Boolean(state.pending?.length) && !state.paused)

  els.statePill.dataset.state = uiState
  els.stateText.textContent = state.paused ? `ĐÃ TẠM DỪNG · ${shortLevel(state.level)}` : 'ĐANG CHẠY'
  els.stateTimer.textContent = state.paused ? fmtDuration(state.pausedForMs) : ''

  els.btnPause.disabled = state.paused
  els.btnResume.disabled = !state.paused

  // lớp phủ pause
  els.overlay.hidden = !state.paused
  if (state.paused) {
    els.pausedTitle.textContent = state.level === 'deep' ? 'MÁY ẢO ĐANG ĐÓNG BĂNG' : 'ĐÃ TẠM DỪNG'
    els.pausedReason.textContent = (state.reasons ?? []).map((reason) => reason.detail ?? reason.kind).join(' · ') || 'theo yêu cầu'
    els.pausedLevel.textContent = levelLabel(state.level)
  }

  renderLadder(state)
  renderReasons(state)
  renderClients(state)
  renderWarnings(state.warnings ?? [])
  renderMetrics(state)
  renderNekoInfo(state)
  renderActions()

  if (app.sensor && state.paused !== previous?.paused) {
    app.sensor.reset()
  }

  const pausedChanged = previous?.paused !== state.paused || previous?.level !== state.level
  if (pausedChanged && app.viewer) app.viewer.setPaused?.(state.paused, state.level)

  const settingsKey = JSON.stringify(state.settings)
  if (app.settingsKey !== settingsKey) {
    app.settingsKey = settingsKey
    const editing = document.activeElement && els.settings.contains(document.activeElement)
    if (!editing) renderSettings(state.settings)
  }

  updateCountdowns()
}

function shortLevel(level) {
  return { soft: 'BẬC MỀM', hard: 'BẬC NEKO', deep: 'BẬC SÂU' }[level] ?? level.toUpperCase()
}

function renderLadder(state) {
  const order = ['soft', 'hard', 'deep']
  const index = order.indexOf(state.level)
  const paused = state.paused
  const pendingHard = Boolean(state.pending?.some((entry) => entry.kind === 'pointer')) && !paused

  $$('#ladder li').forEach((item) => {
    const level = item.dataset.level
    const levelIndex = order.indexOf(level)
    item.classList.toggle('is-active', paused && state.level === level)
    item.classList.toggle('is-done', paused && index > levelIndex)
    item.classList.toggle('is-waiting', paused && index < levelIndex)
    item.classList.toggle('is-pending', pendingHard && level === 'soft')
    const when = item.querySelector('[data-when]')
    if (when) {
      const settings = state.settings
      if (level === 'soft') when.textContent = paused && state.level === 'soft' ? 'đang áp dụng' : pendingHard ? 'sẽ pause sau debounce' : 'chạy ngay khi pause'
      if (level === 'hard') when.textContent = settings.strategies?.server ? (paused && index >= 1 ? 'đã áp dụng' : `sau ${fmtDuration(settings.hardAfterMs)}`) : 'đang tắt'
      if (level === 'deep') when.textContent = settings.strategies?.docker ? (state.docker?.enabled ? (state.level === 'deep' ? 'đang đóng băng' : `sau ${fmtDuration(settings.dockerAfterMs)}`) : 'chưa cấu hình NEKO_CONTAINER') : 'đang tắt'
    }
  })

  const settings = state.settings
  els.badgeHard.textContent = settings.strategies?.server ? `${Math.round(settings.hardAfterMs / 1000)}s` : 'tắt'
  els.badgeDeep.textContent = settings.strategies?.docker ? `${Math.round(settings.dockerAfterMs / 1000)}s` : 'tắt'
}

function renderReasons(state) {
  const reasons = state.reasons ?? []
  const pending = state.pending ?? []

  if (!reasons.length && !pending.length) {
    els.reasons.innerHTML = '<li class="muted">không có — máy ảo đang chạy</li>'
  } else {
    els.reasons.replaceChildren(
      ...reasons.map((reason) => {
        const li = document.createElement('li')
        li.innerHTML = `<i></i><span>${escapeHtml(reason.detail ?? reason.kind)}</span><code>${fmtTime(new Date(reason.at).toISOString())}</code>`
        return li
      }),
      ...pending.map((entry) => {
        const li = document.createElement('li')
        li.style.opacity = '0.7'
        li.innerHTML = `<i style="background:var(--faint)"></i><span>đang chờ: ${escapeHtml(entry.kind)} sau ${fmtDuration(Math.max(0, entry.at - Date.now()))}</span><code>pending</code>`
        return li
      }),
    )
  }
}

function renderClients(state) {
  const clients = state.clients ?? []
  els.clientsCount.textContent = String(clients.length)
  if (!clients.length) {
    els.clients.innerHTML = '<li class="muted">chưa có client</li>'
    return
  }

  els.clients.replaceChildren(
    ...clients.map((client) => {
      const li = document.createElement('li')
      li.dataset.pointer = client.pointer
      const pointer = client.pointer === 'in' ? 'trong khung' : client.pointer === 'out' ? 'ngoài khung' : 'chưa rõ'
      li.innerHTML = `<i></i><span>${client.id.slice(0, 8)} · ${pointer}${client.auto ? '' : ' · tắt auto'}</span><code>${fmtDuration(client.connectedForMs)}</code>`
      return li
    }),
  )
}

function renderWarnings(warnings) {
  els.warnCard.hidden = !warnings?.length
  els.warns.replaceChildren(
    ...(warnings ?? []).map((warning) => {
      const li = document.createElement('li')
      li.textContent = warning
      return li
    }),
  )
}

function renderMetrics(state) {
  const stats = state.stats ?? {}
  const durations = stats.levelDurations ?? {}
  const items = [
    { label: 'đang ở bậc', value: app.paused ? shortLevel(state.level) : 'chạy', small: state.levelLabel },
    { label: 'số lần pause', value: String(stats.pauses ?? 0), small: `${stats.resumes ?? 0} lần resume` },
    { label: 'tổng thời gian pause', value: fmtDuration(stats.totalPausedMs ?? 0), small: 'cộng dồn' },
    { label: 'lần pause hiện tại', value: app.paused ? fmtDuration(state.pausedForMs) : '—', small: state.since ? `từ ${fmtTime(state.since)}` : '' },
    { label: 'client đang xem', value: String(state.clients?.length ?? 0), small: 'tab đang mở' },
    { label: 'neko requests', value: String(state.neko?.requests ?? 0), small: `${state.neko?.errors ?? 0} lỗi` },
  ]

  els.metrics.replaceChildren(
    ...items.map((item) => {
      const div = document.createElement('div')
      div.className = 'metric'
      div.innerHTML = `<small>${item.label}</small><b>${escapeHtml(item.value)}</b><small>${escapeHtml(item.small ?? '')}</small>`
      return div
    }),
  )

  const max = Math.max(1, ...Object.values(durations))
  els.bars.replaceChildren(
    ...['soft', 'hard', 'deep'].map((level) => {
      const value = durations[level] ?? 0
      const bar = document.createElement('div')
      bar.className = 'bar'
      bar.dataset.level = level
      bar.innerHTML = `<span>${level}</span><span class="bar__track"><span class="bar__fill" style="width:${clamp((value / max) * 100, 0, 100)}%"></span></span><span class="bar__value">${fmtDuration(value)}</span>`
      return bar
    }),
  )
}

function renderActions() {
  const actions = app.actions.length ? app.actions : app.state?.stats?.actions?.slice().reverse() ?? []
  if (!actions.length) {
    els.actions.innerHTML = '<li class="muted">chưa có hành động</li>'
    return
  }

  els.actions.replaceChildren(
    ...actions.slice(0, 12).map((action) => {
      const li = document.createElement('li')
      li.innerHTML = `<span>${action.ok === false ? '❌' : '✅'} [${escapeHtml(action.level)}] ${escapeHtml(action.action)}</span><code>${escapeHtml(action.detail ?? '')} · ${fmtTime(action.at)}</code>`
      return li
    }),
  )
}

function renderNekoInfo(state) {
  const neko = state.neko ?? {}
  const docker = state.docker ?? {}
  const rows = [
    ['chế độ', app.config?.mode === 'demo' ? 'DEMO (neko giả lập nội bộ)' : 'LIVE (neko thật)'],
    ['địa chỉ neko', neko.baseUrl ?? (app.config?.neko?.baseUrlConfigured ? 'đã cấu hình' : 'chưa cấu hình')],
    ['kết nối neko', neko.reported?.reachable === true ? 'thông' : neko.reported?.reachable === false ? `lỗi: ${neko.reported?.error ?? 'không rõ'}` : 'chưa kiểm tra'],
    ['private_mode', neko.reported?.privateMode === null || neko.reported?.privateMode === undefined ? '—' : String(neko.reported.privateMode)],
    ['admin session', neko.sessions?.admin ? `${neko.sessions.admin.id}${neko.sessions.admin.isAdmin ? ' (admin)' : ''}` : '—'],
    ['viewer session', neko.sessions?.viewer ? `${neko.sessions.viewer.id}${neko.sessions.viewer.isAdmin ? ' (admin!)' : ''}` : '—'],
    ['container', docker.container ?? 'chưa đặt'],
    ['docker', docker.available === true ? `sẵn sàng (${docker.version})` : docker.available === false ? 'không dùng được' : 'chưa kiểm tra'],
    ['docker actions', Object.entries(docker.actions ?? {}).map(([key, value]) => `${key}=${value}`).join(' ') || '—'],
  ]

  els.nekoInfo.replaceChildren(
    ...rows.flatMap(([key, value]) => {
      const dt = document.createElement('dt')
      dt.textContent = key
      const dd = document.createElement('dd')
      dd.textContent = String(value)
      return [dt, dd]
    }),
  )
}

async function refreshExtras() {
  try {
    const data = await fetch('/api/state', { headers: { accept: 'application/json' } }).then((response) => response.json())
    app.uptimeMs = data.uptimeMs
    els.statusUptime.textContent = `uptime ${fmtDuration(data.uptimeMs)}`

    if (data.state && !app.state) renderState(data.state)
    if (app.state) {
      app.state.stats = data.state.stats
      app.state.neko = data.state.neko
      renderMetrics(app.state)
      renderNekoInfo(app.state)
    }

    if (data.demo) {
      els.nekoCallsCard.hidden = false
      renderCalls(data.demo.calls ?? [], data.demo.privateModeChanges ?? [])
    } else {
      els.nekoCallsCard.hidden = true
    }
  } catch {
    /* ignore */
  }
}

function renderCalls(calls, changes) {
  const items = []

  for (const change of changes.slice(-3)) {
    items.push(
      `<li><span style="color:var(--amber)">private_mode → ${change.enabled} (${fmtTime(change.at)})</span><code>neko: ${change.via}</code></li>`,
    )
  }

  for (const call of calls.slice(-8).reverse()) {
    const body = call.body ? ` ${JSON.stringify(call.body)}` : ''
    items.push(`<li><span>${call.method} ${call.path}${escapeHtml(body)}</span><code>${fmtTime(call.at)} · ${call.authorization ?? 'không auth'}</code></li>`)
  }

  els.nekoCalls.innerHTML = items.join('') || '<li class="muted">chưa có lời gọi nào</li>'
}

// ===========================================================================
// 6) Đồng hồ / đếm ngược
// ===========================================================================
function startClocks() {
  setInterval(() => {
    els.statusClock.textContent = new Date().toLocaleTimeString('vi-VN', { hour12: false })
    if (app.state?.paused) {
      app.state.pausedForMs += 250
      els.stateTimer.textContent = fmtDuration(app.state.pausedForMs)
    }
  }, 250)
}

function updateCountdowns() {
  const state = app.state
  if (!state) return

  if (!state.paused) {
    els.pausedRing.style.strokeDashoffset = '119.4'
    return
  }

  const settings = state.settings ?? {}
  const deadlines = state.deadlines ?? {}
  const parts = []

  const next = []
  if (state.level === 'soft' && settings.strategies?.server && deadlines.hardInMs !== null) {
    next.push({ text: `→ neko private_mode sau ${fmtDuration(deadlines.hardInMs)}`, total: settings.hardAfterMs, left: deadlines.hardInMs })
  }
  if ((state.level === 'soft' || state.level === 'hard') && settings.strategies?.docker && deadlines.dockerInMs !== null) {
    next.push({ text: `→ docker pause sau ${fmtDuration(deadlines.dockerInMs)}`, total: settings.dockerAfterMs, left: deadlines.dockerInMs })
  }
  if (state.level === 'deep' && deadlines.freezeExpiresInMs !== null) {
    next.push({ text: `→ bỏ đóng băng sau ${fmtDuration(deadlines.freezeExpiresInMs)}`, total: settings.maxFreezeMs, left: deadlines.freezeExpiresInMs })
  }
  if (deadlines.maxPauseInMs !== null && settings.maxPauseMs) {
    parts.push(`tự resume sau ${fmtClock(deadlines.maxPauseInMs)}`)
  }

  const upcoming = next[0]
  els.pausedNext.textContent = upcoming ? upcoming.text : parts[0] ?? 'đang giữ trạng thái tạm dừng'
  if (upcoming && upcoming.total > 0) {
    const progress = clamp(1 - upcoming.left / upcoming.total, 0, 1)
    els.pausedRing.style.strokeDashoffset = String(119.4 * (1 - progress))
  } else {
    els.pausedRing.style.strokeDashoffset = '119.4'
  }

  if (parts.length && upcoming) els.pausedNext.textContent = `${upcoming.text} · ${parts[0]}`
}

// ===========================================================================
// 7) Nhật ký
// ===========================================================================
function addLog(entry, { silent = false } = {}) {
  if (!entry) return
  const row = document.createElement('div')
  row.className = 'log__row'
  row.dataset.level = entry.level ?? 'info'
  const meta = entry.meta && Object.keys(entry.meta).length ? ` ${escapeHtml(JSON.stringify(entry.meta))}` : ''
  row.innerHTML = `<span class="log__t">${fmtTime(entry.t ?? new Date().toISOString())}</span><span class="log__lvl">${(entry.level ?? 'info').slice(0, 4).toUpperCase()}</span><span class="log__msg">${escapeHtml(entry.message ?? '')}<span class="log__meta">${meta}</span></span>`

  if (entry.level === 'error') row.style.background = 'rgba(255,107,107,0.07)'

  els.log.append(row)
  app.logCount += 1
  if (app.logCount > 500) {
    els.log.firstElementChild?.remove()
    app.logCount -= 1
  }

  if (els.logAutoscroll.checked) els.log.scrollTop = els.log.scrollHeight
  if (!silent && entry.level !== 'debug') {
    // các sự kiện quan trọng hiện ở thanh dưới
    els.statusLeft.textContent = entry.message
  }
}

// ===========================================================================
// 8) Cài đặt
// ===========================================================================
const SETTINGS_FIELDS = [
  { key: 'leaveDebounceMs', label: 'Trễ khi chuột rời khung', hint: 'chống pause do chạm mép khung (ms)', step: 50, min: 0, max: 3000 },
  { key: 'enterDebounceMs', label: 'Trễ khi chuột quay lại', hint: 'thường để rất nhỏ (ms)', step: 10, min: 0, max: 2000 },
  { key: 'hardAfterMs', label: 'Nâng lên bậc neko sau', hint: 'gọi private_mode (ms)', step: 500, min: 0, max: 120000 },
  { key: 'dockerAfterMs', label: 'Đóng băng docker sau', hint: 'docker pause container neko (ms)', step: 1000, min: 0, max: 900000 },
  { key: 'maxFreezeMs', label: 'Giới hạn đóng băng', hint: 'tự bỏ đóng băng để WebRTC không chết (ms)', step: 5000, min: 0, max: 900000 },
  { key: 'leaseMs', label: 'Hết hạn nhịp tim', hint: 'tự resume nếu client im lặng (ms)', step: 10000, min: 0, max: 3600000 },
  { key: 'maxPauseMs', label: 'Pause tối đa', hint: 'tự resume sau khoảng này (ms, 0 = tắt)', step: 30000, min: 0, max: 7200000 },
  { key: 'idleMs', label: 'Tự pause khi không thao tác', hint: '0 = tắt (ms)', step: 1000, min: 0, max: 600000 },
]

function renderSettings(settings) {
  if (!settings) return
  const scrollTop = els.settings.scrollTop

  els.settings.replaceChildren(
    ...SETTINGS_FIELDS.map((field) => {
      const wrapper = document.createElement('div')
      wrapper.className = 'setting'
      const input = document.createElement('input')
      input.type = 'number'
      input.min = String(field.min)
      input.max = String(field.max)
      input.step = String(field.step)
      input.value = String(settings[field.key] ?? 0)
      input.addEventListener('change', () => applySettings({ [field.key]: Number(input.value) }))
      wrapper.innerHTML = `<div class="setting__label"><b>${field.label}</b><small>${field.hint}</small></div>`
      wrapper.append(input)
      return wrapper
    }),
  )

  // nút gạt
  const toggles = [
    { key: 'autoPause', label: 'Tự động pause khi rời khung', hint: 'tắt khi muốn điều khiển thủ công', scope: 'root' },
    { key: 'multiClientAllMustLeave', label: 'Chờ TẤT CẢ client rời khung', hint: 'tắt = chỉ cần 1 client rời là pause', scope: 'root' },
    { key: 'autoReclaimControl', label: 'Tự lấy lại quyền điều khiển khi resume', hint: 'gửi control/request sau khi tiếp tục', scope: 'root' },
  ]

  const container = els.strategyToggles
  const strategyToggles = [
    { key: 'client', label: 'Bậc mềm (client)', hint: 'dừng video + tắt track trong trình duyệt' },
    { key: 'server', label: 'Bậc neko (private_mode)', hint: 'neko ngừng encode/gửi frame' },
    { key: 'docker', label: 'Bậc sâu (docker pause)', hint: 'đóng băng container neko' },
  ]

  container.replaceChildren(
    ...strategyToggles.map((item) => {
      const row = document.createElement('div')
      row.className = 'toggle'
      const switchEl = document.createElement('button')
      switchEl.className = 'switch'
      switchEl.type = 'button'
      switchEl.setAttribute('role', 'switch')
      switchEl.setAttribute('aria-checked', String(Boolean(settings.strategies?.[item.key])))
      switchEl.addEventListener('click', () => {
        const next = switchEl.getAttribute('aria-checked') !== 'true'
        switchEl.setAttribute('aria-checked', String(next))
        applySettings({ strategies: { [item.key]: next } })
      })
      row.innerHTML = `<div class="toggle__label"><b>${item.label}</b><small>${item.hint}</small></div>`
      row.append(switchEl)
      return row
    }),
  )

  // các toggle chung đặt trong tab Cài đặt (thêm bên dưới phần thời gian)
  const extra = document.createElement('div')
  extra.className = 'toggles'
  extra.style.marginTop = '10px'
  extra.replaceChildren(
    ...toggles.map((item) => {
      const row = document.createElement('div')
      row.className = 'toggle'
      const switchEl = document.createElement('button')
      switchEl.className = 'switch'
      switchEl.type = 'button'
      switchEl.setAttribute('role', 'switch')
      switchEl.setAttribute('aria-checked', String(Boolean(settings[item.key])))
      switchEl.addEventListener('click', () => {
        const next = switchEl.getAttribute('aria-checked') !== 'true'
        switchEl.setAttribute('aria-checked', String(next))
        if (item.key === 'autoPause') {
          app.auto = next
          store('auto', next)
          syncAutoUi()
        }
        applySettings({ [item.key]: next })
      })
      row.innerHTML = `<div class="toggle__label"><b>${item.label}</b><small>${item.hint}</small></div>`
      row.append(switchEl)
      return row
    }),
  )
  els.settings.append(extra)

  els.inpDebounce.value = String(settings.leaveDebounceMs ?? 600)
  els.outDebounce.textContent = `${settings.leaveDebounceMs ?? 600}ms`
  els.settingsNote.textContent = `đang áp dụng · ${new Date().toLocaleTimeString('vi-VN', { hour12: false })}`
  els.settings.scrollTop = scrollTop
}

function applySettings(patch) {
  clearTimeout(app.settingsTimer)
  app.lastPatch = { ...(app.lastPatch ?? {}), ...patch }
  app.settingsTimer = setTimeout(async () => {
    const payload = app.lastPatch
    app.lastPatch = null
    try {
      const result = await api('/api/settings', { body: payload })
      app.lastSettings = result.settings
      renderSettings(result.settings)
      toast('Đã cập nhật cài đặt')
    } catch (error) {
      toast(`Không lưu được cài đặt: ${error.message}`)
    }
  }, 350)
}

function syncAutoUi() {
  els.btnAuto.dataset.on = String(app.auto)
  els.autoValue.textContent = app.auto ? 'BẬT' : 'TẮT'
}

// ===========================================================================
// 9) Sự kiện giao diện
// ===========================================================================
function bindUi() {
  els.btnPause.addEventListener('click', () => control('pause'))
  els.btnResume.addEventListener('click', () => control('resume'))

  els.btnAuto.addEventListener('click', async () => {
    app.auto = !app.auto
    store('auto', app.auto)
    syncAutoUi()
    sendControl({ type: 'auto', enabled: app.auto })
    try {
      await api('/api/auto', { body: { enabled: app.auto } })
    } catch {
      /* ignore */
    }
    toast(app.auto ? 'Đã bật auto-pause' : 'Đã tắt auto-pause')
  })

  els.inpDebounce.addEventListener('input', () => {
    els.outDebounce.textContent = `${els.inpDebounce.value}ms`
  })
  els.inpDebounce.addEventListener('change', () => {
    applySettings({ leaveDebounceMs: Number(els.inpDebounce.value) })
  })

  els.btnSimOut.addEventListener('click', () => {
    sendControl({ type: 'pointer', state: 'out', detail: 'mô phỏng (nút kiểm thử)' })
    toast('Đã mô phỏng: chuột rời khung')
  })

  els.btnSimIn.addEventListener('click', () => {
    sendControl({ type: 'pointer', state: 'in', detail: 'mô phỏng (nút kiểm thử)' })
    toast('Đã mô phỏng: chuột quay lại')
  })

  els.btnLogClear.addEventListener('click', () => {
    els.log.replaceChildren()
    app.logCount = 0
  })

  els.btnSettingsReset.addEventListener('click', async () => {
    try {
      const result = await api('/api/settings', { body: { strategies: { client: true, server: true, docker: false } } })
      renderSettings(result.settings)
      toast('Đã khôi phục chiến lược mặc định')
    } catch (error) {
      toast(error.message)
    }
  })

  els.btnHelp.addEventListener('click', () => els.helpModal.showModal())
  els.helpClose.addEventListener('click', () => els.helpModal.close())

  els.tabs.addEventListener('click', (event) => {
    const button = event.target.closest('.tab')
    if (!button) return
    $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab === button))
    $$('.tabpanel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.panel === button.dataset.tab))
  })

  document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 'p') {
      event.preventDefault()
      control('pause')
    } else if (key === 'r') {
      event.preventDefault()
      control('resume')
    } else if (key === 'a') {
      event.preventDefault()
      els.btnAuto.click()
    }
  })

  window.addEventListener('pagehide', () => {
    if (!app.paused) return
    try {
      navigator.sendBeacon('/api/beacon/resume')
    } catch {
      /* ignore */
    }
  })

  setInterval(() => {
    sendControl({ type: 'heartbeat', auto: app.auto, hidden: document.hidden, applied: app.paused ? 'soft' : 'running' })
  }, 5000)
}

async function control(action) {
  try {
    const result = await api(`/api/${action}`, { body: { detail: 'bảng điều khiển' } })
    renderState(result.state)
  } catch (error) {
    toast(`Không thực hiện được: ${error.message}`)
  }
}

function renderCurlHint() {
  const origin = location.origin
  els.curlHint.textContent = [
    `# tạm dừng / tiếp tục từ bất kỳ script nào`,
    `curl -X POST ${origin}/api/pause  -H 'X-Wayground: 1'`,
    `curl -X POST ${origin}/api/resume -H 'X-Wayground: 1'`,
    ``,
    `# trạng thái`,
    `curl -s ${origin}/api/state | jq .state.level`,
    ``,
    `# dùng trong CI/automation (kèm mật khẩu nếu có APP_PASSWORD)`,
    `curl -X POST ${origin}/api/pause -H 'X-Wayground-Token: $APP_PASSWORD'`,
  ].join('\n')
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
