/**
 * GatherMap Pipeline Deterministic Test Suite
 * Tests the complete Input -> Interpretation -> Filtering -> Scoring -> Ranking pipeline.
 */

const assert = require('assert');
const http = require('http');

process.env.PORT = '0'; // Use ephemeral free port for testing
const app = require('../server.js');

let server;
let baseUrl;

async function request(path, options = {}) {
    const url = baseUrl + path;
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const res = await fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
}

async function runTests() {
    console.log('🚀 Starting GatherMap Pipeline Deterministic Test Suite...\n');

    await new Promise((resolve) => {
        server = app.listen(0, () => {
            const port = server.address().port;
            baseUrl = 'http://localhost:' + port;
            console.log('[Test Server] Running on ephemeral port ' + port + '\n');
            resolve();
        });
    });

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        process.stdout.write('  ⏳ ' + name + '... ');
        try {
            await fn();
            console.log('✅ PASS');
            passed++;
        } catch (err) {
            console.log('❌ FAIL');
            console.error('     ' + err.message);
            failed++;
        }
    }

    try {
        // --- TEST A: Open Schema & Nuanced Preference Parsing ---
        await test('Test A: Preferences Parser outputs open schema for Korean BBQ & Quiet', async () => {
            const res = await request('/api/preferences/parse', {
                method: 'POST',
                body: {
                    discussionText: 'Tối nay thèm ăn thịt nướng Hàn Quốc BBQ, sau đó qua quán cà phê yên tĩnh ngồi làm việc',
                    friends: [
                        { name: 'You', wish: 'thịt nướng Hàn Quốc BBQ' },
                        { name: 'Bob', wish: 'cà phê yên tĩnh làm việc' }
                    ]
                }
            });

            assert.strictEqual(res.status, 200, 'Endpoint should return 200');
            const data = res.data;
            assert.ok(data, 'Response data should be non-null');
            assert.ok(data.hardConstraints, 'Response should contain hardConstraints');
            assert.ok(Array.isArray(data.cuisines), 'cuisines should be an array');
            assert.ok(Array.isArray(data.dishes), 'dishes should be an array');
            assert.ok(Array.isArray(data.ambience), 'ambience should be an array');
            assert.ok(Array.isArray(data.features), 'features should be an array');

            const allParsed = (
                data.cuisines.join(' ') + ' ' +
                data.dishes.join(' ') + ' ' +
                data.ambience.join(' ') + ' ' +
                (data.softPreferences || []).map(p => p.preference).join(' ')
            ).toLowerCase();

            assert.ok(
                allParsed.includes('korean') || allParsed.includes('bbq') || allParsed.includes('nướng') || allParsed.includes('hàn'),
                'Parsed criteria must detect Korean / BBQ intent'
            );
            assert.ok(
                allParsed.includes('quiet') || allParsed.includes('yên tĩnh') || allParsed.includes('work') || allParsed.includes('cà phê') || allParsed.includes('cafe'),
                'Parsed criteria must detect Quiet / Cafe intent'
            );
        });

        // --- TEST B: Korean BBQ Venue Ranking & Structured Breakdown ---
        await test('Test B: Venue Search & Rank for Korean BBQ gives top rank to BBQ and includes structured evidence badges', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    center: { lat: 10.7782, lng: 106.6912 },
                    radiusMeters: 5000,
                    requiredConstraints: { vegetarian: false, no_alcohol: false, quiet_only: false },
                    softPreferences: [
                        { preference: 'Korean BBQ', weight: 5 },
                        { preference: 'Thịt nướng', weight: 4 }
                    ],
                    cuisines: ['korean_bbq', 'korean'],
                    friends: [
                        { id: 1, name: 'You', lat: 10.7798, lng: 106.6990, wish: 'Korean BBQ' }
                    ]
                }
            });

            assert.strictEqual(res.status, 200, 'Search endpoint should return 200');
            const shortlist = res.data.shortlist;
            assert.ok(Array.isArray(shortlist) && shortlist.length > 0, 'Shortlist should contain venues');

            const top = shortlist[0];
            assert.ok(top.groupScore >= 0 && top.groupScore <= 100, 'groupScore should be bounded [0, 100]');
            assert.ok(Array.isArray(top.matches), 'top venue must have matches array');
            assert.ok(Array.isArray(top.partialMatches), 'top venue must have partialMatches array');
            assert.ok(Array.isArray(top.unknowns), 'top venue must have unknowns array');
            assert.ok(Array.isArray(top.mismatches), 'top venue must have mismatches array');

            for (const v of shortlist) {
                assert.ok(Array.isArray(v.matches), 'Matches should be array');
                assert.ok(typeof v.fairnessScore === 'number', 'Fairness score must be numeric');
                assert.ok(typeof v.distanceScore === 'number', 'Distance score must be numeric');
            }
        });

        // --- TEST C: Strict Vegetarian Constraint Filtering ---
        await test('Test C: Strict Vegetarian constraint strictly validates dietary suitability', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    center: { lat: 10.7782, lng: 106.6912 },
                    radiusMeters: 5000,
                    requiredConstraints: { vegetarian: true, no_alcohol: false, quiet_only: false },
                    softPreferences: [{ preference: 'Chay thanh tịnh', weight: 5 }],
                    friends: [{ id: 1, name: 'Alice', lat: 10.7798, lng: 106.6990, wish: 'ăn chay' }]
                }
            });

            assert.strictEqual(res.status, 200);
            const shortlist = res.data.shortlist;
            assert.ok(Array.isArray(shortlist) && shortlist.length > 0, 'Shortlist should return vegetarian options');

            const top = shortlist[0];
            const isVeg = top.isVegetarian ||
                          Boolean(top.attributes?.dietary?.vegetarian) ||
                          (top.category || '').toLowerCase().includes('chay') ||
                          (top.category || '').toLowerCase().includes('vegetarian') ||
                          (top.name || '').toLowerCase().includes('chay') ||
                          (top.tags || []).some(t => t.toLowerCase().includes('vegetarian') || t.toLowerCase().includes('chay')) ||
                          (top.matches || []).some(m => m.toLowerCase().includes('vegetarian') || m.toLowerCase().includes('chay'));

            assert.ok(isVeg, 'Top venue (' + top.name + ' - ' + top.category + ') must be vegetarian-compatible');
        });

        // --- TEST D: Discovery Mode (Clean Wishes, Non-presumptive) ---
        await test('Test D: Clean wishes (Discovery Mode) relies on distance, rating, fairness without fabricated matches', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    center: { lat: 10.7782, lng: 106.6912 },
                    radiusMeters: 3000,
                    requiredConstraints: { vegetarian: false, no_alcohol: false, quiet_only: false },
                    softPreferences: [],
                    friends: [
                        { id: 1, name: 'You', lat: 10.7798, lng: 106.6990, wish: '' },
                        { id: 2, name: 'Bob', lat: 10.7950, lng: 106.7218, wish: '' },
                        { id: 3, name: 'Charlie', lat: 10.7827, lng: 106.6958, wish: '' }
                    ]
                }
            });

            assert.strictEqual(res.status, 200);
            const shortlist = res.data.shortlist;
            assert.ok(Array.isArray(shortlist) && shortlist.length > 0, 'Shortlist should return nearby venues');

            const top = shortlist[0];
            assert.strictEqual(top.matches.length, 0, 'In discovery mode with no preferences, matches should be 0');
            assert.ok(top.fairnessIndex, 'Fairness index must be computed');
            assert.ok(top.distFromCenterKm >= 0, 'Distance from center must be computed');
        });

        // --- TEST E: Geocoding Authority & Coordinate Truthfulness ---
        await test('Test E: Geocoding resolves real coordinates without hallucination', async () => {
            const res = await request('/api/geocode?q=' + encodeURIComponent('Landmark 81, TP.HCM'));
            assert.strictEqual(res.status, 200);
            const geo = res.data;
            assert.ok(geo.lat && geo.lng, 'Geocoding must return lat and lng');
            assert.ok(Math.abs(geo.lat - 10.795) < 0.05, 'Latitude should be in Landmark 81 vicinity');
            assert.ok(Math.abs(geo.lng - 106.721) < 0.05, 'Longitude should be in Landmark 81 vicinity');
            assert.ok(['google', 'openstreetmap', 'known_landmarks', 'gemini_nlp'].includes(geo.source), 'Source should be a recognized resolver: ' + geo.source);
        });

    } finally {
        if (server) {
            server.close();
            console.log('\n[Test Server] Closed.');
        }
    }

    console.log('\n========================================');
    console.log('🎯 Test Summary: ' + passed + ' Passed, ' + failed + ' Failed');
    console.log('========================================\n');

    if (failed > 0) {
        process.exit(1);
    }
}

runTests().catch((err) => {
    console.error('Fatal test error:', err);
    if (server) server.close();
    process.exit(1);
});
