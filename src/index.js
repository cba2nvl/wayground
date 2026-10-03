/**
 * index.js - Điểm khởi động Wayground Console.
 *
 * Luồng khởi động (config.js tự nạp .env khi được import):
 *   config  ->  (demo? fake neko)  ->  NekoClient/DockerDriver
 *         ->  PauseEngine  ->  HTTP + WS server (proxy neko, control channel)
 */
import http from 'node:http'
import { config, envFileLoaded, publicConfig, resolveViewerMode, validateConfig, httpToWs } from './config.js'
import { logger, setLogLevel } from './log.js'
import { NekoClient } from './nekoClient.js'
import { DockerDriver } from './dockerDriver.js'
import { PauseEngine } from './pauseEngine.js'
import { createFakeNeko } from './fakeNeko.js'
import { attachWebSocketProxies } from './proxy.js'
import { attachControlChannel } from './controlChannel.js'
import { createApp, nekoUiUrl, novncUrl } from './routes.js'

async function main() {
  setLogLevel(config.logLevel)
  const warnings = validateConfig(logger)

  logger.info('Wayground Console đang khởi động', { mode: config.mode, viewer: resolveViewerMode(), node: process.version })
  if (envFileLoaded) logger.debug('đã nạp file .env')

  // -------------------------------------------------------------------------
  // 1) DEMO: dựng neko giả lập ngay trong tiến trình
  // -------------------------------------------------------------------------
  let fakeNeko = null
  if (config.mode === 'demo') {
    fakeNeko = createFakeNeko({
      adminUsername: config.neko.adminUsername,
      adminPassword: config.neko.adminPassword,
      userPassword: config.neko.password || 'neko',
    })
    const baseUrl = await fakeNeko.start(0, '127.0.0.1')
    config.neko.baseUrl = baseUrl
    config.neko.wsUrl = httpToWs(baseUrl)
    logger.info(`chế độ DEMO: đã dựng neko giả lập tại ${baseUrl}`, { container: config.neko.container || null })
  }

  // -------------------------------------------------------------------------
  // 2) Dịch vụ
  // -------------------------------------------------------------------------
  const neko = new NekoClient(config, logger)
  const docker = new DockerDriver(config, logger)
  const engine = new PauseEngine({ config, neko, docker, logger })

  const server = http.createServer()
  const startedAt = Date.now()

  const ctx = {
    config,
    logger,
    engine,
    neko,
    docker,
    proxy: null,
    control: null,
    fakeNeko,
    startedAt,
    adminPath: '/',
  }

  // Proxy gọi lại authorize sau khi app được dựng (trước server.listen).
  // Điều này bảo vệ WebSocket của giao diện Neko nhúng bằng cùng cookie đăng nhập.
  const proxy = attachWebSocketProxies(server, {
    config,
    logger,
    authorize: (req) => ctx.app?.authorize?.(req) ?? { ok: false },
  })
  ctx.proxy = proxy

  // control channel đọc `ctx.app` tại thời điểm có kết nối.
  const control = attachControlChannel(server, ctx)
  ctx.control = control

  const { app, authorize, applySettings } = createApp(ctx)
  ctx.app = {
    authorize,
    applySettings,
    publicConfig,
  }

  server.on('request', app)

  // -------------------------------------------------------------------------
  // 3) Khởi động
  // -------------------------------------------------------------------------
  engine.start()
  if (config.strategies.docker) {
    docker.detect().then(({ available, version }) => {
      if (!available) logger.warn('chiến lược Docker bật nhưng docker không khả dụng', { error: docker.lastError })
      else logger.info(`chiến lược Docker sẵn sàng (server ${version}, container ${config.neko.container || 'chưa đặt'})`)
    })
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })

  const address = server.address()
  const shownHost = config.host === '0.0.0.0' ? 'localhost' : config.host
  const viewer = resolveViewerMode()

  logger.info(`🌐 bảng điều khiển: http://${shownHost}:${address.port}/`)
  logger.info('cơ chế: chuột rời khung -> pause | chuột quay lại -> resume', {
    debounce: `${config.pause.leaveDebounceMs}ms`,
    hard: `${config.pause.hardAfterMs}ms`,
    docker: config.strategies.docker ? `${config.pause.dockerAfterMs}ms` : 'tắt',
  })

  if (config.mode === 'live') {
    const reachable = await neko.health()
    logger[reachable ? 'info' : 'error'](reachable ? `neko: đã kết nối ${config.neko.baseUrl}` : `neko: KHÔNG kết nối được ${config.neko.baseUrl}`)
    if (viewer === 'embed') logger.info(`khung xem neko (iframe): ${nekoUiUrl(config)}`)
    if (viewer === 'novnc') logger.info(`khung xem noVNC: ${novncUrl(config)}`)
  } else {
    logger.info('chế độ DEMO: khung xem là máy ảo mô phỏng, mọi lời gọi API neko đều được ghi lại ở tab "Neko API"')
  }

  warnings.forEach((warning) => logger.warn(`cảnh báo: ${warning}`))

  // -------------------------------------------------------------------------
  // 4) Tắt an toàn: luôn resume trước khi thoát
  // -------------------------------------------------------------------------
  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info(`nhận ${signal} -> đang tắt...`)
    try {
      await engine.shutdown()
      await control.close()
      await proxy.close()
      await new Promise((resolve) => server.close(resolve))
      if (fakeNeko) await fakeNeko.stop()
    } catch (error) {
      logger.error('lỗi khi tắt', { error: error.message })
    }
    logger.info('đã tắt. Tạm biệt!')
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', { error: String(reason) }))
  process.on('uncaughtException', (error) => logger.error('uncaughtException', { error: error.message, stack: error.stack }))
}

main().catch((error) => {
  process.stderr.write(`\n❌ Không khởi động được: ${error.message}\n${error.stack ?? ''}\n\n`)
  process.exit(1)
})
