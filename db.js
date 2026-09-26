/**
 * Database Module (Backward Compatibility Adapter)
 * Delegates all database operations to modular repositories in src/repositories/
 */

const { isSupabaseConfigured, dbType, getSupabaseClient, getSqliteDb } = require('./src/repositories/db-client');
const venueRepository = require('./src/repositories/venue-repository');
const reviewRepository = require('./src/repositories/review-repository');
const outingRepository = require('./src/repositories/outing-repository');
const { calcDistanceKm } = require('./src/algorithms/geometric-median');

function haversineKm(lat1, lon1, lat2, lon2) {
    return calcDistanceKm({ lat: lat1, lng: lon1 }, { lat: lat2, lng: lon2 });
}

async function getVenueReviewsSummary(venueId) {
    const reviews = await reviewRepository.getVenueReviews(venueId, 20);
    if (reviews.length === 0) {
        return {
            count: 0,
            avgRating: null,
            sources: [],
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

module.exports = {
    isSupabaseConfigured,
    dbType,
    getSupabaseClient,
    getSqliteDb,
    getAllVenues: venueRepository.getAllVenues,
    getVenuesInRadius: venueRepository.getVenuesInRadius,
    saveOuting: outingRepository.saveOuting,
    getOuting: outingRepository.getOuting,
    saveParticipants: outingRepository.saveParticipants,
    saveRecommendations: outingRepository.saveRecommendations,
    recordVote: outingRepository.recordVote,
    getVotes: outingRepository.getVotes,
    getVenueReviews: reviewRepository.getVenueReviews,
    preloadAllReviews: reviewRepository.preloadAllReviews,
    addVenueReview: reviewRepository.addVenueReview,
    getVenueReviewsSummary,
    getVenueReviewerHighlights: reviewRepository.getVenueReviewerHighlights,
    haversineKm,
    INITIAL_VENUES: venueRepository.INITIAL_VENUES
};
