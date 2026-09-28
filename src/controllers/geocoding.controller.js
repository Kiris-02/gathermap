/**
 * Geocoding Controller
 */

const { geocodeAddress } = require('../services/geocoding-service');
const { calculateGeometricMedian, calcDistanceKm } = require('../algorithms/geometric-median');

async function geocode(req, res, next) {
    try {
        const query = (req.query.q || '').trim();
        if (!query) {
            return res.status(400).json({ error: 'invalid_query', message: 'Query parameter q is required' });
        }

        const result = await geocodeAddress(query, {
            googleKey: process.env.GOOGLE_MAPS_API_KEY,
            geminiKey: process.env.GEMINI_API_KEY
        });

        if (!result) {
            return res.status(404).json({ error: 'not_found', message: 'Location not found in verified geocoding services' });
        }

        res.json(result);
    } catch (err) {
        next(err);
    }
}

function computeGeometricMedian(req, res, next) {
    try {
        const { points } = req.body;
        const median = calculateGeometricMedian(points);
        const distances = points.map(p => ({
            name: p.name || 'Friend',
            distanceKm: Number(calcDistanceKm({ lat: p.lat, lng: p.lng }, median).toFixed(2))
        }));
        res.json({ median, distances });
    } catch (err) {
        next(err);
    }
}

module.exports = {
    geocode,
    computeGeometricMedian
};
