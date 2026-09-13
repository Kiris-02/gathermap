
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

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const db = require('./db');

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

app.use(express.static(path.join(__dirname, 'public')));

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
        googleMapsKey: GOOGLE_KEY,
        hasAIKey: Boolean(GEMINI_KEY),
        aiModel: GEMINI_KEY ? 'gemini-3.6-flash / gemini-3.8-flash' : 'none',
        databaseType: db.dbType,
        isSupabaseConfigured: db.isSupabaseConfigured,
        version: '1.0.0-spec-compliant',
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
            let priceVnd = 65000;
            let avgPrice = '45k - 90k VND';
            if (p.priceLevel === 'PRICE_LEVEL_INEXPENSIVE') { priceVnd = 40000; avgPrice = '30k - 50k VND'; }
            else if (p.priceLevel === 'PRICE_LEVEL_MODERATE') { priceVnd = 85000; avgPrice = '60k - 120k VND'; }
            else if (p.priceLevel === 'PRICE_LEVEL_EXPENSIVE') { priceVnd = 180000; avgPrice = '120k - 250k VND'; }

            const openHours = p.regularOpeningHours?.weekdayDescriptions || [];

            return {
                id: p.id,
                name: p.displayName?.text || 'Google Eatery',
                category: (p.types?.[0] || 'restaurant').replace(/_/g, ' '),
                type: (p.types || []).includes('cafe') ? 'cafe' : 'restaurant',
                isAlley,
                alleyNote: isAlley ? 'Vị trí trong hẻm/địa chỉ ngõ, khuyên gửi xe ngoài' : '',
                address: addr,
                placeId: p.id,
                lat: p.location?.latitude || center.lat,
                lng: p.location?.longitude || center.lng,
                rating: p.rating || 4.5,
                reviewsCount: p.userRatingCount || 100,
                pricePerPersonVnd: priceVnd,
                avgPrice,
                openingHours: openHours,
                source: 'google_live',
                tags: ['Google Maps Live', p.rating >= 4.5 ? 'High Rated' : 'Popular', ...(isAlley ? ['Alley Eatery'] : [])],
                attributes: {
                    noiseLevel: { value: 'moderate', confidence: 'inferred' },
                    seatingComfort: { value: 'standard_dining', confidence: 'inferred' },
                    dietary: { vegetarian: true, vegan: false, halal: false, noAlcohol: !((p.types||[]).includes('bar')) },
                    matcha: { value: false, confidence: 'inferred' },
                    wifiSpeed: { value: 'normal', confidence: 'inferred' },
                    parking: { ease: 'moderate', note: 'Gửi xe lân cận', confidence: 'inferred' }
                },
                unknowns: ['Kiểm tra giờ mở cửa thực tế trên ứng dụng Google Maps trước khi đến']
            };
        });
    } catch (err) {
        console.error('Error calling Google Places API (New):', err.message);
        return [];
    }
}

// Geocoding endpoint (Gemini AI Natural Language Location Resolver + Google / OSM fallback)
app.get('/api/geocode', async (req, res) => {
    const q = (req.query.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Query parameter q required' });

    // 1. LLM NATURAL LANGUAGE PLACE INTERPRETATION (Resolves "UEH B", "BK CS2", "Hồ Thị Kỷ", "Landmark 81"...)
    if (GEMINI_KEY) {
        try {
            const prompt = `Bạn là chuyên gia bản đồ và ngôn ngữ đời sống tại TP.HCM (Sài Gòn).
Người dùng nhập cụm từ địa danh tiếng Việt đời thường, từ viết tắt trường học, chợ, công viên hoặc tiếng lóng địa phương: "${q}".
Hãy giải mã chính xác địa điểm này tại TP.HCM (hoặc vùng phụ cận).
Trả về JSON duy nhất:
{
  "recognized": true,
  "standardName": "Tên địa điểm chuẩn (ví dụ: Trường Đại học Kinh tế TP.HCM - Cơ sở B)",
  "fullAddress": "Địa chỉ đầy đủ tại TP.HCM (ví dụ: 279 Nguyễn Tri Phương, Phường 5, Quận 10, TP.HCM)",
  "searchQuery": "Địa chỉ tối ưu ngắn gọn (ví dụ: 279 Nguyễn Tri Phương, Quận 10, TP.HCM)",
  "lat": 10.763462,
  "lng": 106.666998,
  "explanation": "Giải thích ngắn gọn nguồn gốc từ lóng/viết tắt"
}`;

            const aiResp = await callGemini(prompt, 'application/json');
            if (aiResp && aiResp.text) {
                const aiData = JSON.parse(aiResp.text);
                if (aiData && aiData.recognized && aiData.lat && aiData.lng) {
                    console.log(`🧠 AI Geocoded "${q}" -> ${aiData.standardName} (${aiData.lat}, ${aiData.lng})`);
                    return res.json({
                        source: 'gemini_nlp',
                        name: aiData.standardName || q,
                        address: aiData.fullAddress || aiData.standardName,
                        lat: Number(aiData.lat),
                        lng: Number(aiData.lng),
                        explanation: aiData.explanation || '',
                        aiModel: aiResp.model
                    });
                }
            }
        } catch (err) {
            console.warn('AI Geocoding notice:', err.message);
        }
    }

    // 2. If Google Key exists, use Google Geocoding API
    if (GOOGLE_KEY) {
        try {
            const gRes = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q + ', Ho Chi Minh City')}&key=${GOOGLE_KEY}`);
            const gData = await gRes.json();
            if (gData.results && gData.results.length > 0) {
                const item = gData.results[0];
                return res.json({
                    source: 'google',
                    name: q,
                    address: item.formatted_address,
                    lat: item.geometry.location.lat,
                    lng: item.geometry.location.lng,
                    placeId: item.place_id
                });
            }
        } catch (e) {
            console.error('Google Geocoding error, falling back:', e.message);
        }
    }

    // 3. Free Fallback Geocoding via Nominatim
    try {
        const osmRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q + ', Ho Chi Minh City')}&limit=1`, {
            headers: { 'User-Agent': 'GatherMap-App/1.0' }
        });
        const osmData = await osmRes.json();
        if (osmData && osmData.length > 0) {
            const item = osmData[0];
            return res.json({
                source: 'openstreetmap',
                name: q,
                address: item.display_name,
                lat: parseFloat(item.lat),
                lng: parseFloat(item.lon),
                placeId: 'osm_' + item.place_id
            });
        }
    } catch (e) {
        console.error('OSM Geocoding error:', e.message);
    }

    res.status(404).json({ error: 'Location not found' });
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
app.get('/api/venues/all', async (req, res) => {
    try {
        const venues = await db.getAllVenues();
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
// 3. AI PREFERENCE PARSER (Connected to Gemini)
// ==========================================
app.post('/api/preferences/parse', async (req, res) => {
    const { discussionText = '', friends = [] } = req.body;

    if (GEMINI_KEY && (discussionText || friends.some(f => f.wish))) {
        const combinedWishes = friends.map(f => `${f.name}: "${f.wish || ''}"`).join('\n');
        const prompt = `You are an AI Preference Interpreter strictly following the Group Eatery Recommendation Specification.
Extract hard required constraints and weighted soft preferences from the input text.
Return ONLY valid raw JSON with this exact schema:
{
  "requiredConstraints": {
    "vegetarian": boolean,
    "no_alcohol": boolean,
    "max_price_vnd": number or null,
    "quiet_only": boolean
  },
  "softPreferences": [
    {
      "preference": string,
      "criterion": "quiet_atmosphere" | "matcha_and_aesthetic" | "alley_vibe_and_hearty_food" | "live_music_pub" | "authentic_vietnamese",
      "weight": number (1-5),
      "memberName": string
    }
  ]
}

Group Discussion / Wishes:
${discussionText}
${combinedWishes}`;

        const aiResponse = await callGemini(prompt, 'application/json');
        if (aiResponse && aiResponse.text) {
            try {
                const parsed = JSON.parse(aiResponse.text);
                return res.json({
                    ...parsed,
                    aiPowered: true,
                    aiModel: aiResponse.model
                });
            } catch (jsonErr) {
                console.warn('Failed to parse AI JSON:', jsonErr.message);
            }
        }
    }

    // Deterministic English fallback
    const requiredConstraints = {};
    const softPreferences = [];
    const fullText = (discussionText + ' ' + friends.map(f => f.wish || '').join(' ')).toLowerCase();

    if (fullText.includes('vegetarian') || fullText.includes('vegan') || fullText.includes('chay')) {
        requiredConstraints.vegetarian = true;
    }
    if (fullText.includes('no alcohol') || fullText.includes('no beer') || fullText.includes('không cồn') || fullText.includes('không bia')) {
        requiredConstraints.no_alcohol = true;
    }
    if (fullText.includes('under 50k') || fullText.includes('under 60k') || fullText.includes('budget') || fullText.includes('< 50k')) {
        requiredConstraints.max_price_vnd = 65000;
    }
    if (fullText.includes('strictly quiet') || fullText.includes('quiet only') || fullText.includes('yên tĩnh')) {
        requiredConstraints.quiet_only = true;
    }

    if (fullText.includes('quiet') || fullText.includes('work') || fullText.includes('study') || fullText.includes('yên tĩnh')) {
        softPreferences.push({ preference: 'quiet workspace', criterion: 'quiet_atmosphere', weight: 5, memberName: 'Group' });
    }
    if (fullText.includes('matcha') || fullText.includes('aesthetic') || fullText.includes('photo') || fullText.includes('sống ảo')) {
        softPreferences.push({ preference: 'matcha & aesthetic ambiance', criterion: 'matcha_and_aesthetic', weight: 5, memberName: 'Group' });
    }
    if (fullText.includes('alley') || fullText.includes('street food') || fullText.includes('hearty') || fullText.includes('hẻm') || fullText.includes('bình dân')) {
        softPreferences.push({ preference: 'alley eatery hearty food', criterion: 'alley_vibe_and_hearty_food', weight: 4, memberName: 'Group' });
    }
    if (fullText.includes('live music') || fullText.includes('acoustic') || fullText.includes('pub') || fullText.includes('beer') || fullText.includes('chill')) {
        softPreferences.push({ preference: 'live acoustic music & pub', criterion: 'live_music_pub', weight: 4, memberName: 'Group' });
    }

    res.json({ requiredConstraints, softPreferences, aiPowered: false });
});

// Normalization Helpers
function normalizeConstraints(reqs) {
    if (Array.isArray(reqs)) {
        return reqs.map(r => typeof r === 'string' ? { criterion: r, value: true } : r);
    }
    if (typeof reqs === 'object' && reqs !== null) {
        return Object.entries(reqs)
            .filter(([k, v]) => v === true || typeof v === 'number')
            .map(([k, v]) => ({ criterion: k, value: v }));
    }
    return [];
}

function normalizeSoft(soft) {
    if (!Array.isArray(soft)) return [];
    return soft.map(s => {
        let crit = s.criterion || 'general';
        const pref = (s.preference || '').toLowerCase();
        if (pref.includes('quiet') || pref.includes('work') || pref.includes('study')) crit = 'quiet_atmosphere';
        else if (pref.includes('matcha') || pref.includes('aesthetic') || pref.includes('photo')) crit = 'matcha_and_aesthetic';
        else if (pref.includes('alley') || pref.includes('street') || pref.includes('hearty')) crit = 'alley_vibe_and_hearty_food';
        else if (pref.includes('music') || pref.includes('acoustic') || pref.includes('pub') || pref.includes('beer')) crit = 'live_music_pub';
        else if (pref.includes('vietnamese') || pref.includes('traditional')) crit = 'authentic_vietnamese';

        return {
            criterion: crit,
            weight: s.weight || 3,
            target: s.preference || 'general',
            memberName: s.memberName || 'Group'
        };
    });
}

// ==========================================
// 4. RANKING & SHORTLIST GENERATOR (65/35 Formula & Gemini AI Synthesis)
// ==========================================
app.post('/api/venues/search-and-rank', async (req, res) => {
    try {
        const {
            outingId = 'outing_' + Date.now(),
            outingName = 'Weekend Eatery Hangout',
            mode = 'representative',
            center = { lat: 10.7769, lng: 106.7009 },
            radiusMeters = 3000,
            requiredConstraints = [],
            softPreferences = [],
            friends = []
        } = req.body;

        const normReqs = normalizeConstraints(requiredConstraints);
        const normSoft = normalizeSoft(softPreferences);
        const radiusKm = radiusMeters / 1000;

        // Query real database table
        let inCircleVenues = await db.getVenuesInRadius({ lat: center.lat, lng: center.lng, radiusKm });

        // If Google Maps API Key is configured, pull live Places API (New) data in real time!
        if (GOOGLE_KEY) {
            const livePlaces = await fetchGooglePlacesNearby(center, radiusMeters);
            if (livePlaces.length > 0) {
                const existingNames = new Set(inCircleVenues.map(v => v.name.toLowerCase()));
                for (const p of livePlaces) {
                    if (!existingNames.has(p.name.toLowerCase())) {
                        inCircleVenues.push({
                            ...p,
                            distFromCenterKm: Number(db.haversineKm(center.lat, center.lng, p.lat, p.lng).toFixed(2))
                        });
                    }
                }
            }
        }

        if (inCircleVenues.length === 0) {
            return res.json({
                shortlist: [],
                totalEligible: 0,
                message: `No venues found within ${(radiusMeters / 1000).toFixed(1)} km of the geometric center. Please expand your radius!`
            });
        }

        // Apply hard required constraints
        const passedVenues = inCircleVenues.filter(venue => {
            for (const req of normReqs) {
                if (req.criterion === 'vegetarian' && !venue.attributes?.dietary?.vegetarian) return false;
                if (req.criterion === 'no_alcohol' && !venue.attributes?.dietary?.noAlcohol) return false;
                if (req.criterion === 'max_price_vnd' && venue.pricePerPersonVnd > req.value) return false;
                if (req.criterion === 'quiet_only' && venue.attributes?.noiseLevel?.value !== 'quiet') return false;
            }
            return true;
        });


        if (passedVenues.length === 0) {
            return res.json({
                shortlist: [],
                totalEligible: 0,
                message: 'No venues satisfy all required constraints. Try relaxing price or dietary filters.'
            });
        }

        // Compute scores using the 65/35 group formula
        const memberList = friends.length > 0 ? friends : [{ name: 'Group' }];
        const rankedVenues = passedVenues.map(venue => {
            const memberBreakdowns = memberList.map(friend => {
                const memberPrefs = normSoft.filter(p => p.memberName === friend.name || p.memberName === 'Group' || p.memberName === 'All');

                let totalWeight = 0;
                let weightedSum = 0;
                const friendDist = friend.lat ? db.haversineKm(friend.lat, friend.lng, venue.lat, venue.lng) : venue.distFromCenterKm;
                const travelMins = Math.max(5, Math.round((friendDist / 20) * 60));

                if (memberPrefs.length === 0) {
                    return {
                        friendName: friend.name,
                        score: Math.max(65, 88 - Math.round(friendDist * 3)),
                        travelMins,
                        distKm: Number(friendDist.toFixed(1))
                    };
                }

                memberPrefs.forEach(pref => {
                    const w = pref.weight || 3;
                    totalWeight += w;
                    let match = 0.5;

                    if (pref.criterion === 'quiet_atmosphere') {
                        if (venue.attributes?.noiseLevel?.value === 'quiet') match = 1.0;
                        else if (venue.attributes?.noiseLevel?.value === 'moderate') match = 0.6;
                        else match = 0.2;
                    } else if (pref.criterion === 'matcha_and_aesthetic') {
                        if (venue.attributes.matcha?.value && venue.tags.includes('Aesthetic')) match = 1.0;
                        else if (venue.attributes.matcha?.value || venue.tags.includes('Aesthetic')) match = 0.8;
                        else match = 0.3;
                    } else if (pref.criterion === 'alley_vibe_and_hearty_food') {
                        if (venue.isAlley || venue.tags.includes('Hearty Meal') || venue.tags.includes('Authentic')) match = 1.0;
                        else match = 0.5;
                    } else if (pref.criterion === 'live_music_pub') {
                        if (venue.tags.includes('Live Acoustic Music') || venue.category.includes('Pub')) match = 1.0;
                        else match = 0.2;
                    } else if (pref.criterion === 'authentic_vietnamese') {
                        if (venue.category.includes('Vietnamese') || venue.tags.includes('Vietnamese')) match = 1.0;
                        else match = 0.5;
                    }

                    weightedSum += w * match;
                });

                let memberScore = Math.round((weightedSum / (totalWeight || 1)) * 100);
                if (travelMins <= 10) memberScore = Math.min(100, memberScore + 4);
                else if (travelMins > 20) memberScore = Math.max(30, memberScore - 6);

                return {
                    friendName: friend.name,
                    score: memberScore,
                    travelMins,
                    distKm: Number(friendDist.toFixed(1))
                };
            });

            const scores = memberBreakdowns.map(m => m.score);
            const avgScore = scores.reduce((s, x) => s + x, 0) / scores.length;
            const lowestScore = Math.min(...scores);
            const highestScore = Math.max(...scores);

            // Group score: 65% group average + 35% minimum individual satisfaction
            const groupScore = Number((0.65 * avgScore + 0.35 * lowestScore).toFixed(1));

            const satisfiedMembers = memberBreakdowns.filter(m => m.score >= 80).map(m => m.friendName);
            const compromisedMembers = memberBreakdowns.filter(m => m.score < 65);

            let principalReasons = [];
            if (satisfiedMembers.length > 0) {
                principalReasons.push(`Strongly satisfies preferences of ${satisfiedMembers.join(', ')}`);
            }
            if (venue.isAlley) {
                principalReasons.push('Authentic Saigon alley eatery with hearty dining and high value');
            } else if (venue.attributes?.noiseLevel?.value === 'quiet') {
                principalReasons.push('Quiet atmosphere with comfortable seating, optimal for talking or working');
            }

            let principalCompromises = [];
            if (compromisedMembers.length > 0) {
                const comp = compromisedMembers[0];
                principalCompromises.push(`${comp.friendName} makes a minor trade-off (${comp.score}% satisfaction, ~${comp.travelMins}m travel)`);
            } else {
                principalCompromises.push('Equitable balance, no group member heavily compromised');
            }

            return {
                ...venue,
                groupScore,
                avgScore: Math.round(avgScore),
                lowestScore,
                highestScore,
                fairnessIndex: (groupScore / 10).toFixed(1) + ' / 10',
                memberBreakdowns,
                principalReasons,
                principalCompromises,
                aiRationale: '',
                votes: venue.votes || 0,
                directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}&destination_place_id=${venue.placeId}`,
                mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue.name)}&query_place_id=${venue.placeId}`,
                openingHoursNote: 'Vui lòng kiểm tra lại giờ mở cửa thực tế trên Google Maps trước khi xuất phát'
            };
        });

        rankedVenues.sort((a, b) => b.groupScore - a.groupScore);
        const shortlist = rankedVenues.slice(0, 5);

        // Attach social reviews summary and distilled highlights for each shortlist venue
        for (const venue of shortlist) {
            venue.reviewsSummary = await db.getVenueReviewsSummary(venue.id);
            venue.reviewerHighlights = await db.getVenueReviewerHighlights(venue.id);
            venue.reviewerCount = venue.reviewerHighlights.reviewerCount || 3;
            venue.signatureDishes = venue.reviewerHighlights.socialHighlights?.signatureDishes || [];
        }

        // Call Gemini to synthesize natural-language AI rationale for the top 3
        if (GEMINI_KEY && shortlist.length > 0) {
            const contextSummary = shortlist.slice(0, 3).map((v, i) =>
                `#${i+1} ${v.name} (Score: ${v.groupScore}/100, Price: ${v.avgPrice}, Category: ${v.category})`
            ).join('\n');

            const membersSummary = memberList.map(m => `${m.name}: "${m.wish || 'None'}"`).join('\n');

            const aiPrompt = `You are an expert Group Dining Concierge.
Given this group and the top matching eateries, write a concise 1-2 sentence recommendation in English for each of the top venues, explaining WHY it strikes the best balance for this specific group.
Return ONLY valid JSON:
{
  "venues": [
    { "name": string, "rationale": string }
  ]
}

Group Members:
${membersSummary}

Top Shortlist:
${contextSummary}`;

            const aiRes = await callGemini(aiPrompt, 'application/json');
            if (aiRes && aiRes.text) {
                try {
                    const aiResult = JSON.parse(aiRes.text);
                    (aiResult.venues || []).forEach(aiItem => {
                        const target = shortlist.find(s => s.name.toLowerCase().includes(aiItem.name.toLowerCase()) || aiItem.name.toLowerCase().includes(s.name.toLowerCase()));
                        if (target) {
                            target.aiRationale = aiItem.rationale;
                        }
                    });
                } catch (jsonErr) {
                    console.warn('AI Rationale JSON parse warning:', jsonErr.message);
                }
            }
        }

        // Persist session, participants, and recommendations to the active database
        await db.saveOuting({
            id: outingId,
            name: outingName,
            mode,
            centerLat: center.lat,
            centerLng: center.lng,
            radiusKm
        });
        await db.saveParticipants(outingId, memberList);
        await db.saveRecommendations(outingId, shortlist);

        res.json({
            shortlist,
            totalEligible: passedVenues.length,
            centerUsed: center,
            radiusUsedMeters: radiusMeters,
            activeHardConstraints: normReqs,
            activeSoftPreferences: normSoft,
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

app.get('/api/venues/:id/map-link', async (req, res) => {
    try {
        const venues = await db.getAllVenues();
        const venue = venues.find(v => v.id === req.params.id);
        if (!venue) return res.status(404).json({ error: 'venue_not_found' });
        const url = `https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}&destination_place_id=${venue.placeId}`;
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

        const mapsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' + venue.lat + ',' + venue.lng;

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


