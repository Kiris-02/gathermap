
function calcDistanceKm(p1, p2) {
    if (!p1 || !p2 || p1.lat === undefined || p2.lat === undefined) return 0;
    const R = 6371;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function buildDirectionsUrl(venue) {
    if (!venue || !venue.lat || !venue.lng) return 'https://www.google.com/maps';
    const isRealPlaceId = venue.placeId && typeof venue.placeId === 'string' && venue.placeId.startsWith('ChIJ');
    const placeIdSuffix = isRealPlaceId ? `&destination_place_id=${venue.placeId}` : '';
    return `https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}${placeIdSuffix}`;
}

function buildSearchUrl(venue) {
    if (!venue) return 'https://www.google.com/maps';
    const isRealPlaceId = venue.placeId && typeof venue.placeId === 'string' && venue.placeId.startsWith('ChIJ');
    const placeIdSuffix = isRealPlaceId ? `&query_place_id=${venue.placeId}` : '';
    const query = encodeURIComponent(`${venue.name}, ${venue.address || 'TP.HCM'}`);
    return `https://www.google.com/maps/search/?api=1&query=${query}${placeIdSuffix}`;
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./db');
const semanticEngine = require('./semanticEngine');

const app = express();
app.use(cors());
app.use(express.json());

// Guard against malformed client JSON payloads
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.warn('⚠️ Rejected malformed JSON request:', err.message);
        return res.status(400).json({ error: 'Malformed JSON payload', message: err.message });
    }
    next(err);
});

process.on('uncaughtException', (err) => {
    console.error('🛡️ Handled uncaughtException:', err.message);
});
process.on('unhandledRejection', (reason) => {
    console.warn('🛡️ Handled unhandledRejection:', reason);
});

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: 0,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

let GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

// Resilient Gemini Caller with automatic model fallback
async function callGemini(prompt, responseMimeType = 'application/json') {
    if (!GEMINI_KEY) return null;
    const candidateModels = [
        'gemini-3.1-flash-lite',
        'gemini-3.5-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.8-flash'
    ];
    for (const model of candidateModels) {
        try {
            const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.1,
                        ...(responseMimeType ? { responseMimeType } : {})
                    }
                })
            });
            const data = await res.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return { text, model };
        } catch (e) {
            // try next model
        }
    }
    return null;
}

// Config endpoint: inspect live backend capabilities
app.get('/api/config', (req, res) => {
    res.json({
        hasGoogleKey: Boolean(GOOGLE_KEY),
        hasAIKey: Boolean(GEMINI_KEY),
        aiModel: GEMINI_KEY ? 'gemini-3.1-flash-lite / gemini-2.5-flash' : 'none',
        databaseType: db.dbType,
        isSupabaseConfigured: db.isSupabaseConfigured,
        version: '2.0.0-semantic-profile',
        product: 'Group Eatery Recommendation Engine'
    });
});

// Update Google Maps Key dynamically
app.post('/api/config/maps-key', (req, res) => {
    const { key } = req.body;
    if (typeof key === 'string') {
        GOOGLE_KEY = key.trim();
        process.env.GOOGLE_MAPS_API_KEY = GOOGLE_KEY;
        const envPath = path.join(__dirname, '.env');
        let envContent = '';
        if (fs.existsSync(envPath)) {
            envContent = fs.readFileSync(envPath, 'utf8');
        }
        if (envContent.includes('GOOGLE_MAPS_API_KEY=')) {
            envContent = envContent.replace(/GOOGLE_MAPS_API_KEY=.*/g, `GOOGLE_MAPS_API_KEY=${GOOGLE_KEY}`);
        } else {
            envContent += `\nGOOGLE_MAPS_API_KEY=${GOOGLE_KEY}\n`;
        }
        fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');
        console.log(`🗺️ Updated Google Maps API Key: ${GOOGLE_KEY ? 'Configured' : 'Cleared'}`);
        return res.json({ success: true, hasGoogleKey: Boolean(GOOGLE_KEY) });
    }
    res.status(400).json({ error: 'invalid_key' });
});


// ==========================================
// GOOGLE PLACES API (NEW) & GEOCODING SERVICE
// ==========================================
async function fetchGooglePlacesNearby(center, radiusMeters = 3000) {
    if (!GOOGLE_KEY) return [];
    try {
        const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.types,places.regularOpeningHours'
            },
            body: JSON.stringify({
                includedTypes: ['restaurant', 'cafe', 'vietnamese_restaurant', 'meal_takeaway', 'bar', 'bakery'],
                maxResultCount: 20,
                locationRestriction: {
                    circle: {
                        center: { latitude: center.lat, longitude: center.lng },
                        radius: Math.min(20000, radiusMeters)
                    }
                }
            })
        });
        const data = await res.json();
        if (!data.places || !Array.isArray(data.places)) return [];
        return data.places.map(p => {
            const addr = p.formattedAddress || '';
            const isAlley = addr.toLowerCase().includes('hẻm') || addr.toLowerCase().includes('ngõ') || addr.includes('/');
            
            // Truthful price handling: do not fabricate exact 65000 VND
            let pricePerPersonVnd = null;
            let priceRangeVnd = null;
            let priceConfidence = 'unknown';
            let avgPrice = 'Chưa có thông tin giá';

            if (p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') {
                priceRangeVnd = { min: 30000, max: 60000 };
                pricePerPersonVnd = 45000;
                priceConfidence = 'estimated_from_google_price_level';
                avgPrice = '30k - 60k VND';
            } else if (p.priceLevel === 'PRICE_LEVEL_MODERATE') {
                priceRangeVnd = { min: 60000, max: 150000 };
                pricePerPersonVnd = 95000;
                priceConfidence = 'estimated_from_google_price_level';
                avgPrice = '60k - 150k VND';
            } else if (p.priceLevel === 'PRICE_LEVEL_EXPENSIVE' || p.priceLevel === 'PRICE_LEVEL_VERY_EXPENSIVE') {
                priceRangeVnd = { min: 150000, max: 350000 };
                pricePerPersonVnd = 220000;
                priceConfidence = 'estimated_from_google_price_level';
                avgPrice = '150k - 350k VND';
            }

            const openHours = p.regularOpeningHours?.weekdayDescriptions || [];
            const types = p.types || [];
            const isBar = types.includes('bar') || types.includes('night_club');
            const isCafe = types.includes('cafe') || types.includes('coffee_shop');
            const isBakery = types.includes('bakery');

            return {
                id: p.id,
                name: p.displayName?.text || 'Google Eatery',
                category: (types[0] || 'restaurant').replace(/_/g, ' '),
                type: isCafe ? 'cafe' : (isBakery ? 'bakery' : 'restaurant'),
                isAlley,
                alleyNote: isAlley ? 'Vị trí trong hẻm/địa chỉ ngõ, khuyên gửi xe ngoài' : '',
                address: addr,
                placeId: p.id,
                lat: p.location?.latitude || center.lat,
                lng: p.location?.longitude || center.lng,
                rating: p.rating || null,
                reviewsCount: p.userRatingCount || 0,
                pricePerPersonVnd,
                priceRangeVnd,
                priceConfidence,
                avgPrice,
                openingHours: openHours,
                source: 'google_live',
                tags: ['Google Maps Live', ...(p.rating >= 4.5 ? ['High Rated'] : []), ...(isAlley ? ['Alley Eatery'] : [])],
                attributes: {
                    noiseLevel: { value: null, confidence: 'unknown' },
                    seatingComfort: { value: null, confidence: 'unknown' },
                    dietary: {
                        vegetarian: null,
                        vegan: null,
                        halal: null,
                        noAlcohol: isBar ? false : null
                    },
                    matcha: { value: null, confidence: 'unknown' },
                    wifiSpeed: { value: null, confidence: 'unknown' },
                    parking: { ease: null, note: null, confidence: 'unknown' }
                },
                unknowns: ['Kiểm tra giờ mở cửa và thực đơn thực tế trên ứng dụng Google Maps trước khi đến']
            };
        });
    } catch (err) {
        console.error('Error calling Google Places API (New):', err.message);
        return [];
    }
}

// Geocoding endpoint (Verified Coordinate Authorities: Google Geocoding / OSM Nominatim + NLP Query Normalization)
app.get('/api/geocode', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Query parameter q required' });

    let normalizedQuery = q;
    let locationExplanation = '';

    // Optional: Gemini NLP Address Interpretation to expand Saigon slang / abbreviations (e.g., "UEH B", "BK CS2")
    if (GEMINI_KEY) {
        try {
            const prompt = `Bạn là chuyên gia bản đồ và địa lý đô thị thực tế tại TP.HCM (Sài Gòn).
Người dùng nhập cụm từ địa danh, tên tòa nhà, khách sạn, cơ quan, trường học hoặc tiếng lóng địa phương: "${q}".
Hãy chuẩn hóa cụm từ này thành tên và địa chỉ đường phố chính xác để tìm kiếm trên Google Maps hoặc OpenStreetMap.
Trả về JSON duy nhất:
{
  "recognized": true,
  "standardName": "Tên địa điểm chuẩn chính xác",
  "searchQuery": "Địa chỉ hoặc tên địa điểm đầy đủ để geocode tại TP.HCM",
  "explanation": "Giải thích ngắn gọn"
}`;
            const aiResp = await callGemini(prompt, 'application/json');
            if (aiResp && aiResp.text) {
                const aiData = JSON.parse(aiResp.text);
                if (aiData && aiData.recognized && aiData.searchQuery) {
                    normalizedQuery = aiData.searchQuery;
                    locationExplanation = aiData.explanation || '';
                }
            }
        } catch (err) {
            console.warn('AI Geocode normalization notice:', err.message);
        }
    }

    // 1. Primary Verified Coordinate Authority: Google Geocoding API (if key available)
    if (GOOGLE_KEY) {
        try {
            const gRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(normalizedQuery + ', Ho Chi Minh City')}&key=${GOOGLE_KEY}`);
            const gData = await gRes.json();
            if (gData.results && gData.results.length > 0) {
                const item = gData.results[0];
                return res.json({
                    source: 'google',
                    name: q,
                    standardName: item.formatted_address,
                    address: item.formatted_address,
                    lat: item.geometry.location.lat,
                    lng: item.geometry.location.lng,
                    placeId: item.place_id,
                    explanation: locationExplanation
                });
            }
        } catch (e) {
            console.error('Google Geocoding error, falling back to OSM:', e.message);
        }
    }

    // 2. Primary Verified Coordinate Authority (Free Fallback): OpenStreetMap Nominatim
    try {
        const queriesToTry = [normalizedQuery, q];
        for (const query of queriesToTry) {
            const osmRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query + ', Ho Chi Minh City')}&limit=1`, {
                headers: { 'User-Agent': 'GatherMap-App/2.0 (skrongdattv1@gmail.com)' }
            });
            const osmData = await osmRes.json();
            if (osmData && osmData.length > 0) {
                const item = osmData[0];
                return res.json({
                    source: 'openstreetmap',
                    name: q,
                    standardName: item.display_name,
                    address: item.display_name,
                    lat: parseFloat(item.lat),
                    lng: parseFloat(item.lon),
                    placeId: 'osm_' + item.place_id,
                    explanation: locationExplanation
                });
            }
        }
    } catch (e) {
        console.error('OSM Geocoding error:', e.message);
    }

    // 3. Fallback: Curated Verified Saigon Landmarks
    const KNOWN_LANDMARKS = {
        'landmark 81': { lat: 10.7950, lng: 106.7218, name: 'Landmark 81', address: '720A Điện Biên Phủ, Vinhomes Tân Cảng, Bình Thạnh, TP.HCM' },
        'bến thành': { lat: 10.7725, lng: 106.6980, name: 'Chợ Bến Thành', address: 'Lê Lợi, Phường Bến Thành, Quận 1, TP.HCM' },
        'nhà thờ đức bà': { lat: 10.7798, lng: 106.6990, name: 'Nhà thờ Đức Bà Sài Gòn', address: '01 Công xã Paris, Bến Nghé, Quận 1, TP.HCM' },
        'phố đi bộ nguyễn huệ': { lat: 10.7745, lng: 106.7032, name: 'Phố đi bộ Nguyễn Huệ', address: 'Đường Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM' },
        'hồ con rùa': { lat: 10.7827, lng: 106.6958, name: 'Hồ Con Rùa', address: 'Công trường Quốc tế, Phường 6, Quận 3, TP.HCM' },
        'bitexco': { lat: 10.7716, lng: 106.7044, name: 'Bitexco Financial Tower', address: '2 Hải Triều, Bến Nghé, Quận 1, TP.HCM' },
        'vạn hạnh mall': { lat: 10.7725, lng: 106.6698, name: 'Vạn Hạnh Mall', address: '11 Sư Vạn Hạnh, Phường 12, Quận 10, TP.HCM' }
    };

    const qLower = q.toLowerCase();
    for (const [k, v] of Object.entries(KNOWN_LANDMARKS)) {
        if (qLower.includes(k) || k.includes(qLower)) {
            return res.json({
                source: 'known_landmarks',
                name: q,
                standardName: v.name,
                address: v.address,
                lat: v.lat,
                lng: v.lng,
                placeId: 'landmark_' + k.replace(/\s+/g, '_'),
                explanation: locationExplanation || 'Tọa độ xác thực từ danh mục địa danh TP.HCM'
            });
        }
    }

    res.status(404).json({ error: 'Location not found in verified geocoding services' });
});

// ==========================================
// 1. LOCATION SERVICE: Equal-Weight Geometric Median (Weiszfeld Algorithm)
// ==========================================
function calculateGeometricMedian(points) {
    if (!points || points.length === 0) return { lat: 10.7769, lng: 106.7009 };
    if (points.length === 1) return { lat: points[0].lat, lng: points[0].lng };

    let curLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    let curLng = points.reduce((s, p) => s + p.lng, 0) / points.length;

    for (let iter = 0; iter < 30; iter++) {
        let numLat = 0, numLng = 0, denom = 0;
        for (const p of points) {
            const dist = Math.hypot(p.lat - curLat, p.lng - curLng);
            if (dist < 1e-7) continue;
            const w = 1 / dist;
            numLat += p.lat * w;
            numLng += p.lng * w;
            denom += w;
        }
        if (denom === 0) break;
        const nextLat = numLat / denom;
        const nextLng = numLng / denom;
        if (Math.hypot(nextLat - curLat, nextLng - curLng) < 1e-7) break;
        curLat = nextLat;
        curLng = nextLng;
    }
    return { lat: Number(curLat.toFixed(6)), lng: Number(curLng.toFixed(6)) };
}

app.post('/api/center/geometric-median', (req, res) => {
    const { points } = req.body;
    if (!points || !Array.isArray(points)) {
        return res.status(400).json({ error: 'points array required' });
    }
    const median = calculateGeometricMedian(points);
    const distances = points.map(p => ({
        name: p.name || 'Friend',
        distanceKm: Number(db.haversineKm(p.lat, p.lng, median.lat, median.lng).toFixed(2))
    }));
    res.json({ median, distances });
});

// ==========================================
// 2. VENUE DATABASE ENDPOINTS (Connected to db.js)
// ==========================================
app.get(['/api/venues', '/api/venues/all'], async (req, res) => {
    try {
        const venues = await db.getAllVenues();
        if (req.path === '/api/venues') {
            return res.json(venues);
        }
        res.json({ venues, total: venues.length, database: db.dbType });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/places/nearby', async (req, res) => {
    try {
        const { center = { lat: 10.7769, lng: 106.7009 }, radiusMeters = 3000 } = req.body;
        const radiusKm = radiusMeters / 1000;
        const venues = await db.getVenuesInRadius({ lat: center.lat, lng: center.lng, radiusKm });
        res.json({ venues, total: venues.length, radiusKm, database: db.dbType });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. AI PREFERENCE PARSER (Open Dynamic Schema)
// ==========================================
app.post('/api/preferences/parse', async (req, res) => {
    const { discussionText = '', friends = [] } = req.body;
    const combinedWishes = friends
        .filter(f => f.wish && f.wish.trim())
        .map(f => `${f.name}: "${f.wish.trim()}"`)
        .join('\n');

    const rawInput = (discussionText + (combinedWishes ? '\n' + combinedWishes : '')).trim();

    if (GEMINI_KEY && rawInput) {
        const prompt = `You are an expert AI Preference & Intent Interpreter for a Group Dining / Hangout Application.
Analyze the user's natural-language request (in Vietnamese or English).
Extract structured hard constraints (must-haves) and soft weighted preferences.

IMPORTANT INSTRUCTIONS:
1. Do NOT force food choices into narrow enums. Support ANY cuisine (e.g. Korean, Japanese, Vietnamese, Italian, Thai, Chinese, Indian), dish (e.g. Korean BBQ, Hotpot, Sushi, Pho, Bingsu, Pizza, Seafood, Steak, Dessert), ambience (e.g. lively, quiet/study, romantic, rooftop, cozy, outdoor), and feature (e.g. parking, wifi, air_conditioned, private_room).
2. Hard constraints are non-negotiable boolean filters or maximum budgets. Only set a hard constraint to true if the user explicitly demands it (e.g. "must be vegetarian", "chay", "strictly no alcohol", "under 100k").
3. Soft preferences carry weights from 1 (minor bonus) to 5 (top priority).
4. If no specific cuisine is mentioned (e.g. "anything nearby", "ăn gì cũng được"), keep cuisines and dishes empty.
5. Preserve individual preferences. If a preference comes from a line formatted as MemberName: "wish", set memberName to that exact MemberName. Use memberName "Group" only for preferences that apply to everyone or come from general group discussion.

Return ONLY valid JSON matching this exact schema:
{
  "hardConstraints": {
    "maxPricePerPersonVnd": number or null,
    "vegetarianRequired": boolean,
    "veganRequired": boolean,
    "halalRequired": boolean,
    "noAlcohol": boolean,
    "quietRequired": boolean,
    "openNowRequired": boolean,
    "parkingRequired": boolean
  },
  "cuisines": [
    { "value": string (e.g. "korean", "japanese", "vietnamese"), "weight": number (1-5), "memberName": "Group" }
  ],
  "dishes": [
    { "value": string (e.g. "korean bbq", "hotpot", "sushi", "bingsu", "matcha"), "weight": number (1-5), "memberName": "Group" }
  ],
  "ambience": [
    { "value": string (e.g. "lively", "quiet", "cozy", "rooftop", "aesthetic"), "weight": number (1-5), "memberName": "Group" }
  ],
  "features": [
    { "value": string (e.g. "parking", "fast_wifi", "group_seating"), "weight": number (1-5), "memberName": "Group" }
  ],
  "negativePreferences": [
    { "value": string (e.g. "club-level loud music", "crowded noisy spaces"), "weight": number (1-5) }
  ],
  "rawIntent": string (1 concise sentence summarizing what the group wants)
}

Input Text:
${rawInput}`;

        const aiResponse = await callGemini(prompt, 'application/json');
        if (aiResponse && aiResponse.text) {
            try {
                const parsed = JSON.parse(aiResponse.text);
                
                // Backwards compatibility aliases for older UI components
                const legacySoft = [];
                (parsed.cuisines || []).forEach(c => legacySoft.push({ preference: c.value, criterion: 'cuisine', weight: c.weight, memberName: c.memberName || 'Group' }));
                (parsed.dishes || []).forEach(d => legacySoft.push({ preference: d.value, criterion: 'dish', weight: d.weight, memberName: d.memberName || 'Group' }));
                (parsed.ambience || []).forEach(a => legacySoft.push({ preference: a.value, criterion: 'ambience', weight: a.weight, memberName: a.memberName || 'Group' }));
                (parsed.features || []).forEach(f => legacySoft.push({ preference: f.value, criterion: 'feature', weight: f.weight, memberName: f.memberName || 'Group' }));

                const legacyReqs = {
                    vegetarian: Boolean(parsed.hardConstraints?.vegetarianRequired || parsed.hardConstraints?.veganRequired),
                    no_alcohol: Boolean(parsed.hardConstraints?.noAlcohol),
                    quiet_only: Boolean(parsed.hardConstraints?.quietRequired),
                    max_price_vnd: parsed.hardConstraints?.maxPricePerPersonVnd || null
                };
                parsed.hardConstraints = {
                    ...parsed.hardConstraints,
                    ...legacyReqs,
                    vegetarianRequired: parsed.hardConstraints?.vegetarianRequired ?? legacyReqs.vegetarian,
                    noAlcohol: parsed.hardConstraints?.noAlcohol ?? legacyReqs.no_alcohol,
                    quietRequired: parsed.hardConstraints?.quietRequired ?? legacyReqs.quiet_only,
                    maxPricePerPersonVnd: parsed.hardConstraints?.maxPricePerPersonVnd ?? legacyReqs.max_price_vnd
                };

                return res.json({
                    ...parsed,
                    requiredConstraints: legacyReqs,
                    softPreferences: legacySoft,
                    aiPowered: true,
                    aiModel: aiResponse.model
                });
            } catch (jsonErr) {
                console.warn('Failed to parse AI JSON:', jsonErr.message);
            }
        }
    }

    // Deterministic Rule-Based Fallback
    const hardConstraints = {
        maxPricePerPersonVnd: null,
        vegetarianRequired: false,
        veganRequired: false,
        halalRequired: false,
        noAlcohol: false,
        quietRequired: false,
        openNowRequired: false,
        parkingRequired: false
    };
    const cuisines = [];
    const dishes = [];
    const ambience = [];
    const features = [];
    const negativePreferences = [];

    const lower = rawInput.toLowerCase();

    // Negative preferences detection
    if (lower.includes('not club') || lower.includes('đừng kiểu club') || lower.includes('quá ồn') || lower.includes('not too loud') || lower.includes('not club-loud')) {
        negativePreferences.push({ value: 'club-level loud music', weight: 4 });
    }

    // Hard constraints detection
    if (lower.includes('vegetarian') || lower.includes('chay') || lower.includes('quán chay')) {
        hardConstraints.vegetarianRequired = true;
    }
    if (lower.includes('vegan') || lower.includes('thuần chay')) {
        hardConstraints.veganRequired = true;
        hardConstraints.vegetarianRequired = true;
    }
    if (lower.includes('halal') || lower.includes('hồi giáo')) {
        hardConstraints.halalRequired = true;
    }
    if (lower.includes('no alcohol') || lower.includes('không cồn') || lower.includes('không bia') || lower.includes('no beer')) {
        hardConstraints.noAlcohol = true;
    }
    if (lower.includes('strictly quiet') || lower.includes('yên tĩnh tuyệt đối')) {
        hardConstraints.quietRequired = true;
    }

    // Budget regex (e.g. 150k, 150000, dưới 100k, < 200k)
    const budgetMatch = lower.match(/(?:dưới|<|under|khoảng|around|tối đa|max)\s*(\d+)\s*(k|000|vnd)/i) || lower.match(/(\d+)\s*k/i);
    if (budgetMatch) {
        const num = parseInt(budgetMatch[1], 10);
        hardConstraints.maxPricePerPersonVnd = num < 1000 ? num * 1000 : num;
    }

    // Cuisines & Dishes extraction
    if (lower.includes('korean bbq') || lower.includes('bbq hàn') || lower.includes('thịt nướng hàn')) {
        cuisines.push({ value: 'korean', weight: 5, memberName: 'Group' });
        dishes.push({ value: 'korean bbq', weight: 5, memberName: 'Group' });
    } else if (lower.includes('korean') || lower.includes('hàn quốc') || lower.includes('món hàn')) {
        cuisines.push({ value: 'korean', weight: 5, memberName: 'Group' });
    }

    if (lower.includes('sushi') || lower.includes('sashimi')) {
        cuisines.push({ value: 'japanese', weight: 5, memberName: 'Group' });
        dishes.push({ value: 'sushi', weight: 5, memberName: 'Group' });
    } else if (lower.includes('japanese') || lower.includes('nhật bản') || lower.includes('món nhật')) {
        cuisines.push({ value: 'japanese', weight: 5, memberName: 'Group' });
    }

    if (lower.includes('hotpot') || lower.includes('lẩu')) {
        dishes.push({ value: 'hotpot', weight: 5, memberName: 'Group' });
    }
    if (lower.includes('bbq') || lower.includes('nướng') || lower.includes('grill')) {
        dishes.push({ value: 'bbq', weight: 5, memberName: 'Group' });
    }
    if (lower.includes('matcha')) {
        dishes.push({ value: 'matcha', weight: 5, memberName: 'Group' });
    }
    if (lower.includes('cafe') || lower.includes('cà phê') || lower.includes('coffee')) {
        dishes.push({ value: 'coffee', weight: 4, memberName: 'Group' });
    }
    if (lower.includes('dessert') || lower.includes('bánh ngọt') || lower.includes('bingsu') || lower.includes('chè')) {
        dishes.push({ value: 'dessert', weight: 5, memberName: 'Group' });
    }

    // Ambience
    if (lower.includes('lively') || lower.includes('nhộn nhịp') || lower.includes('sôi động') || lower.includes('tụ tập')) {
        ambience.push({ value: 'lively', weight: 4, memberName: 'Group' });
    }
    if (lower.includes('quiet') || lower.includes('yên tĩnh') || lower.includes('học bài') || lower.includes('study') || lower.includes('work')) {
        ambience.push({ value: 'quiet', weight: 5, memberName: 'Group' });
    }
    if (lower.includes('rooftop') || lower.includes('view đẹp') || lower.includes('chill')) {
        ambience.push({ value: 'rooftop_view', weight: 4, memberName: 'Group' });
    }
    if (lower.includes('aesthetic') || lower.includes('sống ảo') || lower.includes('photo')) {
        ambience.push({ value: 'aesthetic', weight: 4, memberName: 'Group' });
    }

    // Features
    if (lower.includes('parking') || lower.includes('gửi xe')) {
        features.push({ value: 'parking', weight: 3, memberName: 'Group' });
    }
    if (lower.includes('wifi') || lower.includes('mạng mạnh')) {
        features.push({ value: 'fast_wifi', weight: 3, memberName: 'Group' });
    }

    const legacySoft = [
        ...cuisines.map(c => ({ preference: c.value, criterion: 'cuisine', weight: c.weight, memberName: c.memberName })),
        ...dishes.map(d => ({ preference: d.value, criterion: 'dish', weight: d.weight, memberName: d.memberName })),
        ...ambience.map(a => ({ preference: a.value, criterion: 'ambience', weight: a.weight, memberName: a.memberName })),
        ...features.map(f => ({ preference: f.value, criterion: 'feature', weight: f.weight, memberName: f.memberName }))
    ];

    res.json({
        hardConstraints: {
            ...hardConstraints,
            vegetarian: hardConstraints.vegetarianRequired,
            no_alcohol: hardConstraints.noAlcohol,
            quiet_only: hardConstraints.quietRequired,
            max_price_vnd: hardConstraints.maxPricePerPersonVnd
        },
        cuisines,
        dishes,
        ambience,
        features,
        negativePreferences,
        rawIntent: rawInput || 'Tìm địa điểm gặp mặt phù hợp xung quanh tâm điểm nhóm',
        requiredConstraints: {
            vegetarian: hardConstraints.vegetarianRequired,
            no_alcohol: hardConstraints.noAlcohol,
            quiet_only: hardConstraints.quietRequired,
            max_price_vnd: hardConstraints.maxPricePerPersonVnd
        },
        softPreferences: legacySoft,
        aiPowered: false
    });
});

// ==========================================
// 4. WEISZFELD SEARCH-AND-RANK PIPELINE (Evidence-Backed Semantic Engine)
// ==========================================
app.post('/api/venues/search-and-rank', async (req, res) => {
    try {
        const {
            outingId = 'outing_' + Date.now(),
            outingName = 'Weekend Eatery Hangout',
            mode = 'representative',
            center = { lat: 10.7769, lng: 106.7009 },
            radiusMeters = 3000,
            interpretation = null,
            hardConstraints = {},
            requiredConstraints = {},
            cuisines = [],
            dishes = [],
            ambience = [],
            features = [],
            negativePreferences = [],
            softPreferences = [],
            friends = []
        } = req.body;

        const radiusKm = radiusMeters / 1000;

        // 1. Build Unified Intent Profile
        const intentProfile = {
            hardConstraints: {
                maxPricePerPersonVnd: interpretation?.hardConstraints?.maxPricePerPersonVnd ?? (hardConstraints?.maxPricePerPersonVnd ?? (requiredConstraints?.max_price_vnd ?? null)),
                vegetarianRequired: Boolean(interpretation?.hardConstraints?.vegetarianRequired ?? (hardConstraints?.vegetarianRequired || requiredConstraints?.vegetarian)),
                veganRequired: Boolean(interpretation?.hardConstraints?.veganRequired ?? hardConstraints?.veganRequired),
                halalRequired: Boolean(interpretation?.hardConstraints?.halalRequired ?? hardConstraints?.halalRequired),
                noAlcohol: Boolean(interpretation?.hardConstraints?.noAlcohol ?? (hardConstraints?.noAlcohol || requiredConstraints?.no_alcohol)),
                quietRequired: Boolean(interpretation?.hardConstraints?.quietRequired ?? (hardConstraints?.quietRequired || requiredConstraints?.quiet_only)),
                parkingRequired: Boolean(interpretation?.hardConstraints?.parkingRequired ?? hardConstraints?.parkingRequired),
                openNowRequired: Boolean(interpretation?.hardConstraints?.openNowRequired ?? hardConstraints?.openNowRequired)
            },
            cuisines: (interpretation?.cuisines?.length ? interpretation.cuisines : cuisines) || [],
            dishes: (interpretation?.dishes?.length ? interpretation.dishes : dishes) || [],
            ambience: (interpretation?.ambience?.length ? interpretation.ambience : ambience) || [],
            features: (interpretation?.features?.length ? interpretation.features : features) || [],
            negativePreferences: (interpretation?.negativePreferences?.length ? interpretation.negativePreferences : negativePreferences) || [],
            rawIntent: interpretation?.rawIntent || ''
        };

        // Support legacy softPreferences mapping if provided
        if (softPreferences && Array.isArray(softPreferences)) {
            softPreferences.forEach(s => {
                const prefStr = s.preference || s.value || '';
                const crit = s.criterion || 'general';
                const w = Number(s.weight) || 3;
                if (!intentProfile.cuisines.some(c => c.value === prefStr) && !intentProfile.dishes.some(d => d.value === prefStr)) {
                    if (crit === 'cuisine' || crit === 'authentic_vietnamese') {
                        intentProfile.cuisines.push({ value: prefStr, weight: w });
                    } else if (crit === 'dish' || crit === 'sweet_food_dessert' || crit === 'matcha_and_aesthetic' || crit === 'brand_preference' || crit === 'cafe_coffee') {
                        intentProfile.dishes.push({ value: prefStr, weight: w });
                    } else if (crit === 'ambience' || crit === 'peaceful_view' || crit === 'quiet_atmosphere' || crit === 'live_music_pub') {
                        intentProfile.ambience.push({ value: prefStr, weight: w });
                    } else {
                        intentProfile.features.push({ value: prefStr, weight: w });
                    }
                }
            });
        }

        // 2. Fetch Candidates (Local DB + Google Places Live)
        const allDbVenues = await db.getAllVenues();
        let candidates = allDbVenues.map(v => ({
            ...v,
            distFromCenterKm: Number(db.haversineKm(center.lat, center.lng, v.lat, v.lng).toFixed(2))
        }));

        if (GOOGLE_KEY) {
            const livePlaces = await fetchGooglePlacesNearby(center, radiusMeters);
            if (livePlaces.length > 0) {
                const existingNames = new Set(candidates.map(v => v.name.toLowerCase()));
                for (const p of livePlaces) {
                    if (!existingNames.has(p.name.toLowerCase())) {
                        candidates.push({
                            ...p,
                            distFromCenterKm: Number(db.haversineKm(center.lat, center.lng, p.lat, p.lng).toFixed(2))
                        });
                    }
                }
            }
        }

        // 3. Process Reviews and Evaluate Candidates BEFORE ranking
        const memberList = (friends && friends.length > 0) ? friends : [{ name: 'Group' }];
        const evaluatedCandidates = [];

        const preferenceAppliesToMember = (pref, friendName) => {
            if (!pref || typeof pref !== 'object' || !pref.memberName) return true;
            const owner = String(pref.memberName).trim().toLowerCase();
            const member = String(friendName || '').trim().toLowerCase();
            return owner === 'group' || owner === 'all' || owner === member;
        };

        const intentForMember = (friend) => ({
            ...intentProfile,
            cuisines: (intentProfile.cuisines || []).filter(p => preferenceAppliesToMember(p, friend.name)),
            dishes: (intentProfile.dishes || []).filter(p => preferenceAppliesToMember(p, friend.name)),
            ambience: (intentProfile.ambience || []).filter(p => preferenceAppliesToMember(p, friend.name)),
            features: (intentProfile.features || []).filter(p => preferenceAppliesToMember(p, friend.name)),
            negativePreferences: (intentProfile.negativePreferences || []).filter(p => preferenceAppliesToMember(p, friend.name))
        });

        for (const venue of candidates) {
            // Load reviews for venue
            const reviews = await db.getVenueReviews(venue.id, 15);

            // Build evidence-backed semantic profile
            const venueProfile = semanticEngine.buildVenueSemanticProfile(venue, reviews);

            // Evaluate strict hard constraints & radius
            const constraintCheck = semanticEngine.evaluateHardConstraints(
                venue,
                intentProfile.hardConstraints,
                radiusKm,
                venue.distFromCenterKm
            );

            // Score semantic compatibility against intent
            const semanticMatch = semanticEngine.scoreVenueAgainstIntent({
                intentProfile,
                venueProfile,
                venue,
                distanceKm: venue.distFromCenterKm
            });

            // Per-member travel burden and individual satisfaction
            const memberBreakdowns = memberList.map(friend => {
                const fLat = friend.lat || center.lat;
                const fLng = friend.lng || center.lng;
                const friendDist = Number(db.haversineKm(fLat, fLng, venue.lat, venue.lng).toFixed(1));
                const travelMins = Math.max(5, Math.round((friendDist / 20) * 60));
                const travelScore = Math.max(20, Math.min(100, Math.round(100 - (travelMins * 2.2))));

                const memberSemanticMatch = semanticEngine.scoreVenueAgainstIntent({
                    intentProfile: intentForMember(friend),
                    venueProfile,
                    venue,
                    distanceKm: friendDist
                });

                // 70% preference satisfaction + 30% travel burden
                const memberScore = Math.round(0.70 * memberSemanticMatch.semanticScore + 0.30 * travelScore);

                return {
                    friendName: friend.name,
                    score: memberScore,
                    preferenceScore: memberSemanticMatch.semanticScore,
                    preferenceConfidence: memberSemanticMatch.confidence,
                    matches: memberSemanticMatch.matches,
                    mismatches: memberSemanticMatch.mismatches,
                    unknowns: memberSemanticMatch.unknowns,
                    travelScore,
                    travelMins,
                    distKm: friendDist
                };
            });

            // Weiszfeld 65/35 Group Fairness
            const fairness = semanticEngine.calculateFairnessScores(memberBreakdowns);

            evaluatedCandidates.push({
                ...venue,
                venueProfile,
                constraintCheck,
                semanticMatch,
                isVegetarian: Boolean(venue.isVegetarian || venue.attributes?.dietary?.vegetarian || venue.category?.toLowerCase().includes('chay') || (venue.tags || []).includes('vegetarian')),
                groupScore: fairness.groupScore,
                fairnessScore: fairness.fairnessScore || fairness.groupScore,
                preferenceScore: semanticMatch.semanticScore,
                travelScore: Math.round(memberBreakdowns.reduce((s, m) => s + m.travelScore, 0) / memberBreakdowns.length),
                distanceScore: Math.round(memberBreakdowns.reduce((s, m) => s + m.travelScore, 0) / memberBreakdowns.length),
                avgScore: Math.round(fairness.avgScore),
                lowestScore: fairness.lowestScore,
                highestScore: fairness.highestScore,
                fairnessIndex: fairness.fairnessIndex,
                confidence: semanticMatch.confidence,
                matches: semanticMatch.matches.map(m => m.preference),
                partialMatches: semanticMatch.partialMatches.map(m => m.preference),
                mismatches: semanticMatch.mismatches.map(m => m.preference),
                unknowns: semanticMatch.unknowns,
                detailedMatches: semanticMatch.matches,
                detailedPartialMatches: semanticMatch.partialMatches,
                detailedMismatches: semanticMatch.mismatches,
                memberBreakdowns,
                reviewsSummary: {
                    count: reviews.length,
                    avgRating: venue.rating ?? null,
                    evidenceSummaries: venueProfile.evidenceSummaries
                },
                socialHighlights: venue.socialHighlights || {},
                principalReasons: semanticMatch.matches.map(m => m.preference).slice(0, 3),
                principalCompromises: semanticMatch.mismatches.map(m => m.preference).slice(0, 2),
                directionsUrl: buildDirectionsUrl(venue),
                mapsUrl: buildSearchUrl(venue)
            });
        }

        // 4. Strict Shortlist (Never relax hard constraints or radius)
        const strictCandidates = evaluatedCandidates
            .filter(v => v.constraintCheck.passed)
            .sort((a, b) => b.groupScore - a.groupScore);

        const strictShortlist = strictCandidates.slice(0, 5);

        // 5. Explicit Alternatives (Only if violated or strict matches limited)
        const alternativeCandidates = evaluatedCandidates
            .filter(v => !v.constraintCheck.passed)
            .sort((a, b) => {
                if (a.constraintCheck.violations.length !== b.constraintCheck.violations.length) {
                    return a.constraintCheck.violations.length - b.constraintCheck.violations.length;
                }
                return b.groupScore - a.groupScore;
            });

        const nearbyAlternatives = alternativeCandidates.slice(0, 4).map(v => ({
            ...v,
            violations: v.constraintCheck.violations.map(viol => viol.detail)
        }));

        // 6. Evidence-Backed AI Explanation
        const venuesForRationale = strictShortlist.length > 0 ? strictShortlist.slice(0, 3) : nearbyAlternatives.slice(0, 3);
        if (GEMINI_KEY && venuesForRationale.length > 0) {
            const contextSummary = venuesForRationale.map((v, i) => {
                const matchStr = (v.matches || []).map(m => typeof m === 'string' ? m : (m.preference || m.value || '')).filter(Boolean).join(', ') || 'Đánh giá chung tốt';
                const mismatchStr = (v.mismatches || []).map(m => typeof m === 'string' ? m : (m.preference || m.value || '')).filter(Boolean).join(', ') || 'Không có đánh đổi lớn';
                const reviewEvidenceStr = (v.venueProfile?.evidenceSummaries || []).join('; ') || 'Thực khách đánh giá tích cực';
                const violStr = v.violations ? `Vi phạm: ${v.violations.join(', ')}` : 'Thỏa mãn tiêu chí';
                return `#${i+1} ${v.name} (Score: ${v.groupScore}/100, Giá: ${v.avgPrice || 'Bình dân'}, Phù hợp: [${matchStr}], Đánh đổi: [${mismatchStr}], Đánh giá thực tế: "${reviewEvidenceStr}", ${violStr})`;
            }).join('\n');

            const aiPrompt = `You are an expert Group Dining Concierge.
Write a concise 1-2 sentence recommendation rationale in Vietnamese for each venue based STRICTLY on the provided structured matches, review evidence, and trade-offs.
CRITICAL RULES:
1. ONLY reference facts from the provided Matches, Trade-offs, and Review Evidence.
2. DO NOT invent menu items, parking facts, noise levels, or review quotes not in the input.
3. If a venue is an alternative with violations, state the trade-off clearly.

Input Intent: "${intentProfile.rawIntent || 'Tìm quán phù hợp nhóm'}"

Venues & Structured Evidence:
${contextSummary}

Return JSON:
{
  "venues": [
    { "name": string, "rationale": string }
  ]
}`;

            const aiRes = await callGemini(aiPrompt, 'application/json');
            if (aiRes && aiRes.text) {
                try {
                    const aiResult = JSON.parse(aiRes.text);
                    (aiResult.venues || []).forEach(item => {
                        const target = venuesForRationale.find(v => v.name.toLowerCase().includes(item.name.toLowerCase()) || item.name.toLowerCase().includes(v.name.toLowerCase()));
                        if (target) {
                            target.aiRationale = item.rationale;
                        }
                    });
                } catch (e) {
                    console.warn('AI rationale parse error:', e.message);
                }
            }
        }

        // Attach reviewer drawer details for the shortlist
        for (const venue of strictShortlist) {
            venue.reviewerHighlights = await db.getVenueReviewerHighlights(venue.id);
            venue.reviewerCount = venue.reviewerHighlights.reviewerCount ?? 0;
        }
        for (const venue of nearbyAlternatives) {
            venue.reviewerHighlights = await db.getVenueReviewerHighlights(venue.id);
            venue.reviewerCount = venue.reviewerHighlights.reviewerCount ?? 0;
        }

        // Persist session
        await db.saveOuting({
            id: outingId,
            name: outingName,
            mode,
            centerLat: center.lat,
            centerLng: center.lng,
            radiusKm
        });
        await db.saveParticipants(outingId, memberList);
        await db.saveRecommendations(outingId, strictShortlist);

        res.json({
            shortlist: strictShortlist,
            nearbyAlternatives,
            totalStrictEligible: strictCandidates.length,
            totalAlternatives: alternativeCandidates.length,
            message: strictShortlist.length === 0
                ? (intentProfile.hardConstraints.vegetarianRequired
                    ? 'Không tìm thấy quán nào xác thực món chay trong bán kính đã chọn.'
                    : `Không tìm thấy quán nào thỏa mãn tất cả tiêu chí bắt buộc trong bán kính ${(radiusKm).toFixed(1)} km.`)
                : null,
            centerUsed: center,
            radiusUsedMeters: radiusMeters,
            activeIntent: intentProfile,
            recommendationTrace: {
                rawInput: intentProfile.rawIntent,
                parsedIntent: intentProfile,
                center,
                radiusMeters,
                candidatesEvaluated: evaluatedCandidates.length,
                strictPassed: strictCandidates.length,
                alternativesFound: alternativeCandidates.length
            },
            aiPowered: Boolean(GEMINI_KEY),
            database: db.dbType
        });
    } catch (err) {
        console.error('Search-and-rank error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 5. TEMPORARY OUTING SESSION & VOTING (Connected to db.js)
// ==========================================
app.post('/api/outings/create', async (req, res) => {
    try {
        const { name = 'Weekend Hangout', mode = 'representative' } = req.body;
        const outingId = 'EAT-' + Math.floor(1000 + Math.random() * 9000);
        await db.saveOuting({ id: outingId, name, mode, centerLat: 10.7769, centerLng: 106.7009, radiusKm: 3.0 });
        res.json({ id: outingId, name, mode, status: 'active', database: db.dbType });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/outings/:id', async (req, res) => {
    try {
        const outing = await db.getOuting(req.params.id);
        if (!outing) return res.status(404).json({ error: 'outing_not_found' });
        const votes = await db.getVotes(req.params.id);
        res.json({ ...outing, votes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/outings/:id/vote', async (req, res) => {
    try {
        const { venueId, voterName = 'Guest' } = req.body;
        await db.recordVote(req.params.id, venueId, voterName);
        const votes = await db.getVotes(req.params.id);
        res.json({ votes, totalVotesForVenue: (votes[venueId] || []).length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/outings/:id/votes', async (req, res) => {
    try {
        const votes = await db.getVotes(req.params.id);
        res.json({ outingId: req.params.id, votes: votes || {} });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/venues/:id/map-link', async (req, res) => {
    try {
        const venues = await db.getAllVenues();
        const venue = venues.find(v => v.id === req.params.id);
        const url = buildDirectionsUrl(venue);
        res.json({ url, venueName: venue.name, address: venue.address });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

process.on('uncaughtException', (err) => {
    console.error('Server uncaughtException:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Server unhandledRejection:', reason);
});


// ==========================================
// REVIEWS & SOCIAL MEDIA ENDPOINTS
// ==========================================
app.get('/api/venues/:id/reviews', async (req, res) => {
    try {
        const venueId = req.params.id;
        const reviews = await db.getVenueReviews(venueId, 40);
        const summary = await db.getVenueReviewsSummary(venueId);
        res.json({ venueId, summary, reviews });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/venues/:id/reviewers', async (req, res) => {
    try {
        const venueId = req.params.id;
        const data = await db.getVenueReviewerHighlights(venueId);
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/venues/:id/reviews', async (req, res) => {
    try {
        const venueId = req.params.id;
        const { source = 'user', authorName = 'Kiris (Thực khách)', rating = 5.0, content, tags = [] } = req.body;
        if (!content || !content.trim()) return res.status(400).json({ error: 'Content required' });
        const result = await db.addVenueReview({ venueId, source, authorName, rating: Number(rating), content, tags });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ==========================================
// 1-CLICK PRESET SCENARIOS & VIRAL OUTING SHARE
// ==========================================
app.get('/api/presets', (req, res) => {
    res.json({
        presets: [
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
        ]
    });
});

app.post('/api/outings/generate-share-text', (req, res) => {
    try {
        const { venue, friends = [], groupScore, outingCode = 'EAT-2026' } = req.body;
        if (!venue) return res.status(400).json({ error: 'Venue data required' });

        const friendTravels = friends.map(f => {
            const dKm = calcDistanceKm({ lat: f.lat, lng: f.lng }, { lat: venue.lat, lng: venue.lng });
            const estMin = Math.max(3, Math.round(dKm * 3.2));
            return '  👤 ' + f.name + ': ~' + dKm.toFixed(1) + ' km (~' + estMin + ' phút)';
        }).join('\n');

        const signature = (venue.signatureDishes && venue.signatureDishes.length > 0)
            ? venue.signatureDishes.join(', ')
            : (venue.category || 'Món ngon bản địa');

        const mapsUrl = buildDirectionsUrl(venue);

        const host = req.get('host') || 'gathermap.onrender.com';
        const protocol = req.protocol === 'https' || host.includes('render.com') ? 'https' : 'http';
        const appUrl = `${protocol}://${host}`;

        const message = [
            '🎉 KÈO ĂN UỐNG ĐÃ CHỐT BẰNG GATHERMAP!',
            '──────────────────────',
            '📍 Quán: ' + venue.name,
            '🏠 Địa chỉ: ' + (venue.address || 'Trung tâm TP.HCM'),
            '⭐ Đánh giá: ' + (venue.rating || 4.5) + '★ | 💰 Giá: ' + (venue.avgPrice || venue.priceLevel || 'Bình dân'),
            '⚖️ Độ công bằng vị trí nhóm: ' + (venue.groupScore || groupScore || 90) + '/100',
            '',
            '🚗 Khoảng cách di chuyển của từng bạn:',
            friendTravels,
            '',
            '🍜 Món ruột nên thử: ' + signature,
            (venue.socialCons ? '⚠️ Lưu ý: ' + venue.socialCons : ''),
            '',
            '🗺️ Bấm vào đây để chỉ đường Google Maps:',
            mapsUrl,
            '──────────────────────',
            '👉 Xem bản đồ & cùng bình chọn tại: ' + appUrl + ' (Mã kèo: #' + outingCode + ')'
        ].filter(line => line !== null && line !== undefined).join('\n');

        res.json({ message, shareUrl: mapsUrl, venueName: venue.name, appUrl });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Health check endpoint for uptime monitors & cold-start prevention
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        database: db.dbType
    });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 GATHERMAP backend running at http://localhost:${PORT}`);
        console.log(`🤖 AI Engine: ${GEMINI_KEY ? 'Connected (Gemini Multi-Model Fallback)' : 'Disabled'}`);
        console.log(`💾 Database: ${db.dbType}`);

        // Self-ping every 9 minutes to prevent Render Free Tier from falling asleep
        const RENDER_APP_URL = process.env.RENDER_EXTERNAL_URL || 'https://gathermap.onrender.com';
        if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
            console.log(`⏱️ Keep-Alive ping active targeting: ${RENDER_APP_URL}/api/health`);
            setInterval(async () => {
                try {
                    await fetch(`${RENDER_APP_URL}/api/health`);
                    console.log(`💓 Keep-alive ping sent to ${RENDER_APP_URL}`);
                } catch (err) {
                    // silent fallback
                }
            }, 9 * 60 * 1000);
        }
    });
}



module.exports = app;
