#!/usr/bin/env node
/**
 * Chạy app ở chế độ mô phỏng một cách tường minh.
 *
 * `npm start` khởi động stack Docker Compose với Neko thật; dùng `npm run demo`
 * khi chỉ muốn thử giao diện mà không có Docker/Neko.
 */
process.env.MODE = 'demo'
process.env.VIEWER = 'demo'

await import('../src/index.js')
