/**
 * dockerDriver.js - Điều khiển Docker để "đóng băng" container neko.
 *
 * `docker pause` dùng cgroup freezer: toàn bộ tiến trình trong container dừng
 * lại -> CPU gần như 0 tuyệt đối (kể cả pipeline GStreamer đang encode).
 *
 * LƯU Ý QUAN TRỌNG: khi container bị freeze thì neko cũng không gửi được
 * DTLS/RTCP -> WebRTC sẽ chết nếu giữ quá lâu (mặc định khoảng 30-60 giây).
 * Vì vậy PauseEngine luôn có `maxFreezeMs` để tự bỏ đóng băng.
 */
import { spawn } from 'node:child_process'
import { CONTAINER_NAME_RE } from './config.js'

export class DockerDriver {
  constructor(config, logger) {
    this.config = config
    this.logger = logger
    this.bin = config.docker.bin
    this.timeoutMs = config.docker.timeoutMs
    this.available = null
    this.version = null
    this.actions = { pause: 0, unpause: 0, stop: 0, start: 0 }
    this.lastError = null
  }

  get container() {
    return this.config.neko.container
  }

  get enabled() {
    return Boolean(this.container) && CONTAINER_NAME_RE.test(this.container)
  }

  run(args, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(this.bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ ok: false, code: -1, stdout: '', stderr: error.message })
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ ok: false, code: -2, stdout, stderr: `timeout sau ${timeoutMs}ms` })
      }, timeoutMs)

      child.stdout?.on('data', (chunk) => (stdout += chunk.toString()))
      child.stderr?.on('data', (chunk) => (stderr += chunk.toString()))

      child.on('error', (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, code: -1, stdout, stderr: error.message })
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() })
      })
    })
  }

  /** Kiểm tra docker có sẵn sàng không (chỉ gọi 1 lần, sau đó cache). */
  async detect() {
    if (this.available !== null) return { available: this.available, version: this.version }

    const result = await this.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 8000 })
    this.available = result.ok
    this.version = result.ok ? result.stdout : null
    if (!result.ok) {
      this.lastError = result.stderr || 'docker không khả dụng'
      this.logger.debug('docker: không khả dụng', { error: this.lastError })
    } else {
      this.logger.info(`docker: sẵn sàng (server ${this.version})`)
    }

    return { available: this.available, version: this.version }
  }

  async inspect() {
    if (!this.enabled) return { ok: false, error: 'chưa cấu hình NEKO_CONTAINER' }
    const result = await this.run(['inspect', '--format', '{{.State.Status}}|{{.State.Paused}}|{{.State.Running}}', this.container])
    if (!result.ok) return { ok: false, error: result.stderr || `exit ${result.code}` }

    const [status, paused, running] = result.stdout.split('|')
    return { ok: true, status, paused: paused === 'true', running: running === 'true' }
  }

  async #action(action, extraArgs = []) {
    if (!this.enabled) {
      return { ok: false, skipped: true, error: 'chưa cấu hình NEKO_CONTAINER' }
    }

    const result = await this.run([action, ...extraArgs, this.container])
    if (result.ok) {
      this.actions[action] = (this.actions[action] ?? 0) + 1
      this.logger.info(`docker: ${action} ${this.container}`)
    } else {
      this.lastError = result.stderr || `exit ${result.code}`
      this.logger.error(`docker: ${action} ${this.container} thất bại`, { error: this.lastError })
    }
    return result
  }

  pause() {
    return this.#action('pause')
  }

  unpause() {
    return this.#action('unpause')
  }

  stop() {
    return this.#action('stop')
  }

  start() {
    return this.#action('start')
  }

  snapshot() {
    return {
      enabled: this.enabled,
      container: this.container || null,
      bin: this.bin,
      available: this.available,
      version: this.version,
      actions: { ...this.actions },
      lastError: this.lastError,
    }
  }
}

export default DockerDriver
