/**
 * Venue Repository
 * Provides unified access to venues table across Supabase and SQLite.
 */

const { getSupabaseClient, getSqliteDb, isSupabaseConfigured } = require('./db-client');
const { calcDistanceKm } = require('../algorithms/geometric-median');
const INITIAL_VENUES = require('../data/initial-venues.json');

function formatVenueRecord(r) {
    if (!r) return null;
    const rawAttrs = r.attributes || r.traits || {};
    const attrs = typeof rawAttrs === 'string' ? JSON.parse(rawAttrs || '{}') : (rawAttrs || {});

    // Truthful extraction: do NOT fabricate defaults when values are missing
    const rawDietary = attrs.dietary || {};
    const dietary = {
        vegetarian: rawDietary.vegetarian !== undefined ? Boolean(rawDietary.vegetarian) : null,
        vegan: rawDietary.vegan !== undefined ? Boolean(rawDietary.vegan) : null,
        halal: rawDietary.halal !== undefined ? Boolean(rawDietary.halal) : null,
        noAlcohol: rawDietary.noAlcohol !== undefined ? Boolean(rawDietary.noAlcohol) : null
    };

    const noiseLevel = attrs.noiseLevel?.value ? attrs.noiseLevel : { value: null };
    const parking = attrs.parking?.ease ? attrs.parking : { ease: null };
    const matcha = attrs.matcha || { value: false };

    const safeAttrs = {
        ...attrs,
        dietary,
        noiseLevel,
        parking,
        matcha
    };

    const tags = typeof r.tags === 'string' ? JSON.parse(r.tags || '[]') : (r.tags || []);
    const unknowns = typeof r.unknowns === 'string' ? JSON.parse(r.unknowns || '[]') : (r.unknowns || []);

    return {
        id: r.id,
        name: r.name,
        category: r.category,
        type: r.type || 'restaurant',
        isAlley: Boolean(r.is_alley != null ? r.is_alley : r.isAlley),
        alleyNote: r.alley_note || r.alleyNote || '',
        address: r.address,
        placeId: r.place_id || r.placeId || '',
        lat: Number(r.lat),
        lng: Number(r.lng),
        rating: r.rating != null ? Number(r.rating) : null,
        reviewsCount: r.reviews_count != null ? Number(r.reviews_count) : (r.reviewsCount != null ? Number(r.reviewsCount) : 0),
        pricePerPersonVnd: r.price_per_person_vnd != null ? Number(r.price_per_person_vnd) : (r.pricePerPersonVnd != null ? Number(r.pricePerPersonVnd) : null),
        avgPrice: r.avg_price || r.avgPrice || 'Bình dân',
        tags,
        attributes: safeAttrs,
        unknowns,
        socialHighlights: attrs.socialHighlights || r.socialHighlights || {},
        openingHours: attrs.openingHours || r.openingHours || null
    };
}

async function getAllVenues() {
    let venues = [];
    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            const { data, error } = await client.from('venues').select('*');
            if (error) throw error;
            venues = (data || []).map(formatVenueRecord);
        } catch (e) {
            console.error('Supabase getAllVenues error:', e.message);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            const existingIds = new Set(venues.map(v => v.id));
            const rows = sqliteDb.prepare('SELECT * FROM venues').all();
            for (const row of rows) {
                if (!existingIds.has(row.id)) {
                    venues.push(formatVenueRecord(row));
                    existingIds.add(row.id);
                }
            }
        } catch (err) {
            console.warn('SQLite getAllVenues warning:', err.message);
        }
    }

    // Guarantee curated flagship venues are always present
    const existingIds = new Set(venues.map(v => v.id));
    for (const iv of INITIAL_VENUES) {
        if (!existingIds.has(iv.id)) {
            venues.push(formatVenueRecord(iv));
        }
    }

    return venues;
}

async function getVenuesInRadius({ lat, lng, radiusKm = 3 }) {
    const venues = await getAllVenues();
    return venues.map(v => {
        const distKm = calcDistanceKm({ lat, lng }, { lat: v.lat, lng: v.lng });
        return {
            ...v,
            distFromCenterKm: Number(distKm.toFixed(2))
        };
    }).filter(v => v.distFromCenterKm <= radiusKm);
}

async function getVenueById(id) {
    if (!id) return null;
    const all = await getAllVenues();
    return all.find(v => v.id === id) || null;
}

module.exports = {
    formatVenueRecord,
    getAllVenues,
    getVenuesInRadius,
    getVenueById,
    INITIAL_VENUES
};
