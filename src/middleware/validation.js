/**
 * Input Validation Middleware
 * Validates request payloads on all mutating endpoints to prevent invalid database writes or NaN computations.
 */

function validateSearchAndRank(req, res, next) {
    const { center, radiusMeters, friends } = req.body || {};

    if (center) {
        if (typeof center.lat !== 'number' || typeof center.lng !== 'number' || isNaN(center.lat) || isNaN(center.lng)) {
            return res.status(400).json({ error: 'invalid_coordinates', message: 'center.lat and center.lng must be valid numbers' });
        }
    }

    if (radiusMeters !== undefined) {
        const r = Number(radiusMeters);
        if (isNaN(r) || r <= 0 || r > 50000) {
            return res.status(400).json({ error: 'invalid_radius', message: 'radiusMeters must be a positive number up to 50,000' });
        }
    }

    if (friends !== undefined && !Array.isArray(friends)) {
        return res.status(400).json({ error: 'invalid_friends', message: 'friends must be an array' });
    }

    next();
}

function validateVote(req, res, next) {
    const { venueId } = req.body || {};
    const { id: outingId } = req.params;

    if (!outingId || typeof outingId !== 'string') {
        return res.status(400).json({ error: 'invalid_outing_id', message: 'outing id parameter is required' });
    }

    if (!venueId || typeof venueId !== 'string') {
        return res.status(400).json({ error: 'invalid_venue_id', message: 'venueId is required' });
    }

    next();
}

function validateReview(req, res, next) {
    const { content, rating } = req.body || {};
    const { id: venueId } = req.params;

    if (!venueId) {
        return res.status(400).json({ error: 'invalid_venue_id', message: 'venue id parameter is required' });
    }

    if (!content || typeof content !== 'string' || !content.trim()) {
        return res.status(400).json({ error: 'missing_content', message: 'Review content cannot be empty' });
    }

    if (rating !== undefined) {
        const r = Number(rating);
        if (isNaN(r) || r < 1 || r > 5) {
            return res.status(400).json({ error: 'invalid_rating', message: 'Rating must be a number between 1 and 5' });
        }
    }

    next();
}

function validateGeometricMedian(req, res, next) {
    const { points } = req.body || {};
    if (!points || !Array.isArray(points) || points.length === 0) {
        return res.status(400).json({ error: 'invalid_points', message: 'points must be a non-empty array of coordinate objects' });
    }
    next();
}

module.exports = {
    validateSearchAndRank,
    validateVote,
    validateReview,
    validateGeometricMedian
};
