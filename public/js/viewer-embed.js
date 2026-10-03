/**
 * viewer-embed.js - Nhúng nguyên giao diện neko (hoặc noVNC) bằng iframe.
 *
 * Với kiểu này trình duyệt không thể can thiệp vào <video> bên trong iframe,
 * nên việc "pause" hoàn toàn do node.js thực hiện ở phía neko
 * (private_mode -> neko ngừng gửi frame) và/hoặc docker pause.
 */
export function createEmbedViewer(root, { url, kind = 'embed', onStatus, onLog } = {}) {
  const iframe = document.createElement('iframe')
  iframe.src = url
  iframe.allow = 'autoplay; fullscreen; clipboard-read; clipboard-write; microphone'
  iframe.referrerPolicy = 'same-origin'
  iframe.title = kind === 'novnc' ? 'noVNC' : 'neko'
  root.append(iframe)

  let paused = false

  iframe.addEventListener('load', () => {
    onLog?.('khung xem iframe đã tải xong')
    onStatus?.({ ...getStatus(), connected: true, message: `${kind} · đã nhúng` })
  })

  function getStatus() {
    return {
      connected: true,
      connecting: false,
      message: paused ? `${kind} · đang tạm dừng (phía server)` : `${kind} · đang chạy`,
      fps: null,
      resolution: null,
      latencyMs: null,
      bytes: 0,
      paused,
    }
  }

  return {
    name: kind,
    start() {},
    attachInput(inputEl) {
      // chuột/bàn phím do chính iframe nhận; lớp phủ của ta chỉ để phát hiện vào/ra
      inputEl.dataset.active = 'false'
    },
    setPaused(next) {
      paused = next
      onStatus?.(getStatus())
    },
    getStatus,
    reload() {
      iframe.src = iframe.src
    },
    destroy() {
      iframe.remove()
    },
  }
}
