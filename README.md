# Wayground Console

Trang web điều khiển **neko** ([m1k1o/neko](https://github.com/m1k1o/neko) – máy ảo trình duyệt/desktop
truyền qua WebRTC) với một luật duy nhất:

> **Con trỏ chuột rời khỏi khung máy ảo → neko tạm dừng.**
> **Con trỏ quay lại khung → neko chạy tiếp.**

Máy chủ web viết bằng **Node.js** (Express + `ws`), phía sau là neko thật; neko vẫn là nơi
encode video, còn Node.js giữ vai trò "người gác cổng": nhận sự kiện chuột từ trình duyệt,
quyết định pause/resume, rồi gọi API quản trị của neko (và/hoặc `docker pause` container)
để máy ảo thực sự dừng lại.

```
   ┌────────────┐   chuột vào/ra khung    ┌──────────────────────┐   REST admin API   ┌──────────────┐
   │ Trình duyệt│ ──────────────────────► │  Node.js (app này)   │ ─────────────────► │  neko server │
   │  WebRTC    │ ◄────────────────────── │  Pause Engine        │   docker pause     │  (máy ảo)    │
   └────────────┘   video/audio (P2P)     └──────────────────────┘ ─────────────────► └──────────────┘
```

---

## Mục lục

- [Tính năng](#tính-năng)
- [Chạy nhanh với Neko thật](#chạy-nhanh-với-neko-thật)
- [Chạy DEMO (tùy chọn)](#chạy-demo-tùy-chọn)
- [Tùy chỉnh Neko / dùng neko đã có](#tùy-chỉnh-neko--dùng-neko-đã-có)
- [Cơ chế pause hoạt động thế nào](#cơ-chế-pause-hoạt-động-thế-nào)
- [Cấu hình (biến môi trường)](#cấu-hình-biến-môi-trường)
- [API của ứng dụng](#api-của-ứng-dụng)
- [Kiểm thử & chất lượng](#kiểm-thử--chất-lượng)
- [Sự cố thường gặp](#sự-cố-thường-gặp)
- [Kiến trúc & cấu trúc thư mục](#kiến-trúc--cấu-trúc-thư-mục)
- [Bảo mật](#bảo-mật)
- [Ghi công](#ghi-công)

---

## Tính năng

- **Pause theo con trỏ chuột** – vào/ra khỏi khung xem, có debounce để không "nhấp nháy" ở mép khung,
  đo trên toạ độ thật nên vẫn đúng khi cuộn trang, khi mở DevTools hay khi rê chuột sang màn hình khác.
- **Thang 3 bậc pause**:
  1. `soft` – dừng frame ngay ở viewer WebRTC/canvas; với giao diện Neko nhúng, lớp phủ Wayground che khung trong lúc chờ bậc server.
  2. `hard` – bật `private_mode` của neko: **máy chủ neko ngừng gửi frame** cho session người dùng thường.
  3. `deep` – `docker pause` container neko: CPU gần như về 0 (có giới hạn thời gian đóng băng để WebRTC không chết).
- **An toàn, không bỏ quên máy ảo**: tự resume khi hết lease không nhận được tín hiệu từ trình duyệt,
  khi tab bị đóng (`sendBeacon`), khi ẩn tab, khi hết thời gian pause tối đa, khi server tắt.
- **Nhiều tab / nhiều người xem**: chỉ pause khi **tất cả** client đều rời khung (tuỳ chọn
  `MULTI_CLIENT_ALL_MUST_LEAVE=false` nếu chỉ cần một người rời là pause); pause thủ công không bị
  sự kiện chuột "đè" mất.
- **Giao diện Neko thật mặc định**: Compose tự tải/chạy image chính thức `ghcr.io/m1k1o/neko/firefox`;
  khung xem `embed` hiển thị giao diện Neko nguyên bản (chat, clipboard, file transfer), không phải canvas demo.
  `webrtc` (viewer mini) và `novnc` vẫn có thể chọn; `demo` chỉ bật tường minh để thử khi không có Docker.
- **Bảng điều khiển** (tiếng Việt) hiển thị: bậc pause hiện tại, lý do pause, lịch sử, số liệu
  (thời gian theo bậc, số lần pause), nhật ký, các lời gọi API đã gửi tới neko, và chỉnh tham số
  pause ngay trên giao diện (áp dụng tức thì, không cần khởi động lại).
- **Không lộ mật khẩu Neko**: với giao diện gốc, trình duyệt chỉ gửi mật khẩu giả và Node.js thay bằng tài khoản thật khi proxy WebSocket; với viewer WebRTC mini, trình duyệt nhận vé dùng một lần (`/viewer-ws?ticket=…`).
- **`/metrics` chuẩn Prometheus**, `/healthz`, API JSON để tự động hoá, và **chế độ DEMO** có
  neko giả lập ngay trong tiến trình để thử toàn bộ luồng mà không cần Docker.

---

## Chạy nhanh với Neko thật

Cần Docker Desktop/Engine kèm Docker Compose. Không cần cài Neko riêng, không cần `npm install` trên host:
Compose tự tải image Neko chính thức, build Wayground Console và chạy cả hai service.

```bash
npm start
# đợi tải image lần đầu, sau đó mở http://localhost:3000
# dừng stack bằng Ctrl+C hoặc: npm run stop
```

Mặc định khung xem là **giao diện Neko nguyên bản** (`VIEWER=embed`), được proxy qua Wayground cùng origin;
không dùng canvas mô phỏng. Cổng web và dải UDP WebRTC mặc định chỉ bind vào `127.0.0.1` để an toàn. WebRTC dùng IP `127.0.0.1`
cho trình duyệt chạy trên cùng máy.

Muốn truy cập từ máy khác trong LAN/internet: tạo `.env` từ mẫu và đặt IP mà trình duyệt có thể truy cập
được; khi mở app ra ngoài máy local, luôn đặt `APP_PASSWORD`:

```bash
cp .env.example .env
```

```env
APP_BIND_ADDRESS=0.0.0.0
NEKO_BIND_ADDRESS=0.0.0.0
APP_PASSWORD=doi-mat-khau-manh
NEKO_PUBLIC_IP=192.168.1.20 # thay bằng IP LAN/public của host
```

Mở thêm dải UDP `52000-52100` trên firewall/router để WebRTC truyền hình ảnh. Có thể đổi `VIEWER=webrtc`
trong `.env` nếu muốn dùng viewer WebRTC tối giản của Wayground thay cho giao diện Neko gốc.

## Chạy DEMO (tùy chọn)

DEMO chỉ dùng để kiểm thử giao diện/cơ chế pause khi không có Docker. Đây là neko giả lập và canvas,
không phải máy ảo hay giao diện Neko thật:

```bash
npm install
npm run demo
# mở http://localhost:3000
```

Muốn xem bậc "đóng băng Docker" trên stack thật: mở **Cài đặt**, bật `STRATEGY_DOCKER`, hoặc đặt trong
`.env`:

```env
STRATEGY_DOCKER=true
NEKO_CONTAINER=wayground-neko
PAUSE_DOCKER_AFTER_MS=5000
```

---

## Tùy chỉnh Neko / dùng neko đã có

### Neko đóng gói sẵn (mặc định)

`npm start` tương đương `docker compose up --build`: Compose tải image Neko và tự nối app tới
`http://neko:8080` bên trong mạng Docker. Không cần cài/chạy Neko riêng.

| Service | Vai trò | Cổng |
| --- | --- | --- |
| `neko` (`ghcr.io/m1k1o/neko/firefox`) | máy ảo trình duyệt + WebRTC | `127.0.0.1:52000-52100/udp` (HTTP được proxy nội bộ) |
| `console` (app này) | giao diện Neko gốc + pause engine | `127.0.0.1:3000` → `8080` trong container |

- `NEKO_PUBLIC_IP` – mặc định `127.0.0.1` để dùng trên cùng máy. Nếu truy cập từ LAN/public internet,
  đặt IP mà trình duyệt có thể gọi trực tiếp; media WebRTC không đi qua Node.js.
- `NEKO_BIND_ADDRESS` – mặc định chỉ bind dải UDP vào `127.0.0.1`; đổi thành `0.0.0.0` để nhận WebRTC từ mạng.
- `APP_BIND_ADDRESS` – mặc định chỉ bind cổng web vào `127.0.0.1`; đổi thành `0.0.0.0` để mở ra máy khác.
  Khi đó hãy đặt `APP_PASSWORD` và mở dải UDP `52000-52100` trên firewall/router.
- `NEKO_SESSION_API_TOKEN` – token quản trị nội bộ được cấu hình ở cả Neko và app.
- `STRATEGY_DOCKER` – bật nếu muốn bậc "đóng băng" bằng `docker pause`; cần mount
  `/var/run/docker.sock` (Compose đã có sẵn mount, **cân nhắc rủi ro bảo mật** – xem phần [Bảo mật](#bảo-mật)).

### Kết nối tới neko đã chạy sẵn

```bash
# neko đang chạy ở 127.0.0.1:8080, tài khoản người dùng thường "viewer/neko"
cat > .env <<'EOF'
MODE=live
VIEWER=embed
NEKO_URL=http://127.0.0.1:8080
NEKO_USERNAME=viewer
NEKO_PASSWORD=neko
NEKO_ADMIN_USERNAME=admin
NEKO_ADMIN_PASSWORD=admin
STRATEGY_SERVER=true
EOF
npm run start:app # http://localhost:3000
```

> **Quan trọng:** session của khung xem phải là **người dùng thường**, không phải admin.
> neko chỉ pause session không phải admin (`private_mode && !IsAdmin`), nên nếu
> `NEKO_USERNAME` trùng tài khoản admin thì bậc `hard` sẽ không có tác dụng.

Nếu neko chạy bằng docker/khác máy, thêm `NEKO_CONTAINER=<tên container>` và
`STRATEGY_DOCKER=true` để có thêm bậc `deep` (app gọi `docker pause <container>`).

---

## Cơ chế pause hoạt động thế nào

### 1. Trình duyệt đo, Node.js quyết định

`public/js/pause-sensor.js` gắn `pointerenter`/`pointerleave` lên khung xem, cộng thêm phép đo
toạ độ trong `mousemove` (đúng cả khi cuộn trang / mất focus), `visibilitychange` và
`mouseleave` của cửa sổ. Mọi thay đổi được gửi **ngay** qua WebSocket `/ws/control`
(`{"type":"pointer","state":"out"}`) — không debounce ở client, để Node.js là **nơi duy nhất**
quyết định. Nhờ vậy nhiều tab luôn thấy cùng một trạng thái.

Node.js áp `PAUSE_LEAVE_DEBOUNCE_MS` (mặc định 600 ms) trước khi coi là "đã rời khung", nên
lướt chuột ngang qua mép khung không làm máy ảo nhấp nháy pause/resume.

### 2. Thang 3 bậc

| Bậc | Sau bao lâu | Việc thực sự xảy ra | API / lệnh |
| --- | --- | --- | --- |
| `soft` | 0 ms | Viewer WebRTC tắt track; canvas demo đóng băng; giao diện Neko nhúng được Wayground phủ lớp pause | `/ws/control` → client |
| `hard` | `PAUSE_HARD_AFTER_MS` (3000 ms) | neko **ngừng gửi frame** cho session người dùng; neko nhả phím đang giữ | `POST /api/room/settings/ {"private_mode": true}` + `POST /api/room/control/reset` |
| `deep` | `PAUSE_DOCKER_AFTER_MS` (60000 ms) | Container neko bị **đóng băng** (SIGSTOP): CPU gần 0, RAM giữ nguyên | `docker pause wayground-neko` |

Resume đi ngược lại từ trên xuống: bỏ đóng băng → tắt `private_mode` → bỏ lớp pause và bật lại track nếu đang dùng viewer WebRTC mini.
Bậc `deep` có giới hạn `PAUSE_MAX_FREEZE_MS` (mặc định 120 s): quá lâu thì tự `docker unpause`
nhưng **vẫn giữ** `private_mode`, để DTLS/ICE không bị timeout và người dùng quay lại là có hình ngay.

### 3. Các chốt an toàn (không bao giờ bỏ quên máy ảo đang pause)

| Tình huống | Chốt an toàn |
| --- | --- |
| Đóng tab / tắt laptop | `navigator.sendBeacon('/api/beacon/resume')` khi `pagehide`; và lease `PAUSE_LEASE_MS` (10 phút) tự resume khi không còn tín hiệu |
| Mạng rớt, WS chết | Client im lặng quá lease → resume |
| Ẩn tab (chuyển sang tab khác) | Coi như chuột rời khung (`hidden` = `out`) |
| Quên pause quá lâu | `PAUSE_MAX_MS` (30 phút) tự resume |
| Server tắt / khởi động lại | Hook shutdown resume trước khi thoát |
| Chuột quay lại nhưng trước đó pause *thủ công* | Pause thủ công chỉ được gỡ bằng nút Resume (sự kiện chuột không gỡ) |

### 4. Chuột quay lại thì resume

`pointerenter` → `/api/resume` → Node.js gỡ lý do pause, hạ bậc theo thứ tự ngược, bỏ lớp phủ/bật lại track (tuỳ viewer), và (tuỳ chọn `AUTO_RECLAIM_CONTROL`) lấy lại quyền điều khiển để gõ phím ngay không cần click.

---

## Cấu hình (biến môi trường)

Toàn bộ danh sách có kèm giải thích trong [`.env.example`](.env.example). Nhóm chính:

### Máy chủ web

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` (app riêng) | Cổng và địa chỉ lắng nghe; Compose chạy nội bộ ở `8080` |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `APP_PASSWORD` | *(trống)* | Nếu đặt, trang điều khiển yêu cầu đăng nhập (cookie phiên). **Bắt buộc khi mở ra LAN/internet** |
| `APP_BIND_ADDRESS` | `127.0.0.1` (Compose) | Địa chỉ host bind cổng `3000`; chỉ đổi thành `0.0.0.0` khi cần truy cập từ máy khác |
| `TRUST_PROXY` | `true` | Tin `X-Forwarded-*` khi chạy sau reverse proxy |

### Kết nối neko

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `MODE` | `live` | `demo` (mô phỏng) \| `live` \| `auto` (có `NEKO_URL` → `live`; URL trống → `demo`). Compose luôn dùng `live` |
| `VIEWER` | `auto` | `webrtc` \| `embed` \| `novnc` \| `demo` (auto: demo → canvas, live → giao diện Neko gốc `embed`) |
| `NEKO_URL` | `http://127.0.0.1:8080` (app riêng) | Địa chỉ Neko; Compose tự dùng `http://neko:8080` |
| `NEKO_PUBLIC_IP` | `127.0.0.1` (Compose) | Địa chỉ Neko quảng bá cho WebRTC; đổi sang IP LAN/public nếu truy cập từ máy khác |
| `NEKO_BIND_ADDRESS` | `127.0.0.1` (Compose) | Địa chỉ bind các cổng UDP WebRTC; dùng `0.0.0.0` nếu kết nối từ máy khác |
| `NEKO_USERNAME` / `NEKO_PASSWORD` | `neko` / `neko` | **Tài khoản người dùng thường** – session này mới bị `private_mode` pause |
| `NEKO_ADMIN_USERNAME` / `NEKO_ADMIN_PASSWORD` | `admin` / `admin` | Tài khoản admin – dùng để đổi `private_mode` |
| `NEKO_API_TOKEN` | – | Khuyến nghị thay cho mật khẩu admin: đặt `NEKO_SESSION_API_TOKEN=<token>` bên neko rồi điền cùng giá trị ở đây |
| `NEKO_CONTAINER` | – | Tên container neko, cần cho bậc `deep` |
| `NOVNC_URL` / `NOVNC_WS_URL` | `http://localhost:6080/…` | Chỉ dùng khi `VIEWER=novnc` |

### Cơ chế pause

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `PAUSE_LEAVE_DEBOUNCE_MS` | `600` | Chờ bao lâu sau khi chuột rời khung mới pause |
| `PAUSE_ENTER_DEBOUNCE_MS` | `120` | Chờ bao lâu sau khi chuột quay lại mới resume |
| `PAUSE_IDLE_MS` | `0` | Tự pause khi không thao tác (0 = tắt) |
| `PAUSE_HARD_AFTER_MS` | `3000` | Lên bậc `hard` (neko `private_mode`) |
| `PAUSE_DOCKER_AFTER_MS` | `60000` | Lên bậc `deep` (`docker pause`) |
| `PAUSE_MAX_FREEZE_MS` | `120000` | Thời gian đóng băng tối đa trước khi tự bỏ đóng băng |
| `PAUSE_LEASE_MS` | `600000` | Tự resume nếu không nhận được tín hiệu từ trình duyệt |
| `PAUSE_MAX_MS` | `1800000` | Tự resume dù tab vẫn mở |
| `STRATEGY_CLIENT` / `STRATEGY_SERVER` / `STRATEGY_DOCKER` | `true` / `true` / `false` | Bật từng bậc: client / neko / docker |
| `AUTO_RECLAIM_CONTROL` | `true` | Lấy lại quyền chuột/bàn phím sau khi resume |
| `MULTI_CLIENT_ALL_MUST_LEAVE` | `true` | Chỉ pause khi **tất cả** client rời khung |
| `AUTO_PAUSE` | `true` | Bật/tắt phản ứng theo chuột (đổi được ngay trên UI) |

---

## API của ứng dụng

| Phương thức | Đường dẫn | Mô tả |
| --- | --- | --- |
| `GET` | `/` | Bảng điều khiển Wayground; khung xem mặc định chứa giao diện Neko gốc |
| `GET` | `/neko-ui/` | Giao diện chính chủ của Neko, proxy cùng origin (cần đăng nhập nếu có `APP_PASSWORD`) |
| `GET` | `/healthz` | `ok` – dùng cho healthcheck |
| `GET` | `/api/health` | JSON: tình trạng pause + kết nối neko + docker |
| `GET` | `/api/config` | Cấu hình công khai (không có mật khẩu) để UI dựng giao diện |
| `GET` | `/api/state` | Snapshot đầy đủ: bậc, lý do, client, số liệu, lời gọi neko |
| `POST` | `/api/pause` | Pause thủ công, body `{ "reason": "manual", "detail": "…" }` |
| `POST` | `/api/resume` | Resume (gỡ cả pause thủ công) |
| `POST` | `/api/toggle` | Đảo trạng thái |
| `POST` | `/api/pointer` | Trình duyệt báo chuột vào/ra: `{ "clientId": "…", "state": "in" \| "out" }` |
| `POST` | `/api/auto` | Bật/tắt phản ứng theo chuột: `{ "autoPause": false }` |
| `POST` | `/api/settings` | Đổi tham số pause tại chỗ (áp dụng ngay) |
| `POST` | `/api/beacon/resume` | `sendBeacon` khi đóng tab – luôn resume |
| `GET` | `/api/viewer/ticket` | Vé WebRTC dùng một lần hoặc URL tới Neko UI gốc (embed) |
| `GET` | `/metrics` | Prometheus: `wayground_paused`, `wayground_level{level}`, `wayground_pauses_total`, `wayground_paused_seconds_total`, `wayground_clients`, `wayground_neko_reachable`, … |
| `WS` | `/ws/control` | Kênh thời gian thực cho UI: nhận `state`, `log`, `tick`; gửi `pointer`, `pause`, `resume`, `settings`, `heartbeat` |
| `WS` | `/viewer-ws?ticket=…` | Cầu nối WebSocket tới neko `/api/ws` (Node.js gắn token) |
| `WS` | `/neko-ui/ws` | Cầu nối cho `VIEWER=embed`: đi qua adapter `/ws` (legacy) của neko bằng tài khoản thật ở server |

Ví dụ nhanh:

```bash
curl -s localhost:3000/api/state | jq '.state.level, .state.reasons'
curl -sX POST localhost:3000/api/pause  -H 'content-type: application/json' -d '{"detail":"bảo trì"}'
curl -sX POST localhost:3000/api/resume
curl -s localhost:3000/metrics | grep wayground_paused
```

Các endpoint làm thay đổi trạng thái đều kiểm tra `Origin` (chống CSRF) và yêu cầu đăng nhập nếu
`APP_PASSWORD` được đặt.

---

## Kiểm thử & chất lượng

```bash
npm test                 # unit + integration + proxy + frontend + config
npm run lint             # ESLint (flat config)
npm run smoke            # smoke test trên stack Compose đang chạy (localhost:3000)
node scripts/smoke.js http://127.0.0.1:3000   # hoặc trỏ tới app chạy riêng
```

- `test/pauseEngine.test.js` – máy trạng thái pause: debounce, leo thang, hết hạn đóng băng,
  lease, nhiều client, pause thủ công, thống kê.
- `test/integration.test.js` – khởi động **server thật** ở chế độ DEMO trên cổng ngẫu nhiên, kiểm tra
  `/api/*`, `/metrics`, CSRF, kênh WebSocket và đúng chuỗi lời gọi tới neko giả lập.
- `test/http-proxy.test.js` – kiểm tra proxy giữ nguyên asset subpath của giao diện Neko khi chạy dưới `/neko-ui`.
- `test/ws-proxy.test.js` – proxy WebSocket: `/viewer-ws` gắn token, `/neko-ui/ws` đổi mật khẩu giả
  thành tài khoản thật, kiểm tra origin và cookie đăng nhập.
- `test/nekoClient.test.js` – client neko trước một "neko" giả đúng hành vi thật: đường dẫn có
  `/` cuối (chi router), xác thực bằng cookie, lỗi 422 khi session đang kết nối.
- `test/frontend.test.js` – kiểm tra HTML/CSS/JS khớp nhau (id, tab, import, lớp CSS trạng thái).
- `test/config.test.js` – nạp `.env`, thứ tự ưu tiên, dấu nháy/comment.
- `scripts/smoke.js` – kiểm tra nhanh một server đang chạy: health → pause → leo bậc → resume → metrics.

---

## Sự cố thường gặp

| Triệu chứng | Nguyên nhân & cách xử lý |
| --- | --- |
| Log báo `404 … /api/room/settings` | Đường dẫn của neko **phải có dấu `/` cuối** (`/api/room/settings/`) – đây là chi router. Bản này đã gọi đúng; nếu bạn tự viết client thì nhớ điều này |
| Bấm pause nhưng hình vẫn chạy | Khung xem đang dùng tài khoản **admin**; neko chỉ pause session không phải admin. Đổi `NEKO_USERNAME` sang người dùng thường |
| `401/403` khi đổi `private_mode` | Sai mật khẩu admin hoặc token hết hiệu lực. Kiểm tra `NEKO_ADMIN_*` / `NEKO_API_TOKEN` |
| Không có hình (đen) nhưng có tiếng/không có gì | WebRTC là P2P: trình duyệt phải kết nối được tới IP mà neko quảng bá. Đặt `NEKO_PUBLIC_IP`/`NEKO_WEBRTC_NAT1TO1` và mở dải `52000-52100/udp` |
| Bậc `deep` không chạy | `STRATEGY_DOCKER=false`, thiếu `NEKO_CONTAINER`, hoặc container app không có `docker`/socket. Xem tab **Cài đặt → Cảnh báo** |
| Máy ảo "đứng" mãi sau khi bạn tắt tab | Kiểm tra `PAUSE_LEASE_MS`; xem tab Nhật ký có dòng resume theo lease không. Có thể resume thủ công bằng `POST /api/resume` |
| Trang hiện form đăng nhập | `APP_PASSWORD` đang được đặt – đăng nhập bằng mật khẩu đó |
| `VIEWER=embed` báo không kết nối được | neko phải bật `legacy` (`NEKO_LEGACY=true` hoặc dùng biến v2 như `NEKO_DESKTOP_SCREEN`) để có endpoint `/ws` |
| hai tab cùng xem | Mặc định ổn (mỗi tab một session); nếu neko dùng provider chỉ cho 1 session/người, tab thứ hai có thể bị 422 – app tự thử lại rồi dùng lại session gần nhất |

---

## Kiến trúc & cấu trúc thư mục

```
src/
  index.js         khởi động: config → (demo? neko giả lập) → NekoClient/DockerDriver → PauseEngine → HTTP+WS
  config.js        đọc .env (tự nạp khi import), chuẩn hoá & kiểm tra cấu hình
  pauseEngine.js   máy trạng thái pause: lý do, debounce, leo thang bậc, lease, thống kê
  nekoClient.js    client REST tới neko (login, cookie/token, private_mode, control reset)
  dockerDriver.js  docker pause/unpause/inspect (có timeout & kiểm tra tên container)
  proxy.js         reverse proxy HTTP + WebSocket tới neko (vé một lần, đổi Origin, cookie)
  controlChannel.js kênh /ws/control: nhận sự kiện trình duyệt, phát trạng thái/nhật ký
  routes.js        REST API, /metrics, phục vụ giao diện, /neko-api, /neko-ui
  fakeNeko.js      neko giả lập cho chế độ DEMO và cho test
  log.js           logger JSON có vòng đệm lịch sử cho UI
public/
  index.html       giao diện điều khiển (tiếng Việt)
  login.html       trang đăng nhập khi có APP_PASSWORD
  css/app.css      giao diện (dark, trạng thái pause/running rõ ràng)
  js/app.js        dựng UI, kênh điều khiển, chỉnh tham số, hotkey
  js/pause-sensor.js  phát hiện chuột vào/ra khỏi khung (+ tab ẩn, rời cửa sổ)
  js/viewer-neko.js   client WebRTC mini theo giao thức neko (khi VIEWER=webrtc)
  js/viewer-demo.js   máy ảo mô phỏng bằng canvas (chế độ DEMO)
  js/viewer-embed.js  iframe cho VIEWER=embed hoặc novnc
  js/keysyms.js       bảng mã phím X11 cho datachannel của neko
scripts/smoke.js   kiểm tra nhanh một server đang chạy
scripts/demo.js    chạy mô phỏng canvas (chỉ khi gọi npm run demo)
test/              test unit + integration (node:test)
docs/              tài liệu kỹ thuật, ghi chú đối chiếu source neko
```

Máy trạng thái (rút gọn):

```
        ┌─────────────── pause do: chuột rời khung / thủ công / API / hết idle ───────────────┐
        ▼                                                                                     │
   ┌─────────┐  PAUSE_HARD_AFTER_MS   ┌─────────┐  PAUSE_DOCKER_AFTER_MS   ┌─────────┐        │
   │ running │ ─────────────────────► │  soft   │ ────────────────────────► │  hard   │ ───────► deep
   └─────────┘                        └─────────┘                           └─────────┘
        ▲                                  │                                     │
        └──────── resume: chuột quay lại / hết lease / đóng tab / hết hạn ──────┘
```

Chi tiết kỹ thuật và các đối chiếu với source neko nằm ở [`docs/neko-integration.md`](docs/neko-integration.md).

---

## Bảo mật

- Compose chỉ bind cổng web vào `127.0.0.1` mặc định. Nếu đổi `APP_BIND_ADDRESS=0.0.0.0` để mở ra mạng,
  bắt buộc đặt `APP_PASSWORD`; app dùng cookie phiên `HttpOnly` + `SameSite=Lax` và kiểm tra `Origin`.
  WebSocket điều khiển/proxy cũng kiểm tra origin và cookie đăng nhập.
- **Ưu tiên `NEKO_API_TOKEN` hơn mật khẩu admin**: token có thể thu hồi bằng cách đổi biến bên neko,
  và token không cho phép kết nối vào phòng (`CanConnect=false`).
- `STRATEGY_DOCKER=true` nghĩa là **container app được điều khiển Docker (mount `docker.sock`)** –
  tương đương quyền root trên máy chủ. Chỉ bật khi bạn hiểu rõ, và giới hạn app chỉ dùng để
  pause/unpause đúng container neko (`NEKO_CONTAINER` được kiểm tra bằng regex).
- Trình duyệt **không bao giờ** nhận mật khẩu neko: với `VIEWER=webrtc` nó nhận vé một lần dùng;
  với `VIEWER=embed` nó gửi mật khẩu giả và Node.js thay bằng tài khoản thật khi mở WebSocket.
- WebRTC media (video/audio/input) đi trực tiếp giữa trình duyệt và neko; hãy đặt neko trong mạng
  tin cậy, dùng `NEKO_WEBRTC_NAT1TO1`/TURN nếu cần đi qua internet.

---

## Ghi công

- Ý tưởng, giao thức và máy ảo: [m1k1o/neko](https://github.com/m1k1o/neko) (MIT). App này dùng neko
  như một service, không sửa mã nguồn neko.
- Giao thức neko được đối chiếu trực tiếp từ source neko v3 (`server/internal/...`): xem
  [`docs/neko-integration.md`](docs/neko-integration.md) để biết chính xác app đã dùng những API nào.
