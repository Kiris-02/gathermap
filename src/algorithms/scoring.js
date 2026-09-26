/**
 * Scoring & Fairness Formulation
 * Pure functions implementing the specification-standard formulas:
 * 1. Individual Member Score = 70% Preference Satisfaction + 30% Travel Convenience
 * 2. Group Score = 65% Group Average + 35% Minimum Individual Satisfaction
 */

const { SCORING_WEIGHTS, TRAVEL_PARAMS } = require('../config/constants');

/**
 * Estimates travel time in minutes based on distance and average urban speed.
 * NOTE: This is an estimated duration based on distance, NOT real-time traffic data.
 */
function estimateTravelMins(distanceKm) {
    if (distanceKm == null || distanceKm < 0) return TRAVEL_PARAMS.BASE_TRAVEL_MINUTES;
    const travelTime = (distanceKm / TRAVEL_PARAMS.AVERAGE_CITY_SPEED_KMH) * 60;
    return Math.max(TRAVEL_PARAMS.BASE_TRAVEL_MINUTES, Math.round(travelTime + TRAVEL_PARAMS.BASE_TRAVEL_MINUTES));
}

/**
 * Calculates travel convenience score from 0 to 100 based on distance.
 */
function calculateTravelScore(distanceKm) {
    if (distanceKm == null || distanceKm < 0) return 50;
    // 100 points at 0 km, decreasing by 10 points per km
    return Math.max(0, Math.min(100, Math.round(100 - (distanceKm * 10))));
}

/**
 * Computes individual member score combining preference and travel convenience.
 * Member Score = 0.70 * Preference + 0.30 * Travel
 */
function calculateMemberScore(memberSemanticScore, distanceKm) {
    const semScore = typeof memberSemanticScore === 'number' ? memberSemanticScore : 75;
    const travScore = calculateTravelScore(distanceKm);
    const score = Math.round(
        SCORING_WEIGHTS.MEMBER_PREFERENCE * semScore +
        SCORING_WEIGHTS.MEMBER_TRAVEL * travScore
    );
    return Math.max(0, Math.min(100, score));
}

/**
 * Computes group score and fairness breakdown.
 * Group Score = 0.65 * Average Member Score + 0.35 * Minimum Member Score
 */
function calculateFairnessScores(memberScores = []) {
    if (!Array.isArray(memberScores) || memberScores.length === 0) {
        return {
            groupScore: 0,
            avgScore: 0,
            minScore: 0,
            fairnessIndex: 'N/A',
            lowestMember: null
        };
    }

    const scores = memberScores.map(m => (typeof m === 'object' && m !== null) ? m.score : Number(m));
    const avgScore = Number((scores.reduce((s, val) => s + val, 0) / scores.length).toFixed(1));
    const minScore = Math.min(...scores);

    const groupScore = Number((
        SCORING_WEIGHTS.GROUP_AVERAGE * avgScore +
        SCORING_WEIGHTS.GROUP_MINIMUM * minScore
    ).toFixed(1));

    let lowestMember = null;
    if (typeof memberScores[0] === 'object' && memberScores[0] !== null) {
        lowestMember = memberScores.reduce((lowest, curr) => curr.score < lowest.score ? curr : lowest, memberScores[0]);
    }

    let fairnessIndex = 'Cao';
    if (minScore < 50) {
        fairnessIndex = 'Thấp';
    } else if (minScore < 70) {
        fairnessIndex = 'Trung bình';
    }

    return {
        groupScore,
        avgScore,
        minScore,
        fairnessIndex,
        lowestMember
    };
}

module.exports = {
    estimateTravelMins,
    calculateTravelScore,
    calculateMemberScore,
    calculateFairnessScores
};
