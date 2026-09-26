/**
 * Venues Controller
 */

const venueRepository = require('../repositories/venue-repository');
const reviewRepository = require('../repositories/review-repository');
const { searchAndRankVenues } = require('../services/recommendation-service');
const { parsePreferences } = require('../services/ai-service');
const { buildDirectionsUrl, buildSearchUrl, fetchGooglePlacesNearby } = require('../services/places-service');

async function getVenues(req, res, next) {
    try {
        const venues = await venueRepository.getAllVenues();
        res.json({
            count: venues.length,
            venues
        });
    } catch (err) {
        next(err);
    }
}

async function getVenueMapLink(req, res, next) {
    try {
        const venue = await venueRepository.getVenueById(req.params.id);
        if (!venue) {
            return res.status(404).json({ error: 'venue_not_found', message: 'Venue not found' });
        }
        res.json({
            id: venue.id,
            name: venue.name,
            directionsUrl: buildDirectionsUrl(venue),
            searchUrl: buildSearchUrl(venue)
        });
    } catch (err) {
        next(err);
    }
}

async function getVenueReviews(req, res, next) {
    try {
        const reviews = await reviewRepository.getVenueReviews(req.params.id, 50);
        res.json({
            venueId: req.params.id,
            count: reviews.length,
            reviews
        });
    } catch (err) {
        next(err);
    }
}

async function getVenueReviewers(req, res, next) {
    try {
        const highlights = await reviewRepository.getVenueReviewerHighlights(req.params.id);
        res.json(highlights);
    } catch (err) {
        next(err);
    }
}

async function addVenueReview(req, res, next) {
    try {
        const { source, authorName, rating, content, tags } = req.body;
        const result = await reviewRepository.addVenueReview({
            venueId: req.params.id,
            source,
            authorName,
            rating,
            content,
            tags
        });
        res.status(201).json(result);
    } catch (err) {
        next(err);
    }
}

async function nearbyPlaces(req, res, next) {
    try {
        const { center = { lat: 10.7769, lng: 106.7009 }, radiusMeters = 3000 } = req.body;
        const places = await fetchGooglePlacesNearby(center, radiusMeters, process.env.GOOGLE_MAPS_API_KEY);
        res.json({ places });
    } catch (err) {
        next(err);
    }
}

async function handleParsePreferences(req, res, next) {
    try {
        const result = await parsePreferences(req.body, process.env.GEMINI_API_KEY);
        res.json(result);
    } catch (err) {
        next(err);
    }
}

async function handleSearchAndRank(req, res, next) {
    try {
        const result = await searchAndRankVenues(req.body);
        res.json(result);
    } catch (err) {
        next(err);
    }
}

module.exports = {
    getVenues,
    getVenueMapLink,
    getVenueReviews,
    getVenueReviewers,
    addVenueReview,
    nearbyPlaces,
    handleParsePreferences,
    handleSearchAndRank
};
