/**
 * pause-sensor.js - Phát hiện con trỏ chuột vào/ra khỏi khung xem.
 *
 * Nguyên tắc: gửi trạng thái THÔ ngay lập tức (không debounce ở client) để
 * node.js là nơi duy nhất quyết định (server-side debounce + đa client).
 * Trình duyệt chỉ hiển thị trạng thái "đang chờ pause" dựa trên snapshot.
 */
export function createPauseSensor({ element, onChange, onInput, onHiddenChange }) {
  let state = 'unknown'
  let hidden = Boolean(document.hidden)
  let destroyed = false

  const emit = (next, reason) => {
    if (destroyed || next === state) return
    state = next
    onChange?.(state, { reason })
  }

  const isInside = (event) => {
    const rect = element.getBoundingClientRect()
    return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
  }

  const onPointerEnter = () => emit('in', 'pointerenter')
  const onPointerLeave = () => emit('out', 'pointerleave')

  // rời khỏi cửa sổ trình duyệt (ví dụ kéo chuột sang màn hình khác)
  const onWindowLeave = (event) => {
    if (event.relatedTarget === null) emit('out', 'left-window')
  }

  // lần di chuyển chuột đầu tiên quyết định trạng thái khi chưa rõ
  let lastMove = 0
  const onDocumentMove = (event) => {
    const now = performance.now()
    if (now - lastMove < 120) return
    lastMove = now

    if (state === 'unknown') emit(isInside(event) ? 'in' : 'out', 'first-move')
    else if (state === 'in' && !isInside(event)) emit('out', 'outside-by-coords')
    else if (state === 'out' && isInside(event)) emit('in', 'inside-by-coords')

    onInput?.(event)
  }

  const onKeyDown = (event) => onInput?.(event)
  const onWheel = (event) => onInput?.(event)

  const onVisibility = () => {
    const nextHidden = Boolean(document.hidden)
    if (nextHidden === hidden) return
    hidden = nextHidden
    onHiddenChange?.(hidden)
  }

  element.addEventListener('pointerenter', onPointerEnter)
  element.addEventListener('pointerleave', onPointerLeave)
  document.documentElement.addEventListener('mouseleave', onWindowLeave)
  document.addEventListener('mousemove', onDocumentMove, { passive: true })
  document.addEventListener('keydown', onKeyDown, true)
  element.addEventListener('wheel', onWheel, { passive: true })
  document.addEventListener('visibilitychange', onVisibility)

  return {
    get state() {
      return state
    },
    get hidden() {
      return hidden
    },
    /** Đặt lại về 'unknown' (khi khung xem được dựng lại). */
    reset() {
      state = 'unknown'
    },
    set(next, reason = 'manual') {
      emit(next, reason)
    },
    destroy() {
      destroyed = true
      element.removeEventListener('pointerenter', onPointerEnter)
      element.removeEventListener('pointerleave', onPointerLeave)
      document.documentElement.removeEventListener('mouseleave', onWindowLeave)
      document.removeEventListener('mousemove', onDocumentMove)
      document.removeEventListener('keydown', onKeyDown, true)
      element.removeEventListener('wheel', onWheel)
      document.removeEventListener('visibilitychange', onVisibility)
    },
  }
}
