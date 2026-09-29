/**
 * Scoring & Fairness Formulation
 * Pure functions implementing the specification-standard formulas:
 * 1. Individual Member Score = 100% Preference Satisfaction (Geography strictly for candidate eligibility)
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
 * Under radius-only filtering, member score = 100% preference satisfaction.
 * distanceKm is retained for signature compatibility.
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
            fairnessScore: 0,
            avgScore: 0,
            minScore: 0,
            lowestScore: 0,
            highestScore: 0,
            fairnessIndex: 'N/A',
            lowestMember: null
        };
    }

    const scores = memberScores.map(m => (typeof m === 'object' && m !== null) ? (m.score ?? m.totalMemberScore ?? 0) : Number(m));
    const avgScore = Number((scores.reduce((s, val) => s + val, 0) / scores.length).toFixed(1));
    const minScore = Math.min(...scores);
    const lowestScore = minScore;
    const highestScore = Math.max(...scores);

    const groupScore = Number((
        SCORING_WEIGHTS.GROUP_AVERAGE * avgScore +
        SCORING_WEIGHTS.GROUP_MINIMUM * minScore
    ).toFixed(1));

    let lowestMember = null;
    if (typeof memberScores[0] === 'object' && memberScores[0] !== null) {
        lowestMember = memberScores.reduce((lowest, curr) => {
            const currScore = (curr.score ?? curr.totalMemberScore ?? 0);
            const lowestScoreVal = (lowest.score ?? lowest.totalMemberScore ?? 0);
            return currScore < lowestScoreVal ? curr : lowest;
        }, memberScores[0]);
    }

    const fairnessIndex = `${(groupScore / 10).toFixed(1)} / 10`;

    return {
        groupScore,
        fairnessScore: Math.round(groupScore),
        avgScore,
        minScore,
        lowestScore,
        highestScore,
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
