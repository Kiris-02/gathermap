/**
 * Recommendation Service
 * Orchestrates the full 8-step recommendation pipeline:
 * 1. Compute/verify Weiszfeld Geometric Median center
 * 2. Retrieve candidate venues from repository
 * 3. Filter non-negotiable hard constraints
 * 4. Score semantic preferences against review evidence
 * 5. Compute travel burden from each member's starting point
 * 6. Calculate Member Satisfaction: 70% Preference + 30% Travel Convenience
 * 7. Calculate Group Fairness: 65% Group Average + 35% Minimum Member Satisfaction
 * 8. Rank candidates, attach social proof, and persist outing session
 */

const venueRepository = require('../repositories/venue-repository');
const reviewRepository = require('../repositories/review-repository');
const outingRepository = require('../repositories/outing-repository');
const { generateUniqueOutingId } = require('./outing-service');
const semanticEngine = require('../../semanticEngine');
const { calcDistanceKm } = require('../algorithms/geometric-median');
const { buildDirectionsUrl, buildSearchUrl } = require('./places-service');
const { dbType } = require('../repositories/db-client');

async function searchAndRankVenues(params) {
    const {
        outingId: inputOutingId,
        outingName = 'Weekend Eatery Hangout',
        mode = 'representative',
        center = { lat: 10.7769, lng: 106.7009 },
        radiusMeters = 3000,
        interpretation = null,
        hardConstraints = {},
        requiredConstraints = {},
        cuisines = [],
        dishes = [],
        ambience = [],
        features = [],
        negativePreferences = [],
        softPreferences = [],
        friends = []
    } = params;

    const outingId = inputOutingId || (await generateUniqueOutingId());
    const radiusKm = radiusMeters / 1000;

    // 1. Build Unified Intent Profile
    const intentProfile = {
        hardConstraints: {
            maxPricePerPersonVnd: interpretation?.hardConstraints?.maxPricePerPersonVnd ?? (hardConstraints?.maxPricePerPersonVnd ?? (requiredConstraints?.max_price_vnd ?? null)),
            vegetarianRequired: Boolean(interpretation?.hardConstraints?.vegetarianRequired ?? (hardConstraints?.vegetarianRequired || requiredConstraints?.vegetarian)),
            veganRequired: Boolean(interpretation?.hardConstraints?.veganRequired ?? hardConstraints?.veganRequired),
            halalRequired: Boolean(interpretation?.hardConstraints?.halalRequired ?? hardConstraints?.halalRequired),
            noAlcohol: Boolean(interpretation?.hardConstraints?.noAlcohol ?? (hardConstraints?.noAlcohol || requiredConstraints?.no_alcohol)),
            quietRequired: Boolean(interpretation?.hardConstraints?.quietRequired ?? (hardConstraints?.quietRequired || requiredConstraints?.quiet_only)),
            parkingRequired: Boolean(interpretation?.hardConstraints?.parkingRequired ?? hardConstraints?.parkingRequired),
            openNowRequired: Boolean(interpretation?.hardConstraints?.openNowRequired ?? hardConstraints?.openNowRequired)
        },
        cuisines: (interpretation?.cuisines?.length ? interpretation.cuisines : cuisines) || [],
        dishes: (interpretation?.dishes?.length ? interpretation.dishes : dishes) || [],
        ambience: (interpretation?.ambience?.length ? interpretation.ambience : ambience) || [],
        features: (interpretation?.features?.length ? interpretation.features : features) || [],
        negativePreferences: (interpretation?.negativePreferences?.length ? interpretation.negativePreferences : negativePreferences) || [],
        rawIntent: interpretation?.rawIntent || ''
    };

    // Support legacy softPreferences mapping if provided
    if (softPreferences && Array.isArray(softPreferences)) {
        softPreferences.forEach(sp => {
            const val = (sp.preference || sp.criterion || '').toLowerCase();
            const w = sp.weight || 4;
            const memberName = sp.memberName || 'Group';
            if (val.includes('matcha')) intentProfile.dishes.push({ value: 'matcha', weight: w, memberName });
            else if (val.includes('bbq')) intentProfile.dishes.push({ value: 'bbq', weight: w, memberName });
            else if (val.includes('korean')) intentProfile.cuisines.push({ value: 'korean', weight: w, memberName });
            else if (val.includes('sushi') || val.includes('japanese')) intentProfile.cuisines.push({ value: 'japanese', weight: w, memberName });
            else if (val.includes('dessert') || val.includes('bánh ngọt')) intentProfile.dishes.push({ value: 'dessert', weight: w, memberName });
            else if (val.includes('quiet') || val.includes('yên tĩnh')) intentProfile.ambience.push({ value: 'quiet', weight: w, memberName });
            else if (val.includes('parking') || val.includes('gửi xe')) intentProfile.features.push({ value: 'parking', weight: w, memberName });
            else if (val.includes('wifi')) intentProfile.features.push({ value: 'fast_wifi', weight: w, memberName });
            else if (val.includes('lively')) intentProfile.ambience.push({ value: 'lively', weight: w, memberName });
        });
    }

    // Dynamic preferences collection
    const allDynamicPreferences = [
        ...(interpretation?.preferences || []),
        ...intentProfile.cuisines.map(c => ({ text: c.value, importance: c.weight, memberName: c.memberName })),
        ...intentProfile.dishes.map(d => ({ text: d.value, importance: d.weight, memberName: d.memberName })),
        ...intentProfile.ambience.map(a => ({ text: a.value, importance: a.weight, memberName: a.memberName })),
        ...intentProfile.features.map(f => ({ text: f.value, importance: f.weight, memberName: f.memberName }))
    ];

    const preferenceAppliesToMember = (pref, friendName) => {
        if (!pref || typeof pref !== 'object' || !pref.memberName) return true;
        const owner = String(pref.memberName).trim().toLowerCase();
        const member = String(friendName || '').trim().toLowerCase();
        return owner === 'group' || owner === 'all' || owner === member;
    };

    const intentForMember = (friend) => ({
        ...intentProfile,
        cuisines: (intentProfile.cuisines || []).filter(p => preferenceAppliesToMember(p, friend.name)),
        dishes: (intentProfile.dishes || []).filter(p => preferenceAppliesToMember(p, friend.name)),
        ambience: (intentProfile.ambience || []).filter(p => preferenceAppliesToMember(p, friend.name)),
        features: (intentProfile.features || []).filter(p => preferenceAppliesToMember(p, friend.name)),
        negativePreferences: (intentProfile.negativePreferences || []).filter(p => preferenceAppliesToMember(p, friend.name))
    });

    // 2. Candidate Retrieval
    const candidates = await venueRepository.getAllVenues();

    const memberList = (friends && friends.length > 0)
        ? friends
        : [{ id: 1, name: 'You', lat: center.lat, lng: center.lng }];

    // Preload reviews in parallel
    await Promise.all(candidates.map(async (v) => {
        v._reviews = await reviewRepository.getVenueReviews(v.id, 25);
    }));

    // 3. Evaluate each venue against hard constraints & semantic preference
    const evaluatedCandidates = [];
    const queryList = [
        ...intentProfile.cuisines.map(c => c.value),
        ...intentProfile.dishes.map(d => d.value),
        ...intentProfile.ambience.map(a => a.value),
        ...intentProfile.features.map(f => f.value)
    ];

    for (const venue of candidates) {
        const reviews = venue._reviews || [];
        const distFromCenterKm = Number(calcDistanceKm(center, { lat: venue.lat, lng: venue.lng }).toFixed(2));

        const reviewAnalysis = await semanticEngine.analyzeReviewsForPreferences({
            venue,
            reviews,
            preferences: allDynamicPreferences,
            geminiCaller: null
        });

        const venueProfile = semanticEngine.buildVenueSemanticProfile(venue, reviews, reviewAnalysis.matches);
        const constraintCheck = semanticEngine.evaluateHardConstraints(venue, intentProfile.hardConstraints, radiusKm, distFromCenterKm);

        const semanticMatch = semanticEngine.scoreVenueAgainstIntent({
            intentProfile: {
                ...intentProfile,
                preferences: allDynamicPreferences,
                preferenceMatches: reviewAnalysis.matches
            },
            venueProfile,
            venue,
            distanceKm: distFromCenterKm
        });

        // Calculate member satisfaction breakdowns
        const memberBreakdowns = memberList.map(friend => {
            const fLat = friend.lat || center.lat;
            const fLng = friend.lng || center.lng;
            const friendDist = Number(calcDistanceKm({ lat: fLat, lng: fLng }, { lat: venue.lat, lng: venue.lng }).toFixed(1));
            const travelMins = Math.max(5, Math.round((friendDist / 20) * 60));
            const travelScore = Math.max(20, Math.min(100, Math.round(100 - (travelMins * 2.2))));

            const memberPrefs = allDynamicPreferences.filter(p => preferenceAppliesToMember(p, friend.name));
            const memberSemanticMatch = semanticEngine.scoreVenueAgainstIntent({
                intentProfile: {
                    ...intentForMember(friend),
                    preferences: memberPrefs,
                    preferenceMatches: reviewAnalysis.matches
                },
                venueProfile,
                venue,
                distanceKm: friendDist
            });

            // 70% preference satisfaction + 30% travel burden
            const memberScore = Math.round(0.70 * memberSemanticMatch.semanticScore + 0.30 * travelScore);

            return {
                friendId: friend.id,
                friendName: friend.name,
                score: memberScore,
                preferenceScore: memberSemanticMatch.semanticScore,
                preferenceConfidence: memberSemanticMatch.confidence,
                matches: memberSemanticMatch.matches,
                mismatches: memberSemanticMatch.mismatches,
                unknowns: memberSemanticMatch.unknowns,
                travelScore,
                travelMins,
                distKm: friendDist,
                distanceKm: friendDist
            };
        });

        const fairness = semanticEngine.calculateFairnessScores(memberBreakdowns);

        // Generate AI / Algorithmic Rationale
        let aiRationale = '';
        if (venueProfile.signatureDishes && venueProfile.signatureDishes.length > 0) {
            aiRationale = `Phù hợp với nhóm nhờ món nổi bật: ${venueProfile.signatureDishes.slice(0, 2).join(', ')}.`;
        }
        if (memberBreakdowns.length > 0 && fairness.lowestMember) {
            const lowest = memberBreakdowns.find(m => m.score === fairness.minScore);
            if (lowest && lowest.distanceKm > 4) {
                aiRationale += ` Lưu ý: bạn ${lowest.friendName} ở xa hơn (${lowest.distanceKm} km, ~${lowest.travelMins}p).`;
            }
        }
        if (!aiRationale) {
            aiRationale = `Địa điểm đáp ứng tiêu chuẩn chung của nhóm với điểm công bằng ${fairness.groupScore}/100.`;
        }

        evaluatedCandidates.push({
            ...venue,
            distFromCenterKm,
            constraintCheck,
            venueProfile,
            semanticMatch,
            memberBreakdowns,
            groupScore: fairness.groupScore,
            fairnessScore: fairness.fairnessScore || fairness.groupScore,
            preferenceScore: semanticMatch.semanticScore,
            travelScore: Math.round(memberBreakdowns.reduce((s, m) => s + m.travelScore, 0) / memberBreakdowns.length),
            distanceScore: Math.round(memberBreakdowns.reduce((s, m) => s + m.travelScore, 0) / memberBreakdowns.length),
            avgScore: Math.round(fairness.avgScore),
            lowestScore: fairness.lowestScore,
            highestScore: fairness.highestScore,
            minScore: fairness.lowestScore,
            fairnessIndex: fairness.fairnessIndex || 'Cao',
            aiRationale,
            directionsUrl: buildDirectionsUrl(venue),
            searchUrl: buildSearchUrl(venue),
            matches: (semanticMatch.matches || []).map(m => typeof m === 'string' ? m : (m.preference || m.value || '')).filter(Boolean),
            partialMatches: (semanticMatch.partialMatches || []).map(m => typeof m === 'string' ? m : (m.preference || m.value || '')).filter(Boolean),
            mismatches: (semanticMatch.mismatches || []).map(m => typeof m === 'string' ? m : (m.preference || m.value || '')).filter(Boolean),
            unknowns: semanticMatch.unknowns || [],
            principalReasons: (semanticMatch.matches || []).slice(0, 3).map(m => typeof m === 'string' ? m : `Phù hợp tiêu chí: ${m.preference || m.value || ''}`),
            principalCompromises: constraintCheck.violations.length > 0
                ? constraintCheck.violations.map(v => typeof v === 'string' ? v : v.detail)
                : (distFromCenterKm > radiusKm ? [`Vượt bán kính tìm kiếm (${distFromCenterKm} km > ${radiusKm} km)`] : [])
        });
    }

    // 4. Split into Strict Shortlist vs Nearby Alternatives
    const strictCandidates = evaluatedCandidates.filter(c => c.constraintCheck.passed);
    const alternativeCandidates = evaluatedCandidates
        .filter(c => !c.constraintCheck.passed)
        .sort((a, b) => {
            if (a.constraintCheck.violations.length !== b.constraintCheck.violations.length) {
                return a.constraintCheck.violations.length - b.constraintCheck.violations.length;
            }
            return b.groupScore - a.groupScore;
        });

    strictCandidates.sort((a, b) => b.groupScore - a.groupScore);

    const strictShortlist = strictCandidates.slice(0, 10);
    const nearbyAlternatives = alternativeCandidates.slice(0, 5).map(v => ({
        ...v,
        violations: v.constraintCheck.violations.map(viol => typeof viol === 'string' ? viol : viol.detail)
    }));

    // Attach Reviewer Highlights
    for (const venue of strictShortlist) {
        venue.reviewerHighlights = await reviewRepository.getVenueReviewerHighlights(venue.id);
        venue.reviewerCount = venue.reviewerHighlights.reviewerCount ?? 0;
    }
    for (const venue of nearbyAlternatives) {
        venue.reviewerHighlights = await reviewRepository.getVenueReviewerHighlights(venue.id);
        venue.reviewerCount = venue.reviewerHighlights.reviewerCount ?? 0;
    }

    // 5. Persist Outing Session with the same unified outingId
    await outingRepository.saveOuting({
        id: outingId,
        name: outingName,
        mode,
        centerLat: center.lat,
        centerLng: center.lng,
        radiusKm
    });
    await outingRepository.saveParticipants(outingId, memberList);
    await outingRepository.saveRecommendations(outingId, strictShortlist);

    let message = null;
    if (strictShortlist.length === 0) {
        if (intentProfile.hardConstraints.vegetarianRequired) {
            message = 'Không tìm thấy quán nào xác thực món chay trong bán kính đã chọn.';
        } else {
            message = `Không tìm thấy quán nào thỏa mãn tất cả tiêu chí bắt buộc trong bán kính ${(radiusKm).toFixed(1)} km.`;
        }
    }

    return {
        outingId,
        shortlist: strictShortlist,
        nearbyAlternatives,
        totalStrictEligible: strictCandidates.length,
        totalAlternatives: alternativeCandidates.length,
        message,
        centerUsed: center,
        radiusUsedMeters: radiusMeters,
        activeIntent: intentProfile,
        recommendationTrace: {
            rawInput: intentProfile.rawIntent,
            parsedIntent: intentProfile,
            center,
            radiusMeters,
            candidatesEvaluated: evaluatedCandidates.length,
            strictPassed: strictCandidates.length,
            alternativesFound: alternativeCandidates.length
        },
        debugTrace: {
            rawIntent: intentProfile.rawIntent,
            parsedIntent: intentProfile,
            retrievalQueries: queryList,
            candidateIds: candidates.map(c => c.id),
            strictFilterResults: evaluatedCandidates.map(c => ({ venueId: c.id, passed: c.constraintCheck.passed, violations: c.constraintCheck.violations })),
            reviewEvidenceIds: evaluatedCandidates.flatMap(c => (c.venueProfile?.preferenceMatches || []).flatMap(m => m.evidenceIds || [])),
            semanticMatchMatrix: evaluatedCandidates.map(c => ({ venueId: c.id, matches: c.matches, mismatches: c.mismatches, unknowns: c.unknowns })),
            memberScores: evaluatedCandidates.slice(0, 5).map(c => ({ venueId: c.id, memberBreakdowns: c.memberBreakdowns })),
            groupScores: evaluatedCandidates.slice(0, 5).map(c => ({ venueId: c.id, groupScore: c.groupScore })),
            finalRanking: strictShortlist.map(s => ({ id: s.id, name: s.name, score: s.groupScore }))
        },
        aiPowered: Boolean(process.env.GEMINI_API_KEY),
        database: dbType
    };
}

module.exports = {
    searchAndRankVenues
};
