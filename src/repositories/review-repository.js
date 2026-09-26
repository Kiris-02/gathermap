/**
 * Review Repository
 * Handles social reviews from Google Local Guide, TikTok, Facebook, ShopeeFood, and Users.
 */

const { getSupabaseClient, getSqliteDb, isSupabaseConfigured } = require('./db-client');
const { getVenueById } = require('./venue-repository');

const venueReviewsCache = new Map();
let allReviewsPreloaded = false;

function formatReviewRecord(r) {
    if (!r) return null;
    return {
        id: r.id,
        venueId: r.venue_id || r.venueId,
        source: r.source || 'user',
        authorName: r.author_name || r.authorName || 'Thực khách',
        authorAvatar: r.author_avatar || r.authorAvatar || '',
        rating: Number(r.rating || 5.0),
        content: r.content || '',
        sentiment: r.sentiment || 'positive',
        tags: typeof r.tags === 'string' ? JSON.parse(r.tags || '[]') : (r.tags || []),
        likesCount: Number(r.likes_count || r.likesCount || 0),
        reviewDate: r.review_date || r.date_text || 'Gần đây'
    };
}

async function preloadAllReviews() {
    if (allReviewsPreloaded) return;
    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            const { data, error } = await client.from('reviews').select('*').order('created_at', { ascending: false });
            if (!error && data) {
                data.forEach(r => {
                    const formatted = formatReviewRecord(r);
                    if (!venueReviewsCache.has(formatted.venueId)) {
                        venueReviewsCache.set(formatted.venueId, []);
                    }
                    venueReviewsCache.get(formatted.venueId).push(formatted);
                });
                allReviewsPreloaded = true;
                return;
            }
        } catch (e) {
            console.warn('Supabase preloadAllReviews warning:', e.message);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            const rows = sqliteDb.prepare('SELECT * FROM reviews ORDER BY created_at DESC').all();
            rows.forEach(r => {
                const formatted = formatReviewRecord(r);
                if (!venueReviewsCache.has(formatted.venueId)) {
                    venueReviewsCache.set(formatted.venueId, []);
                }
                venueReviewsCache.get(formatted.venueId).push(formatted);
            });
            allReviewsPreloaded = true;
        } catch (e) {
            console.warn('SQLite preloadAllReviews warning:', e.message);
        }
    }
}

async function getVenueReviews(venueId, limit = 50) {
    if (!venueId) return [];
    if (venueReviewsCache.has(venueId)) {
        const cached = venueReviewsCache.get(venueId);
        return cached.slice(0, limit);
    }

    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            const { data } = await client.from('reviews').select('*').eq('venue_id', venueId).order('created_at', { ascending: false }).limit(limit);
            const formatted = (data || []).map(formatReviewRecord);
            venueReviewsCache.set(venueId, formatted);
            return formatted;
        } catch (e) {
            console.error('Supabase getVenueReviews error:', e.message);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            const rows = sqliteDb.prepare('SELECT * FROM reviews WHERE venue_id = ? ORDER BY created_at DESC LIMIT ?').all(venueId, limit);
            const formatted = rows.map(formatReviewRecord);
            venueReviewsCache.set(venueId, formatted);
            return formatted;
        } catch (e) {
            console.warn('SQLite getVenueReviews warning:', e.message);
        }
    }

    return [];
}

async function addVenueReview({ venueId, source = 'user', authorName = 'Kiris (Thực khách)', rating = 5.0, content, sentiment = 'positive', tags = [] }) {
    const id = 'rev-' + Date.now();
    const reviewDate = 'Vừa xong';
    const tagStr = JSON.stringify(tags || []);

    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            await client.from('reviews').insert([{
                id,
                venue_id: venueId,
                source,
                author_name: authorName,
                rating,
                content,
                tags: tagStr,
                date_text: reviewDate
            }]);
            venueReviewsCache.delete(venueId);
            return { id, success: true };
        } catch (e) {
            console.error('Supabase addVenueReview error:', e.message);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            sqliteDb.prepare(`
                INSERT INTO reviews (id, venue_id, source, author_name, rating, content, sentiment, tags, likes_count, review_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `).run(id, venueId, source, authorName, rating, content, sentiment, tagStr, reviewDate);
            venueReviewsCache.delete(venueId);
            return { id, success: true };
        } catch (e) {
            console.error('SQLite addVenueReview error:', e.message);
            throw e;
        }
    }

    return { id, success: true };
}

async function getVenueReviewerHighlights(venueId) {
    const venue = await getVenueById(venueId);
    const reviews = await getVenueReviews(venueId, 6);
    return {
        venueId,
        name: venue ? venue.name : '',
        address: venue ? venue.address : '',
        category: venue ? venue.category : '',
        rating: venue ? (venue.rating ?? null) : null,
        socialHighlights: venue ? (venue.socialHighlights || {}) : {},
        reviewerCount: reviews.length,
        reviewers: reviews
    };
}

module.exports = {
    preloadAllReviews,
    getVenueReviews,
    addVenueReview,
    getVenueReviewerHighlights,
    formatReviewRecord
};
