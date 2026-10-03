/**
 * Kiểm tra tĩnh phần giao diện (không cần trình duyệt):
 *  - mọi selector $() trong JS phải tồn tại trong HTML
 *  - tab nào cũng phải có panel tương ứng
 *  - các module import trong JS phải tồn tại thật
 *  - escapeSetCookie của proxy hoạt động đúng
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { rewriteSetCookie } from '../src/proxy.js'

const root = path.resolve(import.meta.dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('index.html: mọi id mà app.js dùng đều tồn tại', () => {
  const html = read('public/index.html')
  const js = read('public/js/app.js')

  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]))
  const usedIds = new Set([...js.matchAll(/\$\('#([a-zA-Z0-9_-]+)'\)/g)].map((match) => match[1]))

  const missing = [...usedIds].filter((id) => !htmlIds.has(id))
  assert.deepEqual(missing, [], `các id bị thiếu trong index.html: ${missing.join(', ')}`)
})

test('index.html: tab và panel khớp nhau', () => {
  const html = read('public/index.html')
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1])
  const panels = [...html.matchAll(/data-panel="([^"]+)"/g)].map((match) => match[1])

  assert.ok(tabs.length >= 4)
  for (const tab of tabs) assert.ok(panels.includes(tab), `thiếu panel cho tab "${tab}"`)
  for (const panel of panels) assert.ok(tabs.includes(panel), `thiếu tab cho panel "${panel}"`)
})

test('các module trong public/js tồn tại và import đúng', () => {
  const dir = path.join(root, 'public/js')
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.js'))
  assert.ok(files.length >= 6, 'phải có đủ các module giao diện')

  for (const file of files) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8')
    for (const match of source.matchAll(/from '\.\/([^']+)'/g)) {
      const target = path.join(dir, match[1])
      assert.ok(fs.existsSync(target), `${file} import thiếu: ${match[1]}`)
    }
  }
})

test('index.html nạp đúng css/js và có các phần tử chính', () => {
  const html = read('public/index.html')
  assert.match(html, /href="\/css\/app\.css"/)
  assert.match(html, /src="\/js\/app\.js"/)
  assert.ok(fs.existsSync(path.join(root, 'public/css/app.css')))
  assert.match(html, /id="paused-overlay"/)
  assert.match(html, /id="viewer-root"/)
  assert.match(html, /id="screen-input"/)
})

test('Docker Compose dùng Neko thật và giao diện gốc là viewer mặc định', () => {
  const compose = read('docker-compose.yml')
  assert.match(compose, /image:\s*ghcr\.io\/m1k1o\/neko\/firefox:latest/)
  assert.match(compose, /MODE:\s*live/)
  assert.match(compose, /VIEWER:\s*\$\{VIEWER:-embed\}/)
  assert.match(compose, /NEKO_LEGACY:\s*'true'/)
  assert.match(compose, /NEKO_URL:\s*http:\/\/neko:8080/)
})

test('Render deploys the app as a self-contained Node demo, not a Compose stack', () => {
  const render = read('render.yaml')
  const packageJson = JSON.parse(read('package.json'))

  assert.match(render, /runtime:\s*node/)
  assert.match(render, /buildCommand:\s*npm ci --omit=dev/)
  assert.match(render, /startCommand:\s*npm run start:app/)
  assert.match(render, /healthCheckPath:\s*\/healthz/)
  assert.match(render, /key:\s*MODE\s*\n\s*value:\s*demo/)
  assert.match(render, /key:\s*VIEWER\s*\n\s*value:\s*demo/)
  assert.equal(packageJson.scripts.start, 'node src/index.js')
  assert.equal(packageJson.scripts['start:stack'], 'docker compose up --build')
})

test('giao diện mặc định không hiện nhãn demo trước khi nạp cấu hình', () => {
  const html = read('public/index.html')
  assert.match(html, /data-mode="live" data-viewer="embed"/)
  assert.match(html, /id="badge-mode"[^>]*>LIVE</)
  assert.match(html, /id="badge-viewer"[^>]*>NEKO</)
})

test('login.html gửi đúng API đăng nhập', () => {
  const html = read('public/login.html')
  assert.match(html, /fetch\('\/api\/login'/)
  assert.match(html, /X-Wayground/)
})

test('rewriteSetCookie bỏ Domain và ép Path=/', () => {
  const result = rewriteSetCookie('NEKO_SESSION=abc; Path=/api; Domain=neko.local; HttpOnly; Secure')
  assert.ok(!/domain=/i.test(result), 'phải bỏ Domain')
  assert.match(result, /Path=\//)
  assert.match(result, /HttpOnly/)
})

test('app.css có các lớp trạng thái quan trọng', () => {
  const css = read('public/css/app.css')
  for (const selector of ['.screen[data-state=', '.screen__paused', '.paused-card', '.ladder', '.log__row', '.switch']) {
    assert.ok(css.includes(selector), `thiếu selector ${selector}`)
  }
})
