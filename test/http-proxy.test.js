import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import test, { after, before } from 'node:test'
import { createHttpProxy } from '../src/proxy.js'

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

let upstreamServer
let gatewayServer
let upstreamBase
let gatewayBase
const requests = []

before(async () => {
  upstreamServer = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url })
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`${req.method} ${req.url}`)
  })
  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve))
  upstreamBase = `http://127.0.0.1:${upstreamServer.address().port}`

  const app = express()
  app.use('/neko-ui', createHttpProxy({ logger: silentLogger, targetBase: upstreamBase }))
  app.use('/neko-api', createHttpProxy({ logger: silentLogger, targetBase: `${upstreamBase}/api` }))
  gatewayServer = http.createServer(app)
  await new Promise((resolve) => gatewayServer.listen(0, '127.0.0.1', resolve))
  gatewayBase = `http://127.0.0.1:${gatewayServer.address().port}`
})

after(async () => {
  await new Promise((resolve) => gatewayServer?.close(resolve))
  await new Promise((resolve) => upstreamServer?.close(resolve))
})

test('HTTP proxy giữ nguyên đường dẫn gốc khi Express mount /neko-ui', async () => {
  requests.length = 0
  const response = await fetch(`${gatewayBase}/neko-ui/js/app.js?v=1`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'GET /js/app.js?v=1')
  assert.deepEqual(requests.at(-1), { method: 'GET', url: '/js/app.js?v=1' })
})

test('HTTP proxy đưa API neko vào /api và vẫn giữ subpath/query', async () => {
  const response = await fetch(`${gatewayBase}/neko-api/room/settings/?private=true`)
  assert.equal(response.status, 200)
  assert.equal(await response.text(), 'GET /api/room/settings/?private=true')
})
