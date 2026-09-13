# 🤝 GATHERMAP FRONTEND INTEGRATION GUIDE & API CONTRACT
> **Tài liệu Bàn giao Kỹ thuật dành cho Frontend AI Teammate**  
> *Dự án: GatherMap — Equal-Weight Geometric Group Eatery Matchmaker*  
> *Backend Engine: Node.js / Express / SQLite (148 KB) / Google Gemini Live & Google Maps API*  
> *Host: http://localhost:3000 (CORS enabled)*

---

## 🧭 1. Tổng quan & Trạng thái Hệ thống (System Status)

Backend đã được hoàn thiện 100%, bảo mật, tối ưu token theo triết lý Hackathon Winner (Jake Kang Framework):
- **Cơ sở dữ liệu**: SQLite 148 KB tại `gathermap.db` chứa 24 quán ăn Sài Gòn đã xác thực tọa độ thật, kèm 50+ trích dẫn reviewer (Google Local Guide, TikTok KOC, Facebook, ShopeeFood).
- **Thuật toán công bằng**: Tính tâm hình học Weiszfeld Geometric Median với tỷ lệ 65% khoảng cách + 35% khẩu vị.
- **Hệ thống phòng thủ (Smart Fallbacks)**: Tự động chạy dữ liệu nội bộ nếu không có Google API Key hoặc Gemini bị timeout.

---

## 🔌 2. Chi tiết Toàn bộ REST API Endpoints

### 1️⃣ Lấy kịch bản mẫu 1-Click (`GET /api/presets`)
Trả về 3 kịch bản demo mẫu chuẩn bị sẵn (để demo không bao giờ bị xịt):
* **Endpoint**: `GET /api/presets`
* **Response**: `{ presets: [ { id, title, tag, description, friends, constraints, softPreferences, radiusMeters } ] }`

---

### 2️⃣ Tìm kiếm & Xếp hạng Quán ăn (`POST /api/venues/search-and-rank`)
Thuật toán trung tâm nhận vị trí nhóm và trả về danh sách quán xếp hạng:
* **Endpoint**: `POST /api/venues/search-and-rank`
* **Payload**:
```json
{
  "center": { "lat": 10.7782, "lng": 106.6912 },
  "radiusMeters": 3000,
  "requiredConstraints": { "vegetarian": false, "no_alcohol": false, "quiet_only": false, "max_price_vnd": 150000 },
  "softPreferences": [{ "preference": "Quiet workspace", "weight": 5 }],
  "friends": [{ "id": 1, "name": "You", "lat": 10.7798, "lng": 106.6990 }]
}
```
* **Response fields quan trọng**:
  - `shortlist[]`: Danh sách quán đã sắp xếp theo `groupScore` (0–100).
  - `venue.signatureDishes`: Mảng 2-3 món ruột (ví dụ: ["Cơm tấm sườn nướng", "Chả trứng"]).
  - `venue.socialPros`: Điểm khen MXH.
  - `venue.socialCons`: Lưu ý gửi xe, giờ cao điểm.
  - `venue.reviewerCount`: Số lượng reviewer có sẵn.
  - `venue.directionsUrl`: Link chỉ đường Google Maps trực tiếp.
  - `venue.friendDistances[]`: Khoảng cách từng bạn tới quán.

---

### 3️⃣ Xem chi tiết Reviewer ở Bottomline (`GET /api/venues/:id/reviewers`)
* **Endpoint**: `GET /api/venues/:id/reviewers`
* **Response**: `{ venueId, name, signatureDishes, socialPros, socialCons, reviewers: [ { source, authorName, rating, date, content, tags } ] }`

---

### 4️⃣ Đăng Review mới từ Drawer (`POST /api/venues/:id/reviews`)
* **Endpoint**: `POST /api/venues/:id/reviews`
* **Payload**: `{ source, authorName, rating, content, tags }`

---

### 5️⃣ Tạo tin nhắn Chia sẻ rủ bạn bè Zalo/Messenger (`POST /api/outings/generate-share-text`)
* **Endpoint**: `POST /api/outings/generate-share-text`
* **Payload**: `{ venue, friends, groupScore, outingCode }`
* **Response**: `{ message, shareUrl, venueName }`

---

### 6️⃣ Geocoding tìm địa chỉ bạn bè (`GET /api/geocode?q={tên đường/quận}`)
* **Endpoint**: `GET /api/geocode?q=Landmark%2081`
* **Response**: `{ lat, lng, address }`

---

## 🎨 3. Nhiệm vụ Frontend AI có thể tiếp quản và mở rộng

Frontend tích hợp sẵn tại `public/index.html` hiện đã chạy mượt mà 100% tất cả các tính năng trên.  
Nếu bạn (Frontend AI) muốn nâng cấp thêm giao diện riêng (như React/Next.js/Vue/Mobile App):
1. **Mobile Bottom-Sheet UX**: Thiết kế ngăn kéo vuốt mượt mà trên điện thoại khi xem danh sách quán.
2. **Animation**: Hiệu ứng radar quét sóng và pháo hoa ăn mừng khi chốt quán ăn (`groupScore > 90`).
3. **Mã QR Code Outing**: Tạo mã QR dẫn thẳng vào link buổi hẹn để bạn bè quét camera tham gia.
4. **Theme Toggling**: Chuyển đổi Dark Mode / Cyberpunk Amber / Light Mode.

> 💡 Mọi API backend đều đang lắng nghe tại http://localhost:3000, trả về định dạng JSON chuẩn RFC và đã bật CORS cho mọi domain.
