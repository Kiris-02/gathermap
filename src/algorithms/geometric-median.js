/**
 * Geometric Median & Spatial Distance Algorithms
 * Implements Weiszfeld Algorithm for L1 Fermat-Weber location problem.
 */

const { GEOMETRIC_PARAMS } = require('../config/constants');

/**
 * Calculates Great-Circle distance between two points in km (Haversine formula).
 */
function calcDistanceKm(p1, p2) {
    if (!p1 || !p2 || p1.lat === undefined || p2.lat === undefined) return 0;
    const R = 6371; // Earth radius in km
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLng = (p2.lng - p1.lng) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Weiszfeld Algorithm for calculating the equal-weight geometric median
 * Minimizes sum of Euclidean distances to all participant coordinates,
 * preventing a distant outlier from disproportionately skewing the rendezvous point.
 */
function calculateGeometricMedian(points) {
    if (!points || !Array.isArray(points) || points.length === 0) {
        return { ...GEOMETRIC_PARAMS.DEFAULT_CENTER };
    }
    const validPoints = points.filter(p => p && typeof p.lat === 'number' && typeof p.lng === 'number');
    if (validPoints.length === 0) {
        return { ...GEOMETRIC_PARAMS.DEFAULT_CENTER };
    }
    if (validPoints.length === 1) {
        return { lat: validPoints[0].lat, lng: validPoints[0].lng };
    }

    // Initialize with center of gravity (arithmetic mean)
    let curLat = validPoints.reduce((s, p) => s + p.lat, 0) / validPoints.length;
    let curLng = validPoints.reduce((s, p) => s + p.lng, 0) / validPoints.length;

    for (let iter = 0; iter < GEOMETRIC_PARAMS.MAX_WEISZFELD_ITERATIONS; iter++) {
        let numLat = 0;
        let numLng = 0;
        let denom = 0;

        for (const p of validPoints) {
            const dist = Math.hypot(p.lat - curLat, p.lng - curLng);
            if (dist < GEOMETRIC_PARAMS.CONVERGENCE_EPSILON) continue;
            const w = 1 / dist;
            numLat += p.lat * w;
            numLng += p.lng * w;
            denom += w;
        }

        if (denom === 0) break;
        const nextLat = numLat / denom;
        const nextLng = numLng / denom;

        if (Math.hypot(nextLat - curLat, nextLng - curLng) < GEOMETRIC_PARAMS.CONVERGENCE_EPSILON) {
            break;
        }
        curLat = nextLat;
        curLng = nextLng;
    }

    return {
        lat: Number(curLat.toFixed(6)),
        lng: Number(curLng.toFixed(6))
    };
}

module.exports = {
    calcDistanceKm,
    calculateGeometricMedian
};
