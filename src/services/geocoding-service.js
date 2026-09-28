/**
 * Geocoding Service
 * Resilient multi-tier geocoding with in-memory caching:
 * 1. Cache
 * 2. Verified Saigon Landmarks Dictionary
 * 3. Google Maps Geocoding API (if key available)
 * 4. OpenStreetMap Nominatim (Free Fallback)
 * 5. Gemini AI query normalization (if key available)
 */

const { API_PROVIDERS } = require('../config/constants');

const geocodeCache = new Map();

const KNOWN_LANDMARKS = {
    'landmark 81': { lat: 10.7950, lng: 106.7218, name: 'Landmark 81', address: '720A Điện Biên Phủ, Vinhomes Tân Cảng, Bình Thạnh, TP.HCM' },
    'bến thành': { lat: 10.7725, lng: 106.6980, name: 'Chợ Bến Thành', address: 'Lê Lợi, Phường Bến Thành, Quận 1, TP.HCM' },
    'nhà thờ đức bà': { lat: 10.7798, lng: 106.6990, name: 'Nhà thờ Đức Bà Sài Gòn', address: '01 Công xã Paris, Bến Nghé, Quận 1, TP.HCM' },
    'phố đi bộ nguyễn huệ': { lat: 10.7745, lng: 106.7032, name: 'Phố đi bộ Nguyễn Huệ', address: 'Đường Nguyễn Huệ, Bến Nghé, Quận 1, TP.HCM' },
    'hồ con rùa': { lat: 10.7827, lng: 106.6958, name: 'Hồ Con Rùa', address: 'Công trường Quốc tế, Phường 6, Quận 3, TP.HCM' },
    'bitexco': { lat: 10.7716, lng: 106.7044, name: 'Bitexco Financial Tower', address: '2 Hải Triều, Bến Nghé, Quận 1, TP.HCM' },
    'vạn hạnh mall': { lat: 10.7725, lng: 106.6698, name: 'Vạn Hạnh Mall', address: '11 Sư Vạn Hạnh, Phường 12, Quận 10, TP.HCM' },
    'ueh b': { lat: 10.7615, lng: 106.6675, name: 'UEH Cơ sở B', address: '279 Nguyễn Tri Phương, Phường 5, Quận 10, TP.HCM' },
    'hồ thị kỷ': { lat: 10.7663, lng: 106.6749, name: 'Chợ hoa Hồ Thị Kỷ', address: 'Hồ Thị Kỷ, Phường 1, Quận 10, TP.HCM' }
};

async function geocodeAddress(query, { googleKey = '', geminiKey = '' } = {}) {
    const rawQuery = (query || '').trim();
    if (!rawQuery) {
        throw new Error('Query parameter q is required');
    }

    const cacheKey = rawQuery.toLowerCase();
    if (geocodeCache.has(cacheKey)) {
        return geocodeCache.get(cacheKey);
    }

    let normalizedQuery = rawQuery;
    let locationExplanation = '';

    // 1. Check known landmark dictionary
    for (const [k, v] of Object.entries(KNOWN_LANDMARKS)) {
        if (cacheKey.includes(k) || k.includes(cacheKey)) {
            const result = {
                source: 'known_landmarks',
                name: rawQuery,
                standardName: v.name,
                address: v.address,
                lat: v.lat,
                lng: v.lng,
                placeId: 'landmark_' + k.replace(/\s+/g, '_'),
                explanation: 'Tọa độ xác thực từ danh mục địa danh TP.HCM'
            };
            geocodeCache.set(cacheKey, result);
            return result;
        }
    }

    // 2. Google Geocoding API if key configured
    if (googleKey) {
        try {
            const gUrl = `${API_PROVIDERS.GOOGLE_GEOCODE_URL}?address=${encodeURIComponent(normalizedQuery + ', Ho Chi Minh City')}&key=${googleKey}`;
            const gRes = await fetch(gUrl);
            const gData = await gRes.json();
            if (gData.status === 'OK' && gData.results && gData.results.length > 0) {
                const item = gData.results[0];
                const result = {
                    source: 'google',
                    name: rawQuery,
                    standardName: item.formatted_address,
                    address: item.formatted_address,
                    lat: item.geometry.location.lat,
                    lng: item.geometry.location.lng,
                    placeId: item.place_id,
                    explanation: locationExplanation
                };
                geocodeCache.set(cacheKey, result);
                return result;
            } else if (gData.status === 'OVER_QUERY_LIMIT' || gData.status === 'REQUEST_DENIED') {
                console.warn(`[Geocoding] Google Maps API returned ${gData.status}: ${gData.error_message || ''}`);
            }
        } catch (e) {
            console.warn('[Geocoding] Google Geocoding error, falling back to OSM:', e.message);
        }
    }

    // 3. OpenStreetMap Nominatim Fallback
    try {
        const queriesToTry = [normalizedQuery, rawQuery];
        for (const qTry of queriesToTry) {
            const osmUrl = `${API_PROVIDERS.NOMINATIM_BASE_URL}?format=json&q=${encodeURIComponent(qTry + ', Ho Chi Minh City')}&limit=1`;
            const osmRes = await fetch(osmUrl, {
                headers: { 'User-Agent': 'GatherMap-App/2.0 (skrongdattv1@gmail.com)' }
            });
            const osmData = await osmRes.json();
            if (osmData && osmData.length > 0) {
                const item = osmData[0];
                const result = {
                    source: 'openstreetmap',
                    name: rawQuery,
                    standardName: item.display_name,
                    address: item.display_name,
                    lat: parseFloat(item.lat),
                    lng: parseFloat(item.lon),
                    placeId: 'osm_' + item.place_id,
                    explanation: locationExplanation
                };
                geocodeCache.set(cacheKey, result);
                return result;
            }
        }
    } catch (e) {
        console.warn('[Geocoding] OSM Geocoding fallback error:', e.message);
    }

    // 4. Default fallback near District 10 center if known generic request
    if (cacheKey.includes('quận 10') || cacheKey.includes('district 10') || cacheKey.includes('q10')) {
        const result = {
            source: 'district_fallback',
            name: rawQuery,
            standardName: 'Quận 10, TP.HCM',
            address: 'Quận 10, TP.HCM',
            lat: 10.7725,
            lng: 106.6698,
            placeId: 'district_10',
            explanation: 'Tọa độ trung tâm Quận 10'
        };
        geocodeCache.set(cacheKey, result);
        return result;
    }

    return null;
}

module.exports = {
    geocodeAddress,
    KNOWN_LANDMARKS
};
