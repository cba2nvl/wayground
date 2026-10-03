# Tích hợp neko – ghi chú kỹ thuật

Tài liệu này ghi lại **chính xác** những gì app đã dùng ở neko, đối chiếu trực tiếp từ source
[m1k1o/neko](https://github.com/m1k1o/neko) (nhánh `master`, neko v3). Mục đích: khi neko đổi phiên
bản, bạn biết cần kiểm tra chỗ nào; và khi tự viết client khác, bạn không phải mò lại.

Các đường dẫn file bên dưới là đường dẫn trong repository neko.

---

## 1. `private_mode` – cách neko "tạm dừng" thật sự

- `server/internal/session/session.go`
  - `PrivateModeEnabled() = manager.Settings().PrivateMode && !profile.IsAdmin` → **admin không bao giờ
    bị pause**. Vì vậy khung xem phải đăng nhập bằng tài khoản người dùng thường.
  - `LegacyIsHost()` trả `false` khi `private_mode` bật → người dùng thường mất quyền host, chuột/bàn
    phím không tới được máy ảo (đúng nghĩa "pause").
- `server/internal/session/manager.go` – khi settings đổi: `webrtcPeer.SetPaused(enabled)` cho mọi
  session không phải admin.
- `server/internal/webrtc/peer.go:314` – `SetPaused(isPaused)` thực chất là
  `videoTrack.SetPaused(isPaused || videoDisabled)` và `audioTrack.SetPaused(...)`: **track bị tạm
  dừng ở tầng RTP**, kết nối WebRTC vẫn sống → khi resume, hình quay lại ngay, không phải đàm phán lại.
- `server/internal/websocket/handler/signal.go` – khi client gửi `signal/request` mà session đang ở
  `private_mode`, `peer.SetPaused(true)` được áp ngay từ đầu.

**Hệ quả cần nhớ:** `private_mode` là thiết lập **dùng chung cho cả phòng**. Nếu nhiều người cùng xem
một neko, bất kỳ ai rời chuột (theo luật pause) cũng làm cả phòng dừng. App có tuỳ chọn
`MULTI_CLIENT_ALL_MUST_LEAVE=true` để chỉ pause khi tất cả client đều rời khung; muốn mỗi người một
máy ảo riêng thì cần nhiều instance neko (neko-rooms hoặc nhiều container).

---

## 2. REST API đã dùng

| Method | Đường dẫn (đúng như neko) | Quyền | Ghi chú |
| --- | --- | --- | --- |
| `POST` | `/api/login` | – | Body `{username, password}` → `{id, profile, state}`; **có** `token` trong body nếu `session.cookie.enabled=false` (mặc định), chỉ `Set-Cookie: NEKO_SESSION=…` nếu bật cookie |
| `GET` | `/api/room/settings/` | admin | Trả `Settings` (có `private_mode`, `locked_controls`, `implicit_hosting`, …) |
| `POST` | `/api/room/settings/` | admin | Body là **partial JSON** được `json.Unmarshal` đè lên settings hiện tại → `{"private_mode":true}` là đủ |
| `POST` | `/api/room/control/reset` | admin | Nhả phím đang giữ + trả quyền điều khiển (dùng trước khi pause để tránh kẹt phím) |
| `GET` | `/api/room/control/` | có `can_host` | `{has_host, host_id}` |
| `GET` | `/api/sessions` | admin | Danh sách session |
| `GET` | `/health` | – | Chuỗi `true` |
| `GET` | `/api/whoami` | – | Dùng để kiểm tra phiên còn sống |

Xác thực (`server/pkg/auth`, hàm lấy token trong `server/internal/session/manager.go`): neko đọc theo
thứ tự **cookie `NEKO_SESSION`** → header `Authorization: Bearer <token>` → `?token=<token>`.
Vì vậy client trong `src/nekoClient.js` giữ cookie phiên và/hoặc token tuỳ theo cấu hình neko.

> ⚠️ **Cái bẫy hay gặp nhất: dấu `/` cuối đường dẫn.** neko dùng chi router và đăng ký bằng
> `r.Route("/settings", func(r){ r.Post("/") })` (`server/internal/api/room/handler.go`), nên đường
> dẫn thật là `/api/room/settings/`. Gọi `/api/room/settings` → **404** (chi không tự thêm dấu `/`).
> App này đã có test riêng cho việc đó (`test/nekoClient.test.js`).

---

## 3. Giao thức WebSocket mới (`/api/ws`) – dùng cho `VIEWER=webrtc`

1. Mở WS `/api/ws` (kèm token/cookie) → neko gửi `{"event":"system/init", …}`.
2. Client gửi `{"event":"signal/request","video":{},"audio":{}}`
   (`server/internal/websocket/handler/signal.go`). Nếu không chỉ định selector, neko dùng video đầu tiên.
3. neko trả `{"event":"signal/provide","sdp":…,"iceservers":[…],"video":{…},"audio":{…}}` – `sdp` là
   **offer** của neko; client tạo answer và gửi `{"event":"signal/answer","sdp":…}`.
4. Trao đổi ICE: `{"event":"signal/candidate","candidate":{…}}` (cả hai chiều); neko có thể gửi
   `signal/restart` khi cần đàm phán lại.
5. **Kênh dữ liệu (input) do neko tạo** (`server/internal/webrtc/peer.go`, `CreateDataChannel`) →
   client phải lắng nghe `pc.ondatachannel`, không tự tạo.

`system/init` (server → client) có các khoá:
`session_id`, `control_host`, `screen_size`, `sessions`, `settings`, `touch_events`,
`screencast_enabled`, `webrtc.videos` (`server/pkg/types/message/messages.go`).

### Định dạng gói trên datachannel

```
Header (3 byte, BigEndian): [event u8][length u16]
Body (chiều client → server, length = số byte của body):
  0x01 MOVE       u16 x, u16 y                 (4 byte)
  0x02 SCROLL     i16 deltaX, i16 deltaY, u8 controlKey   (5 byte)
                  (neko vẫn nhận bản cũ 4 byte khi length == 4)
  0x03 KEY_DOWN   u32 keysym X11               (4 byte)
  0x04 KEY_UP     u32 keysym
  0x05 BTN_DOWN   u32 button (1 = trái, 2 = giữa, 3 = phải)
  0x06 BTN_UP     u32 button
  0x07 PING       u32 ClientTs1, u32 ClientTs2
  0x08…0x0a TOUCH_BEGIN/UPDATE/END  u32 id, i32 x, i32 y, u8 pressure
Server → client:
  0x01 CURSOR_POSITION  u16 x, u16 y           (length = 7, đã tính cả header)
  0x02 CURSOR_IMAGE     u16 w, u16 h, u16 xhot, u16 yhot + ảnh (length = 11 + len(ảnh))
  0x03 PONG             echo ping + u32 ServerTs1/2 (length = 19)
```

Chi tiết: `server/internal/webrtc/handler.go`, `server/internal/webrtc/payload/*.go`.

Hai điểm tinh tế:

- `length` trong gói **server → client** tính cả 3 byte header (cursor position: 7 = 3 + 4); còn trong
  gói **client → server** thì neko so sánh `header.Length == 4` cho scroll cũ, tức là độ dài **body**.
  App này ghi body-length cho chiều gửi lên và đọc theo `length` cho chiều nhận xuống.
- Mọi opcode (trừ PING/PONG) chỉ có tác dụng khi session **đang là host**; nếu không, neko bỏ qua
  (`handler.go: "continue only if session is host"`). Với `NEKO_SESSION_IMPLICIT_HOSTING=true`, thao
  tác chuột đầu tiên sẽ tự nhận quyền host. Bật `LOCKED_CONTROLS`/`CONTROL_PROTECTION` thì cần admin
  trong phòng – app có thể tự tắt hai cờ đó bằng quyền admin khi khởi động.

Ngoài ra: pipeline capture mặc định của neko v3 có `ShowPointer: true`
(`server/internal/config/capture.go` – khối "no video pipelines specified, using default") nên **con
trỏ của host nằm ngay trong video**. Hai opcode `CURSOR_IMAGE`/`CURSOR_POSITION` phục vụ tính năng
`session.inactive_cursors` (hiện con trỏ của **người xem khác**); app này chỉ có một người xem nên
`public/js/viewer-neko.js` bỏ qua chúng và chỉ dùng `PONG` để đo độ trễ.

---

## 4. Giao thức cũ (`/ws`) – giao diện kèm theo của neko

Giao diện Vue mà neko phục vụ tại `/` **không** nói giao thức mới: `client/src/neko/index.ts` mở
`<pathname>/ws` và gửi `?username=&password=`; neko dịch sang giao thức mới ở
`server/internal/http/legacy/handler.go` (`signal/request` được adapter này gửi hộ).

- `/ws` **chỉ tồn tại khi `legacy` bật**: `server/internal/http/manager.go:158,170` chỉ gọi
  `legacy.New(...).Route(...)` khi `viper.GetBool("legacy")`. Cờ này tự bật khi bạn dùng biến cấu
  hình kiểu v2 (`server/internal/config/*.go: viper.Set("legacy", true)`), hoặc đặt `NEKO_LEGACY=true`.
- `GET/POST/DELETE /file?usr=&pwd=&filename=` cũng thuộc handler legacy (tải/up file).
- Vì vậy `VIEWER=embed` **yêu cầu neko chạy ở chế độ legacy**. WebSocket `/neko-ui/ws` của app được
  nối tiếp tới `/ws` với tài khoản thật ở server, còn trình duyệt chỉ gửi mật khẩu giả.

---

## 5. Biến môi trường neko v3 (đối chiếu viper)

neko đọc env với tiền tố `NEKO` + tên khoá, thay `.` bằng `_`
(`viper.SetEnvPrefix("NEKO")`, `strings.NewReplacer(".", "_")`, `viper.AutomaticEnv()`), nên:

| Khoá cấu hình | Biến môi trường |
| --- | --- |
| `session.api_token` | `NEKO_SESSION_API_TOKEN` *(không phải `NEKO_SESSION_APITOKEN` – tên đó của v2)* |
| `session.implicit_hosting` | `NEKO_SESSION_IMPLICIT_HOSTING` |
| `session.merciful_reconnect` (mặc định `true`) | `NEKO_SESSION_MERCIFUL_RECONNECT` |
| `session.cookie.enabled` (mặc định `false`) | `NEKO_SESSION_COOKIE_ENABLED` |
| `session.cookie.name` (mặc định `NEKO_SESSION`) | `NEKO_SESSION_COOKIE_NAME` |
| `member.provider` (mặc định `multiuser`) | `NEKO_MEMBER_PROVIDER` |
| `member.multiuser.user_password` | `NEKO_MEMBER_MULTIUSER_USER_PASSWORD` |
| `member.multiuser.user_profile` | `NEKO_MEMBER_MULTIUSER_USER_PROFILE` |
| `webrtc.epr` | `NEKO_WEBRTC_EPR` |
| `webrtc.nat1to1` | `NEKO_WEBRTC_NAT1TO1` |
| `webrtc.icetrickle` | `NEKO_WEBRTC_ICETRICKLE` |
| `desktop.screen` | `NEKO_DESKTOP_SCREEN` |
| `server.legacy` / cờ `legacy` | `NEKO_LEGACY` |

Ghi chú:

- **API token** (`server/internal/session/manager.go:42-57`) tạo sẵn một session admin tên `API`
  với `CanConnect=false` → **không thể** kết nối vào phòng, chỉ dùng để gọi REST quản trị. Rất hợp để
  app này điều khiển `private_mode` mà không cần mật khẩu admin.
- **Nhà cung cấp `multiuser`** (`server/internal/member/multiuser/provider.go`): mỗi lần
  `/api/login` sinh id ngẫu nhiên `"<username>-<uid>"` → hai tab = hai session độc lập (không bị lỗi
  422). Provider khác (file/object/oauth) có thể trả 422 *session already connected*; app tự thử lại,
  nếu vẫn bận thì dùng lại session gần nhất.
- `session.merciful_reconnect=true`: nếu một session đã kết nối mà có kết nối mới, neko **thay thế**
  peer cũ. Nghĩa là hai tab dùng chung một session sẽ "giành" nhau; dùng tài khoản khác nhau nếu cần
  nhiều người xem đồng thời.

---

## 6. Vì sao cần reverse proxy trong app

1. **`Origin`**: neko kiểm tra `Origin` khi nâng cấp WebSocket; WS mở từ Node.js không có `Origin`
   (hoặc `Origin` rỗng) luôn được chấp nhận. Trình duyệt nói chuyện với app của bạn, app nói chuyện
   với neko.
2. **Cookie/mixed-content**: nếu neko chạy HTTP mà trang của bạn HTTPS, trình duyệt sẽ chặn; proxy giữ
   mọi thứ cùng một origin, đồng thời bỏ thuộc tính `Domain` của cookie neko để cookie gắn với domain
   của bạn (`rewriteSetCookie` trong `src/proxy.js`).
3. **Không lộ thông tin**: token neko chỉ nằm ở server; trình duyệt nhận "vé" một lần
   (`/api/viewer/ticket` → `/viewer-ws?ticket=…`, hết hạn 60 s, dùng một lần) hoặc mật khẩu giả
   (với `VIEWER=embed`).

Điều proxy **không** làm được: media WebRTC (UDP). Trình duyệt phải kết nối trực tiếp tới neko, nên
`NEKO_WEBRTC_NAT1TO1`/`NEKO_WEBRTC_EPR`/TURN vẫn phải cấu hình đúng phía neko.

---

## 7. Giới hạn đã biết

- `private_mode` ảnh hưởng **toàn phòng** (xem mục 1).
- Khi `VIEWER=embed` qua proxy, chức năng **tải/up file** của giao diện neko cần mật khẩu thật trong
  URL (`/file?pwd=`) – nếu bạn cần, hãy dùng `VIEWER=webrtc`, hoặc để người dùng mở neko trực tiếp.
- `docker pause` đóng băng cả tiến trình WebRTC (DTLS/ICE không chạy trong lúc đóng băng) → vì thế
  app giới hạn `PAUSE_MAX_FREEZE_MS` và **vẫn giữ `private_mode`** sau khi bỏ đóng băng: hình không tự
  chạy lại ngoài ý muốn, nhưng handshake có cơ hội hồi phục.
- `VIEWER=novnc` chỉ pause được **ở phía server** (neko/`docker pause`); noVNC không có khái niệm
  "ngừng gửi frame" như neko.
- neko cần thời gian ngắn để track `SetPaused` lan tới RTP; bậc `soft` ở client là thứ cho cảm giác
  tức thời, còn bậc `hard` mới là "máy chủ ngừng gửi".

---

## 8. Checklist khi neko lên phiên bản mới

1. `POST /api/room/settings/` còn là đường dẫn có `/` cuối? (`server/internal/api/room/handler.go`)
2. `private_mode` còn nằm trong `Settings` và còn bị chặn với admin? (`session/session.go`)
3. `/api/login` trả token trong body hay chỉ cookie? (`session.cookie.enabled` mặc định)
4. Opcode datachannel và layout header có đổi? (`server/internal/webrtc/payload/`)
5. Endpoint legacy `/ws` còn tồn tại và còn tự bật khi dùng biến v2? (`http/manager.go`)
6. Tên env có đổi theo viper không? (`session.api_token` → `NEKO_SESSION_API_TOKEN`)
7. Chạy lại `npm test` – `test/nekoClient.test.js` và `test/ws-proxy.test.js` sẽ báo ngay nếu có gì lệch.
