const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.startsWith('http'));

let dbClient = null;
let sqliteDb = null;

// Initial curated 10 venues from specification
const INITIAL_VENUES = [
    {
        "id": "hcm-vnu-01",
        "name": "The Workshop Coffee",
        "category": "Specialty Coffee & Workspace",
        "type": "cafe",
        "isAlley": false,
        "alleyNote": "",
        "address": "27 Ngô Đức Kế, Bến Nghé, District 1, HCMC",
        "placeId": "ChIJP3Sa8zi1NTERV2zZ_v4GkAI",
        "lat": 10.7735,
        "lng": 106.7042,
        "rating": 4.8,
        "reviewsCount": 1450,
        "pricePerPersonVnd": 75000,
        "avgPrice": "60k - 100k VND",
        "attributes": {
            "noiseLevel": {
                "value": "quiet",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "spacious_tables_power_outlets",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": true,
                "confidence": "high"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "moderate",
                "note": "Tầng trệt gửi xe 10k",
                "confidence": "high"
            }
        },
        "tags": [
            "Quiet",
            "Workspace",
            "Specialty Coffee",
            "Aesthetic",
            "Power Outlets"
        ],
        "unknowns": [
            "Đỗ ô tô: Khuyên gửi hầm Bitexco",
            "Thẻ quốc tế: Xác nhận tại quầy"
        ]
    },
    {
        "id": "hcm-vnu-02",
        "name": "Quán Bụi — Authentic Vietnamese",
        "category": "Traditional Vietnamese Dining",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "19 Ngô Văn Năm, Bến Nghé, District 1, HCMC",
        "placeId": "ChIJ4S9tEji1NTER8Y3U03mYp_k",
        "lat": 10.7818,
        "lng": 106.7055,
        "rating": 4.7,
        "reviewsCount": 1890,
        "pricePerPersonVnd": 120000,
        "avgPrice": "90k - 180k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "comfortable_bamboo_chairs",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": true,
                "halal": false,
                "noAlcohol": false
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "high"
            },
            "parking": {
                "ease": "easy",
                "note": "Có bảo vệ dắt xe tận nơi",
                "confidence": "verified"
            }
        },
        "tags": [
            "Vietnamese",
            "Hearty Meal",
            "Vegetarian Options",
            "Cozy",
            "Group Dining"
        ],
        "unknowns": [
            "Phòng VIP máy lạnh: Cần đặt trước"
        ]
    },
    {
        "id": "hcm-vnu-03",
        "name": "Quán Ăn Hẻm 200 Xóm Chiếu (Seafood & Snails)",
        "category": "Saigon Alley Eatery & Night Street Food",
        "type": "alley_eatery",
        "isAlley": true,
        "alleyNote": "Vào hẻm 200 Xóm Chiếu 40m, quán nằm ngay khúc cua đèn lồng đỏ",
        "address": "Hẻm 200 Xóm Chiếu, Phường 14, Quận 4, TP.HCM",
        "placeId": "ChIJN_8mSza1NTER3gK1vTqDqQw",
        "lat": 10.7608,
        "lng": 106.705,
        "rating": 4.6,
        "reviewsCount": 820,
        "pricePerPersonVnd": 45000,
        "avgPrice": "30k - 65k VND",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "plastic_stools",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": false
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "none",
                "confidence": "high"
            },
            "parking": {
                "ease": "moderate",
                "note": "Gửi xe đầu hẻm 5k",
                "confidence": "verified"
            }
        },
        "tags": [
            "Alley Eatery",
            "Budget (<50k)",
            "Seafood & Snails",
            "Hearty Meal",
            "Street Food"
        ],
        "unknowns": [
            "Chuyển khoản: Sóng đôi lúc chập chờn, nên chuẩn bị tiền mặt"
        ]
    },
    {
        "id": "hcm-vnu-04",
        "name": "Hum Vegetarian, Lounge & Restaurant",
        "category": "Fine Vegetarian Dining & Botanical Lounge",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "32 Võ Văn Tần, Phường Võ Thị Sáu, Quận 3, TP.HCM",
        "placeId": "ChIJV4rXp_W0NTERd6d4aO4Q2aM",
        "lat": 10.7782,
        "lng": 106.6912,
        "rating": 4.9,
        "reviewsCount": 2600,
        "pricePerPersonVnd": 150000,
        "avgPrice": "120k - 250k VND",
        "attributes": {
            "noiseLevel": {
                "value": "quiet",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "luxury_wooden_sofa",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": true,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": true,
                "confidence": "high"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Bãi xe máy và ô tô rộng rãi",
                "confidence": "verified"
            }
        },
        "tags": [
            "Vegetarian",
            "Quiet",
            "Botanical",
            "Photogenic",
            "No Alcohol"
        ],
        "unknowns": [
            "Món không gluten: Báo phục vụ để tùy chỉnh riêng"
        ]
    },
    {
        "id": "hcm-vnu-05",
        "name": "Okkio Caffe — Artisan Matcha & Coffee",
        "category": "Specialty Café & Japanese Ceremonial Matcha",
        "type": "cafe",
        "isAlley": false,
        "alleyNote": "",
        "address": "120-122 Lê Lợi, Bến Thành, District 1, HCMC",
        "placeId": "ChIJUzQ_f_e0NTERz0sW7fWd3YQ",
        "lat": 10.7725,
        "lng": 106.6978,
        "rating": 4.7,
        "reviewsCount": 950,
        "pricePerPersonVnd": 65000,
        "avgPrice": "55k - 85k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "modern_aesthetic_chairs",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": true,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": true,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "moderate",
                "note": "Gửi xe hầm đối diện",
                "confidence": "high"
            }
        },
        "tags": [
            "Artisan Matcha",
            "Retro Aesthetic",
            "Specialty Coffee",
            "Conversation"
        ],
        "unknowns": [
            "Ổ cắm điện: Chỉ có ở một số bàn sát tường"
        ]
    },
    {
        "id": "hcm-vnu-06",
        "name": "Bánh Xèo Tôm Nhảy Bà Hai (Hẻm 119 Bàn Cờ)",
        "category": "Authentic Saigon Crispy Crepe Alley",
        "type": "alley_eatery",
        "isAlley": true,
        "alleyNote": "Vào hẻm 119 Bàn Cờ 25m, bảng hiệu đèn led vàng",
        "address": "119/8 Bàn Cờ, Phường 3, Quận 3, TP.HCM",
        "placeId": "ChIJz2xP_fG0NTER9F9hU71234A",
        "lat": 10.7685,
        "lng": 106.6815,
        "rating": 4.6,
        "reviewsCount": 620,
        "pricePerPersonVnd": 45000,
        "avgPrice": "35k - 55k VND",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "standard_steel_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "medium"
            },
            "parking": {
                "ease": "easy",
                "note": "Để xe miễn phí trước cửa quán",
                "confidence": "verified"
            }
        },
        "tags": [
            "Alley Eatery",
            "Budget (<50k)",
            "Crispy Crepe",
            "Veg Option",
            "Hearty Meal"
        ],
        "unknowns": [
            "Máy lạnh: Dùng quạt công suất lớn"
        ]
    },
    {
        "id": "hcm-vnu-07",
        "name": "Acoustic Bar Saigon — Live Music & Pub",
        "category": "Live Music & Craft Beer Lounge",
        "type": "bar",
        "isAlley": true,
        "alleyNote": "Hẻm 6E Ngô Thời Nhiệm, cuối hẻm cụt cách âm yên tĩnh",
        "address": "6E Ngô Thời Nhiệm, Phường Võ Thị Sáu, Quận 3, TP.HCM",
        "placeId": "ChIJN_123_W0NTER3gK1vTqDqQQ",
        "lat": 10.7812,
        "lng": 106.689,
        "rating": 4.7,
        "reviewsCount": 1100,
        "pricePerPersonVnd": 95000,
        "avgPrice": "70k - 140k VND",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "bar_stools_cushions",
                "confidence": "high"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": false
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "moderate",
                "confidence": "medium"
            },
            "parking": {
                "ease": "easy",
                "note": "Bảo vệ trông xe ngay đầu hẻm",
                "confidence": "verified"
            }
        },
        "tags": [
            "Live Acoustic Music",
            "Craft Beer",
            "Night Chill",
            "Open Late",
            "Lively"
        ],
        "unknowns": [
            "Phụ thu nhạc sống: Khoảng 50k vào đêm cuối tuần"
        ]
    },
    {
        "id": "hcm-vnu-08",
        "name": "Dabao Concept — Heritage Garden Café",
        "category": "Imperial Heritage Café & Tropical Courtyard",
        "type": "cafe",
        "isAlley": true,
        "alleyNote": "Hẻm 18 Tú Xương rợp bóng cây cổ thụ yên bình",
        "address": "18 Tú Xương, Phường Võ Thị Sáu, Quận 3, TP.HCM",
        "placeId": "ChIJd24_f_W0NTER19aW7fWd3YX",
        "lat": 10.7825,
        "lng": 106.6865,
        "rating": 4.8,
        "reviewsCount": 1320,
        "pricePerPersonVnd": 68000,
        "avgPrice": "55k - 85k VND",
        "attributes": {
            "noiseLevel": {
                "value": "quiet",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "vintage_wood_garden_chairs",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": true,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": true,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Bãi để xe có mái che rộng",
                "confidence": "verified"
            }
        },
        "tags": [
            "Quiet",
            "Photogenic Garden",
            "Courtyard",
            "Matcha & Lotus Tea",
            "Relax"
        ],
        "unknowns": [
            "Khu vực hút thuốc: Chỉ được hút ở sân sau"
        ]
    },
    {
        "id": "hcm-vnu-09",
        "name": "Snob Coffee 24/7 (Boardgame & Late Study)",
        "category": "24/7 Coffee & Co-working Lounge",
        "type": "cafe",
        "isAlley": false,
        "alleyNote": "",
        "address": "185 Nguyễn Thị Minh Khai, Phường Phạm Ngũ Lão, Quận 1, TP.HCM",
        "placeId": "ChIJy_183_W0NTER3gK1vTqDqQZ",
        "lat": 10.771,
        "lng": 106.6895,
        "rating": 4.5,
        "reviewsCount": 880,
        "pricePerPersonVnd": 45000,
        "avgPrice": "35k - 60k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "long_tables_sofa",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": true,
                "confidence": "high"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Bảo vệ ghi vé xe miễn phí trước mặt tiền",
                "confidence": "verified"
            }
        },
        "tags": [
            "Open 24/7",
            "Budget (<50k)",
            "Boardgame",
            "Power Outlets",
            "Night Study"
        ],
        "unknowns": [
            "Tiếng ồn ban đêm: Yên tĩnh hơn sau 0h đêm"
        ]
    },
    {
        "id": "hcm-vnu-10",
        "name": "Bún Thịt Nướng Chị Tuyền (Hẻm 175 Cô Giang)",
        "category": "Legendary Saigon Char-Grilled Pork Noodle",
        "type": "alley_eatery",
        "isAlley": true,
        "alleyNote": "Vào hẻm 175 Cô Giang 10m, quán 30 năm nức tiếng",
        "address": "175c Cô Giang, Phường Cô Giang, Quận 1, TP.HCM",
        "placeId": "ChIJz2xP_fG0NTER9F9hU79999Z",
        "lat": 10.7612,
        "lng": 106.6925,
        "rating": 4.6,
        "reviewsCount": 1420,
        "pricePerPersonVnd": 55000,
        "avgPrice": "45k - 70k VND",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "standard_steel_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "medium"
            },
            "parking": {
                "ease": "moderate",
                "note": "Có người hướng dẫn để xe trước hẻm",
                "confidence": "high"
            }
        },
        "tags": [
            "Alley Eatery",
            "Char-Grilled Pork",
            "Hearty Meal",
            "Flavorful",
            "Budget"
        ],
        "unknowns": [
            "Nhanh hết hàng: Thường hết bún sau 20h"
        ]
    },
    {
        "id": "hcm-vnu-11",
        "name": "Sủi Cảo Đại Ký (Phố Sủi Cảo Hà Tôn Quyền)",
        "category": "Chợ Lớn Handcrafted Shrimp Dumplings & Egg Noodles",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "192 Hà Tôn Quyền, Phường 4, Quận 11 (Giáp Quận 5), TP.HCM",
        "placeId": "ChIJ_sui_cao_dai_ky_q5",
        "lat": 10.7584,
        "lng": 106.6578,
        "rating": 4.6,
        "reviewsCount": 1980,
        "pricePerPersonVnd": 65000,
        "avgPrice": "50k - 85k VND",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "steel_tables_fans",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "high"
            },
            "parking": {
                "ease": "easy",
                "note": "Bảo vệ dắt xe vào bãi miễn phí",
                "confidence": "verified"
            }
        },
        "tags": [
            "Sủi Cảo Chợ Lớn",
            "Hearty Meal",
            "Authentic",
            "Budget",
            "Group Dining"
        ],
        "unknowns": [
            "Giờ cao điểm: Từ 18h30 - 20h thường phải đợi xếp bàn 5-10 phút"
        ]
    },
    {
        "id": "hcm-vnu-12",
        "name": "Dim Tu Tac — Ẩm Thực Quảng Đông",
        "category": "Premium Cantonese Dim Sum & Tea House",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "29B Trần Hưng Đạo, Phường 6, Quận 5, TP.HCM",
        "placeId": "ChIJ_dim_tu_tac_tran_hung_dao",
        "lat": 10.7548,
        "lng": 106.6712,
        "rating": 4.7,
        "reviewsCount": 2450,
        "pricePerPersonVnd": 180000,
        "avgPrice": "140k - 300k VND",
        "attributes": {
            "noiseLevel": {
                "value": "quiet",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "luxury_cushions_round_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": false,
                "halal": false,
                "noAlcohol": false
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Bãi ô tô và xe máy rộng rãi có nhân viên",
                "confidence": "verified"
            }
        },
        "tags": [
            "Dimsum",
            "Cantonese",
            "Quiet",
            "Family & Friends",
            "Spacious AC"
        ],
        "unknowns": [
            "Đặt bàn trước: Cuối tuần nên gọi trước 2 tiếng"
        ]
    },
    {
        "id": "hcm-vnu-13",
        "name": "Cơm Gà Đông Nguyên (Gia Truyền Chợ Lớn)",
        "category": "Traditional Herbal Boiled Chicken & Tonic Soup",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "801 Nguyễn Trãi, Phường 14, Quận 5, TP.HCM",
        "placeId": "ChIJ_dong_nguyen_chicken_rice",
        "lat": 10.7525,
        "lng": 106.662,
        "rating": 4.5,
        "reviewsCount": 3200,
        "pricePerPersonVnd": 85000,
        "avgPrice": "65k - 120k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "traditional_wooden_chairs",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "high"
            },
            "parking": {
                "ease": "easy",
                "note": "Có chỗ giữ xe mặt tiền",
                "confidence": "verified"
            }
        },
        "tags": [
            "Cơm Gà Chợ Lớn",
            "Canh Tiềm Thảo Mộc",
            "Authentic",
            "Hearty Meal"
        ],
        "unknowns": [
            "Canh tiềm óc heo / sâm: Thường hết sớm sau 19h"
        ]
    },
    {
        "id": "hcm-vnu-14",
        "name": "Nhà Hàng Chay Bếp Xanh An Duyên",
        "category": "Artisan Zen Vegetarian & Botanical Teahouse",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "10 Nguyễn Tri Phương, Phường 6, Quận 5, TP.HCM",
        "placeId": "ChIJ_chay_bep_xanh_an_duyen",
        "lat": 10.7552,
        "lng": 106.6685,
        "rating": 4.8,
        "reviewsCount": 1100,
        "pricePerPersonVnd": 95000,
        "avgPrice": "75k - 150k VND",
        "attributes": {
            "noiseLevel": {
                "value": "quiet",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "zen_bamboo_sofa",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": true,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": true,
                "confidence": "high"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Bãi đỗ xe máy an toàn",
                "confidence": "verified"
            }
        },
        "tags": [
            "Vegetarian",
            "Vegan",
            "Quiet",
            "Lẩu Nấm Dưỡng Sinh",
            "No Alcohol"
        ],
        "unknowns": [
            "Ngày rằm / mùng 1: Nên đặt chỗ trước để tránh hết bàn"
        ]
    },
    {
        "id": "hcm-vnu-15",
        "name": "Lẩu Bò Cô Thảo (Hẻm Chợ Hoa Hồ Thị Kỷ)",
        "category": "Legendary Alley Beef Hotpot & Marrow Bone",
        "type": "alley_eatery",
        "isAlley": true,
        "alleyNote": "Vào hẻm 84 Hồ Thị Kỷ khoảng 50m trong chợ hoa đêm",
        "address": "84/10 Hồ Thị Kỷ, Phường 1, Quận 10, TP.HCM",
        "placeId": "ChIJ_lau_bo_co_thao_ho_thi_ky",
        "lat": 10.7635,
        "lng": 106.678,
        "rating": 4.6,
        "reviewsCount": 1850,
        "pricePerPersonVnd": 75000,
        "avgPrice": "60k - 110k VND",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "steel_tables_plastic_chairs",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": false
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "moderate",
                "confidence": "medium"
            },
            "parking": {
                "ease": "moderate",
                "note": "Gửi xe đầu hẻm chợ hoa 5k",
                "confidence": "verified"
            }
        },
        "tags": [
            "Alley Eatery",
            "Lẩu Bò Tủy",
            "Lively",
            "Street Food",
            "Night Hangout"
        ],
        "unknowns": [
            "Không gian: Hẻm ăn nhậu đông đúc, không có máy lạnh"
        ]
    },
    {
        "id": "hcm-vnu-16",
        "name": "Chè Mâm Khánh Vy (Sư Vạn Hạnh)",
        "category": "Iconic 16-Bowl Traditional Sweet Soup Tray",
        "type": "cafe",
        "isAlley": false,
        "alleyNote": "",
        "address": "242B Sư Vạn Hạnh, Phường 2, Quận 10, TP.HCM",
        "placeId": "ChIJ_che_mam_su_van_hanh",
        "lat": 10.7628,
        "lng": 106.6705,
        "rating": 4.5,
        "reviewsCount": 1150,
        "pricePerPersonVnd": 35000,
        "avgPrice": "25k - 45k VND",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "low_stools_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "medium"
            },
            "parking": {
                "ease": "easy",
                "note": "Để xe ngay vỉa hè trước quán",
                "confidence": "verified"
            }
        },
        "tags": [
            "Budget (<50k)",
            "Chè Mâm",
            "Street Dessert",
            "Late Night Sweet"
        ],
        "unknowns": [
            "Chỉ nhận tiền mặt hoặc chuyển khoản QR"
        ]
    },
    {
        "id": "hcm-vnu-17",
        "name": "Bánh Canh Cua Út Lệ (Tô Hiến Thành)",
        "category": "Rich Fresh Crab Tapioca Noodle & Crispy Dough",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "210 Tô Hiến Thành, Phường 15, Quận 10, TP.HCM",
        "placeId": "ChIJ_banh_canh_cua_ut_le",
        "lat": 10.7788,
        "lng": 106.6658,
        "rating": 4.6,
        "reviewsCount": 1600,
        "pricePerPersonVnd": 65000,
        "avgPrice": "55k - 80k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "spacious_indoor_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Có bảo vệ xếp xe cẩn thận",
                "confidence": "verified"
            }
        },
        "tags": [
            "Bánh Canh Cua",
            "Hearty Meal",
            "Flavorful Broth",
            "Crab & Shrimp"
        ],
        "unknowns": [
            "Chả cua cây thêm: 15k/cây"
        ]
    },
    {
        "id": "hcm-vnu-18",
        "name": "Cơm Tấm Ba Ghiền (Michelin Bib Gourmand)",
        "category": "Saigon Giant Char-Grilled Pork Chop Broken Rice",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "84 Đặng Văn Ngữ, Phường 10, Phú Nhuận, TP.HCM",
        "placeId": "ChIJ_com_tam_ba_ghien",
        "lat": 10.7932,
        "lng": 106.672,
        "rating": 4.5,
        "reviewsCount": 4600,
        "pricePerPersonVnd": 95000,
        "avgPrice": "75k - 130k VND",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "standard_steel_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "medium"
            },
            "parking": {
                "ease": "moderate",
                "note": "Bảo vệ dắt xe trước cửa",
                "confidence": "verified"
            }
        },
        "tags": [
            "Cơm Tấm Sườn Khổng Lồ",
            "Michelin Bib Gourmand",
            "Hearty Meal",
            "Legendary"
        ],
        "unknowns": [
            "Khói nướng sườn thơm đặc trưng lan tỏa khu vực mặt tiền"
        ]
    },
    {
        "id": "hcm-vnu-19",
        "name": "The Dome Kaffe (Hẻm 10 Đoàn Thị Điểm)",
        "category": "Minimalist Japanese White-Tone Café & Matcha Latte",
        "type": "cafe",
        "isAlley": true,
        "alleyNote": "Vào hẻm 10 Đoàn Thị Điểm 20m, quán tone trắng đen tối giản",
        "address": "10/16 Đoàn Thị Điểm, Phường 1, Phú Nhuận, TP.HCM",
        "placeId": "ChIJ_the_dome_kaffe",
        "lat": 10.7962,
        "lng": 106.685,
        "rating": 4.7,
        "reviewsCount": 1050,
        "pricePerPersonVnd": 60000,
        "avgPrice": "50k - 75k VND",
        "attributes": {
            "noiseLevel": {
                "value": "quiet",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "minimalist_sofa_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": true,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": true,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Để xe trong sân hẻm trước cửa quán",
                "confidence": "verified"
            }
        },
        "tags": [
            "Artisan Matcha",
            "Quiet",
            "Workspace",
            "Photogenic Minimalist",
            "Pastry"
        ],
        "unknowns": [
            "Không gian yên tĩnh: Phù hợp đọc sách hoặc làm việc máy tính"
        ]
    },
    {
        "id": "hcm-vnu-20",
        "name": "Quán Bún Bò Huế Ba Nghị (Nguyễn Văn Đậu)",
        "category": "Authentic Imperial Hue Spicy Beef & Crab Cake Noodle",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "466 Nguyễn Văn Đậu, Phường 11, Bình Thạnh, TP.HCM",
        "placeId": "ChIJ_bun_bo_ba_nghi",
        "lat": 10.8175,
        "lng": 106.6908,
        "rating": 4.7,
        "reviewsCount": 1340,
        "pricePerPersonVnd": 60000,
        "avgPrice": "50k - 75k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "spacious_air_conditioned_hall",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Bãi xe máy rộng rãi có người trông",
                "confidence": "verified"
            }
        },
        "tags": [
            "Bún Bò Huế Chuẩn Vị",
            "Sa Tế Cay Nồng",
            "Hearty Meal",
            "Air Conditioned"
        ],
        "unknowns": [
            "Chả cua hấp: Có thể gọi thêm phần riêng 20k"
        ]
    },
    {
        "id": "hcm-vnu-21",
        "name": "Mì Quảng Sâm (Ca Văn Thỉnh)",
        "category": "Central Vietnam Turmeric Rice Noodle & Crispy Cracker",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "8 Ca Văn Thỉnh, Phường 11, Tân Bình, TP.HCM",
        "placeId": "ChIJ_mi_quang_sam",
        "lat": 10.7895,
        "lng": 106.6508,
        "rating": 4.6,
        "reviewsCount": 1450,
        "pricePerPersonVnd": 55000,
        "avgPrice": "45k - 65k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "high"
            },
            "seatingComfort": {
                "value": "clean_wooden_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "high"
            },
            "parking": {
                "ease": "easy",
                "note": "Để xe trước mặt tiền rộng",
                "confidence": "verified"
            }
        },
        "tags": [
            "Mì Quảng Chuẩn Vị",
            "Mì Quảng Ếch",
            "Bánh Tráng Mè Nướng",
            "Budget"
        ],
        "unknowns": [
            "Có phục vụ rau sống trụng theo yêu cầu"
        ]
    },
    {
        "id": "hcm-vnu-22",
        "name": "Phở Hòa Pasteur (60 Năm Gia Truyền)",
        "category": "Heritage Saigon Beef Pho & Crispy Fried Dough",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "260C Pasteur, Phường Võ Thị Sáu, Quận 3, TP.HCM",
        "placeId": "ChIJ_pho_hoa_pasteur",
        "lat": 10.7876,
        "lng": 106.6904,
        "rating": 4.5,
        "reviewsCount": 5800,
        "pricePerPersonVnd": 95000,
        "avgPrice": "85k - 110k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "vintage_clean_steel_tables",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "fast",
                "confidence": "verified"
            },
            "parking": {
                "ease": "easy",
                "note": "Nhân viên bảo vệ ghi vé dắt xe chu đáo",
                "confidence": "verified"
            }
        },
        "tags": [
            "Phở Bò Gia Truyền",
            "Nước Dùng Đậm Đà",
            "Hearty Meal",
            "Saigon Icon"
        ],
        "unknowns": [
            "Bánh su kem và quẩy giòn tính tiền theo số lượng ăn"
        ]
    },
    {
        "id": "hcm-vnu-23",
        "name": "Bánh Mì Huỳnh Hoa (Lê Thị Riêng)",
        "category": "Saigon Signature Heavy-Loaded Pâté & Ham Baguette",
        "type": "takeaway",
        "isAlley": false,
        "alleyNote": "",
        "address": "26 Lê Thị Riêng, Phường Bến Thành, Quận 1, TP.HCM",
        "placeId": "ChIJ_banh_mi_huynh_hoa",
        "lat": 10.7712,
        "lng": 106.6923,
        "rating": 4.4,
        "reviewsCount": 6200,
        "pricePerPersonVnd": 68000,
        "avgPrice": "68k VND / ổ đặc biệt",
        "attributes": {
            "noiseLevel": {
                "value": "lively",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "takeaway_limited_bench",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": false,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "none",
                "confidence": "high"
            },
            "parking": {
                "ease": "moderate",
                "note": "Có bảo vệ điều phối dừng xe lấy bánh",
                "confidence": "verified"
            }
        },
        "tags": [
            "Bánh Mì Ô-môi",
            "Pate Béo Ngậy",
            "Đồ Chua Giòn Tan",
            "Saigon Icon"
        ],
        "unknowns": [
            "Chủ yếu bán mang về (Takeaway), ổ rất to đủ 2 người ăn nhỏ"
        ]
    },
    {
        "id": "hcm-vnu-24",
        "name": "Bánh Cuốn Tây Hồ (Đinh Tiên Hoàng)",
        "category": "60-Year Legacy Steamed Rice Rolls & Cinnamon Pork Sausage",
        "type": "restaurant",
        "isAlley": false,
        "alleyNote": "",
        "address": "127 Đinh Tiên Hoàng, Phường Đa Kao, Quận 1, TP.HCM",
        "placeId": "ChIJ_banh_cuon_tay_ho",
        "lat": 10.7925,
        "lng": 106.6975,
        "rating": 4.5,
        "reviewsCount": 2100,
        "pricePerPersonVnd": 55000,
        "avgPrice": "45k - 70k VND",
        "attributes": {
            "noiseLevel": {
                "value": "moderate",
                "confidence": "verified"
            },
            "seatingComfort": {
                "value": "classic_dining_chairs",
                "confidence": "verified"
            },
            "dietary": {
                "vegetarian": true,
                "vegan": false,
                "halal": false,
                "noAlcohol": true
            },
            "matcha": {
                "value": false,
                "confidence": "verified"
            },
            "wifiSpeed": {
                "value": "normal",
                "confidence": "high"
            },
            "parking": {
                "ease": "easy",
                "note": "Bảo vệ dắt xe trước cửa hàng",
                "confidence": "verified"
            }
        },
        "tags": [
            "Bánh Cuốn Gia Truyền",
            "Chả Lụa Quế",
            "Bánh Tôm Giòn",
            "Breakfast & Dining"
        ],
        "unknowns": [
            "Có bánh cuốn chay nhân nấm mộc nhĩ thanh đạm"
        ]
    }
];

if (isSupabaseConfigured) {
    dbClient = createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log('✅ Connected to Supabase Cloud Database:', SUPABASE_URL);
} else {
    const dbPath = path.join(__dirname, 'gathermap.db');
    sqliteDb = new Database(dbPath);
    initSqliteSchema(sqliteDb);
    console.log('📦 Connected to Local Persistent Database (SQLite):', dbPath);
}

function initSqliteSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS outings (
            id TEXT PRIMARY KEY,
            name TEXT,
            mode TEXT DEFAULT 'representative',
            center_lat REAL NOT NULL,
            center_lng REAL NOT NULL,
            radius_km REAL NOT NULL DEFAULT 3.0,
            status TEXT NOT NULL DEFAULT 'active',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS participants (
            id TEXT PRIMARY KEY,
            outing_id TEXT NOT NULL,
            name TEXT NOT NULL,
            district TEXT,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            wish TEXT,
            is_me INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS venues (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            type TEXT NOT NULL,
            is_alley INTEGER DEFAULT 0,
            alley_note TEXT,
            address TEXT NOT NULL,
            place_id TEXT,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            rating REAL DEFAULT 4.5,
            reviews_count INTEGER DEFAULT 100,
            price_per_person_vnd INTEGER DEFAULT 60000,
            avg_price TEXT DEFAULT '35k - 80k VND',
            tags TEXT DEFAULT '[]',
            attributes TEXT DEFAULT '{}',
            unknowns TEXT DEFAULT '[]'
        );

        CREATE TABLE IF NOT EXISTS recommendations (
            id TEXT PRIMARY KEY,
            outing_id TEXT NOT NULL,
            venue_id TEXT NOT NULL,
            group_score REAL NOT NULL,
            avg_score REAL NOT NULL,
            lowest_score REAL NOT NULL,
            ai_rationale TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS votes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            outing_id TEXT NOT NULL,
            venue_id TEXT NOT NULL,
            voter_name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(outing_id, venue_id, voter_name)
        );

        CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY,
            venue_id TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'google',
            author_name TEXT NOT NULL,
            author_avatar TEXT,
            rating REAL DEFAULT 5.0,
            content TEXT NOT NULL,
            sentiment TEXT DEFAULT 'positive',
            tags TEXT DEFAULT '[]',
            likes_count INTEGER DEFAULT 0,
            review_date TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_reviews_venue_id ON reviews(venue_id);
        CREATE INDEX IF NOT EXISTS idx_reviews_source ON reviews(source);
    `);

    // Seed curated 10 venues
    const count = db.prepare('SELECT COUNT(*) as count FROM venues').get().count;
    if (count < 24) {
        db.prepare('DELETE FROM venues').run();
        const insert = db.prepare(`
            INSERT INTO venues (
                id, name, category, type, is_alley, alley_note,
                address, place_id, lat, lng, rating, reviews_count,
                price_per_person_vnd, avg_price, tags, attributes, unknowns
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const v of INITIAL_VENUES) {
            insert.run(
                v.id,
                v.name,
                v.category,
                v.type,
                v.isAlley ? 1 : 0,
                v.alleyNote || '',
                v.address,
                v.placeId || '',
                v.lat,
                v.lng,
                v.rating,
                v.reviewsCount,
                v.pricePerPersonVnd,
                v.avgPrice,
                JSON.stringify(v.tags),
                JSON.stringify(v.attributes),
                JSON.stringify(v.unknowns)
            );
        }
        console.log(`🌱 Seeded ${INITIAL_VENUES.length} curated HCMC venues into SQLite`);
    }
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

async function getAllVenues() {
    if (isSupabaseConfigured) {
        try {
            const { data, error } = await dbClient.from('venues').select('*');
            if (error) throw error;
            return (data || []).map(formatVenueRecord);
        } catch (e) {
            console.error('Supabase query error:', e.message);
        }
    }
    const rows = sqliteDb.prepare('SELECT * FROM venues').all();
    return rows.map(formatVenueRecord);
}

async function getVenuesInRadius({ lat, lng, radiusKm = 3 }) {
    const venues = await getAllVenues();
    return venues.map(v => {
        const distKm = haversineKm(lat, lng, v.lat, v.lng);
        return {
            ...v,
            distFromCenterKm: Number(distKm.toFixed(2))
        };
    }).filter(v => v.distFromCenterKm <= radiusKm);
}

function formatVenueRecord(r) {
    const rawAttrs = r.attributes || r.traits || {};
    const attrs = typeof rawAttrs === 'string' ? JSON.parse(rawAttrs || '{}') : (rawAttrs || {});

    // Ensure nested objects always exist so safe access never throws
    const dietary = attrs.dietary || { vegetarian: false, noAlcohol: false };
    const noiseLevel = attrs.noiseLevel || { value: 'moderate' };
    const matcha = attrs.matcha || { value: false };
    const safeAttrs = {
        ...attrs,
        dietary,
        noiseLevel,
        matcha
    };

    const rawHighlights = r.social_highlights || attrs.social_highlights || {};
    const socialHighlights = typeof rawHighlights === 'string' ? JSON.parse(rawHighlights || '{}') : (rawHighlights || {});

    return {
        id: r.id,
        name: r.name,
        category: r.category,
        type: r.type || attrs.type || 'restaurant',
        isAlley: Boolean(r.is_alley !== undefined ? r.is_alley : attrs.is_alley),
        alleyNote: r.alley_note || attrs.alley_note || '',
        address: r.address,
        placeId: r.place_id || attrs.place_id || '',
        lat: Number(r.lat),
        lng: Number(r.lng),
        rating: Number(r.rating || 4.5),
        reviewsCount: Number(r.reviews_count || 100),
        pricePerPersonVnd: Number(r.price_per_person_vnd || attrs.price_per_person_vnd || 50000),
        avgPrice: r.avg_price || '35k - 80k VND',
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags || '[]') : (r.tags || []),
        attributes: safeAttrs,
        unknowns: typeof r.unknowns === 'string' ? JSON.parse(r.unknowns || '[]') : (r.unknowns || []),
        socialHighlights
    };
}


async function saveOuting({ id, name = 'Weekend Hangout', mode = 'representative', centerLat, centerLng, radiusKm = 3 }) {
    const outingId = id || ('outing_' + Date.now());
    if (isSupabaseConfigured) {
        try {
            await dbClient.from('outings').upsert([{
                id: outingId,
                name,
                mode,
                center_lat: centerLat,
                center_lng: centerLng,
                radius_km: radiusKm
            }]);
        } catch (e) {
            console.error('Supabase saveOuting error:', e.message);
        }
    } else {
        sqliteDb.prepare(`
            INSERT OR REPLACE INTO outings (id, name, mode, center_lat, center_lng, radius_km)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(outingId, name, mode, centerLat, centerLng, radiusKm);
    }
    return outingId;
}

async function getOuting(id) {
    if (isSupabaseConfigured) {
        try {
            const { data } = await dbClient.from('outings').select('*').eq('id', id).single();
            return data;
        } catch (e) {
            console.error('Supabase getOuting error:', e.message);
        }
    }
    return sqliteDb.prepare('SELECT * FROM outings WHERE id = ?').get(id);
}

async function saveParticipants(outingId, participants = []) {
    if (!participants || participants.length === 0) return;
    if (isSupabaseConfigured) {
        try {
            await dbClient.from('participants').insert(participants.map(p => ({
                id: p.id || ('part_' + Math.random().toString(36).substr(2, 9)),
                outing_id: outingId,
                name: p.name,
                district: p.district || '',
                lat: p.lat,
                lng: p.lng,
                wish: p.wish || ''
            })));
        } catch (e) {
            console.error('Supabase saveParticipants error:', e.message);
        }
    } else {
        const stmt = sqliteDb.prepare(`
            INSERT OR REPLACE INTO participants (id, outing_id, name, district, lat, lng, wish)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const p of participants) {
            stmt.run(
                p.id || ('part_' + Math.random().toString(36).substr(2, 9)),
                outingId,
                p.name || 'Friend',
                p.district || '',
                p.lat != null ? p.lat : 10.7769,
                p.lng != null ? p.lng : 106.7009,
                p.wish || ''
            );
        }
    }
}

async function saveRecommendations(outingId, recommendations = []) {
    if (!recommendations || recommendations.length === 0) return;
    if (isSupabaseConfigured) {
        try {
            await dbClient.from('recommendations').insert(recommendations.map(r => ({
                id: 'rec_' + Math.random().toString(36).substr(2, 9),
                outing_id: outingId,
                venue_id: r.id,
                group_score: r.groupScore,
                avg_score: r.avgScore,
                lowest_score: r.lowestScore,
                ai_rationale: r.aiRationale || ''
            })));
        } catch (e) {
            console.error('Supabase saveRecommendations error:', e.message);
        }
    } else {
        const stmt = sqliteDb.prepare(`
            INSERT INTO recommendations (id, outing_id, venue_id, group_score, avg_score, lowest_score, ai_rationale)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const r of recommendations) {
            stmt.run(
                'rec_' + Math.random().toString(36).substr(2, 9),
                outingId,
                r.id,
                r.groupScore || 0,
                r.avgScore || 0,
                r.lowestScore || 0,
                r.aiRationale || (r.principalReasons || []).join('. ')
            );
        }
    }
}

async function recordVote(outingId, venueId, voterName = 'Guest') {
    if (isSupabaseConfigured) {
        try {
            await dbClient.from('votes').insert([{ outing_id: outingId, venue_id: venueId, voter_name: voterName }]);
        } catch (e) {
            console.error('Supabase recordVote error:', e.message);
        }
    } else {
        sqliteDb.prepare(`
            INSERT OR IGNORE INTO votes (outing_id, venue_id, voter_name)
            VALUES (?, ?, ?)
        `).run(outingId, venueId, voterName);
    }
}

async function getVotes(outingId) {
    if (isSupabaseConfigured) {
        try {
            const { data } = await dbClient.from('votes').select('*').eq('outing_id', outingId);
            const votesMap = {};
            (data || []).forEach(v => {
                if (!votesMap[v.venue_id]) votesMap[v.venue_id] = [];
                votesMap[v.venue_id].push(v.voter_name);
            });
            return votesMap;
        } catch (e) {
            console.error('Supabase getVotes error:', e.message);
        }
    }
    const rows = sqliteDb.prepare('SELECT venue_id, voter_name FROM votes WHERE outing_id = ?').all(outingId);
    const votesMap = {};
    rows.forEach(v => {
        if (!votesMap[v.venue_id]) votesMap[v.venue_id] = [];
        votesMap[v.venue_id].push(v.voter_name);
    });
    return votesMap;
}


// ==========================================
// SOCIAL MEDIA & COMMUNITY REVIEWS SERVICE
// ==========================================
async function getVenueReviews(venueId, limit = 50) {
    if (isSupabaseConfigured) {
        try {
            const { data } = await dbClient.from('reviews').select('*').eq('venue_id', venueId).order('created_at', { ascending: false }).limit(limit);
            return (data || []).map(formatReviewRecord);
        } catch (e) {
            console.error('Supabase getVenueReviews error:', e.message);
        }
    }
    const rows = sqliteDb.prepare('SELECT * FROM reviews WHERE venue_id = ? ORDER BY created_at DESC LIMIT ?').all(venueId, limit);
    return rows.map(formatReviewRecord);
}

async function addVenueReview({ venueId, source = 'user', authorName = 'Kiris (Thực khách)', rating = 5.0, content, sentiment = 'positive', tags = [] }) {
    const id = 'rev-' + Date.now();
    const reviewDate = 'Vừa xong';
    const tagStr = JSON.stringify(tags || []);

    if (isSupabaseConfigured) {
        try {
            await dbClient.from('reviews').insert([{
                id, venue_id: venueId, source, author_name: authorName, rating, content, sentiment, tags: tagStr, review_date: reviewDate
            }]);
            return { id, success: true };
        } catch (e) {
            console.error('Supabase addVenueReview error:', e.message);
        }
    }

    sqliteDb.prepare(`
        INSERT INTO reviews (id, venue_id, source, author_name, rating, content, sentiment, tags, likes_count, review_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, venueId, source, authorName, rating, content, sentiment, tagStr, reviewDate);

    return { id, success: true };
}

async function getVenueReviewsSummary(venueId) {
    const reviews = await getVenueReviews(venueId, 20);
    if (reviews.length === 0) {
        return {
            count: 0,
            avgRating: 4.5,
            sources: ['google'],
            topReview: null
        };
    }
    const avgRating = Number((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1));
    const sources = [...new Set(reviews.map(r => r.source))];
    const topReview = reviews[0];

    return {
        count: reviews.length,
        avgRating,
        sources,
        topReview
    };
}

function formatReviewRecord(r) {
    return {
        id: r.id,
        venueId: r.venue_id,
        source: r.source,
        authorName: r.author_name,
        authorAvatar: r.author_avatar || '',
        rating: Number(r.rating || 5.0),
        content: r.content,
        sentiment: r.sentiment || 'positive',
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags || '[]') : (r.tags || []),
        likesCount: Number(r.likes_count || 0),
        reviewDate: r.review_date || 'Gần đây'
    };
}

async function getVenueReviewerHighlights(venueId) {
    const venues = await getAllVenues();
    const venue = venues.find(v => v.id === venueId);
    const reviews = await getVenueReviews(venueId, 6);
    return {
        venueId,
        name: venue ? venue.name : '',
        address: venue ? venue.address : '',
        category: venue ? venue.category : '',
        rating: venue ? venue.rating : 4.5,
        socialHighlights: venue ? (venue.socialHighlights || {}) : {},
        reviewerCount: reviews.length,
        reviewers: reviews
    };
}

module.exports = {
    isSupabaseConfigured,
    dbType: isSupabaseConfigured ? 'Supabase Cloud Database (PostgreSQL)' : 'Local SQLite Database (gathermap.db)',
    getAllVenues,
    getVenuesInRadius,
    saveOuting,
    getOuting,
    saveParticipants,
    saveRecommendations,
    recordVote,
    getVotes,
    getVenueReviews,
    addVenueReview,
    getVenueReviewsSummary,
    getVenueReviewerHighlights,
    haversineKm,
    INITIAL_VENUES
};
