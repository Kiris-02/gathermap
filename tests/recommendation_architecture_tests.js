/**
 * Recommendation Architecture & Semantic Engine Deterministic Test Suite
 * Validates Tests A through J per collaborator specifications.
 */

const assert = require('assert');
const path = require('path');
process.env.PORT = '0'; // Ephemeral port
const app = require('../server.js');
const semanticEngine = require('../semanticEngine.js');

let server;
let baseUrl;

async function request(apiPath, options = {}) {
    const url = baseUrl + apiPath;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
}

async function runAllTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING RECOMMENDATION ARCHITECTURE DETERMINISTIC TEST SUITE');
    console.log('================================================================\n');

    await new Promise((resolve) => {
        server = app.listen(0, () => {
            const port = server.address().port;
            baseUrl = 'http://127.0.0.1:' + port;
            console.log(`[Test Server] Running on http://127.0.0.1:${port}\n`);
            resolve();
        });
    });

    let passed = 0;
    let failed = 0;

    async function it(label, fn) {
        process.stdout.write(`  ⏳ ${label} ... `);
        try {
            await fn();
            console.log('✅ PASS');
            passed++;
        } catch (err) {
            console.log('❌ FAIL');
            console.error(`     Error: ${err.message}\n`);
            failed++;
        }
    }

    try {
        // --- TEST A: Specific Intent (Korean BBQ, <150k, lively, 5 people) ---
        await it('Test A: Specific Intent extraction & structured profile generation', async () => {
            const res = await request('/api/preferences/parse', {
                method: 'POST',
                body: {
                    discussionText: 'Nhóm 5 người muốn ăn thịt nướng Hàn Quốc BBQ, không gian vui vẻ nhộn nhịp dưới 150k/người',
                    friends: [
                        { name: 'Kiris', wish: 'Korean BBQ' },
                        { name: 'Alice', wish: 'ngân sách 150k' }
                    ]
                }
            });
            assert.strictEqual(res.status, 200, 'Parser should return 200');
            const data = res.data;
            assert.ok(data.cuisines || data.dishes, 'Should extract cuisines or dishes');
            assert.ok(data.hardConstraints, 'Should extract hardConstraints');
            
            const extractStr = (arr) => (arr || []).map(x => (typeof x === 'string' ? x : (x.value || x.preference || JSON.stringify(x)))).join(' ');
            const textAll = (
                extractStr(data.cuisines) + ' ' +
                extractStr(data.dishes) + ' ' +
                extractStr(data.ambience) + ' ' +
                extractStr(data.features) + ' ' +
                extractStr(data.softPreferences)
            ).toLowerCase();

            assert.ok(
                textAll.includes('korean') || textAll.includes('bbq') || textAll.includes('nướng') || textAll.includes('hàn'),
                'Must detect Korean or BBQ intent'
            );
            const maxP = data.hardConstraints.max_price_vnd || data.hardConstraints.maxPricePerPersonVnd;
            assert.ok(
                maxP <= 150000 || textAll.includes('150k') || textAll.includes('150000'),
                'Must detect budget limit around 150k'
            );
        });

        // --- TEST B: Strict Hard Constraint (Vegetarian, Quiet, <100k) ---
        await it('Test B: Strict Hard Constraint enforcement (never violates vegetarian & budget)', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    center: { lat: 10.7782, lng: 106.6912 },
                    radiusMeters: 4000,
                    requiredConstraints: {
                        vegetarian: true,
                        no_alcohol: false,
                        quiet_only: true,
                        max_price_vnd: 100000
                    },
                    softPreferences: [
                        { preference: 'Quiet study ambience', weight: 5 }
                    ],
                    friends: [
                        { name: 'Friend 1', lat: 10.7780, lng: 106.6910 },
                        { name: 'Friend 2', lat: 10.7785, lng: 106.6915 }
                    ]
                }
            });
            assert.strictEqual(res.status, 200);
            const data = res.data;
            assert.ok(Array.isArray(data.shortlist), 'shortlist must be an array');
            assert.ok(Array.isArray(data.nearbyAlternatives), 'nearbyAlternatives must be an array');

            // Every venue in shortlist MUST satisfy vegetarian and max_price_vnd <= 100k
            data.shortlist.forEach(venue => {
                assert.ok(
                    venue.isVegetarian || (venue.tags && venue.tags.includes('vegetarian')) || venue.category.toLowerCase().includes('chay') || venue.attributes?.dietary?.vegetarian,
                    `Venue ${venue.name} in strictShortlist must be vegetarian`
                );
                if (venue.avgPriceNumber) {
                    assert.ok(venue.avgPriceNumber <= 100000, `Venue ${venue.name} must be <= 100k`);
                }
            });
        });

        // --- TEST C: Negative Constraint (Sushi, No Alcohol, 200k) ---
        await it('Test C: Negative constraint parsing and alcohol exclusion', async () => {
            const parseRes = await request('/api/preferences/parse', {
                method: 'POST',
                body: {
                    discussionText: 'Muốn ăn sushi, ngân sách 200k nhưng tuyệt đối KHÔNG UỐNG BIA RƯỢU, không cồn nha',
                    friends: [{ name: 'Alex', wish: 'sushi no alcohol' }]
                }
            });
            assert.strictEqual(parseRes.status, 200);
            const pData = parseRes.data;
            const hasNoAlcohol = (pData.hardConstraints && (pData.hardConstraints.no_alcohol === true || pData.hardConstraints.noAlcohol === true)) ||
                (pData.negativePreferences && pData.negativePreferences.some(np => {
                    const text = (typeof np === 'string' ? np : (np.value || np.item || JSON.stringify(np))).toLowerCase();
                    return text.includes('alcohol') || text.includes('rượu') || text.includes('bia') || text.includes('cồn');
                }));
            assert.ok(hasNoAlcohol, 'Must extract no_alcohol hardConstraint or negative preference');
        });

        // --- TEST D: Broad Exploratory Intent ---
        await it('Test D: Broad exploratory intent (Group dinner, no specific cuisine)', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    center: { lat: 10.7725, lng: 106.6690 },
                    radiusMeters: 5000,
                    interpretation: {
                        rawIntent: 'Nhóm bạn đi ăn tối nói chuyện rôm rả, đồ ăn ngon, quán thoải mái',
                        hardConstraints: { max_price_vnd: 500000 },
                        cuisines: [],
                        dishes: [],
                        ambience: ['thoải mái', 'rôm rả', 'nhóm bạn'],
                        features: ['group dining']
                    },
                    friends: [
                        { name: 'Kiris', lat: 10.7720, lng: 106.6680 },
                        { name: 'John', lat: 10.7730, lng: 106.6700 }
                    ]
                }
            });
            assert.strictEqual(res.status, 200);
            assert.ok(res.data.shortlist.length > 0, 'Should find venues for general group dining');
            const top = res.data.shortlist[0];
            assert.ok(top.groupScore > 0, 'Group score should be calculated');
            assert.ok(top.fairnessIndex, 'Fairness index should be present');
            assert.ok(top.aiRationale, 'AI rationale should be present');
        });

        // --- TEST E: Review Evidence vs Noise (Quiet Talk outranks Loud venue) ---
        await it('Test E: Review evidence noise analysis (quiet venue outranks loud club)', () => {
            const mockQuietVenue = {
                id: 'venue-quiet',
                name: 'Quiet Study Tea House',
                category: 'Tea House',
                address: '123 Calm St',
                lat: 10.77,
                lng: 106.67,
                tags: ['tea', 'quiet', 'dessert']
            };
            const mockLoudVenue = {
                id: 'venue-loud',
                name: 'Rocking Loud Pub & Sweets',
                category: 'Pub',
                address: '456 Busy St',
                lat: 10.77,
                lng: 106.67,
                tags: ['music', 'drinks']
            };

            const quietReviews = [
                { rating: 5, review_text: 'Không gian cực kỳ yên tĩnh, nhẹ nhàng, nhạc du dương nói chuyện thì thầm rất dễ chịu.' },
                { rating: 4.5, review_text: 'Quán yên ắng, phù hợp ngồi đọc sách và trò chuyện thân mật, không ồn ào.' }
            ];
            const loudReviews = [
                { rating: 4, review_text: 'Quán mở nhạc bass đập rất to, cực kỳ ồn ào như vũ trường, không thể nghe thấy gì.' },
                { rating: 3.5, review_text: 'Quá ồn và náo nhiệt, phải gào lên mới nói chuyện được với bạn bè.' }
            ];

            const quietProfile = semanticEngine.buildVenueSemanticProfile(mockQuietVenue, quietReviews);
            const loudProfile = semanticEngine.buildVenueSemanticProfile(mockLoudVenue, loudReviews);

            assert.strictEqual(quietProfile.noiseLevel, 'quiet', 'Quiet profile should detect quiet noiseLevel');
            assert.strictEqual(loudProfile.noiseLevel, 'loud', 'Loud profile should detect loud noiseLevel');

            const intentProfile = {
                ambience: ['yên tĩnh', 'quiet', 'trò chuyện'],
                hardConstraints: { quiet_only: true }
            };

            const quietScore = semanticEngine.scoreVenueAgainstIntent({
                intentProfile,
                venueProfile: quietProfile,
                venue: mockQuietVenue,
                distanceKm: 0.5
            });

            const loudScore = semanticEngine.scoreVenueAgainstIntent({
                intentProfile,
                venueProfile: loudProfile,
                venue: mockLoudVenue,
                distanceKm: 0.5
            });

            assert.ok(quietScore.totalScore > loudScore.totalScore, 'Quiet venue must score higher than loud venue for quiet intent');
            assert.ok(quietScore.matches.some(m => (m.preference || m).toLowerCase().includes('yên tĩnh') || (m.preference || m).toLowerCase().includes('quiet')), 'Quiet venue must have quiet match');
        });

        // --- TEST F: Review Evidence vs Parking (Easy parking outranks Difficult) ---
        await it('Test F: Review evidence parking analysis (easy parking outranks difficult parking)', () => {
            const mockEasyParking = {
                id: 'v-p1',
                name: 'Spacious Cake Garden',
                category: 'Bakery',
                tags: ['parking', 'spacious']
            };
            const mockHardParking = {
                id: 'v-p2',
                name: 'Narrow Alley Sweets',
                category: 'Bakery',
                tags: ['alley']
            };

            const easyReviews = [
                { rating: 5, review_text: 'Có bãi đỗ xe rộng rãi, giữ xe miễn phí, đỗ ô tô và xe máy cực kỳ thoải mái an ninh.' }
            ];
            const hardReviews = [
                { rating: 3, review_text: 'Không có chỗ để xe, gửi xe ở ngoài rất khó khăn và bị chặt chém đắt đỏ.' }
            ];

            const easyProfile = semanticEngine.buildVenueSemanticProfile(mockEasyParking, easyReviews);
            const hardProfile = semanticEngine.buildVenueSemanticProfile(mockHardParking, hardReviews);

            assert.strictEqual(easyProfile.parkingEase, 'easy', 'Should detect easy parking');
            assert.strictEqual(hardProfile.parkingEase, 'difficult', 'Should detect difficult parking');

            const intent = {
                features: ['đỗ xe', 'parking', 'giữ xe'],
                ambience: []
            };

            const sEasy = semanticEngine.scoreVenueAgainstIntent({
                intentProfile: intent,
                venueProfile: easyProfile,
                venue: mockEasyParking,
                distanceKm: 1.0
            });
            const sHard = semanticEngine.scoreVenueAgainstIntent({
                intentProfile: intent,
                venueProfile: hardProfile,
                venue: mockHardParking,
                distanceKm: 1.0
            });

            assert.ok(sEasy.totalScore > sHard.totalScore, 'Easy parking venue must outscore difficult parking venue');
        });

        // --- TEST G: Radius Integrity (0 in radius -> shortlist empty, alternatives present) ---
        await it('Test G: Radius integrity (0 within strict radius -> strictShortlist is empty, alternatives flagged)', async () => {
            // Pick a coordinate far away (e.g. Can Gio or deep sea) with 500m radius
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    center: { lat: 10.4000, lng: 107.0000 },
                    radiusMeters: 500, // Very tight 500m in Can Gio
                    requiredConstraints: {},
                    friends: [{ name: 'Explorer', lat: 10.4000, lng: 107.0000 }]
                }
            });
            assert.strictEqual(res.status, 200);
            const data = res.data;
            assert.strictEqual(data.shortlist.length, 0, 'strictShortlist MUST be empty when all venues are outside radius');
            assert.ok(data.nearbyAlternatives.length > 0, 'nearbyAlternatives should present out-of-radius candidates');
            
            // Check that violation reason explicitly indicates distance/radius
            const alt = data.nearbyAlternatives[0];
            assert.ok(
                alt.violations && alt.violations.some(v => v.includes('Bán kính') || v.includes('km')),
                'Alternatives must have explicit radius violation tag'
            );
        });

        // --- TEST H: Strict Constraint Integrity (No fake fallbacks) ---
        await it('Test H: Zero fake fallbacks for impossible constraints', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    center: { lat: 10.7782, lng: 106.6912 },
                    radiusMeters: 3000,
                    requiredConstraints: {
                        vegetarian: true,
                        max_price_vnd: 2000 // Impossible 2,000 VND
                    },
                    friends: [{ name: 'Kiris', lat: 10.7782, lng: 106.6912 }]
                }
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.shortlist.length, 0, 'strictShortlist must be empty when constraints cannot be met');
        });

        // --- TEST I: Unknown Metadata Integrity (null/unknown never faked as positive) ---
        await it('Test I: Unknown metadata calibration', () => {
            const blankVenue = {
                id: 'v-blank',
                name: 'Mystery Shop',
                category: 'Cafe'
            };
            const profile = semanticEngine.buildVenueSemanticProfile(blankVenue, []);
            assert.strictEqual(profile.noiseLevel, 'unknown', 'Unspecified noise level must be unknown');
            assert.strictEqual(profile.parkingEase, 'unknown', 'Unspecified parking must be unknown');

            const intent = {
                ambience: ['yên tĩnh tuyệt đối'],
                features: ['bãi xe hơi rộng']
            };

            const scoreRes = semanticEngine.scoreVenueAgainstIntent({
                intentProfile: intent,
                venueProfile: profile,
                venue: blankVenue,
                distanceKm: 1.0
            });

            assert.ok(scoreRes.unknowns.length > 0, 'Should record unknown attributes in unknowns array');
            assert.ok(scoreRes.confidenceScore < 0.6, 'Confidence score should be lower for unknown data');
        });

        // --- TEST J: Decoupled Weiszfeld Group Fairness (65% Avg + 35% Min) ---
        await it('Test J: Decoupled travel vs semantic fairness logic', () => {
            // Case 1: Perfectly balanced travel (50, 50)
            const balanced = semanticEngine.calculateFairnessScores([
                { totalMemberScore: 50 },
                { totalMemberScore: 50 }
            ]);
            // Case 2: Unfair travel (90, 10) - same average 50, but min is 10
            const unfair = semanticEngine.calculateFairnessScores([
                { totalMemberScore: 90 },
                { totalMemberScore: 10 }
            ]);

            assert.strictEqual(balanced.avgScore, 50);
            assert.strictEqual(unfair.avgScore, 50);
            assert.ok(balanced.fairnessScore > unfair.fairnessScore, 'Balanced group travel must achieve higher Weiszfeld fairness score than skewed travel');
            assert.strictEqual(balanced.fairnessScore, 50, '65% * 50 + 35% * 50 = 50');
            assert.strictEqual(unfair.fairnessScore, Math.round(0.65 * 50 + 0.35 * 10), '65% * 50 + 35% * 10 = 36');
        });

    } finally {
        if (server) {
            server.close();
        }
    }

    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================');
    if (failed > 0) {
        process.exit(1);
    }
}

runAllTests().catch(err => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
});
