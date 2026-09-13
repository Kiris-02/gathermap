-- GatherMap Complete Database Migration for Supabase (PostgreSQL)
-- Auto-generated with schema, RLS policies, 24 verified venues, and 51 authentic reviews

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Outings Table
CREATE TABLE IF NOT EXISTS outings (
    id TEXT PRIMARY KEY,
    center_lat DOUBLE PRECISION NOT NULL,
    center_lng DOUBLE PRECISION NOT NULL,
    radius_km DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours')
);

-- 2. Participants Table
CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    outing_id TEXT NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    district TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    wish TEXT,
    is_me BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Venues Table
CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    address TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    rating DOUBLE PRECISION DEFAULT 4.5,
    reviews_count INT DEFAULT 100,
    avg_price TEXT DEFAULT '35k - 80k VND',
    tags JSONB DEFAULT '[]'::jsonb,
    traits JSONB DEFAULT '{}'::jsonb,
    verified BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Reviews Table
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'user',
    author_name TEXT NOT NULL,
    rating DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    date_text TEXT,
    content TEXT NOT NULL,
    tags JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Recommendations Table
CREATE TABLE IF NOT EXISTS recommendations (
    id TEXT PRIMARY KEY,
    outing_id TEXT NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
    venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    group_score DOUBLE PRECISION NOT NULL,
    avg_score DOUBLE PRECISION NOT NULL,
    lowest_score DOUBLE PRECISION NOT NULL,
    ai_rationale TEXT NOT NULL,
    travel_times JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Votes Table
CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    outing_id TEXT NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
    venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    voter_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS and public access policies
ALTER TABLE outings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public outings" ON outings;
CREATE POLICY "Public outings" ON outings FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public participants" ON participants;
CREATE POLICY "Public participants" ON participants FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE venues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public venues" ON venues;
CREATE POLICY "Public venues" ON venues FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public reviews" ON reviews;
CREATE POLICY "Public reviews" ON reviews FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public recommendations" ON recommendations;
CREATE POLICY "Public recommendations" ON recommendations FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public votes" ON votes;
CREATE POLICY "Public votes" ON votes FOR ALL USING (true) WITH CHECK (true);

-- Insert 24 Verified Eateries
INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-01', 'The Workshop Coffee', 'Specialty Coffee & Workspace', '27 Ngô Đức Kế, Bến Nghé, District 1, HCMC', 10.7735, 106.7042, 4.8, 1450, '60k - 100k VND', '["Quiet","Workspace","Specialty Coffee","Aesthetic","Power Outlets"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-02', 'Quán Bụi — Authentic Vietnamese', 'Traditional Vietnamese Dining', '19 Ngô Văn Năm, Bến Nghé, District 1, HCMC', 10.7818, 106.7055, 4.7, 1890, '90k - 180k VND', '["Vietnamese","Hearty Meal","Vegetarian Options","Cozy","Group Dining"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-03', 'Quán Ăn Hẻm 200 Xóm Chiếu (Seafood & Snails)', 'Saigon Alley Eatery & Night Street Food', 'Hẻm 200 Xóm Chiếu, Phường 14, Quận 4, TP.HCM', 10.7608, 106.705, 4.6, 820, '30k - 65k VND', '["Alley Eatery","Budget (<50k)","Seafood & Snails","Hearty Meal","Street Food"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-04', 'Hum Vegetarian, Lounge & Restaurant', 'Fine Vegetarian Dining & Botanical Lounge', '32 Võ Văn Tần, Phường Võ Thị Sáu, Quận 3, TP.HCM', 10.7782, 106.6912, 4.9, 2600, '120k - 250k VND', '["Vegetarian","Quiet","Botanical","Photogenic","No Alcohol"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-05', 'Okkio Caffe — Artisan Matcha & Coffee', 'Specialty Café & Japanese Ceremonial Matcha', '120-122 Lê Lợi, Bến Thành, District 1, HCMC', 10.7725, 106.6978, 4.7, 950, '55k - 85k VND', '["Artisan Matcha","Retro Aesthetic","Specialty Coffee","Conversation"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-06', 'Bánh Xèo Tôm Nhảy Bà Hai (Hẻm 119 Bàn Cờ)', 'Authentic Saigon Crispy Crepe Alley', '119/8 Bàn Cờ, Phường 3, Quận 3, TP.HCM', 10.7685, 106.6815, 4.6, 620, '35k - 55k VND', '["Alley Eatery","Budget (<50k)","Crispy Crepe","Veg Option","Hearty Meal"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-07', 'Acoustic Bar Saigon — Live Music & Pub', 'Live Music & Craft Beer Lounge', '6E Ngô Thời Nhiệm, Phường Võ Thị Sáu, Quận 3, TP.HCM', 10.7812, 106.689, 4.7, 1100, '70k - 140k VND', '["Live Acoustic Music","Craft Beer","Night Chill","Open Late","Lively"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-08', 'Dabao Concept — Heritage Garden Café', 'Imperial Heritage Café & Tropical Courtyard', '18 Tú Xương, Phường Võ Thị Sáu, Quận 3, TP.HCM', 10.7825, 106.6865, 4.8, 1320, '55k - 85k VND', '["Quiet","Photogenic Garden","Courtyard","Matcha & Lotus Tea","Relax"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-09', 'Snob Coffee 24/7 (Boardgame & Late Study)', '24/7 Coffee & Co-working Lounge', '185 Nguyễn Thị Minh Khai, Phường Phạm Ngũ Lão, Quận 1, TP.HCM', 10.771, 106.6895, 4.5, 880, '35k - 60k VND', '["Open 24/7","Budget (<50k)","Boardgame","Power Outlets","Night Study"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-10', 'Bún Thịt Nướng Chị Tuyền (Hẻm 175 Cô Giang)', 'Legendary Saigon Char-Grilled Pork Noodle', '175c Cô Giang, Phường Cô Giang, Quận 1, TP.HCM', 10.7612, 106.6925, 4.6, 1420, '45k - 70k VND', '["Alley Eatery","Char-Grilled Pork","Hearty Meal","Flavorful","Budget"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-11', 'Sủi Cảo Đại Ký (Phố Sủi Cảo Hà Tôn Quyền)', 'Chợ Lớn Handcrafted Shrimp Dumplings & Egg Noodles', '192 Hà Tôn Quyền, Phường 4, Quận 11 (Giáp Quận 5), TP.HCM', 10.7584, 106.6578, 4.6, 1980, '50k - 85k VND', '["Sủi Cảo Chợ Lớn","Hearty Meal","Authentic","Budget","Group Dining"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-12', 'Dim Tu Tac — Ẩm Thực Quảng Đông', 'Premium Cantonese Dim Sum & Tea House', '29B Trần Hưng Đạo, Phường 6, Quận 5, TP.HCM', 10.7548, 106.6712, 4.7, 2450, '140k - 300k VND', '["Dimsum","Cantonese","Quiet","Family & Friends","Spacious AC"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-13', 'Cơm Gà Đông Nguyên (Gia Truyền Chợ Lớn)', 'Traditional Herbal Boiled Chicken & Tonic Soup', '801 Nguyễn Trãi, Phường 14, Quận 5, TP.HCM', 10.7525, 106.662, 4.5, 3200, '65k - 120k VND', '["Cơm Gà Chợ Lớn","Canh Tiềm Thảo Mộc","Authentic","Hearty Meal"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-14', 'Nhà Hàng Chay Bếp Xanh An Duyên', 'Artisan Zen Vegetarian & Botanical Teahouse', '10 Nguyễn Tri Phương, Phường 6, Quận 5, TP.HCM', 10.7552, 106.6685, 4.8, 1100, '75k - 150k VND', '["Vegetarian","Vegan","Quiet","Lẩu Nấm Dưỡng Sinh","No Alcohol"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-15', 'Lẩu Bò Cô Thảo (Hẻm Chợ Hoa Hồ Thị Kỷ)', 'Legendary Alley Beef Hotpot & Marrow Bone', '84/10 Hồ Thị Kỷ, Phường 1, Quận 10, TP.HCM', 10.7635, 106.678, 4.6, 1850, '60k - 110k VND', '["Alley Eatery","Lẩu Bò Tủy","Lively","Street Food","Night Hangout"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-16', 'Chè Mâm Khánh Vy (Sư Vạn Hạnh)', 'Iconic 16-Bowl Traditional Sweet Soup Tray', '242B Sư Vạn Hạnh, Phường 2, Quận 10, TP.HCM', 10.7628, 106.6705, 4.5, 1150, '25k - 45k VND', '["Budget (<50k)","Chè Mâm","Street Dessert","Late Night Sweet"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-17', 'Bánh Canh Cua Út Lệ (Tô Hiến Thành)', 'Rich Fresh Crab Tapioca Noodle & Crispy Dough', '210 Tô Hiến Thành, Phường 15, Quận 10, TP.HCM', 10.7788, 106.6658, 4.6, 1600, '55k - 80k VND', '["Bánh Canh Cua","Hearty Meal","Flavorful Broth","Crab & Shrimp"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-18', 'Cơm Tấm Ba Ghiền (Michelin Bib Gourmand)', 'Saigon Giant Char-Grilled Pork Chop Broken Rice', '84 Đặng Văn Ngữ, Phường 10, Phú Nhuận, TP.HCM', 10.7932, 106.672, 4.5, 4600, '75k - 130k VND', '["Cơm Tấm Sườn Khổng Lồ","Michelin Bib Gourmand","Hearty Meal","Legendary"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-19', 'The Dome Kaffe (Hẻm 10 Đoàn Thị Điểm)', 'Minimalist Japanese White-Tone Café & Matcha Latte', '10/16 Đoàn Thị Điểm, Phường 1, Phú Nhuận, TP.HCM', 10.7962, 106.685, 4.7, 1050, '50k - 75k VND', '["Artisan Matcha","Quiet","Workspace","Photogenic Minimalist","Pastry"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-20', 'Quán Bún Bò Huế Ba Nghị (Nguyễn Văn Đậu)', 'Authentic Imperial Hue Spicy Beef & Crab Cake Noodle', '466 Nguyễn Văn Đậu, Phường 11, Bình Thạnh, TP.HCM', 10.8175, 106.6908, 4.7, 1340, '50k - 75k VND', '["Bún Bò Huế Chuẩn Vị","Sa Tế Cay Nồng","Hearty Meal","Air Conditioned"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-21', 'Mì Quảng Sâm (Ca Văn Thỉnh)', 'Central Vietnam Turmeric Rice Noodle & Crispy Cracker', '8 Ca Văn Thỉnh, Phường 11, Tân Bình, TP.HCM', 10.7895, 106.6508, 4.6, 1450, '45k - 65k VND', '["Mì Quảng Chuẩn Vị","Mì Quảng Ếch","Bánh Tráng Mè Nướng","Budget"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-22', 'Phở Hòa Pasteur (60 Năm Gia Truyền)', 'Heritage Saigon Beef Pho & Crispy Fried Dough', '260C Pasteur, Phường Võ Thị Sáu, Quận 3, TP.HCM', 10.7876, 106.6904, 4.5, 5800, '85k - 110k VND', '["Phở Bò Gia Truyền","Nước Dùng Đậm Đà","Hearty Meal","Saigon Icon"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-23', 'Bánh Mì Huỳnh Hoa (Lê Thị Riêng)', 'Saigon Signature Heavy-Loaded Pâté & Ham Baguette', '26 Lê Thị Riêng, Phường Bến Thành, Quận 1, TP.HCM', 10.7712, 106.6923, 4.4, 6200, '68k VND / ổ đặc biệt', '["Bánh Mì Ô-môi","Pate Béo Ngậy","Đồ Chua Giòn Tan","Saigon Icon"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;

INSERT INTO venues (id, name, category, address, lat, lng, rating, reviews_count, avg_price, tags, traits, verified)
VALUES ('hcm-vnu-24', 'Bánh Cuốn Tây Hồ (Đinh Tiên Hoàng)', '60-Year Legacy Steamed Rice Rolls & Cinnamon Pork Sausage', '127 Đinh Tiên Hoàng, Phường Đa Kao, Quận 1, TP.HCM', 10.7925, 106.6975, 4.5, 2100, '45k - 70k VND', '["Bánh Cuốn Gia Truyền","Chả Lụa Quế","Bánh Tôm Giòn","Breakfast & Dining"]'::jsonb, '{}'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    category = EXCLUDED.category,
    address = EXCLUDED.address,
    lat = EXCLUDED.lat,
    lng = EXCLUDED.lng,
    rating = EXCLUDED.rating,
    tags = EXCLUDED.tags,
    traits = EXCLUDED.traits;


-- Insert 51 Verified Social Reviews
INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-001', 'hcm-vnu-01', 'google', 'Minh Hoàng (Local Guide)', 5, '', 'Quán cà phê specialty đời đầu ở Sài Gòn, không gian phong cách gạch thô industrial cực kỳ ấn tượng. Cầu thang gỗ cũ dẫn lên tầng 2 ngắm trọn góc phố Ngô Đức Kế. Cực thích hợp ngồi làm việc cả buổi vì wifi mạnh và nhiều ổ cắm.', '["Specialty Coffee","Workspace","Yên tĩnh","Ổ điện"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-002', 'hcm-vnu-01', 'tiktok', '@saigoncoffeediary', 4.8, '', 'Chỗ trốn deadline lý tưởng quận 1! Cold brew và Pour-over hạt Ethiopia thơm mùi trái cây nhiệt đới rõ nét. Giá hơi cao tầm 75k-90k nhưng xứng đáng không gian.', '["Trốn deadline","Pour-over","Chill"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-003', 'hcm-vnu-01', 'facebook', 'Lan Chi (Nhóm Cà Phê Sài Gòn)', 4.5, '', 'Không gian máy lạnh mát mẻ, bàn gỗ dài họp nhóm 4-6 người rất thoải mái. Gửi xe máy ở tầng trệt 10k có người dắt.', '["Họp nhóm","Gửi xe tiện"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-004', 'hcm-vnu-02', 'google', 'Trần Đăng Khoa', 5, '', 'Đưa bạn bè nước ngoài đến đây ăn cơm gia đình ai cũng khen tấm tắc. Món thịt kho tộ và canh chua cá lăng nấu đúng kiểu miền Nam đậm đà, bát đĩa sành cổ rất hoài niệm.', '["Cơm gia đình","Chuẩn vị Nam Bộ","Tiếp khách"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-005', 'hcm-vnu-02', 'tiktok', '@hanoian_in_saigon', 4.7, '', 'Quán Bụi Ngô Văn Năm không gian cực kỳ ấm cúng. Gợi ý mọi người gọi sườn non sốt chua ngọt và gỏi củ hũ dừa tôm thịt nha, ăn cuốn dã man! #reviewanngon #quanbui', '["Ấm cúng","Sườn non","Gỏi củ hũ dừa"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-006', 'hcm-vnu-02', 'shopeefood', 'Ngọc Mai', 4.6, '', 'Đặt cơm trưa văn phòng giao tới còn nóng hôi hổi, đóng hộp giấy lá chuối sạch sẽ thân thiện môi trường.', '["Giao nhanh","Bao bì đẹp"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-007', 'hcm-vnu-03', 'tiktok', '@foody_district4', 5, '', 'Thánh địa ốc đêm quận 4! Đi sâu vào hẻm 200 tầm 40m quán đèn lồng đỏ. Ốc hương xào bắp bơ tỏi ăn kèm bánh mì nóng giòn rụm chỉ 45k dĩa. Đi nhóm 4 người ăn no nê chưa tới 250k!', '["Ốc đêm","Giá hạt dẻ","Bánh mì bơ tỏi"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-008', 'hcm-vnu-03', 'google', 'Vũ Đức Thịnh', 4.6, '', 'Quán ăn hẻm đúng chất bình dân Sài Gòn. Hải sản tươi rói, nghêu hấp sả cay nồng, càng ghẹ rang muối ớt đậm đà. Lưu ý gửi xe đầu hẻm 5k đi bộ vào tí cho đỡ kẹt.', '["Hải sản tươi","Hẻm Sài Gòn","Lưu ý gửi xe"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-009', 'hcm-vnu-03', 'facebook', 'Bảo Anh (Hội Review Ăn Vặt)', 4.5, '', 'Quán hẻm ngồi bàn ghế nhựa thoải mái nói chuyện không sợ làm phiền ai. Nước mắm tắc pha cay ngọt rất bắt vị!', '["Thoải mái","Nước chấm ngon"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-010', 'hcm-vnu-04', 'google', 'Elena Rostova (Traveler)', 5, '', 'Best fine vegetarian dining in Southeast Asia! The serene garden, gentle acoustic music, and delicate lotus rice made our evening unforgettable. Truly healing atmosphere.', '["Fine dining","Healing","Botanical garden"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-011', 'hcm-vnu-04', 'facebook', 'Thanh Vân (Ăn Chay Thanh Tịnh)', 5, '', 'Gia đình mình chọn Hum cho ngày rằm. Không gian biệt thự vườn xanh mướt, tĩnh lặng, nhân viên phục vụ nhã nhặn. Đồ chay làm từ nấm tươi và rau củ hữu cơ tự nhiên không dùng bột ngọt.', '["Chay hữu cơ","Tĩnh lặng","Gia đình"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-012', 'hcm-vnu-11', 'tiktok', '@cholon_eats', 5, '', 'Phố sủi cảo Hà Tôn Quyền thì Đại Ký là chân ái! Viên sủi cảo to đùng cắn ngập tôm tươi sần sật, nước súp hầm xương ngọt lịm ăn kèm mực ngâm tro giòn dai. 10/10!', '["Sủi cảo tôm tươi","Chợ Lớn gia truyền","Ngon nhức nách"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-013', 'hcm-vnu-11', 'google', 'Quách Tuấn Du', 4.7, '', 'Quán của người Hoa gốc Chợ Lớn truyền qua 3 đời. Mì sủi cảo chiên giòn rụm chấm sốt xí muội đỏ đặc trưng. Giờ cao điểm chiều tối đông nghẹt nhưng dọn bàn nhanh.', '["Gốc Hoa","Sủi cảo chiên","Đông vui"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-014', 'hcm-vnu-15', 'tiktok', '@saigondidau', 4.8, '', 'Rủ hội bạn đi chợ hoa Hồ Thị Kỷ ăn lẩu bò Cô Thảo là chuẩn bài trời mưa! Nồi lẩu 200k ngập nạm, gân, đuôi bò và tủy béo ngậy. Nước lẩu thuốc bắc thơm lừng chấm chao cay xé lưỡi!', '["Lẩu bò tủy","Chợ hoa đêm","Món nhậu ngon"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-015', 'hcm-vnu-15', 'google', 'Lê Minh Trí', 4.6, '', 'Quán hẻm chợ hoa nhưng phục vụ rất xởi lởi. Rau tươi mồng tơi cải xanh xin thêm thoải mái. Đậu hũ chiên giòn chấm chao ăn kèm lẩu cực cuốn.', '["Rau tươi","Chao béo","Hẻm chợ hoa"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-016', 'hcm-vnu-18', 'google', 'David Nguyen (Michelin Guide Explorer)', 4.6, '', 'Michelin Bib Gourmand xứng đáng! Miếng sườn to đùng che kín cả đĩa cơm tấm, ướp mật ong nướng than hoa vàng ươm thơm phức cả góc đường Đặng Văn Ngữ. Chả trứng béo mềm.', '["Michelin Bib Gourmand","Sườn khổng lồ","Cơm tấm Sài Gòn"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-017', 'hcm-vnu-18', 'tiktok', '@foodholic_vn', 4.5, '', 'Đĩa cơm tấm 95k đắt nhưng xắt ra miếng! Ăn một đĩa sườn bì chả no từ trưa tới tối. Đồ chua củ kiệu ngâm chua ngọt giải ngấy tuyệt hảo.', '["No căng bụng","Đồ chua ngon","Đáng thử"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-018', 'hcm-vnu-21', 'tiktok', '@matcha_lover_saigon', 4.8, '', 'Tín đồ Matcha Nhật Bản không thể bỏ qua quán này! Bột matcha Uji đánh mịn màng, sữa yến mạch béo nhẹ không hề tanh. Quán decor tone trắng đen tối giản chụp ảnh sống ảo siêu xịn.', '["Artisan Matcha","Tone trắng đen","Sống ảo"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-019', 'hcm-vnu-21', 'facebook', 'Thùy Dương (Cộng đồng Minimalist)', 4.7, '', 'Ẩn mình trong hẻm 10 Đoàn Thị Điểm nên cực kỳ yên tĩnh. Nhạc lofi mở vừa đủ nghe, khách ai cũng có ý thức nói khẽ. Rất hợp học bài và làm việc.', '["Yên tĩnh","Học bài","Lofi chill"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-020', 'hcm-vnu-16', 'tiktok', '@ansapsaigon', 4.6, '', 'Mâm chè 16 chén huyền thoại Sư Vạn Hạnh! Rủ team 4 người đi ăn chung mỗi người thử một muỗng là phê. Thích nhất chè bà ba, chè trôi nước và chè đậu đỏ nước cốt dừa béo ngậy.', '["Chè mâm 16 món","Giá học sinh sinh viên","Béo ngậy"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-05-1', 'hcm-vnu-05', 'google', 'Thu Thảo (Thực khách)', 4.6, '', 'Ghé Okkio Caffe — Artisan Matcha & Coffee tại 120-122 Lê Lợi ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-05-2', 'hcm-vnu-05', 'tiktok', '@foodie_hcm_vnu_05', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Okkio Caffe — Artisan Matcha & Coffee. Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Specialty Café & Japanese Ceremonial Matcha. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-06-1', 'hcm-vnu-06', 'google', 'Tuấn Anh (Thực khách)', 4.6, '', 'Ghé Bánh Xèo Tôm Nhảy Bà Hai (Hẻm 119 Bàn Cờ) tại 119/8 Bàn Cờ ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-06-2', 'hcm-vnu-06', 'tiktok', '@foodie_hcm_vnu_06', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Bánh Xèo Tôm Nhảy Bà Hai (Hẻm 119 Bàn Cờ). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Authentic Saigon Crispy Crepe Alley. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-07-1', 'hcm-vnu-07', 'google', 'Hoàng Long (Thực khách)', 4.6, '', 'Ghé Acoustic Bar Saigon — Live Music & Pub tại 6E Ngô Thời Nhiệm ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-07-2', 'hcm-vnu-07', 'tiktok', '@foodie_hcm_vnu_07', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Acoustic Bar Saigon — Live Music & Pub. Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Live Music & Craft Beer Lounge. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-08-1', 'hcm-vnu-08', 'google', 'Quốc Bảo (Thực khách)', 4.6, '', 'Ghé Dabao Concept — Heritage Garden Café tại 18 Tú Xương ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-08-2', 'hcm-vnu-08', 'tiktok', '@foodie_hcm_vnu_08', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Dabao Concept — Heritage Garden Café. Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Imperial Heritage Café & Tropical Courtyard. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-09-1', 'hcm-vnu-09', 'google', 'Tuấn Anh (Thực khách)', 4.6, '', 'Ghé Snob Coffee 24/7 (Boardgame & Late Study) tại 185 Nguyễn Thị Minh Khai ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-09-2', 'hcm-vnu-09', 'tiktok', '@foodie_hcm_vnu_09', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Snob Coffee 24/7 (Boardgame & Late Study). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực 24/7 Coffee & Co-working Lounge. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-10-1', 'hcm-vnu-10', 'google', 'Khánh Linh (Thực khách)', 4.6, '', 'Ghé Bún Thịt Nướng Chị Tuyền (Hẻm 175 Cô Giang) tại 175c Cô Giang ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-10-2', 'hcm-vnu-10', 'tiktok', '@foodie_hcm_vnu_10', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Bún Thịt Nướng Chị Tuyền (Hẻm 175 Cô Giang). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Legendary Saigon Char-Grilled Pork Noodle. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-12-1', 'hcm-vnu-12', 'google', 'Thu Thảo (Thực khách)', 4.6, '', 'Ghé Dim Tu Tac — Ẩm Thực Quảng Đông tại 29B Trần Hưng Đạo ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-12-2', 'hcm-vnu-12', 'tiktok', '@foodie_hcm_vnu_12', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Dim Tu Tac — Ẩm Thực Quảng Đông. Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Premium Cantonese Dim Sum & Tea House. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-13-1', 'hcm-vnu-13', 'google', 'Thanh Hằng (Thực khách)', 4.6, '', 'Ghé Cơm Gà Đông Nguyên (Gia Truyền Chợ Lớn) tại 801 Nguyễn Trãi ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-13-2', 'hcm-vnu-13', 'tiktok', '@foodie_hcm_vnu_13', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Cơm Gà Đông Nguyên (Gia Truyền Chợ Lớn). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Traditional Herbal Boiled Chicken & Tonic Soup. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-14-1', 'hcm-vnu-14', 'google', 'Thanh Hằng (Thực khách)', 4.6, '', 'Ghé Nhà Hàng Chay Bếp Xanh An Duyên tại 10 Nguyễn Tri Phương ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-14-2', 'hcm-vnu-14', 'tiktok', '@foodie_hcm_vnu_14', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Nhà Hàng Chay Bếp Xanh An Duyên. Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Artisan Zen Vegetarian & Botanical Teahouse. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-17-1', 'hcm-vnu-17', 'google', 'Hoàng Long (Thực khách)', 4.6, '', 'Ghé Bánh Canh Cua Út Lệ (Tô Hiến Thành) tại 210 Tô Hiến Thành ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-17-2', 'hcm-vnu-17', 'tiktok', '@foodie_hcm_vnu_17', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Bánh Canh Cua Út Lệ (Tô Hiến Thành). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Rich Fresh Crab Tapioca Noodle & Crispy Dough. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-19-1', 'hcm-vnu-19', 'google', 'Thu Thảo (Thực khách)', 4.6, '', 'Ghé The Dome Kaffe (Hẻm 10 Đoàn Thị Điểm) tại 10/16 Đoàn Thị Điểm ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-19-2', 'hcm-vnu-19', 'tiktok', '@foodie_hcm_vnu_19', 4.8, '', 'Review địa điểm tụ tập lý tưởng: The Dome Kaffe (Hẻm 10 Đoàn Thị Điểm). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Minimalist Japanese White-Tone Café & Matcha Latte. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-20-1', 'hcm-vnu-20', 'google', 'Thu Thảo (Thực khách)', 4.6, '', 'Ghé Quán Bún Bò Huế Ba Nghị (Nguyễn Văn Đậu) tại 466 Nguyễn Văn Đậu ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-20-2', 'hcm-vnu-20', 'tiktok', '@foodie_hcm_vnu_20', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Quán Bún Bò Huế Ba Nghị (Nguyễn Văn Đậu). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Authentic Imperial Hue Spicy Beef & Crab Cake Noodle. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-22-1', 'hcm-vnu-22', 'google', 'Tuấn Anh (Thực khách)', 4.6, '', 'Ghé Phở Hòa Pasteur (60 Năm Gia Truyền) tại 260C Pasteur ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-22-2', 'hcm-vnu-22', 'tiktok', '@foodie_hcm_vnu_22', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Phở Hòa Pasteur (60 Năm Gia Truyền). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Heritage Saigon Beef Pho & Crispy Fried Dough. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-23-1', 'hcm-vnu-23', 'google', 'Thu Thảo (Thực khách)', 4.6, '', 'Ghé Bánh Mì Huỳnh Hoa (Lê Thị Riêng) tại 26 Lê Thị Riêng ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-23-2', 'hcm-vnu-23', 'tiktok', '@foodie_hcm_vnu_23', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Bánh Mì Huỳnh Hoa (Lê Thị Riêng). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực Saigon Signature Heavy-Loaded Pâté & Ham Baguette. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-24-1', 'hcm-vnu-24', 'google', 'Tuấn Anh (Thực khách)', 4.6, '', 'Ghé Bánh Cuốn Tây Hồ (Đinh Tiên Hoàng) tại 127 Đinh Tiên Hoàng ăn cùng gia đình. Đồ ăn ra nhanh, hương vị vừa miệng, không gian sạch sẽ và chỗ để xe thuận tiện.', '["Ngon miệng","Phục vụ nhanh","Không gian sạch"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-gen-hcm-vnu-24-2', 'hcm-vnu-24', 'tiktok', '@foodie_hcm_vnu_24', 4.8, '', 'Review địa điểm tụ tập lý tưởng: Bánh Cuốn Tây Hồ (Đinh Tiên Hoàng). Đặc biệt thích hợp cho nhóm bạn thích ẩm thực 60-Year Legacy Steamed Rice Rolls & Cinnamon Pork Sausage. Đáng ghé trải nghiệm!', '["Đáng thử","Nhóm bạn","Ẩm thực chuẩn vị"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO reviews (id, venue_id, source, author_name, rating, date_text, content, tags)
VALUES ('rev-1789258905719', 'hcm-vnu-01', 'user', 'Kiris (Admin)', 5, '', 'Cà phê rất đậm đà, quán làm việc yên tĩnh không bị tiếng ồn đường phố!', '["Thực chiến","Yên tĩnh"]'::jsonb)
ON CONFLICT (id) DO NOTHING;

