/**
 * Bảng mã X11 keysym - neko nhận phím dưới dạng keysym (giống Guacamole).
 * Với ký tự in được ta dùng luôn mã Unicode; các phím đặc biệt tra bảng.
 */
export const KEYSYMS = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  Control: 0xffe3,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  CapsLock: 0xffe5,
  Meta: 0xffeb,
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
  Alt: 0xffe9,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  ContextMenu: 0xff67,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  PrintScreen: 0xff61,
  Pause: 0xff13,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  ' ': 0x20,
  '!': 0x21,
  '"': 0x22,
  '#': 0x23,
  $: 0x24,
  '%': 0x25,
  '&': 0x26,
  "'": 0x27,
  '(': 0x28,
  ')': 0x29,
  '*': 0x2a,
  '+': 0x2b,
  ',': 0x2c,
  '-': 0x2d,
  '.': 0x2e,
  '/': 0x2f,
  ':': 0x3a,
  ';': 0x3b,
  '<': 0x3c,
  '=': 0x3d,
  '>': 0x3e,
  '?': 0x3f,
  '@': 0x40,
  '[': 0x5b,
  '\\': 0x5c,
  ']': 0x5d,
  '^': 0x5e,
  _: 0x5f,
  '`': 0x60,
  '{': 0x7b,
  '|': 0x7c,
  '}': 0x7d,
  '~': 0x7e,
}

/**
 * Đổi KeyboardEvent thành keysym.
 * Trên macOS, neko dùng Mode_switch cho phím Option giống bản gốc:
 *   Super -> Alt_L, Alt -> Mode_switch (xem client/src/components/video.vue)
 */
export function eventToKeysym(event) {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

  if (event.code && KEYSYMS[event.code] !== undefined && event.key.length > 1) return KEYSYMS[event.code]
  if (event.key.length === 1) {
    const codePoint = event.key.codePointAt(0)
    if (codePoint) return codePoint
  }

  let keysym = KEYSYMS[event.code] ?? KEYSYMS[event.key]

  if (isMac) {
    switch (keysym) {
      case 0xffeb: // Super_L
        keysym = 0xffe9 // Alt_L
        break
      case 0xffec: // Super_R
        keysym = 0xffeb // Super_L
        break
      case 0xffe9: // Alt_L
        keysym = 0xff7e // Mode_switch
        break
      case 0xffea: // Alt_R
        keysym = 0xfe03 // ISO_Level3_Shift
        break
    }
  }

  return keysym ?? 0
}

/** Số hiệu nút chuột X11: 1 = trái, 2 = giữa, 3 = phải, 8/9 = lùi/tiến. */
export function mouseButton(event) {
  switch (event.button) {
    case 0:
      return 1
    case 1:
      return 2
    case 2:
      return 3
    case 3:
      return 8
    case 4:
      return 9
    default:
      return 1
  }
}
