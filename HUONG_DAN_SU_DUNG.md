# HƯỚNG DẪN SỬ DỤNG MULTI LLM PROXY TỪ XA

Tài liệu này dành cho Ad Storyboard Studio và các ứng dụng khác cần gọi model nội dung, phân tích ảnh hoặc sinh ảnh qua một API thống nhất.

## 1. Địa chỉ và trạng thái

| Mục đích | Địa chỉ |
|---|---|
| API trên chính máy chủ | `http://127.0.0.1:3456` |
| API từ Internet | `https://thanhcctv.bestmarathon.vn` |
| Hướng dẫn tiếng Việt | `/huong-dan?format=html` |
| Tài liệu API đầy đủ | `/guide?format=html` |
| Kiểm tra dịch vụ | `/health` |
| Danh sách model | `/v1/models` |

Luồng xử lý:

```text
Ứng dụng từ xa
  -> Cloudflare DNS/WAF/Tunnel
  -> Multi LLM Proxy :3456
  -> Claude/Codex cho nội dung
  -> ima2-gen :3333 cho hình ảnh
```

Phân biệt hai lớp:

- **Tunnel** chuyển request từ hostname công khai về `127.0.0.1:3456`.
- **WAF** quyết định request có được đi vào tunnel hay bị Cloudflare chặn.

Tunnel chạy không đồng nghĩa API đã truy cập được từ mọi mạng. Chỉ kết luận API từ xa hoạt động khi lệnh kiểm tra công khai ở mục 3 trả HTTP `200`.

### Trạng thái nghiệm thu gần nhất (16/07/2026)

| Hạng mục | Kết quả | Chi tiết |
|---|---|---|
| Multi LLM Proxy | PASS | Origin local `/health` trả `200` |
| Cloudflare Tunnel | PASS | Dịch vụ `cloudflared` đang `active` |
| Hướng dẫn trong LAN | PASS | `http://192.168.1.37:3456/huong-dan?format=html` trả `200` |
| API qua Internet | FAIL | Cloudflare WAF đang trả trang block `403` |

Kết luận hiện tại: **chưa được coi là API từ xa hoạt động**. Cần hoàn thành bước sửa WAF ở mục 3 rồi kiểm tra lại từ mạng ngoài LAN.

## 2. Bảo mật và API key

Request từ Internet phải có một trong hai header:

```http
Authorization: Bearer <API_KEY>
```

hoặc:

```http
x-api-key: <API_KEY>
```

Mỗi ứng dụng dùng một key riêng trong `config.json`:

```json
{
  "apiKeys": [
    {
      "key": "<64_HEX_RANDOM>",
      "app": "ad-storyboard-studio",
      "rpm": 60,
      "admin": false
    }
  ]
}
```

Quy tắc bắt buộc:

- Key ứng dụng phải đặt `admin: false`.
- Chỉ key vận hành máy chủ mới được đặt `admin: true`.
- Không ghi key vào Git, project storyboard, JSON/Markdown export hoặc mã frontend.
- Không gửi key qua tin nhắn hoặc chụp màn hình.
- Khi nghi ngờ lộ key, tạo key mới và vô hiệu hóa key cũ ngay.

Các endpoint `/config`, `/stats`, `/logs` và `/token*` yêu cầu localhost hoặc key có `admin: true`. Key ứng dụng thông thường nhận `403 admin_required` khi gọi các endpoint này.

## 3. Kích hoạt API qua Cloudflare

### Bước 1: kiểm tra origin trên máy chủ

```bash
curl -i http://127.0.0.1:3456/health
```

Yêu cầu: HTTP `200` và JSON có `"status":"ok"`.

### Bước 2: kiểm tra tunnel

```bash
systemctl is-active cloudflared
```

Yêu cầu: `active`.

Ingress của tunnel phải trỏ hostname `thanhcctv.bestmarathon.vn` về:

```text
http://127.0.0.1:3456
```

### Bước 3: bỏ rule WAF chặn nhầm API

Trong Cloudflare Dashboard:

1. Mở zone `bestmarathon.vn`.
2. Vào **Security -> Events** và lọc hostname `thanhcctv.bestmarathon.vn`.
3. Mở sự kiện `403` gần nhất để xác định đúng rule đang block.
4. Sửa rule đó để loại trừ hostname API, ví dụ thêm điều kiện:

```text
and not (http.host eq "thanhcctv.bestmarathon.vn")
```

5. Nếu dùng một rule **Skip**, đặt nó trước rule block và chỉ skip rule gây chặn nhầm. Không tắt toàn bộ bảo vệ của cả domain.

Việc xác thực request vẫn do API key của proxy đảm nhiệm. Có thể giữ rate limiting của Cloudflare, nhưng không dùng Managed Challenge cho endpoint API trả JSON.

### Bước 4: kiểm tra từ một mạng khác

Chạy từ máy không nằm trong LAN của server, ví dụ máy dùng 4G/5G:

```bash
curl -i https://thanhcctv.bestmarathon.vn/health
```

Kết quả đúng là HTTP `200` và JSON. Nếu nhận HTML có tiêu đề `Attention Required! | Cloudflare`, WAF vẫn đang chặn.

### Bước 5: kiểm tra request có xác thực

```bash
export MLLM_URL="https://thanhcctv.bestmarathon.vn"
export MLLM_API_KEY="<API_KEY_CUA_UNG_DUNG>"

curl -sS "$MLLM_URL/v1/chat/completions" \
  -H "Authorization: Bearer $MLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-opus-5",
    "messages": [
      {"role": "user", "content": "Chỉ trả lời đúng một từ: OK"}
    ]
  }'
```

Không ghi key thật trực tiếp vào source code. Biến môi trường trên chỉ là ví dụ cho một phiên terminal.

## 4. Model nên dùng

Luôn kiểm tra danh sách đang phục vụ:

```bash
curl -sS https://thanhcctv.bestmarathon.vn/v1/models
```

Thiết lập hiện dùng cho Ad Storyboard Studio:

| Công việc | Model |
|---|---|
| Kịch bản quảng cáo chất lượng cao | `claude-opus-5` |
| Tự chọn theo độ khó | `auto` |
| Sinh/sửa ảnh | `gpt-5.6-terra` qua ima2-gen |

Model ảnh không xuất hiện trong `/v1/models` vì nó được chuyển tiếp qua hai endpoint ảnh riêng.

## 5. Tạo nội dung hoặc kịch bản

Endpoint:

```text
POST /v1/chat/completions
```

Ví dụ:

```bash
curl -sS "$MLLM_URL/v1/chat/completions" \
  -H "Authorization: Bearer $MLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: storyboard-vulan-001" \
  -d '{
    "model": "claude-opus-5",
    "messages": [
      {
        "role": "system",
        "content": "Bạn là biên kịch quảng cáo. Chỉ xuất JSON hợp lệ."
      },
      {
        "role": "user",
        "content": "Viết quảng cáo giải chạy online Vu Lan dài 50 giây, 5 scene x 10 giây, giọng thuyết minh ngoài hình, có hook, lợi ích và CTA."
      }
    ],
    "stream": false,
    "timeout": 900
  }'
```

Nội dung trả về nằm tại:

```text
.choices[0].message.content
```

`Idempotency-Key` là tùy chọn. Gửi lại cùng key và cùng body trong thời gian cache sẽ nhận cùng kết quả, tránh tạo trùng khi mạng chập chờn.

## 6. Tạo ảnh mới

Endpoint:

```text
POST /v1/images/generations
```

```bash
curl -sS "$MLLM_URL/v1/images/generations" \
  -H "Authorization: Bearer $MLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.6-terra",
    "provider": "oauth",
    "promptMode": "direct",
    "prompt": "Vertical cinematic advertising frame, two Vietnamese runners on a lotus road at dawn...",
    "size": "9:16",
    "quality": "hd",
    "n": 1,
    "response_format": "b64_json"
  }' > image-response.json

jq -r '.data[0].b64_json' image-response.json | base64 -d > frame.png
```

Giá trị `response_format: "url"` hiện trả **data URL**, không phải link ảnh được lưu vĩnh viễn trên Internet. Client phải lưu `b64_json` hoặc data URL thành file/IndexedDB/object storage nếu cần dùng lại sau khi tải lại trang.

## 7. Sửa ảnh với nhiều ảnh tham chiếu

Endpoint:

```text
POST /v1/images/edits
```

Thứ tự ảnh là hợp đồng bắt buộc:

- `image` là `IMAGE 1`.
- Phần tử đầu của `images[]` là `IMAGE 2`.
- Các phần tử tiếp theo lần lượt là `IMAGE 3`, `IMAGE 4`, `IMAGE 5`.
- Prompt phải khai báo rõ alias và vai trò của từng ảnh theo đúng thứ tự này.

Ví dụ gán ảnh:

```text
IMAGE 1 = [KOL_NU]: khóa khuôn mặt, vóc dáng và nhận dạng nữ.
IMAGE 2 = [KOL_NAM]: khóa khuôn mặt, vóc dáng và nhận dạng nam.
IMAGE 3 = [DUONG_SEN]: chỉ dùng làm bối cảnh.
IMAGE 4 = [AO_HONG_MAT_TRUOC]: khóa thiết kế mặt trước áo.
IMAGE 5 = [AO_HONG_MAT_SAU]: khóa thiết kế mặt sau áo.
```

Chuẩn bị JSON request từ năm file ảnh:

```bash
KOL_NU=$(base64 -w0 kol-nu.jpg)
KOL_NAM=$(base64 -w0 kol-nam.jpg)
DUONG_SEN=$(base64 -w0 duong-sen.jpg)
AO_TRUOC=$(base64 -w0 ao-hong-truoc.jpg)
AO_SAU=$(base64 -w0 ao-hong-sau.jpg)

jq -n \
  --arg image "$KOL_NU" \
  --arg i2 "$KOL_NAM" \
  --arg i3 "$DUONG_SEN" \
  --arg i4 "$AO_TRUOC" \
  --arg i5 "$AO_SAU" \
  --arg prompt 'IMAGE 1 = [KOL_NU]. IMAGE 2 = [KOL_NAM]. IMAGE 3 = [DUONG_SEN]. IMAGE 4 = [AO_HONG_MAT_TRUOC]. IMAGE 5 = [AO_HONG_MAT_SAU]. Create one vertical 9:16 cinematic frame. Keep both identities exact, dress both runners in the referenced pink event shirt, place them running naturally on the referenced lotus road. Do not copy clothing from identity references. Do not change faces, shirt artwork, logo or environment geometry.' \
  '{
    model: "gpt-5.6-terra",
    provider: "oauth",
    promptMode: "direct",
    prompt: $prompt,
    image: $image,
    images: [$i2, $i3, $i4, $i5],
    size: "9:16",
    quality: "hd",
    response_format: "b64_json"
  }' > edit-request.json

curl -sS "$MLLM_URL/v1/images/edits" \
  -H "Authorization: Bearer $MLLM_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @edit-request.json > edit-response.json

jq -r '.data[0].b64_json' edit-response.json | base64 -d > scene-01-start.png
```

Không viết chung chung như “dùng ảnh tham chiếu”. Phải nói ảnh nào khóa nhân vật, ảnh nào chỉ lấy áo và ảnh nào chỉ lấy bối cảnh. Ad Storyboard Studio giới hạn năm ảnh đầu vào cho mỗi lần sinh frame để vai trò không bị loãng.

## 8. Ad Storyboard Studio gọi API thế nào

Khi chạy giao diện bằng Vite:

```text
Trình duyệt -> /llm-proxy -> Vite server -> 127.0.0.1:3456
```

Vite đọc key `ad-storyboard-studio` ở phía server và chèn vào request. Người dùng giao diện không cần nhập hoặc nhìn thấy API key. Key không được đưa vào project hoặc file export.

API từ xa `https://thanhcctv.bestmarathon.vn` dành cho:

- ứng dụng chạy trên máy khác;
- script tự động;
- server khác trong hệ thống;
- công cụ tích hợp trực tiếp theo chuẩn OpenAI-compatible.

Không đưa API key quản trị vào cấu hình trình duyệt. Nếu deploy frontend công khai, mọi request AI vẫn phải đi qua backend/proxy server của ứng dụng.

## 9. Endpoint Agent giao tiếp trực tiếp với Codex CLI

`/v1/chat/completions` vẫn là API hỏi–đáp văn bản. Khi cần trải nghiệm gần giống phiên Codex hiện tại — xem file, chạy kiểm tra, cập nhật dự án, nhận tiến độ và duyệt lệnh — dùng nhóm endpoint `/v1/agent/sessions/*`.

Điểm khác biệt:

- giữ nguyên một Codex thread qua nhiều lượt;
- trả sự kiện có cấu trúc như message delta, plan, command, file change và token usage;
- nhận `text`, ảnh, audio hoặc đường dẫn media nằm trong workspace;
- có steer, interrupt và luồng phê duyệt command/file;
- không công khai raw JSON-RPC hoặc `thread/shellCommand` chạy ngoài sandbox.

Nhóm endpoint này chỉ cho phép localhost hoặc API key riêng có `admin: true`. Ba key ứng dụng hiện tại đều không phải admin nên không thể điều khiển máy từ Internet; đây là trạng thái an toàn có chủ đích.

### Tạo phiên

```bash
curl -sS http://127.0.0.1:3456/v1/agent/sessions \
  -H 'Content-Type: application/json' \
  -d '{
    "cwd":"/home/thanhcctv2/multi-llm-proxy",
    "model":"gpt-5.6-terra",
    "sandbox":"read-only",
    "networkAccess":false
  }'
```

Giữ lại cả `id` và `threadId`. `id` dùng cho các endpoint trong lúc phiên proxy còn sống; `threadId` dùng để khôi phục lịch sử bằng trường `resumeThreadId` sau khi proxy khởi động lại.

### Gửi yêu cầu và xem tiến độ trực tiếp

```bash
curl -sS http://127.0.0.1:3456/v1/agent/sessions/$SESSION_ID/turns \
  -H 'Content-Type: application/json' \
  -d '{"input":[{"type":"text","text":"Kiểm tra git và chạy test, báo tiến độ cho tôi"}]}'

curl -N http://127.0.0.1:3456/v1/agent/sessions/$SESSION_ID/events/stream
```

Nếu kết nối SSE bị ngắt, nối lại với `?after=<SEQ_CUOI>` hoặc gọi `GET .../events?after=<SEQ_CUOI>` để lấy phần bị lỡ.

### Duyệt một thao tác

Khi stream trả event `kind: "request"`, đọc kỹ `command`, `cwd`, `reason` trong payload rồi dùng `requestId`:

```bash
curl -sS http://127.0.0.1:3456/v1/agent/sessions/$SESSION_ID/approvals/$REQUEST_ID \
  -H 'Content-Type: application/json' \
  -d '{"decision":"accept"}'
```

Chỉ hỗ trợ `accept`, `decline`, `cancel` cho từng lần. Proxy không cho duyệt vĩnh viễn hoặc mở `danger-full-access`.

Mặc định máy này dùng `read-only`, không có network, tối đa bốn phiên và tự dọn sau một giờ không hoạt động. Chỉ chọn `workspace-write` khi thật sự muốn sửa file; quyền ghi thực tế bị giới hạn vào đúng `cwd` của phiên. Không đưa admin key vào frontend hoặc ứng dụng công khai.

## 10. Bảng xử lý lỗi

| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `403` kèm trang HTML Cloudflare | WAF chặn trước tunnel | Xem Security Events, sửa đúng rule theo mục 3 |
| `401 invalid_api_key` dạng JSON | Thiếu hoặc sai key ứng dụng | Kiểm tra header Bearer/x-api-key và key trong `config.json` |
| `403 admin_required` dạng JSON | Key ứng dụng gọi endpoint quản trị | Dùng endpoint thường; chỉ admin mới dùng route quản trị |
| `429 rate_limit_exceeded` | Vượt RPM của key hoặc hàng đợi đầy | Chờ `Retry-After`, giảm song song hoặc tăng RPM có kiểm soát |
| `500 unsupported image format` | Base64 hỏng hoặc file không phải PNG/JPEG/WebP hợp lệ | Chuẩn hóa ảnh rồi encode lại, không gửi đường dẫn file thay cho base64 |
| `500 ... returned no image` | ima2-gen/model ảnh lỗi | Kiểm tra `pm2 logs ima2-gen`, provider và model |
| Request ảnh quá lớn | Tổng JSON vượt giới hạn body hoặc Cloudflare | Giảm kích thước/dung lượng ảnh tham chiếu |
| F5 mất ảnh | Client chỉ giữ data URL trong RAM | Lưu project/IndexedDB hoặc tải file trước khi tải lại trang |

## 11. Lệnh vận hành trên server

```bash
pm2 status
pm2 logs multi-llm-proxy --lines 100
pm2 logs ima2-gen --lines 100
pm2 restart multi-llm-proxy
systemctl is-active cloudflared
curl -sS http://127.0.0.1:3456/health
```

Không in `config.json`, API key hoặc tunnel token vào log hỗ trợ công khai.

## 12. Checklist nghiệm thu API từ xa

- [ ] `cloudflared` ở trạng thái `active`.
- [ ] Origin local `/health` trả `200`.
- [ ] Hostname công khai `/health` trả JSON `200`, không phải HTML Cloudflare.
- [ ] Request không có key tới endpoint AI trả `401`.
- [ ] Request có key ứng dụng hợp lệ tạo được một câu trả lời.
- [ ] Key ứng dụng gọi `/config` bị chặn `403 admin_required`.
- [ ] Tạo được một ảnh mới và lưu được base64 thành file.
- [ ] Sửa ảnh nhiều tham chiếu giữ đúng thứ tự `IMAGE 1..5`.
- [ ] API key không xuất hiện trong frontend, project hoặc file export.
- [ ] Đã thử từ mạng ngoài LAN.

Chỉ kết luận **API từ xa hoạt động** khi toàn bộ mục bắt buộc trên đều đạt.
