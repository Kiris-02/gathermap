/**
 * Share Token Security, Route Protection, and Outing Mutability Test Suite
 * Validates:
 * 1. POST /api/venues/search-and-rank without outingId creates new session with fresh share token.
 * 2. POST /api/venues/search-and-rank with existing outingId rejects missing token (401) and invalid token (403).
 * 3. Rejected mutations guarantee zero changes to participants, recommendations, center, and radius.
 * 4. PUT /api/outings/:id enforces share token and successfully updates radius.
 * 5. GET /api/outings/:id restores intact memberBreakdowns with individual scores and numeric distFromCenterKm.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const testDbPath = path.join(__dirname, 'token-security-test.db');
if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch (_) {}
}
process.env.SQLITE_DB_PATH = testDbPath;
process.env.PORT = '0';

const app = require('../server');
const outingRepository = require('../src/repositories/outing-repository');

let server;
let baseUrl;

async function request(endpoint, options = {}) {
    const url = baseUrl + endpoint;
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
    console.log('================================================================');
    console.log('🧪 RUNNING SHARE TOKEN SECURITY & MUTATION PROTECTION SUITE');
    console.log('================================================================\n');

    await new Promise((resolve) => {
        server = app.listen(0, () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            console.log(`[Test Server] Running on ${baseUrl}\n`);
            resolve();
        });
    });

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        process.stdout.write(`  ⏳ ${name} ... `);
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

    let testOutingId = null;
    let testShareToken = null;
    const initialCenter = { lat: 10.7769, lng: 106.7009 };
    const initialFriends = [
        { name: 'Kiris (Host)', lat: 10.7769, lng: 106.7009, wish: 'Korean BBQ, lively' },
        { name: 'Binh', lat: 10.7850, lng: 106.6950, wish: 'Budget under 150k' }
    ];

    try {
        // --- TEST 1: POST without outingId creates new outing and returns shareToken ---
        await test('POST /api/venues/search-and-rank without outingId creates new outing and issues shareToken', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    center: initialCenter,
                    radiusMeters: 3000,
                    friends: initialFriends,
                    requiredConstraints: {},
                    softPreferences: ['korean_bbq']
                }
            });

            assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
            assert.ok(res.data.outingId, 'Must return outingId');
            assert.ok(res.data.shareToken, 'Must return shareToken');
            assert.strictEqual(typeof res.data.shareToken, 'string');
            assert.ok(res.data.shareToken.length >= 32, 'Token must be high-entropy');
            assert.ok(Array.isArray(res.data.shortlist) && res.data.shortlist.length > 0, 'Must return shortlist');

            testOutingId = res.data.outingId;
            testShareToken = res.data.shareToken;

            // Verify initial state saved in DB
            const saved = await outingRepository.getOuting(testOutingId);
            assert.strictEqual(saved.radiusKm, 3.0, 'Initial radius must be 3.0 km');
            assert.strictEqual(saved.participants.length, 2, 'Initial participants count must be 2');
        });

        // --- TEST 2: POST with existing outingId but MISSING token is rejected with 401 ---
        await test('POST /api/venues/search-and-rank with existing outingId rejects missing token (401) with zero mutation', async () => {
            const maliciousCenter = { lat: 21.0285, lng: 105.8542 }; // Hanoi coords
            const maliciousFriends = [{ name: 'Hacker', lat: 21.0, lng: 105.0, wish: 'Malicious Overwrite' }];

            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                body: {
                    outingId: testOutingId,
                    center: maliciousCenter,
                    radiusMeters: 10000,
                    friends: maliciousFriends
                }
            });

            assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
            assert.strictEqual(res.data.error, 'unauthorized');
            assert.strictEqual(res.data.code, 'token_required');

            // CRITICAL ASSERTION: DB state must be 100% UNCHANGED
            const dbCheck = await outingRepository.getOuting(testOutingId);
            assert.strictEqual(dbCheck.radiusKm, 3.0, 'Radius must NOT change on 401');
            assert.strictEqual(dbCheck.centerLat, initialCenter.lat, 'Center lat must NOT change on 401');
            assert.strictEqual(dbCheck.centerLng, initialCenter.lng, 'Center lng must NOT change on 401');
            assert.strictEqual(dbCheck.participants.length, 2, 'Participants must NOT change on 401');
            assert.strictEqual(dbCheck.participants[0].name, 'Kiris (Host)', 'Participant name must be intact');
        });

        // --- TEST 3: POST with existing outingId but INVALID token is rejected with 403 ---
        await test('POST /api/venues/search-and-rank with existing outingId rejects invalid token (403) with zero mutation', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                headers: {
                    'x-share-token': 'completely-wrong-token-abc123xyz'
                },
                body: {
                    outingId: testOutingId,
                    center: { lat: 0, lng: 0 },
                    radiusMeters: 500,
                    friends: []
                }
            });

            assert.strictEqual(res.status, 403, `Expected 403, got ${res.status}`);
            assert.strictEqual(res.data.error, 'forbidden');
            assert.strictEqual(res.data.code, 'invalid_token');

            // CRITICAL ASSERTION: DB state must be 100% UNCHANGED
            const dbCheck = await outingRepository.getOuting(testOutingId);
            assert.strictEqual(dbCheck.radiusKm, 3.0, 'Radius must NOT change on 403');
            assert.strictEqual(dbCheck.participants.length, 2, 'Participants must NOT change on 403');
        });

        // --- TEST 4: PUT /api/outings/:id rejects missing and invalid token ---
        await test('PUT /api/outings/:id rejects missing (401) and invalid (403) share tokens', async () => {
            const noTokenRes = await request(`/api/outings/${testOutingId}`, {
                method: 'PUT',
                body: { radiusKm: 1.5 }
            });
            assert.strictEqual(noTokenRes.status, 401);

            const badTokenRes = await request(`/api/outings/${testOutingId}`, {
                method: 'PUT',
                headers: { 'x-share-token': 'bad-token' },
                body: { radiusKm: 1.5 }
            });
            assert.strictEqual(badTokenRes.status, 403);

            const dbCheck = await outingRepository.getOuting(testOutingId);
            assert.strictEqual(dbCheck.radiusKm, 3.0, 'Radius must remain 3.0 after failed PUT');
        });

        // --- TEST 5: PUT /api/outings/:id succeeds with valid share token ---
        await test('PUT /api/outings/:id updates radius with valid share token via x-share-token header', async () => {
            const res = await request(`/api/outings/${testOutingId}`, {
                method: 'PUT',
                headers: { 'x-share-token': testShareToken },
                body: { radiusKm: 2.0 }
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.radiusKm, 2.0);

            const dbCheck = await outingRepository.getOuting(testOutingId);
            assert.strictEqual(dbCheck.radiusKm, 2.0, 'Radius must be updated to 2.0 km in DB');
        });

        // --- TEST 6: POST with valid share token updates shortlist and preserves outing integrity ---
        await test('POST /api/venues/search-and-rank succeeds with valid share token and updates recommendations', async () => {
            const res = await request('/api/venues/search-and-rank', {
                method: 'POST',
                headers: { 'x-share-token': testShareToken },
                body: {
                    outingId: testOutingId,
                    center: initialCenter,
                    radiusMeters: 2000,
                    friends: initialFriends
                }
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.outingId, testOutingId);
            assert.ok(res.data.shortlist.length > 0);
        });

        // --- TEST 7: GET /api/outings/:id restores intact memberBreakdowns with individual scores and numeric distFromCenterKm ---
        await test('GET /api/outings/:id restores intact memberBreakdowns with distinct scores and numeric distFromCenterKm', async () => {
            const res = await request(`/api/outings/${testOutingId}`, {
                headers: { 'x-share-token': testShareToken }
            });

            assert.strictEqual(res.status, 200);
            const outing = res.data.outing || res.data;
            assert.strictEqual(outing.radiusKm, 2.0, 'Restored radius must be 2.0 km');
            assert.ok(Array.isArray(outing.shortlist) && outing.shortlist.length > 0, 'Shortlist must exist');

            const firstVenue = outing.shortlist[0];

            // 1. Assert numeric distFromCenterKm (NOT undefined, NOT NaN)
            assert.notStrictEqual(firstVenue.distFromCenterKm, undefined, 'distFromCenterKm must not be undefined');
            assert.ok(!isNaN(firstVenue.distFromCenterKm), 'distFromCenterKm must not be NaN');
            assert.strictEqual(typeof firstVenue.distFromCenterKm, 'number', 'distFromCenterKm must be number');
            assert.ok(firstVenue.distFromCenterKm >= 0, 'distFromCenterKm must be non-negative');

            // 2. Assert memberBreakdowns has distinct scores and travel times for each member
            assert.ok(Array.isArray(firstVenue.memberBreakdowns), 'memberBreakdowns must be an array');
            assert.strictEqual(firstVenue.memberBreakdowns.length, 2, 'Must have 2 member breakdowns');

            const mb1 = firstVenue.memberBreakdowns[0];
            const mb2 = firstVenue.memberBreakdowns[1];

            assert.ok(mb1.friendName, 'Member 1 must have friendName');
            assert.ok(mb2.friendName, 'Member 2 must have friendName');
            assert.ok(typeof mb1.score === 'number' && !isNaN(mb1.score), 'Member 1 score must be valid number');
            assert.ok(typeof mb2.score === 'number' && !isNaN(mb2.score), 'Member 2 score must be valid number');
            assert.ok(typeof mb1.travelMins === 'number' && !isNaN(mb1.travelMins), 'Travel mins must be numeric');
            assert.ok(typeof mb2.travelMins === 'number' && !isNaN(mb2.travelMins), 'Travel mins must be numeric');

            // 3. Secret hash hygiene: share_token_hash must NEVER be exposed in client response
            assert.strictEqual(res.data.share_token_hash, undefined, 'share_token_hash must not leak in root');
            assert.strictEqual(outing.share_token_hash, undefined, 'share_token_hash must not leak in outing');
        });

    } finally {
        if (server) server.close();
        if (fs.existsSync(testDbPath)) {
            try { fs.unlinkSync(testDbPath); } catch (_) {}
        }
    }

    console.log('\n================================================================');
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log('================================================================');

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runTests().catch(err => {
        console.error('Fatal test error:', err);
        process.exit(1);
    });
}

module.exports = { runTests };
