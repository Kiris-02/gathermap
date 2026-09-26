/**
 * Places Service
 * Utilities for Google Maps directions links, place search URLs, and optional Places API Nearby search.
 */

const { API_PROVIDERS } = require('../config/constants');

function buildDirectionsUrl(venue) {
    if (!venue || venue.lat === undefined || venue.lng === undefined) {
        return 'https://www.google.com/maps';
    }
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

async function fetchGooglePlacesNearby(center, radiusMeters = 3000, googleKey = '') {
    if (!googleKey || !center || center.lat === undefined || center.lng === undefined) {
        return [];
    }
    try {
        const res = await fetch(API_PROVIDERS.GOOGLE_PLACES_NEARBY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': googleKey,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.priceLevel,places.primaryType'
            },
            body: JSON.stringify({
                includedTypes: ['restaurant', 'cafe', 'bakery', 'meal_takeaway'],
                maxResultCount: 20,
                locationRestriction: {
                    circle: {
                        center: { latitude: center.lat, longitude: center.lng },
                        radius: Math.min(radiusMeters, 5000)
                    }
                }
            })
        });
        const data = await res.json();
        if (data && Array.isArray(data.places)) {
            return data.places.map(p => ({
                id: p.id,
                name: p.displayName?.text || '',
                address: p.formattedAddress || '',
                lat: p.location?.latitude,
                lng: p.location?.longitude,
                rating: p.rating || null,
                reviewsCount: p.userRatingCount || 0,
                category: p.primaryType || 'Eatery'
            }));
        }
    } catch (e) {
        console.warn('[Places] Google Places nearby query error:', e.message);
    }
    return [];
}

module.exports = {
    buildDirectionsUrl,
    buildSearchUrl,
    fetchGooglePlacesNearby
};
