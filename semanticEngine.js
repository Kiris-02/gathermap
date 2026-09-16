/**
 * GatherMap Semantic Recommendation Engine (v2.0)
 * 
 * Implements:
 * 1. buildVenueSemanticProfile(venue, reviews): Cached, provenance-backed semantic venue profiles.
 * 2. scoreVenueAgainstIntent({ intentProfile, venueProfile, member, venue, distanceKm }):
 *    Calibrated semantic matching (confirmed_match, strong_match, partial_match, mismatch, unknown)
 *    with confidence metrics and negative preference penalties.
 * 3. evaluateHardConstraints(venue, hardConstraints, radiusKm, distanceKm):
 *    Strict non-relaxable constraints and radius integrity.
 * 4. calculateFairnessScores(memberScores):
 *    65% group average + 35% minimum individual satisfaction.
 */

// In-memory versioned cache for venue semantic profiles
const venueProfileCache = new Map();
const PROFILE_SCHEMA_VERSION = '2.0.0';

/**
 * Normalizes text for robust fuzzy keyword & semantic matching
 */
function norm(str) {
    if (!str) return '';
    return String(str)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Analyzes raw review texts to extract structured traits and evidence counts
 */
function analyzeReviewEvidence(reviews = []) {
    const traitCounts = {
        conversationFriendly: { pos: 0, neg: 0 },
        quietAtmosphere: { pos: 0, neg: 0 },
        livelyAtmosphere: { pos: 0, neg: 0 },
        groupFriendly: { pos: 0, neg: 0 },
        parkingEasy: { pos: 0, neg: 0 },
        parkingDifficult: { pos: 0, neg: 0 },
        largePortions: { pos: 0, neg: 0 },
        deliciousFood: { pos: 0, neg: 0 },
        highPrice: { pos: 0, neg: 0 },
        budgetFriendly: { pos: 0, neg: 0 }
    };

    const extractedDishes = new Set();
    const evidenceSummaries = [];

    reviews.forEach(r => {
        const text = norm(r.content || r.review_text || r.text || r.comment);
        const tags = (r.tags || []).map(t => norm(t));

        // Noise & Conversation
        if (text.includes('yen tinh') || text.includes('de noi chuyen') || text.includes('tro chuyen') || text.includes('hoc bai') || text.includes('lam viec') || text.includes('quiet') || text.includes('nhe nhang') || text.includes('du duong') || text.includes('yen ang') || text.includes('comfortable place for long conversations')) {
            traitCounts.conversationFriendly.pos++;
            traitCounts.quietAtmosphere.pos++;
        }
        if (text.includes('qua on') || text.includes('rat on') || text.includes('on ao') || text.includes('nhac to') || text.includes('loud') || text.includes('bass') || text.includes('extremely loud') || text.includes('qua on ao') || text.includes('nao nhiet')) {
            traitCounts.conversationFriendly.neg++;
            traitCounts.quietAtmosphere.neg++;
            traitCounts.livelyAtmosphere.pos++;
        }

        // Lively vibe (positive context)
        if (text.includes('nhon nhip') || text.includes('dong vui') || text.includes('soi dong') || text.includes('lively')) {
            traitCounts.livelyAtmosphere.pos++;
        }

        // Group seating & gathering
        if (text.includes('di nhom') || text.includes('tu tap ban be') || text.includes('ban rong') || text.includes('ban lon') || text.includes('phu hop di dong') || text.includes('good for groups') || text.includes('spacious group seating') || text.includes('spacious tables')) {
            traitCounts.groupFriendly.pos++;
        }

        // Parking ease vs difficulty
        const isDifficultParking = text.includes('kho gui xe') || text.includes('gui xe kho') || text.includes('cho gui xe chat') || text.includes('khong co cho gui xe') || text.includes('khong co cho de xe') || text.includes('parking is difficult') || text.includes('het cho de xe') || text.includes('kho khan') || text.includes('gui xe kho khan');
        const isEasyParking = text.includes('de gui xe') || text.includes('gui xe tien') || text.includes('gui xe de') || text.includes('co bao ve giu xe') || text.includes('cho de xe rong') || text.includes('easy parking') || text.includes('bai xe rong') || text.includes('bai do xe rong') || text.includes('giu xe mien phi') || text.includes('do xe thoai mai') || text.includes('do xe va xe may cuc ky thoai mai');

        if (isDifficultParking) {
            traitCounts.parkingDifficult.pos++;
        } else if (isEasyParking) {
            traitCounts.parkingEasy.pos++;
        }

        // Portion sizes
        if (text.includes('phan an nhieu') || text.includes('dia to') || text.includes('do an nhieu') || text.includes('no ne') || text.includes('large portions')) {
            traitCounts.largePortions.pos++;
        }

        // Food quality & signature dishes
        if (text.includes('ngon') || text.includes('dam vi') || text.includes('chuan vi') || text.includes('great food')) {
            traitCounts.deliciousFood.pos++;
        }

        // Dishes mentioned in reviews
        const dishKeywords = ['bbq', 'thit nuong', 'samgyeopsal', 'sushi', 'sashimi', 'lau', 'hotpot', 'banh ngot', 'matcha', 'bingsu', 'ca phe', 'tra sua', 'steak', 'pizza', 'com tam', 'bun bo'];
        dishKeywords.forEach(dk => {
            if (text.includes(dk)) extractedDishes.add(dk);
        });
    });

    // Synthesize review profile
    const totalRev = reviews.length;
    const calcTrait = (pos, neg, defaultConf = 0.5) => {
        const evidenceCount = pos + neg;
        if (evidenceCount === 0) return { score: null, confidence: 0.2, evidenceCount: 0 };
        const score = Number((pos / (pos + neg)).toFixed(2));
        const confidence = Math.min(0.95, Number((defaultConf + (evidenceCount * 0.1)).toFixed(2)));
        return { score, confidence, evidenceCount };
    };

    const reviewProfile = {
        conversationFriendly: calcTrait(traitCounts.conversationFriendly.pos, traitCounts.conversationFriendly.neg),
        quietAtmosphere: calcTrait(traitCounts.quietAtmosphere.pos, traitCounts.quietAtmosphere.neg),
        livelyAtmosphere: calcTrait(traitCounts.livelyAtmosphere.pos, 0),
        groupFriendly: calcTrait(traitCounts.groupFriendly.pos, 0),
        parkingEase: calcTrait(traitCounts.parkingEasy.pos, traitCounts.parkingDifficult.pos),
        largePortions: calcTrait(traitCounts.largePortions.pos, 0),
        deliciousFood: calcTrait(traitCounts.deliciousFood.pos, 0)
    };

    // Synthesize human-readable factual summaries
    if (traitCounts.conversationFriendly.pos > traitCounts.conversationFriendly.neg) {
        evidenceSummaries.push(`Thực khách khen không gian trò chuyện thoải mái, yên tĩnh (${traitCounts.conversationFriendly.pos} đánh giá)`);
    } else if (traitCounts.conversationFriendly.neg > 0) {
        evidenceSummaries.push(`Nhiều đánh giá lưu ý quán khá ồn ào vào giờ cao điểm (${traitCounts.conversationFriendly.neg} đánh giá)`);
    }

    if (traitCounts.parkingEasy.pos > traitCounts.parkingDifficult.pos) {
        evidenceSummaries.push(`Chỗ giữ xe thuận tiện, có bảo vệ hỗ trợ (${traitCounts.parkingEasy.pos} đánh giá)`);
    } else if (traitCounts.parkingDifficult.pos > 0) {
        evidenceSummaries.push(`Bãi xe hạn chế, gửi xe có thể khó khăn vào giờ đông (${traitCounts.parkingDifficult.pos} đánh giá)`);
    }

    if (traitCounts.groupFriendly.pos > 0) {
        evidenceSummaries.push(`Bàn ghế rộng rãi, phù hợp nhóm bạn tụ tập (${traitCounts.groupFriendly.pos} đánh giá)`);
    }

    return {
        reviewProfile,
        extractedDishes: Array.from(extractedDishes),
        evidenceSummaries
    };
}

/**
 * Builds an evidence-backed Semantic Venue Profile with provenance and confidence
 */
function buildVenueSemanticProfile(venue, reviews = []) {
    // Generate cache key
    const reviewHash = reviews.map(r => r.id).join('-').slice(0, 32);
    const cacheKey = `${venue.id || venue.name}_${reviews.length}_${reviewHash}_${PROFILE_SCHEMA_VERSION}`;

    if (venueProfileCache.has(cacheKey)) {
        return venueProfileCache.get(cacheKey);
    }

    const vName = norm(venue.name);
    const vCat = norm(venue.category);
    const vTags = (venue.tags || []).map(t => norm(t));
    const vDishes = (venue.signatureDishes || []).map(d => norm(d));
    const vAttributes = venue.attributes || {};

    const { reviewProfile, extractedDishes, evidenceSummaries } = analyzeReviewEvidence(reviews);

    // 1. Cuisines with Provenance
    const cuisines = [];
    const addCuisine = (val, conf, src) => {
        if (!cuisines.some(c => c.value === val)) {
            cuisines.push({ value: val, confidence: conf, sources: [src] });
        }
    };

    if (vCat.includes('korean') || vTags.includes('korean') || vName.includes('korean') || vTags.includes('han quoc') || vCat.includes('han quoc')) {
        addCuisine('korean', 0.95, { type: 'database_category' });
    }
    if (vCat.includes('japanese') || vTags.includes('japanese') || vName.includes('japanese') || vTags.includes('nhat ban') || vName.includes('sushi')) {
        addCuisine('japanese', 0.95, { type: 'database_category' });
    }
    if (vCat.includes('vietnamese') || vTags.includes('vietnamese') || vTags.includes('viet nam') || vCat.includes('viet nam')) {
        addCuisine('vietnamese', 0.95, { type: 'database_category' });
    }
    if (vCat.includes('italian') || vTags.includes('italian') || vTags.includes('y')) {
        addCuisine('italian', 0.90, { type: 'database_category' });
    }
    if (vCat.includes('vegetarian') || vTags.includes('chay') || vTags.includes('vegan') || vName.includes('chay')) {
        addCuisine('vegetarian', 0.98, { type: 'database_category' });
    }

    // 2. Dishes with Provenance
    const dishes = [];
    const addDish = (val, conf, src) => {
        if (!dishes.some(d => d.value === val)) {
            dishes.push({ value: val, confidence: conf, sources: [src] });
        }
    };

    // Korean BBQ
    if (vName.includes('bbq') || vTags.includes('bbq') || vTags.includes('thit nuong') || vDishes.includes('samgyeopsal') || extractedDishes.includes('bbq') || extractedDishes.includes('thit nuong')) {
        const conf = (vName.includes('bbq') || vTags.includes('bbq')) ? 0.95 : 0.85;
        addDish('korean bbq', conf, { type: 'menu_and_reviews', evidenceCount: reviews.length });
    }
    // Sushi
    if (vName.includes('sushi') || vTags.includes('sushi') || vDishes.includes('sushi') || extractedDishes.includes('sushi')) {
        addDish('sushi', 0.95, { type: 'menu_and_reviews' });
    }
    // Hotpot
    if (vName.includes('lau') || vTags.includes('hotpot') || vTags.includes('lau') || extractedDishes.includes('hotpot') || extractedDishes.includes('lau')) {
        addDish('hotpot', 0.92, { type: 'menu_and_reviews' });
    }
    // Coffee & Dessert
    if (venue.type === 'cafe' || vName.includes('coffee') || vName.includes('cafe') || vTags.includes('cafe') || vName.includes('trung nguyen')) {
        addDish('coffee', 0.95, { type: 'venue_type' });
    }
    if (venue.type === 'bakery' || vName.includes('bakery') || vTags.includes('dessert') || vTags.includes('banh ngot') || vDishes.includes('bingsu') || vName.includes('bbang')) {
        addDish('dessert', 0.95, { type: 'venue_type' });
    }
    if (vTags.includes('matcha') || vDishes.includes('matcha') || vName.includes('matcha') || extractedDishes.includes('matcha')) {
        addDish('matcha', 0.90, { type: 'menu_and_tags' });
    }

    // 3. Ambience with Review Provenance
    const ambience = [];
    const addAmbience = (val, conf, src) => {
        if (!ambience.some(a => a.value === val)) {
            ambience.push({ value: val, confidence: conf, sources: [src] });
        }
    };

    if (vAttributes.noiseLevel?.value === 'quiet' || reviewProfile.quietAtmosphere.score >= 0.6) {
        addAmbience('quiet', reviewProfile.quietAtmosphere.confidence || 0.85, { type: 'reviews_and_metadata', evidenceCount: reviewProfile.quietAtmosphere.evidenceCount });
        addAmbience('conversation-friendly', reviewProfile.conversationFriendly.confidence || 0.80, { type: 'reviews' });
    } else if (vAttributes.noiseLevel?.value === 'lively' || reviewProfile.livelyAtmosphere.score >= 0.6) {
        addAmbience('lively', reviewProfile.livelyAtmosphere.confidence || 0.85, { type: 'reviews_and_metadata' });
    }

    if (vTags.includes('aesthetic') || vTags.includes('view dep') || vName.includes('san vuon') || vName.includes('view pho')) {
        addAmbience('aesthetic', 0.85, { type: 'venue_tags' });
    }

    // 4. Features with Review & Metadata Provenance
    const features = [];
    const addFeature = (val, conf, src) => {
        if (!features.some(f => f.value === val)) {
            features.push({ value: val, confidence: conf, sources: [src] });
        }
    };

    if (reviewProfile.groupFriendly.score >= 0.5 || vTags.includes('group') || vName.includes('buffet') || vName.includes('bbq') || vName.includes('lau')) {
        addFeature('group-friendly seating', reviewProfile.groupFriendly.confidence || 0.80, { type: 'review_and_type' });
    }

    if (vAttributes.parking?.ease === 'easy' || reviewProfile.parkingEase.score >= 0.6) {
        addFeature('easy parking', reviewProfile.parkingEase.confidence || 0.80, { type: 'reviews_and_metadata' });
    } else if (vAttributes.parking?.ease === 'difficult' || (reviewProfile.parkingEase.score !== null && reviewProfile.parkingEase.score < 0.4)) {
        addFeature('difficult parking', reviewProfile.parkingEase.confidence || 0.75, { type: 'reviews_and_metadata' });
    }

    // 5. Dietary Truthfulness (Never fabricate)
    const dietary = {
        vegetarian: vAttributes.dietary?.vegetarian ?? (vCat.includes('vegetarian') || vTags.includes('chay') ? true : null),
        vegan: vAttributes.dietary?.vegan ?? (vTags.includes('vegan') || vTags.includes('thuan chay') ? true : null),
        halal: vAttributes.dietary?.halal ?? (vTags.includes('halal') ? true : null),
        noAlcohol: vAttributes.dietary?.noAlcohol ?? (venue.type === 'bar' ? false : null)
    };

    const profile = {
        venueId: venue.id,
        cuisines,
        dishes,
        ambience,
        features,
        dietary,
        traits: {
            conversationFriendly: reviewProfile.conversationFriendly.score !== null ? (reviewProfile.conversationFriendly.score >= 0.5) : (vAttributes.noiseLevel?.value === 'quiet'),
            quietAtmosphere: reviewProfile.quietAtmosphere.score !== null ? (reviewProfile.quietAtmosphere.score >= 0.5) : (vAttributes.noiseLevel?.value === 'quiet'),
            livelyAtmosphere: reviewProfile.livelyAtmosphere.score !== null ? (reviewProfile.livelyAtmosphere.score >= 0.5) : (vAttributes.noiseLevel?.value === 'lively'),
            groupFriendly: reviewProfile.groupFriendly.score !== null ? (reviewProfile.groupFriendly.score >= 0.5) : true,
            easyParking: reviewProfile.parkingEase.score !== null ? (reviewProfile.parkingEase.score >= 0.5) : (vAttributes.parking?.ease === 'easy'),
            difficultParking: (reviewProfile.parkingEase.score !== null && reviewProfile.parkingEase.score < 0.4) || vAttributes.parking?.ease === 'difficult'
        },
        noiseLevel: reviewProfile.quietAtmosphere.score !== null 
            ? (reviewProfile.quietAtmosphere.score >= 0.5 ? 'quiet' : 'loud') 
            : (vAttributes.noiseLevel?.value || 'unknown'),
        parkingEase: reviewProfile.parkingEase.score !== null 
            ? (reviewProfile.parkingEase.score >= 0.5 ? 'easy' : 'difficult') 
            : (vAttributes.parking?.ease || 'unknown'),
        reviewProfile,
        evidenceSummaries,
        price: {
            perPersonVnd: venue.pricePerPersonVnd || null,
            rangeVnd: venue.priceRangeVnd || null,
            confidence: venue.priceConfidence || 'database_record'
        }
    };

    venueProfileCache.set(cacheKey, profile);
    return profile;
}

/**
 * Strict Hard Constraint Evaluator
 * NEVER silently ignores constraints or radius.
 */
function evaluateHardConstraints(venue, hardConstraints = {}, radiusKm = 3.0, distanceKm = 0.0) {
    const violations = [];
    const vText = norm(`${venue.name} ${venue.category} ${(venue.tags || []).join(' ')}`);
    const dietary = venue.attributes?.dietary || {};

    // 1. Strict Radius Constraint
    if (distanceKm > radiusKm) {
        violations.push({
            rule: 'outside_radius',
            detail: `Cách tâm điểm ${(distanceKm).toFixed(1)} km (vượt bán kính ${(radiusKm).toFixed(1)} km)`
        });
    }

    // 2. Strict Vegetarian Requirement
    const vegRequired = !!(hardConstraints.vegetarianRequired || hardConstraints.vegetarian);
    if (vegRequired) {
        const isVerifiedVeg = dietary.vegetarian === true || venue.isVegetarian === true || vText.includes('chay') || vText.includes('vegetarian');
        if (!isVerifiedVeg) {
            violations.push({
                rule: 'vegetarian_unverified',
                detail: 'Quán chưa có thông tin xác thực phục vụ đồ chay'
            });
        }
    }

    // 3. Strict Vegan Requirement
    const veganRequired = !!(hardConstraints.veganRequired || hardConstraints.vegan);
    if (veganRequired) {
        const isVerifiedVegan = dietary.vegan === true || vText.includes('vegan') || vText.includes('thuan chay');
        if (!isVerifiedVegan) {
            violations.push({
                rule: 'vegan_unverified',
                detail: 'Quán chưa có thông tin xác thực món thuần chay (vegan)'
            });
        }
    }

    // 4. Strict Halal Requirement
    const halalRequired = !!(hardConstraints.halalRequired || hardConstraints.halal);
    if (halalRequired) {
        const isVerifiedHalal = dietary.halal === true || vText.includes('halal');
        if (!isVerifiedHalal) {
            violations.push({
                rule: 'halal_unverified',
                detail: 'Quán chưa có chứng nhận hoặc xác nhận chuẩn Halal'
            });
        }
    }

    // 5. Strict No-Alcohol Requirement
    const noAlcoholRequired = !!(hardConstraints.noAlcohol || hardConstraints.no_alcohol);
    if (noAlcoholRequired) {
        const hasAlcohol = dietary.noAlcohol === false || venue.type === 'bar' || vText.includes('beer') || vText.includes('pub') || vText.includes('ruou') || vText.includes('bia');
        if (hasAlcohol) {
            violations.push({
                rule: 'serves_alcohol',
                detail: 'Không gian có phục vụ đồ uống có cồn / bia rượu'
            });
        }
    }

    // 6. Strict Quiet Requirement
    const quietRequired = !!(hardConstraints.quietRequired || hardConstraints.quiet_only || hardConstraints.quiet);
    if (quietRequired) {
        const isQuiet = venue.attributes?.noiseLevel?.value === 'quiet' || vText.includes('yen tinh');
        if (!isQuiet) {
            violations.push({
                rule: 'quiet_unverified',
                detail: 'Không gian chưa được xác thực yên tĩnh phù hợp học tập / làm việc'
            });
        }
    }

    // 7. Strict Budget Cap
    const maxBudget = hardConstraints.maxPricePerPersonVnd || hardConstraints.max_price_vnd || hardConstraints.maxPriceVnd;
    if (maxBudget) {
        const vPrice = venue.pricePerPersonVnd || venue.avgPriceNumber || (venue.priceRangeVnd?.min) || null;
        if (vPrice && vPrice > maxBudget) {
            const excessK = Math.round((vPrice - maxBudget) / 1000);
            violations.push({
                rule: 'exceeds_budget',
                detail: `Giá ước tính ~${Math.round(vPrice / 1000)}k/người (vượt ngân sách ~${excessK}k)`
            });
        }
    }

    return {
        passed: violations.length === 0,
        violations
    };
}

/**
 * Calibrated Semantic Scorer
 * 
 * Scores:
 * - confirmed_match = 1.0
 * - strong_match    = 0.8
 * - partial_match   = 0.5
 * - mismatch        = 0.0
 * - unknown         = null (decreases confidence, does not inflate match score)
 */
function scoreVenueAgainstIntent({ intentProfile = {}, venueProfile, venue, distanceKm = 0 }) {
    const vText = norm(`${venue.name} ${venue.category} ${(venue.tags || []).join(' ')} ${(venue.signatureDishes || []).join(' ')}`);

    const matches = [];
    const partialMatches = [];
    const mismatches = [];
    const unknowns = [];

    let weightedScoreSum = 0;
    let totalWeight = 0;
    let confidenceSum = 0;
    let evaluatedCriteriaCount = 0;

    const recordCriterion = (prefName, weight, score, confidence, source = 'semantic_match') => {
        totalWeight += weight;
        evaluatedCriteriaCount++;
        confidenceSum += confidence;

        if (score === null) {
            unknowns.push(prefName);
            // Unknown reduces confidence; contributes zero positive match score
            return;
        }

        weightedScoreSum += (score * weight);

        if (score >= 0.8) {
            matches.push({ preference: prefName, score, confidence, source });
        } else if (score >= 0.4) {
            partialMatches.push({ preference: prefName, score, confidence, source });
        } else {
            mismatches.push({ preference: prefName, score, confidence, source });
        }
    };

    // 1. Cuisines Matching
    (intentProfile.cuisines || []).forEach(c => {
        const rawName = typeof c === 'string' ? c : (c.value || c.preference || '');
        const val = norm(rawName);
        if (!val) return;
        const w = Number(c.weight) || 4;
        const matchedCuisine = (venueProfile.cuisines || []).find(vc => vc.value === val || val.includes(vc.value) || vc.value.includes(val));

        if (matchedCuisine) {
            recordCriterion(`Ẩm thực ${rawName}`, w, 1.0, matchedCuisine.confidence, 'profile_cuisine');
        } else if (vText.includes(val)) {
            recordCriterion(`Ẩm thực ${rawName}`, w, 0.8, 0.75, 'text_mention');
        } else {
            recordCriterion(`Ẩm thực ${rawName}`, w, 0.0, 0.85, 'cuisine_mismatch');
        }
    });

    // 2. Dishes Matching
    (intentProfile.dishes || []).forEach(d => {
        const rawName = typeof d === 'string' ? d : (d.value || d.preference || '');
        const val = norm(rawName);
        if (!val) return;
        const w = Number(d.weight) || 4;
        const matchedDish = (venueProfile.dishes || []).find(vd => vd.value === val || val.includes(vd.value) || vd.value.includes(val));

        if (matchedDish) {
            recordCriterion(`Món ${rawName}`, w, 1.0, matchedDish.confidence, 'profile_dish');
        } else if (vText.includes(val)) {
            recordCriterion(`Món ${rawName}`, w, 0.8, 0.75, 'menu_text');
        } else if (val.includes('bbq') && (vText.includes('nuong') || vText.includes('grill'))) {
            recordCriterion(`Món ${rawName}`, w, 0.7, 0.70, 'related_grill');
        } else {
            recordCriterion(`Món ${rawName}`, w, 0.0, 0.80, 'dish_mismatch');
        }
    });

    // 3. Ambience Matching (Reviews play critical role here)
    (intentProfile.ambience || []).forEach(a => {
        const rawName = typeof a === 'string' ? a : (a.value || a.preference || '');
        const val = norm(rawName);
        if (!val) return;
        const w = Number(a.weight) || 3;

        // Quiet / Conversation-friendly
        if (val.includes('quiet') || val.includes('yen tinh') || val.includes('talk') || val.includes('conversation') || val.includes('study')) {
            if (venueProfile.traits?.conversationFriendly || venueProfile.traits?.quietAtmosphere || venueProfile.noiseLevel === 'quiet') {
                recordCriterion('Yên tĩnh trò chuyện', w, 1.0, venueProfile.reviewProfile?.conversationFriendly?.confidence || 0.85, 'review_evidence');
            } else if (venueProfile.traits?.livelyAtmosphere || venueProfile.noiseLevel === 'loud') {
                recordCriterion('Yên tĩnh trò chuyện', w, 0.1, 0.80, 'confirmed_noisy_mismatch');
            } else {
                recordCriterion('Yên tĩnh trò chuyện', w, null, 0.4, 'unknown_ambience');
            }
        }
        // Lively / Energetic
        else if (val.includes('lively') || val.includes('nhon nhip') || val.includes('soi dong')) {
            if (venueProfile.traits?.livelyAtmosphere || venueProfile.noiseLevel === 'loud') {
                recordCriterion('Không khí nhộn nhịp', w, 1.0, 0.85, 'review_evidence');
            } else if (venueProfile.traits?.quietAtmosphere || venueProfile.noiseLevel === 'quiet') {
                recordCriterion('Không khí nhộn nhịp', w, 0.2, 0.80, 'quiet_mismatch');
            } else {
                recordCriterion('Không khí nhộn nhịp', w, null, 0.4, 'unknown_ambience');
            }
        }
        // Aesthetic / Photogenic
        else if (val.includes('aesthetic') || val.includes('view') || val.includes('chill') || val.includes('song ao')) {
            const hasView = vText.includes('view') || vText.includes('aesthetic') || vText.includes('song ao') || (venue.tags || []).includes('Aesthetic');
            if (hasView) {
                recordCriterion('Không gian đẹp / View chill', w, 0.9, 0.80, 'tags_and_photos');
            } else {
                recordCriterion('Không gian đẹp / View chill', w, null, 0.5, 'unknown');
            }
        }
        else {
            if (vText.includes(val)) {
                recordCriterion(rawName, w, 0.8, 0.7, 'text_match');
            } else {
                recordCriterion(rawName, w, null, 0.3, 'unknown');
            }
        }
    });

    // 4. Features Matching (Parking, Group Seating)
    (intentProfile.features || []).forEach(f => {
        const rawName = typeof f === 'string' ? f : (f.value || f.preference || '');
        const val = norm(rawName);
        if (!val) return;
        const w = Number(f.weight) || 3;

        if (val.includes('parking') || val.includes('gui xe') || val.includes('park') || val.includes('do xe') || val.includes('bai xe')) {
            if (venueProfile.traits?.easyParking || venueProfile.parkingEase === 'easy') {
                recordCriterion('Chỗ gửi xe thuận tiện', w, 1.0, venueProfile.reviewProfile?.parkingEase?.confidence || 0.80, 'review_evidence');
            } else if (venueProfile.traits?.difficultParking || venueProfile.parkingEase === 'difficult') {
                recordCriterion('Chỗ gửi xe thuận tiện', w, 0.15, 0.75, 'review_evidence_difficult_parking');
            } else {
                recordCriterion('Chỗ gửi xe thuận tiện', w, null, 0.4, 'unknown_parking');
            }
        }
        else if (val.includes('group') || val.includes('nhom') || val.includes('5 people') || val.includes('6 people')) {
            if (venueProfile.traits?.groupFriendly) {
                recordCriterion('Bàn rộng cho nhóm', w, 0.95, venueProfile.reviewProfile?.groupFriendly?.confidence || 0.80, 'review_evidence');
            } else {
                recordCriterion('Bàn rộng cho nhóm', w, null, 0.5, 'unknown_group');
            }
        }
        else {
            if (vText.includes(val)) {
                recordCriterion(rawName, w, 0.8, 0.7, 'text_match');
            } else {
                recordCriterion(rawName, w, null, 0.4, 'unknown');
            }
        }
    });

    // 5. Negative Preferences Penalty (e.g. club-level loud music)
    (intentProfile.negativePreferences || []).forEach(neg => {
        const val = norm(neg.value || neg);
        const w = Number(neg.weight) || 4;

        if (val.includes('club') || val.includes('loud') || val.includes('on')) {
            if (venueProfile.traits.livelyAtmosphere && venueProfile.reviewProfile.quietAtmosphere.score < 0.2) {
                // Violated negative preference! Severe penalty
                weightedScoreSum -= (0.4 * w);
                mismatches.push({
                    preference: `Tránh ${neg.value || neg}`,
                    score: 0.0,
                    confidence: 0.85,
                    source: 'review_evidence_too_loud'
                });
            }
        }
    });

    // Compute final semantic score and confidence
    let semanticScore = 75; // Baseline if user entered no specific food preferences
    let confidence = 0.75;

    if (totalWeight > 0) {
        semanticScore = Math.max(10, Math.min(100, Math.round((weightedScoreSum / totalWeight) * 100)));
        confidence = evaluatedCriteriaCount > 0 ? Number((confidenceSum / evaluatedCriteriaCount).toFixed(2)) : 0.70;
    } else {
        // Fallback to venue general rating and review health
        const rating = venue.rating || 4.5;
        semanticScore = Math.round((rating / 5) * 85);
        confidence = 0.80;
    }

    return {
        semanticScore,
        totalScore: semanticScore,
        confidence,
        confidenceScore: confidence,
        matches,
        partialMatches,
        mismatches,
        unknowns
    };
}

/**
 * Calculates per-member satisfaction and Weiszfeld group fairness
 */
function calculateFairnessScores(memberScores = []) {
    if (memberScores.length === 0) {
        return { groupScore: 70, fairnessScore: 70, avgScore: 70, lowestScore: 70, fairnessIndex: '7.0 / 10' };
    }
    const scores = memberScores.map(m => typeof m === 'number' ? m : (m.score ?? m.totalMemberScore ?? 70));
    const avgScore = Number((scores.reduce((s, x) => s + x, 0) / scores.length).toFixed(1));
    const lowestScore = Math.min(...scores);
    const highestScore = Math.max(...scores);

    // 65% group average + 35% minimum individual satisfaction
    const groupScore = Number((0.65 * avgScore + 0.35 * lowestScore).toFixed(1));

    return {
        groupScore,
        fairnessScore: Math.round(groupScore),
        avgScore,
        lowestScore,
        highestScore,
        fairnessIndex: `${(groupScore / 10).toFixed(1)} / 10`
    };
}

module.exports = {
    buildVenueSemanticProfile,
    evaluateHardConstraints,
    scoreVenueAgainstIntent,
    calculateFairnessScores,
    analyzeReviewEvidence
};
