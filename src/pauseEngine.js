/**
 * pauseEngine.js - TRÁI TIM của ứng dụng: máy trạng thái pause/resume.
 *
 * Ý tưởng: mọi nguyên nhân muốn pause được gom vào `#reasons` (Set các "lý do").
 *   - paused  <=>  có ít nhất 1 lý do
 *   - running <=>  không còn lý do nào
 * Nhờ vậy nhiều nguồn (chuột rời khung, bấm nút, gọi API, idle, debug) không
 * đè lên nhau, và việc resume chỉ xảy ra khi TẤT CẢ đã hết lý do.
 *
 * Bậc thang tiết kiệm tài nguyên (escalation ladder):
 *   soft : client tạm dừng video element + tắt track (tức thời, 0ms)
 *   hard : neko `private_mode = true` -> neko đóng subscription track, không
 *          encode/gửi frame nữa (mặc định sau 3s)
 *   deep : `docker pause <container>` -> đóng băng cả máy ảo (sau 60s)
 *
 * An toàn:
 *   - `maxFreezeMs`  : tự bỏ đóng băng Docker để WebRTC/DTLS không chết.
 *   - `leaseMs`      : tự resume nếu client không còn gửi nhịp tim.
 *   - orphanGraceMs  : tự resume khi tất cả client ngắt kết nối (đóng tab).
 *   - `maxPauseMs`   : tự resume sau thời gian pause tối đa.
 *   - shutdown()     : luôn resume khi node.js tắt.
 */
import { EventEmitter } from 'node:events'

export const LEVELS = ['running', 'soft', 'hard', 'deep']

export const LEVEL_INFO = {
  running: { index: 0, label: 'Đang chạy', short: 'RUNNING' },
  soft: { index: 1, label: 'Tạm dừng mềm (client)', short: 'SOFT' },
  hard: { index: 2, label: 'Tạm dừng phía neko (private mode)', short: 'HARD' },
  deep: { index: 3, label: 'Đóng băng máy ảo (docker pause)', short: 'DEEP' },
}

const DEFAULT_ORPHAN_GRACE_MS = 5000
const TICK_MS = 1000

const now = () => Date.now()

export class PauseEngine extends EventEmitter {
  /**
   * @param {{config: any, neko: any, docker: any, logger: any}} deps
   */
  constructor({ config, neko, docker, logger }) {
    super()
    this.config = config
    this.neko = neko
    this.docker = docker
    this.logger = logger

    this.orphanGraceMs = Number(process.env.PAUSE_ORPHAN_GRACE_MS ?? DEFAULT_ORPHAN_GRACE_MS)

    this.level = 'running'
    this.reasons = new Map() // kind -> { at, detail }
    this.pending = new Map() // kind -> { timer, at, delayMs, detail }
    this.timers = { hard: null, docker: null, freezeExpiry: null, maxPause: null, orphan: null }
    this.clients = new Map()
    this.deadlines = { hardAt: null, dockerAt: null, freezeExpiresAt: null, maxPauseAt: null }

    this.lastInputAt = now()
    this.noClientsSince = null

    this.stats = {
      pauses: 0,
      resumes: 0,
      totalPausedMs: 0,
      levelDurations: { soft: 0, hard: 0, deep: 0 },
      levelCounts: { soft: 0, hard: 0, deep: 0 },
      lastPause: null,
      lastResume: null,
      lastAction: null,
      failures: [],
      actions: [],
    }

    this.enteredAt = null
    this.levelSince = null
    this.pausedByClient = false
    this.nekoReported = { privateMode: null, checkedAt: null, reachable: null, error: null }
    this.freezeExpired = false
    this.tick = null
    this._shuttingDown = false
  }

  // -------------------------------------------------------------------------
  // Vòng đời
  // -------------------------------------------------------------------------
  start() {
    if (this.tick) return
    this.tick = setInterval(() => this.#tick().catch(() => {}), TICK_MS)
    this.tick.unref?.()
    this.logger.info('pause engine: đã khởi động')
    this.#syncNekoState().catch(() => {})
    this.#emit()
  }

  async shutdown() {
    this._shuttingDown = true
    if (this.tick) clearInterval(this.tick)
    this.tick = null

    if (this.level !== 'running') {
      this.logger.info('pause engine: tắt server -> tự động resume để không bỏ quên máy ảo')
      await this.#exitPause('server-shutdown', { force: true }).catch(() => {})
    }
  }

  // -------------------------------------------------------------------------
  // Client (trình duyệt) đăng ký theo dõi
  // -------------------------------------------------------------------------
  touchClient(clientId, meta = {}) {
    if (!clientId) return null
    let client = this.clients.get(clientId)
    if (!client) {
      client = {
        id: clientId,
        pointer: 'unknown',
        auto: true,
        connectedAt: now(),
        lastSeen: now(),
        lastHeartbeat: now(),
        lastInputAt: now(),
        inputCount: 0,
        heartbeatCount: 0,
        ua: meta.ua ?? null,
        meta: {},
      }
      this.clients.set(clientId, client)
      this.logger.debug('client kết nối', { clientId: clientId.slice(0, 12), ua: truncate(client.ua, 60) })

      if (this.timers.orphan) {
        clearTimeout(this.timers.orphan)
        this.timers.orphan = null
        this.noClientsSince = null
        this.logger.debug('client quay lại -> huỷ tự-resume do hết client')
      }

      // client mới có thể khai báo luôn trạng thái con trỏ
      if (meta.pointer === 'in' || meta.pointer === 'out') {
        client.pointer = meta.pointer
        this.#recomputePointerReason()
      } else {
        this.#emit()
      }
    }

    client.lastSeen = now()
    return client
  }

  heartbeat(clientId, meta = {}) {
    const client = this.touchClient(clientId, meta)
    if (!client) return null
    client.lastHeartbeat = now()
    client.heartbeatCount += 1
    if (typeof meta.auto === 'boolean') client.auto = meta.auto
    if (typeof meta.pausedByClient === 'boolean') this.pausedByClient = meta.pausedByClient

    let recompute = false
    if (meta.pointer === 'in' || meta.pointer === 'out') {
      if (client.pointer !== meta.pointer) {
        client.pointer = meta.pointer
        recompute = true
      }
    }
    if (typeof meta.hidden === 'boolean' && client.hidden !== meta.hidden) {
      client.hidden = meta.hidden
      recompute = true
    }

    if (meta.input) this.noteInput(clientId)
    if (recompute) this.#recomputePointerReason()
    return client
  }

  noteInput(clientId) {
    const client = this.touchClient(clientId)
    this.lastInputAt = now()
    if (client) {
      client.lastInputAt = this.lastInputAt
      client.inputCount += 1
    }
    if (this.reasons.has('idle')) {
      this.logger.debug('có thao tác -> huỷ lý do idle')
      this.clearReason('idle')
    }
  }

  dropClient(clientId) {
    const client = this.clients.get(clientId)
    if (!client) return
    this.clients.delete(clientId)
    this.logger.debug('client ngắt kết nối', { clientId: clientId.slice(0, 12) })

    // còn client khác thì tính lại; hết client thì giữ nguyên và chờ ân hạn
    if (this.clients.size > 0) this.#recomputePointerReason()

    if (this.clients.size === 0) {
      this.noClientsSince = now()
      if (this.level !== 'running') {
        const delay = Math.max(1000, this.orphanGraceMs)
        if (this.timers.orphan) clearTimeout(this.timers.orphan)
        this.timers.orphan = setTimeout(() => {
          this.timers.orphan = null
          if (this.clients.size === 0 && this.level !== 'running' && !this._shuttingDown) {
            this.logger.info('không còn client nào -> tự resume')
            this.resume('no-clients', { force: true })
          }
        }, delay)
        this.timers.orphan.unref?.()
      }
    }
    this.#emit()
  }

  /** Báo cáo vị trí chuột của 1 client: 'in' (trong khung) | 'out' (ngoài khung). */
  setClientPointer(clientId, pointer) {
    if (!['in', 'out'].includes(pointer)) return
    const client = this.touchClient(clientId)
    if (!client) return
    if (client.pointer === pointer) return
    client.pointer = pointer
    if (pointer === 'in') this.noteInput(clientId)
    this.#recomputePointerReason()
  }

  setClientAuto(clientId, enabled) {
    const client = this.touchClient(clientId)
    if (client) client.auto = Boolean(enabled)
    this.#recomputePointerReason()
  }

  setClientHidden(clientId, hidden) {
    const client = this.touchClient(clientId)
    if (client) client.hidden = Boolean(hidden)
    this.#recomputePointerReason()
  }

  // -------------------------------------------------------------------------
  // Lý do pause
  // -------------------------------------------------------------------------
  /**
   * @param {'manual'|'api'|'debug'} kind
   */
  pause(kind = 'manual', { detail, debounceMs } = {}) {
    if (kind === 'manual' || kind === 'api' || kind === 'debug') {
      this.scheduleReason(kind, debounceMs ?? 0, detail ?? kind)
    }
    this.#evaluate(`pause:${kind}`)
    return this.snapshot()
  }

  resume(kind = 'manual', { detail, force = false } = {}) {
    // 'manual' (người dùng bấm resume) xoá TẤT CẢ lý do
    if (force || kind === 'manual' || kind === 'api') {
      const cleared = [...this.reasons.keys()]
      this.reasons.clear()
      this.#clearPending()
      if (cleared.length) this.logger.debug('resume: đã xoá mọi lý do', { cleared, by: kind })
    } else {
      this.clearReason(kind, detail)
    }

    this.#evaluate(`resume:${kind}`)
    return this.snapshot()
  }

  toggle(source = 'manual') {
    return this.level === 'running' ? this.pause(source) : this.resume(source)
  }

  /** Đặt lý do có trễ (debounce) - huỷ được nếu tình huống đổi chiều. */
  scheduleReason(kind, delayMs, detail) {
    if (this.reasons.has(kind)) return
    if (this.pending.has(kind)) {
      const existing = this.pending.get(kind)
      if (existing.delayMs === delayMs && existing.detail === detail) return
      clearTimeout(existing.timer)
      this.pending.delete(kind)
    }

    if (delayMs <= 0) {
      this.#addReason(kind, detail)
      return
    }

    const timer = setTimeout(() => {
      this.pending.delete(kind)
      this.#addReason(kind, detail)
    }, delayMs)
    timer.unref?.()
    this.pending.set(kind, { timer, at: now() + delayMs, delayMs, detail })
    this.logger.debug(`hẹn pause sau ${delayMs}ms`, { kind, detail })
  }

  clearReason(kind, detail) {
    const pending = this.pending.get(kind)
    if (pending) {
      clearTimeout(pending.timer)
      this.pending.delete(kind)
    }
    if (this.reasons.has(kind)) {
      this.reasons.delete(kind)
      this.logger.debug('đã xoá lý do pause', { kind, detail })
      this.#evaluate(`clear:${kind}`)
    }
  }

  #addReason(kind, detail) {
    if (this.reasons.has(kind)) return
    this.reasons.set(kind, { at: now(), detail: detail ?? kind })
    this.logger.info('lý do pause', { kind, detail: detail ?? kind, totalReasons: this.reasons.size })
    this.#evaluate(`add:${kind}`)
  }

  #clearPending() {
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  // -------------------------------------------------------------------------
  // Tính lý do "chuột rời khung"
  // -------------------------------------------------------------------------
  #recomputePointerReason() {
    const runtime = this.config.runtime
    if (!runtime.autoPause) {
      this.clearReason('pointer', 'autoPause=off')
      return
    }

    const active = [...this.clients.values()].filter((c) => c.auto)
    if (active.length === 0) {
      this.clearReason('pointer', 'không còn client bật auto-pause')
      return
    }

    const allMustLeave = this.config.pause.multiClientAllMustLeave
    const isOut = (c) => c.pointer === 'out' || c.hidden === true
    const shouldPause = allMustLeave ? active.every(isOut) : active.some(isOut)

    if (shouldPause) {
      // Nếu đã pause vì lý do khác thì không cần "chuột rời khung" nữa
      if (this.reasons.has('pointer')) return
      this.scheduleReason(
        'pointer',
        this.config.pause.leaveDebounceMs,
        active.length === 1 ? 'chuột rời khung xem' : `chuột rời khung (${active.length} client)`,
      )
    } else {
      // chuột đã quay lại -> resume ngay (có thể kèm trễ nhỏ chống rung)
      if (this.pending.has('pointer')) this.clearReason('pointer', 'chuột đã quay lại')
      if (this.reasons.has('pointer')) {
        this.logger.info('chuột quay lại khung -> tiếp tục')
        this.clearReason('pointer')
      }
    }
  }

  // -------------------------------------------------------------------------
  // Chuyển trạng thái
  // -------------------------------------------------------------------------
  #evaluate(trigger) {
    const wantPause = this.reasons.size > 0

    if (wantPause && this.level === 'running') {
      this.#enterPause(trigger).catch((error) => this.logger.error('enter pause lỗi', { error: error.message }))
    } else if (!wantPause && this.level !== 'running') {
      this.#exitPause(trigger).catch((error) => this.logger.error('exit pause lỗi', { error: error.message }))
    } else {
      this.#emit()
    }
  }

  async #enterPause(trigger) {
    this.enteredAt = now()
    this.level = 'soft'
    this.levelSince = now()
    this.freezeExpired = false
    this.stats.pauses += 1
    this.stats.levelCounts.soft += 1
    this.stats.lastPause = {
      at: new Date().toISOString(),
      trigger,
      reasons: [...this.reasons.entries()].map(([kind, info]) => ({ kind, detail: info.detail })),
    }

    const reasonDetail = this.stats.lastPause.reasons.map((r) => r.detail).join(', ')
    this.logger.info(`⏸  PAUSE (bậc SOFT) - lý do: ${reasonDetail || trigger}`)
    this.emit('pause', this.snapshot())

    // chiến lược client: chỉ broadcast để trình duyệt tự pause video/track
    this.#recordAction('soft', 'broadcast tới client', true, 'pause video element + tắt track nhận')
    this.#emit()

    this.#scheduleEscalation()
  }

  async #exitPause(trigger) {
    const prev = this.level
    const durationMs = this.enteredAt ? now() - this.enteredAt : 0

    this.#clearTimers()
    this.deadlines = { hardAt: null, dockerAt: null, freezeExpiresAt: null, maxPauseAt: null }

    // 1) bỏ đóng băng Docker trước (nếu có)
    if (prev === 'deep') {
      if (this.timers.orphan) {
        /* noop */
      }
      const result = this.docker.enabled ? await this.docker.unpause() : { skipped: true }
      // container có thể đã bị stop (trường hợp hibernate)
      const state = this.docker.enabled ? await this.docker.inspect() : { ok: false }
      if (state.ok && !state.running) {
        this.logger.warn('docker: container không chạy -> khởi động lại')
        await this.docker.start()
      }
      this.#recordAction('deep', 'docker unpause', result.ok !== false, result.error ?? 'container được giải phóng')
      this.level = 'hard'
    }

    // 2) tắt private mode của neko
    if (prev === 'hard' || prev === 'deep') {
      if (this.config.strategies.server) {
        try {
          await this.neko.setPrivateMode(false, `resume:${trigger}`)
          this.#recordAction('hard', 'private_mode = false', true, 'neko gửi frame trở lại')
        } catch (error) {
          this.#recordFailure('hard', `private_mode = false: ${error.message}`)
          this.#recordAction('hard', 'private_mode = false', false, error.message)
        }
      }
    }

    // 3) bậc soft: báo client chạy lại
    this.level = 'running'
    this.levelSince = now()
    this.stats.resumes += 1
    this.stats.totalPausedMs += durationMs
    this.stats.lastResume = { at: new Date().toISOString(), trigger, durationMs: durationMs, fromLevel: prev }
    this.logger.info(`▶  RESUME (từ ${prev}) sau ${(durationMs / 1000).toFixed(1)}s - nguồn: ${trigger}`)
    this.enteredAt = null

    this.emit('resume', this.snapshot())
    this.#emit()
  }

  #scheduleEscalation() {
    const { hardAfterMs, dockerAfterMs, maxPauseMs } = this.config.pause

    if (this.config.strategies.server && hardAfterMs >= 0) {
      this.deadlines.hardAt = now() + hardAfterMs
      this.timers.hard = setTimeout(() => {
        this.timers.hard = null
        this.#applyHardPause().catch((error) => this.logger.error('hard pause lỗi', { error: error.message }))
      }, hardAfterMs)
      this.timers.hard.unref?.()
    }

    if (maxPauseMs > 0) {
      this.deadlines.maxPauseAt = now() + maxPauseMs
      this.timers.maxPause = setTimeout(() => {
        this.timers.maxPause = null
        if (this.level !== 'running') {
          this.logger.warn(`đã pause quá ${Math.round(maxPauseMs / 1000)}s -> tự resume`)
          this.pause('debug', { detail: 'max-pause-expired' })
          this.resume('max-pause-expired', { force: true })
        }
      }, maxPauseMs)
      this.timers.maxPause.unref?.()
    }

    if (this.config.strategies.docker && dockerAfterMs >= 0 && this.docker.enabled) {
      this.deadlines.dockerAt = now() + dockerAfterMs
      this.timers.docker = setTimeout(() => {
        this.timers.docker = null
        this.#applyFreeze().catch((error) => this.logger.error('docker freeze lỗi', { error: error.message }))
      }, dockerAfterMs)
      this.timers.docker.unref?.()
    }
  }

  async #applyHardPause() {
    if (this.level === 'running' || this.level === 'hard' || this.level === 'deep') return

    // Nhả phím/chuột đang giữ để tránh "kẹt phím" trên máy ảo
    await this.neko.releaseControl('pause')

    try {
      await this.neko.setPrivateMode(true, 'pause-engine')
      this.level = 'hard'
      this.stats.levelCounts.hard += 1
      this.#recordAction('hard', 'private_mode = true', true, 'neko ngừng gửi frame (tiết kiệm CPU encoder)')
    } catch (error) {
      this.#recordFailure('hard', `private_mode = true: ${error.message}`)
      this.#recordAction('hard', 'private_mode = true', false, error.message)
    }

    this.#emit()
  }

  async #applyFreeze() {
    if (this.level === 'running') return
    if (!this.docker.enabled) return

    const detect = await this.docker.detect()
    if (!detect.available) {
      this.#recordFailure('deep', `docker không khả dụng: ${this.docker.lastError}`)
      this.#recordAction('deep', 'docker pause', false, this.docker.lastError ?? 'docker không khả dụng')
      this.#emit()
      return
    }

    const result = await this.docker.pause()
    if (result.ok) {
      this.level = 'deep'
      this.stats.levelCounts.deep += 1
      this.#recordAction('deep', `docker pause ${this.config.neko.container}`, true, 'đóng băng cgroup: CPU ~ 0')
    } else {
      this.#recordFailure('deep', `docker pause: ${result.error ?? result.stderr}`)
      this.#recordAction('deep', 'docker pause', false, result.error ?? result.stderr ?? 'lỗi không xác định')
    }

    const maxFreezeMs = this.config.pause.maxFreezeMs
    if (result.ok && maxFreezeMs > 0) {
      this.deadlines.freezeExpiresAt = now() + maxFreezeMs
      this.timers.freezeExpiry = setTimeout(() => {
        this.timers.freezeExpiry = null
        this.#expireFreeze().catch((error) => this.logger.error('hết hạn freeze lỗi', { error: error.message }))
      }, maxFreezeMs)
      this.timers.freezeExpiry.unref?.()
    }

    this.#emit()
  }

  /** Bỏ đóng băng nhưng vẫn giữ pause (mềm/hard) để WebRTC không chết. */
  async #expireFreeze() {
    if (this.level !== 'deep') return
    this.freezeExpired = true
    this.deadlines.freezeExpiresAt = null

    const result = await this.docker.unpause()
    this.level = 'hard'
    this.#recordAction(
      'deep',
      'docker unpause (hết hạn đóng băng)',
      result.ok !== false,
      `đã đóng băng ${Math.round(this.config.pause.maxFreezeMs / 1000)}s; giữ private_mode để neko không chết DTLS`,
    )
    this.logger.warn('đã bỏ đóng băng Docker để bảo vệ kết nối WebRTC (vẫn đang pause ở bậc hard)')
    this.#emit()
  }

  // -------------------------------------------------------------------------
  // Đồng hồ nhịp (watchdog)
  // -------------------------------------------------------------------------
  async #tick() {
    if (this._shuttingDown) return

    const t = now()

    // 1) idle pause
    const { idleMs, leaseMs } = this.config.pause
    if (idleMs > 0 && this.config.runtime.autoPause && this.clients.size > 0 && this.level === 'running') {
      const activeIn = [...this.clients.values()].filter((c) => c.auto && c.pointer === 'in')
      if (activeIn.length > 0 && t - this.lastInputAt > idleMs && !this.reasons.has('idle')) {
        this.#addReason('idle', `không thao tác trong ${Math.round(idleMs / 1000)}s`)
      }
    } else if (this.reasons.has('idle') && (idleMs === 0 || !this.config.runtime.autoPause)) {
      this.clearReason('idle', 'idle pause bị tắt')
    }

    // 2) lease: client im lặng quá lâu
    if (this.level !== 'running' && leaseMs > 0) {
      const heartbeats = [...this.clients.values()].map((c) => c.lastHeartbeat)
      if (heartbeats.length > 0) {
        const newest = Math.max(...heartbeats)
        if (t - newest > leaseMs) {
          this.logger.warn(`client không phản hồi > ${Math.round(leaseMs / 1000)}s -> tự resume (safety lease)`)
          this.resume('lease-expired', { force: true })
        }
      }
    }

    // 3) dọn client "chết" (không heartbeat trong 3 lần tick mà vẫn mở socket)
    for (const [id, client] of [...this.clients.entries()]) {
      if (t - client.lastHeartbeat > 45000) {
        this.logger.debug('client treo (không heartbeat) -> loại bỏ', { clientId: id.slice(0, 12) })
        this.dropClient(id)
      }
    }

    // 4) đồng bộ trạng thái neko định kỳ (mỗi 30s)
    if (!this.nekoReported.checkedAt || t - this.nekoReported.checkedAt > 30000) {
      await this.#syncNekoState().catch(() => {})
    }
  }

  async #syncNekoState() {
    if (!this.neko.enabled) {
      this.nekoReported = { privateMode: null, checkedAt: now(), reachable: false, error: 'chưa cấu hình NEKO_URL' }
      return
    }

    try {
      const settings = await this.neko.getSettings()
      this.nekoReported = { privateMode: Boolean(settings?.private_mode), checkedAt: now(), reachable: true, error: null }
    } catch (error) {
      this.nekoReported = { privateMode: null, checkedAt: now(), reachable: false, error: error.message }
    }
  }

  // -------------------------------------------------------------------------
  // Cấu hình runtime
  // -------------------------------------------------------------------------
  updateSettings(patch = {}) {
    const numKeys = [
      'leaveDebounceMs',
      'enterDebounceMs',
      'idleMs',
      'hardAfterMs',
      'dockerAfterMs',
      'maxFreezeMs',
      'leaseMs',
      'maxPauseMs',
    ]

    for (const key of numKeys) {
      if (patch[key] === undefined) continue
      const value = Number(patch[key])
      if (Number.isFinite(value) && value >= 0) this.config.pause[key] = Math.round(value)
    }

    if (typeof patch.multiClientAllMustLeave === 'boolean') {
      this.config.pause.multiClientAllMustLeave = patch.multiClientAllMustLeave
    }

    if (patch.strategies && typeof patch.strategies === 'object') {
      for (const key of ['client', 'server', 'docker']) {
        if (typeof patch.strategies[key] === 'boolean') {
          this.config.strategies[key] = patch.strategies[key]
          // Nếu tắt chiến lược đang áp dụng -> hạ bậc tương ứng
          if (!patch.strategies[key] && key === 'server' && (this.level === 'hard' || this.level === 'deep')) {
            this.logger.warn('chiến lược server bị tắt khi đang pause -> hạ xuống bậc mềm')
            this.level = 'soft'
            this.neko.setPrivateMode(false, 'strategy-disabled').catch(() => {})
          }
        }
      }
    }

    if (typeof patch.autoReclaimControl === 'boolean') this.config.autoReclaimControl = patch.autoReclaimControl

    if (typeof patch.autoPause === 'boolean') {
      this.config.runtime.autoPause = patch.autoPause
      if (!patch.autoPause) {
        this.clearReason('pointer', 'autoPause=off')
        this.clearReason('idle', 'autoPause=off')
      } else {
        this.#recomputePointerReason()
      }
    }

    if (patch.leaveScope === 'viewport' || patch.leaveScope === 'document') {
      this.config.runtime.leaveScope = patch.leaveScope
    }

    // đang pause mà đổi mốc thời gian -> lên lịch lại
    if (this.level !== 'running') {
      this.#clearTimers()
      this.#scheduleEscalation()
    }

    this.#emit()
    return this.snapshot()
  }

  #clearTimers() {
    for (const key of ['hard', 'docker', 'freezeExpiry', 'maxPause']) {
      if (this.timers[key]) {
        clearTimeout(this.timers[key])
        this.timers[key] = null
      }
    }
  }

  #recordAction(level, action, ok, detail) {
    const entry = { at: new Date().toISOString(), level, action, ok, detail }
    this.stats.lastAction = entry
    this.stats.actions.push(entry)
    if (this.stats.actions.length > 100) this.stats.actions.shift()
    this.emit('action', entry)
  }

  #recordFailure(level, message) {
    this.stats.failures.push({ at: new Date().toISOString(), level, message })
    if (this.stats.failures.length > 50) this.stats.failures.shift()
    this.logger.error(`chiến lược ${level} thất bại: ${message}`)
  }

  // -------------------------------------------------------------------------
  // Snapshot cho UI / API
  // -------------------------------------------------------------------------
  #levelDurations() {
    const durations = { ...this.stats.levelDurations }
    if (this.level !== 'running' && this.levelSince) {
      durations[this.level] = (durations[this.level] ?? 0) + (now() - this.levelSince)
    }
    return durations
  }

  #warnings() {
    const warnings = []

    if (this.config.strategies.docker) {
      if (!this.docker.enabled) {
        warnings.push('Chiến lược Docker đang bật nhưng chưa cấu hình NEKO_CONTAINER -> sẽ bị bỏ qua.')
      } else if (this.docker.available === false) {
        warnings.push(`Không gọi được docker (${this.docker.lastError ?? 'không rõ lý do'}).`)
      } else if (this.docker.available === null) {
        warnings.push('Chưa kiểm tra được docker (chạy `docker version` để kiểm chứng).')
      }
    }

    if (this.neko.enabled && this.nekoReported.reachable === false) {
      warnings.push(`Không kết nối được neko: ${this.nekoReported.error}`)
    }

    if (this.config.strategies.server && this.neko.sessions?.viewer?.isAdmin) {
      warnings.push(
        'Session của khung xem có quyền admin -> neko sẽ KHÔNG pause session này bằng private_mode. ' +
          'Hãy dùng tài khoản người dùng thường (NEKO_USERNAME/NEKO_PASSWORD).',
      )
    }

    if (this.nekoReported.privateMode === true && this.level === 'running') {
      warnings.push('neko đang bật private_mode (có thể do thao tác khác) trong khi bảng điều khiển cho là đang chạy.')
    }

    return warnings
  }

  snapshot() {
    const t = now()
    return {
      paused: this.level !== 'running',
      level: this.level,
      levelLabel: LEVEL_INFO[this.level]?.label ?? this.level,
      levelIndex: LEVEL_INFO[this.level]?.index ?? 0,
      since: this.enteredAt ? new Date(this.enteredAt).toISOString() : null,
      pausedForMs: this.enteredAt ? t - this.enteredAt : 0,
      reasons: [...this.reasons.entries()].map(([kind, info]) => ({ kind, at: info.at, detail: info.detail })),
      pending: [...this.pending.entries()].map(([kind, info]) => ({ kind, at: info.at, delayMs: info.delayMs })),
      deadlines: {
        hardInMs: this.deadlines.hardAt ? Math.max(0, this.deadlines.hardAt - t) : null,
        dockerInMs: this.deadlines.dockerAt ? Math.max(0, this.deadlines.dockerAt - t) : null,
        freezeExpiresInMs: this.deadlines.freezeExpiresAt ? Math.max(0, this.deadlines.freezeExpiresAt - t) : null,
        maxPauseInMs: this.deadlines.maxPauseAt ? Math.max(0, this.deadlines.maxPauseAt - t) : null,
      },
      freezeExpired: this.freezeExpired,
      clients: [...this.clients.values()].map((c) => ({
        id: c.id,
        pointer: c.pointer,
        auto: c.auto,
        hidden: Boolean(c.hidden),
        connectedForMs: t - c.connectedAt,
        lastHeartbeatAgoMs: t - c.lastHeartbeat,
        lastInputAgoMs: t - c.lastInputAt,
        inputCount: c.inputCount,
      })),
      settings: {
        ...this.config.pause,
        autoPause: this.config.runtime.autoPause,
        leaveScope: this.config.runtime.leaveScope,
        strategies: { ...this.config.strategies },
        autoReclaimControl: this.config.autoReclaimControl,
      },
      stats: {
        ...this.stats,
        levelDurations: this.#levelDurations(),
        currentLevelSince: this.levelSince ? new Date(this.levelSince).toISOString() : null,
      },
      neko: { ...this.neko.snapshot(), reported: this.nekoReported },
      docker: this.docker.snapshot(),
      warnings: this.#warnings(),
      serverTime: new Date().toISOString(),
    }
  }

  #emit() {
    this.emit('change', this.snapshot())
  }
}

function truncate (value, max) {
  if (!value) return null
  const str = String(value)
  return str.length > max ? `${str.slice(0, max - 1)}…` : str
}

export default PauseEngine
