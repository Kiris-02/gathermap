/**
 * Presets Controller
 * Provides 1-click curated scenario presets for demos and instant testing.
 */

const PRESETS = [
    {
        id: 'preset_cuoituan_3nguoi',
        title: 'Hẹn hò cuối tuần (Q1 - Q3 - Bình Thạnh)',
        tag: '3 người • Món Việt & Cà phê',
        description: 'An ở Bến Thành, Bình ở Hồ Con Rùa, Châu ở Hàng Xanh cùng tìm điểm gặp công bằng.',
        friends: [
            { id: 1, name: 'An', lat: 10.7720, lng: 106.6983, color: 'bg-blue-500', wish: 'Thèm cơm tấm hoặc bún chả' },
            { id: 2, name: 'Bình', lat: 10.7828, lng: 106.6958, color: 'bg-emerald-500', wish: 'Không gian máy lạnh, sạch sẽ' },
            { id: 3, name: 'Châu', lat: 10.8015, lng: 106.7115, color: 'bg-amber-500', wish: 'Giá dưới 100k, ăn no' }
        ],
        constraints: { vegetarian: false, no_alcohol: false, quiet_only: false, max_price_vnd: 120000 },
        softPreferences: [
            { preference: 'Authentic Vietnamese', weight: 5 },
            { preference: 'Comfortable Seating', weight: 4 }
        ],
        radiusMeters: 2500
    },
    {
        id: 'preset_deadline_4nguoi',
        title: 'Cà phê chạy deadline (Q10 - Phú Nhuận - Tân Bình - Q3)',
        tag: '4 người • Yên tĩnh & Wifi',
        description: '4 bạn sinh viên/freelancer cần quán cà phê rộng rãi, nhiều ổ cắm, máy lạnh mát rượi.',
        friends: [
            { id: 1, name: 'Minh', lat: 10.7712, lng: 106.6675, color: 'bg-indigo-500', wish: 'Cần nhiều ổ cắm sạc laptop' },
            { id: 2, name: 'Lan', lat: 10.7985, lng: 106.6872, color: 'bg-pink-500', wish: 'Thích trà trái cây hoặc matcha' },
            { id: 3, name: 'Khoa', lat: 10.7932, lng: 106.6621, color: 'bg-teal-500', wish: 'Bàn rộng làm việc nhóm' },
            { id: 4, name: 'Tú', lat: 10.7811, lng: 106.6835, color: 'bg-purple-500', wish: 'Yên tĩnh, không mở nhạc quá to' }
        ],
        constraints: { vegetarian: false, no_alcohol: true, quiet_only: true, max_price_vnd: 80000 },
        softPreferences: [
            { preference: 'Quiet workspace', weight: 5 },
            { preference: 'Fast Wi-Fi & Power Sockets', weight: 5 }
        ],
        radiusMeters: 3000
    },
    {
        id: 'preset_launuong_cholon_4nguoi',
        title: 'Đại tiệc lẩu nướng (Q5 Chợ Lớn - Q4 - Q1 - Q10)',
        tag: '4 người • Lẩu nướng & Tụ tập',
        description: 'Hội bạn tụ tập liên hoan buổi tối, tìm quán lẩu nướng ngon bổ rẻ, chỗ ngồi thoáng mát.',
        friends: [
            { id: 1, name: 'Hùng', lat: 10.7548, lng: 106.6623, color: 'bg-red-500', wish: 'Thèm lẩu hải sản hoặc đồ nướng' },
            { id: 2, name: 'My', lat: 10.7612, lng: 106.7025, color: 'bg-orange-500', wish: 'Chỗ gửi xe dễ, không gian thoáng' },
            { id: 3, name: 'Đức', lat: 10.7689, lng: 106.6892, color: 'bg-yellow-500', wish: 'Ngon đậm đà chuẩn vị Sài Gòn' },
            { id: 4, name: 'Linh', lat: 10.7645, lng: 106.6710, color: 'bg-emerald-500', wish: 'Ăn uống thả ga, giá sinh viên' }
        ],
        constraints: { vegetarian: false, no_alcohol: false, quiet_only: false, max_price_vnd: 200000 },
        softPreferences: [
            { preference: 'Hotpot & Grill', weight: 5 },
            { preference: 'Spacious & Lively', weight: 4 }
        ],
        radiusMeters: 3500
    }
];

function getPresets(req, res) {
    res.json({ presets: PRESETS });
}

module.exports = {
    getPresets,
    PRESETS
};
