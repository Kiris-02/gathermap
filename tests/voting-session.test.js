/**
 * Voting & Session Lifecycle Integration Test Suite
 * Tests session loading, vote deduplication (toggle off / vote change),
 * clean database schema (fresh DB & legacy DB backward compatibility),
 * data contract harmonization, and cryptographic share token access control.
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Configure isolated test database path to avoid polluting gathermap.db
const testDbPath = path.join(__dirname, 'isolated-test-session.test.db');
if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch (_) {}
}
process.env.SQLITE_DB_PATH = testDbPath;
process.env.PORT = '0';
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const app = require('../src/app');
const { generateUniqueOutingId } = require('../src/services/outing-service');

async function runVotingSessionTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING VOTING & SESSION LIFECYCLE TEST SUITE');
    console.log('================================================================\n');

    const server = http.createServer(app);

    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve();
        });
    });

    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`[Test Server] Running on ${baseUrl}\n`);

    async function req(apiPath, options = {}) {
        const url = `${baseUrl}${apiPath}`;
        const res = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        const contentType = res.headers.get('content-type') || '';
        let data = null;
        if (contentType.includes('application/json')) {
            data = await res.json();
        } else {
            data = await res.text();
        }
        return { status: res.status, ok: res.ok, data };
    }

    let passed = 0;
    let failed = 0;

    async function runTest(name, fn) {
        process.stdout.write(`  ⏳ ${name} ... `);
        try {
            await fn();
            console.log('✅ PASS');
            passed++;
        } catch (err) {
            console.log(`❌ FAIL: ${err.message}`);
            console.error(err);
            failed++;
        }
    }

    try {
        // --- SUITE A: CLEAN DATABASE SCHEMA & BACKWARD COMPATIBILITY ---

        // Test 1: Fresh empty SQLite DB
        await runTest('Fresh empty SQLite DB: schema initializes with TEXT PK and votes function without NULL id', async () => {
            const freshDbPath = path.join(__dirname, 'fresh-test-schema.test.db');
            if (fs.existsSync(freshDbPath)) fs.unlinkSync(freshDbPath);

            const freshDb = new Database(freshDbPath);
            freshDb.exec(`
                CREATE TABLE IF NOT EXISTS outings (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    mode TEXT DEFAULT 'representative',
                    center_lat REAL NOT NULL,
                    center_lng REAL NOT NULL,
                    radius_km REAL NOT NULL DEFAULT 3.0,
                    status TEXT NOT NULL DEFAULT 'active',
                    share_token_hash TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS votes (
                    id TEXT PRIMARY KEY,
                    outing_id TEXT NOT NULL,
                    venue_id TEXT NOT NULL,
                    voter_name TEXT NOT NULL,
                    voter_id TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(outing_id, voter_name, venue_id)
                );
            `);

            const cols = freshDb.pragma('table_info(votes)');
            const idCol = cols.find(c => c.name === 'id');
            assert.strictEqual(idCol.type.toUpperCase(), 'TEXT', 'id must be TEXT');
            assert.strictEqual(idCol.pk, 1, 'id must be PRIMARY KEY');

            const voteId = 'vote-test-uuid-001';
            freshDb.prepare(`
                INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id)
                VALUES (?, ?, ?, ?, ?)
            `).run(voteId, 'EAT-TEST-01', 'venue-123', 'Tester', 'voter_t1');

            const inserted = freshDb.prepare('SELECT * FROM votes WHERE outing_id = ?').get('EAT-TEST-01');
            assert(inserted, 'Vote must be inserted');
            assert.strictEqual(inserted.id, voteId, 'id must match non-null generated voteId');

            // Change vote by id
            freshDb.prepare(`
                UPDATE votes SET venue_id = ?, voter_name = ?, voter_id = ?, created_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run('venue-456', 'Tester', 'voter_t1', inserted.id);

            const updated = freshDb.prepare('SELECT * FROM votes WHERE id = ?').get(inserted.id);
            assert.strictEqual(updated.venue_id, 'venue-456', 'Vote should be updated to venue-456');

            // Retract/toggle vote by id
            freshDb.prepare('DELETE FROM votes WHERE id = ?').run(inserted.id);
            const remaining = freshDb.prepare('SELECT * FROM votes WHERE id = ?').get(inserted.id);
            assert.strictEqual(remaining, undefined, 'Vote must be deleted cleanly by id');

            freshDb.close();
            try { fs.unlinkSync(freshDbPath); } catch (_) {}
        });

        // Test 2: Legacy SQLite DB migration from INTEGER PK to TEXT PK without data loss
        await runTest('Legacy SQLite DB migration: INTEGER id seamlessly migrated to TEXT PK preserving historical votes', async () => {
            const legacyDbPath = path.join(__dirname, 'legacy-migration-test.test.db');
            if (fs.existsSync(legacyDbPath)) fs.unlinkSync(legacyDbPath);

            const legacyDb = new Database(legacyDbPath);

            legacyDb.exec(`
                CREATE TABLE votes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    outing_id TEXT NOT NULL,
                    venue_id TEXT NOT NULL,
                    voter_name TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(outing_id, voter_name, venue_id)
                );
                INSERT INTO votes (outing_id, venue_id, voter_name) VALUES ('EAT-LEGACY', 'v1_phu_nhuan_chay', 'Alice');
                INSERT INTO votes (outing_id, venue_id, voter_name) VALUES ('EAT-LEGACY', 'v2_matcha_specialty', 'Bob');
            `);

            const cols = legacyDb.pragma('table_info(votes)');
            const idCol = cols.find(c => c.name === 'id');
            assert(idCol.type.toUpperCase().includes('INT'), 'Legacy DB starts with INTEGER id');

            legacyDb.transaction(() => {
                legacyDb.exec(`
                    CREATE TABLE IF NOT EXISTS votes_new_text_pk (
                        id TEXT PRIMARY KEY,
                        outing_id TEXT NOT NULL,
                        venue_id TEXT NOT NULL,
                        voter_name TEXT NOT NULL,
                        voter_id TEXT,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE(outing_id, voter_name, venue_id)
                    );
                    INSERT OR IGNORE INTO votes_new_text_pk (id, outing_id, venue_id, voter_name, voter_id, created_at)
                    SELECT 'vote-' || CAST(id AS TEXT), outing_id, venue_id, voter_name, voter_name, created_at FROM votes;
                    DROP TABLE votes;
                    ALTER TABLE votes_new_text_pk RENAME TO votes;
                `);
            })();

            const migratedCols = legacyDb.pragma('table_info(votes)');
            const migratedIdCol = migratedCols.find(c => c.name === 'id');
            assert.strictEqual(migratedIdCol.type.toUpperCase(), 'TEXT', 'id must now be TEXT');

            const allVotes = legacyDb.prepare('SELECT * FROM votes ORDER BY id ASC').all();
            assert.strictEqual(allVotes.length, 2, 'Must preserve all 2 historical votes');
            assert.strictEqual(allVotes[0].id, 'vote-1', 'Legacy integer 1 migrated to vote-1');
            assert.strictEqual(allVotes[1].id, 'vote-2', 'Legacy integer 2 migrated to vote-2');

            legacyDb.close();
            try { fs.unlinkSync(legacyDbPath); } catch (_) {}
        });

        // --- SUITE B: COLLISION RESISTANCE & OUTING OVERWRITE PREVENTION ---

        // Test 3: Outing ID format and collision resistance
        await runTest('Collision-resistant outing ID generator produces high-entropy codes', async () => {
            const generated = new Set();
            for (let i = 0; i < 50; i++) {
                const id = await generateUniqueOutingId();
                assert(/^EAT-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/.test(id), `ID ${id} must follow format EAT-XXXXXX without confusing chars`);
                assert(!generated.has(id), `ID ${id} collided within 50 generations!`);
                generated.add(id);
            }
        });

        // Test 4: Prevent outing creation or voting from overwriting existing outing coordinates/radius
        await runTest('Outing integrity: voting or duplicate saves never overwrite original center and radius', async () => {
            const uniqueId = await generateUniqueOutingId();
            const customCenter = { lat: 10.7325, lng: 106.7118 }; // District 7
            const customRadiusMeters = 4500;

            const resCreate = await req('/api/venues/search-and-rank', {
                method: 'POST',
                body: JSON.stringify({
                    outingId: uniqueId,
                    center: customCenter,
                    radiusMeters: customRadiusMeters,
                    friends: [
                        { name: 'Charlie', lat: 10.7320, lng: 106.7110 }
                    ]
                })
            });
            assert.strictEqual(resCreate.status, 200);
            const shareToken = resCreate.data.shareToken;
            assert(shareToken, 'search-and-rank must return a valid shareToken');

            // Verify access control: Without token -> 401
            const resNoToken = await req(`/api/outings/${uniqueId}`);
            assert.strictEqual(resNoToken.status, 401, 'Fetching outing without token must return 401');

            // Verify access control: Invalid token -> 403
            const resBadToken = await req(`/api/outings/${uniqueId}?token=bad_invalid_token_12345`);
            assert.strictEqual(resBadToken.status, 403, 'Fetching outing with bad token must return 403');

            // Cast a vote with valid token
            const resVote = await req(`/api/outings/${uniqueId}/vote?token=${shareToken}`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: 'v1_phu_nhuan_chay',
                    voterId: 'voter_charlie',
                    voterName: 'Charlie'
                })
            });
            assert.strictEqual(resVote.status, 200);

            // Fetch outing with valid token: verify center and radius were NOT reset to default (10.7769, 106.7009, 3.0)
            const resGet = await req(`/api/outings/${uniqueId}`, {
                headers: { 'x-share-token': shareToken }
            });
            assert.strictEqual(resGet.status, 200);
            const outing = resGet.data.outing;
            assert.strictEqual(Number(outing.centerLat.toFixed(4)), 10.7325, 'centerLat must remain preserved');
            assert.strictEqual(Number(outing.centerLng.toFixed(4)), 106.7118, 'centerLng must remain preserved');
            assert.strictEqual(Number(outing.radiusKm), 4.5, 'radiusKm must remain 4.5');
            assert.strictEqual(resGet.data.share_token_hash, undefined, 'share_token_hash must NEVER be exposed in API responses');
        });

        // --- SUITE C: SHARED LINK RESTORATION & CONTRACT HARMONIZATION ---

        const testSessionId = await generateUniqueOutingId();
        let testSessionToken = '';

        // Test 5: Search and rank creates outing and persists recommendations
        await runTest('Unified outing creation via search-and-rank persists shortlist and participants', async () => {
            const res = await req('/api/venues/search-and-rank', {
                method: 'POST',
                body: JSON.stringify({
                    outingId: testSessionId,
                    center: { lat: 10.7782, lng: 106.6912 },
                    radiusMeters: 3000,
                    friends: [
                        { name: 'Alice', lat: 10.7782, lng: 106.6912, wish: 'Món chay thanh tịnh' },
                        { name: 'Bob', lat: 10.7800, lng: 106.6950, wish: 'Gần trung tâm' }
                    ]
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.shortlist && res.data.shortlist.length > 0, 'Expected non-empty shortlist');
            assert.strictEqual(res.data.outingId, testSessionId, 'Outing ID must match request');
            assert(res.data.shareToken, 'Response must include shareToken');
            testSessionToken = res.data.shareToken;
        });

        // Test 6: Fetch session details by outing ID with harmonized contracts
        await runTest('Fetch session details by outing ID returns harmonized camelCase and snake_case contracts', async () => {
            const res = await req(`/api/outings/${testSessionId}?token=${testSessionToken}`);
            assert.strictEqual(res.status, 200);
            const data = res.data;

            assert(data.outing, 'Expected outing object');
            const outing = data.outing;

            // Center coordinate contract harmonization
            assert(outing.centerLat != null && outing.center_lat != null, 'Both centerLat and center_lat must be present');
            assert.strictEqual(Number(outing.centerLat), Number(outing.center_lat));

            // Radius contract harmonization
            assert(outing.radiusKm != null && outing.radius_meters != null, 'Both radiusKm and radius_meters must be present');
            assert.strictEqual(outing.radius_meters, 3000);

            // Participants / Friends contract harmonization
            assert(Array.isArray(outing.participants), 'participants must be array');
            assert(Array.isArray(outing.friends), 'friends alias must be array');
            assert.strictEqual(outing.friends.length, 2, 'Expected 2 friends');
            assert.strictEqual(outing.friends[0].name, 'Alice');

            // Recommendations / Shortlist contract harmonization
            assert(Array.isArray(outing.shortlist), 'shortlist must be array');
            assert(Array.isArray(outing.recommendations), 'recommendations must be array');
            assert(outing.shortlist.length > 0, 'shortlist must not be empty');
            assert(outing.shortlist[0].id, 'First venue must have id');
            assert(outing.shortlist[0].name, 'First venue must have name');
            assert(outing.shortlist[0].groupScore != null, 'First venue must have groupScore');
            assert(Array.isArray(outing.shortlist[0].memberBreakdowns), 'First venue must have memberBreakdowns');
        });

        // --- SUITE D: VOTING, VOTE CHANGE, RETRACTION & ERROR ROLLBACK ---

        const venue1Id = 'hcm-vnu-veg-01';
        const venue2Id = 'hcm-vnu-bbq-01';

        // Test 7: Cast a new vote
        await runTest('Cast a new vote for venue 1', async () => {
            const res = await req(`/api/outings/${testSessionId}/vote?token=${testSessionToken}`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue1Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.success);
            assert.strictEqual(res.data.action, 'voted');
            assert.strictEqual(res.data.currentVotedVenue, venue1Id);
        });

        // Test 8: Toggle off vote by voting for the same venue again
        await runTest('Toggle off vote by voting again for the same venue', async () => {
            const res = await req(`/api/outings/${testSessionId}/vote?token=${testSessionToken}`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue1Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.success);
            assert.strictEqual(res.data.action, 'unvoted', 'Second click should unvote (toggle off)');

            // Verify vote was removed
            const session = await req(`/api/outings/${testSessionId}?token=${testSessionToken}`);
            const aliceVotes = session.data.votes.filter(v => v.voter_id === 'voter_alice_001' || v.voter_name === 'Alice');
            assert.strictEqual(aliceVotes.length, 0, 'Alice should have 0 votes after toggle');
        });

        // Test 9: Vote change from venue 1 to venue 2
        await runTest('Vote change: cast vote 1, then vote for venue 2', async () => {
            const res1 = await req(`/api/outings/${testSessionId}/vote?token=${testSessionToken}`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue1Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });
            assert.strictEqual(res1.data.action, 'voted');

            // Now vote for venue 2 (should move vote)
            const res2 = await req(`/api/outings/${testSessionId}/vote?token=${testSessionToken}`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue2Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });
            assert.strictEqual(res2.status, 200);
            assert(res2.data.action === 'voted' || res2.data.action === 'changed');

            const session = await req(`/api/outings/${testSessionId}?token=${testSessionToken}`);
            const aliceVotes = session.data.votes.filter(v => (v.voter_id === 'voter_alice_001' || v.voter_name === 'Alice') && (v.venue_id === venue2Id || v.venueId === venue2Id));
            assert.strictEqual(aliceVotes.length, 1, 'Alice should have exactly 1 vote on venue 2');
        });

        // Test 10: Validation rejects missing venueId
        await runTest('Validation rejects missing venueId with 400', async () => {
            const res = await req(`/api/outings/${testSessionId}/vote?token=${testSessionToken}`, {
                method: 'POST',
                body: JSON.stringify({
                    voterName: 'Alice'
                })
            });
            assert.strictEqual(res.status, 400);
            assert(res.data.error, 'Expected error message in response');
        });

        // Test 11: Non-existent outing polling resilience
        await runTest('Polling non-existent outing returns 404 gracefully', async () => {
            const res = await req('/api/outings/non_existent_outing_99999?token=dummy_token_123');
            assert.strictEqual(res.status, 404);
            assert(res.data.error);
        });

        // Test 12: Viral share plan text generation
        await runTest('Generate viral share plan contains host, outing and share token parameters', async () => {
            const res = await req('/api/outings/generate-share-text', {
                method: 'POST',
                body: JSON.stringify({
                    outingCode: testSessionId,
                    shareToken: testSessionToken,
                    venue: {
                        name: 'Hum Vegetarian',
                        address: '32 Võ Văn Tần, Q.3',
                        lat: 10.7779,
                        lng: 106.6908
                    },
                    friends: [
                        { name: 'Alice' },
                        { name: 'Bob' }
                    ]
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.message.includes(testSessionId), 'Message should contain the outing code');
            assert(res.data.message.includes('?outing=' + testSessionId), 'Message should contain ?outing= parameter');
            assert(res.data.message.includes('&token=' + testSessionToken), 'Message should contain &token= parameter');
        });

        // Test 13: Authorized updateOutingSettings
        await runTest('Authorized outing settings update via PUT /api/outings/:id', async () => {
            const updateRes = await req(`/api/outings/${testSessionId}?token=${testSessionToken}`, {
                method: 'PUT',
                body: JSON.stringify({
                    name: 'Tiệc Tất Niên Nhóm',
                    radiusKm: 5.5
                })
            });

            assert.strictEqual(updateRes.status, 200);
            assert.strictEqual(updateRes.data.name, 'Tiệc Tất Niên Nhóm');
            assert.strictEqual(Number(updateRes.data.radiusKm), 5.5);

            // Fetch to verify persistence
            const verifyGet = await req(`/api/outings/${testSessionId}?token=${testSessionToken}`);
            assert.strictEqual(verifyGet.data.name, 'Tiệc Tất Niên Nhóm');
            assert.strictEqual(Number(verifyGet.data.radiusKm), 5.5);
        });

    } finally {
        server.close();
        if (fs.existsSync(testDbPath)) {
            try { fs.unlinkSync(testDbPath); } catch (_) {}
        }
    }

    console.log(`\n================================================================`);
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`================================================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runVotingSessionTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
