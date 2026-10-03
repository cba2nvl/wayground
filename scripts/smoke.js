#!/usr/bin/env node
/**
 * scripts/smoke.js - Kiểm tra nhanh stack Compose (mặc định localhost:3000).
 *
 *   node scripts/smoke.js                       # kiểm tra http://127.0.0.1:3000
 *   node scripts/smoke.js http://host:3000      # kiểm tra app chạy riêng
 *   APP_PASSWORD=abc node scripts/smoke.js      # kèm mật khẩu bảng điều khiển
 *
 * Kịch bản: health -> state -> pause (chờ leo bậc) -> resume -> in báo cáo.
 */
const base = (process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const password = process.env.APP_PASSWORD ?? ''

const headers = { 'content-type': 'application/json', 'X-Wayground': '1' }
if (password) headers['X-Wayground-Token'] = password

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function call(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return { status: response.status, data }
}

function line(label, value) {
  process.stdout.write(`${label.padEnd(28)} ${value}\n`)
}

async function main() {
  process.stdout.write(`\n=== Wayground smoke test · ${base} ===\n\n`)

  const health = await call('/api/health')
  if (health.status !== 200) throw new Error(`/api/health trả về ${health.status}`)
  line('chế độ', `${health.data.mode} · pause=${health.data.paused} · level=${health.data.level}`)

  const state = await call('/api/state')
  if (state.status !== 200) throw new Error(`/api/state trả về ${state.status}`)
  line('viewer/neko', `neko=${state.data.state.neko.enabled} reachable=${state.data.state.neko.reported.reachable}`)
  line('cấu hình pause', JSON.stringify(state.data.state.settings.strategies))

  process.stdout.write('\n—> POST /api/pause\n')
  const paused = await call('/api/pause', { method: 'POST', body: { reason: 'api', detail: 'smoke test' } })
  if (!paused.data?.ok) throw new Error(`pause thất bại: ${JSON.stringify(paused.data)}`)
  line('trạng thái ngay sau pause', `${paused.data.state.level}`)

  const hardAfter = paused.data.state.settings.hardAfterMs
  await sleep(Math.min(6000, Math.max(500, hardAfter + 400)))

  const after = await call('/api/state')
  line('bậc sau khi chờ', `${after.data.state.level} (đã set private_mode ${after.data.state.neko.privateModeSet} lần)`)
  line('lý do', after.data.state.reasons.map((reason) => reason.kind).join(', ') || '—')
  line('neko: request/lỗi', `${after.data.state.neko.requests} / ${after.data.state.neko.errors}`)

  process.stdout.write('\n—> POST /api/resume\n')
  const resumed = await call('/api/resume', { method: 'POST', body: { detail: 'smoke test' } })
  if (!resumed.data?.ok) throw new Error(`resume thất bại: ${JSON.stringify(resumed.data)}`)
  await sleep(300)
  const final = await call('/api/state')
  line('trạng thái cuối', `paused=${final.data.state.paused} · level=${final.data.state.level}`)
  line('số lần pause', `${final.data.state.stats.pauses}`)
  line('tổng thời gian pause', `${(final.data.state.stats.totalPausedMs / 1000).toFixed(2)}s`)

  const metrics = await fetch(`${base}/metrics`)
  line('/metrics', `${metrics.status} (${metrics.headers.get('content-type')})`)

  if (final.data.state.paused) throw new Error('resume không thành công')
  process.stdout.write('\n✅ Tất cả OK\n\n')
}

main().catch((error) => {
  process.stderr.write(`\n❌ Smoke test thất bại: ${error.message}\n\n`)
  process.exit(1)
})
