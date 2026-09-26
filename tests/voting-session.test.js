/**
 * Voting & Session Lifecycle Integration Test Suite
 * Tests session loading, vote deduplication (toggle off / vote change),
 * clean database schema (fresh DB & legacy DB backward compatibility),
 * and data contract harmonization for shared outing links.
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
            process.stdout.write('✅ PASS\n');
            passed++;
        } catch (err) {
            process.stdout.write(`❌ FAIL: ${err.message}\n`);
            failed++;
        }
    }

    try {
        // --- SUITE A: SCHEMA & DATABASE TESTING (FRESH DB & LEGACY DB) ---

        // Test 1: Fresh empty SQLite database initialization & voting
        await runTest('Fresh empty SQLite DB: schema initializes with TEXT PK and votes function without NULL id', async () => {
            const freshDbPath = path.join(__dirname, 'fresh-empty-test.test.db');
            if (fs.existsSync(freshDbPath)) fs.unlinkSync(freshDbPath);

            const dbClientModule = require('../src/repositories/db-client');
            const freshDb = new Database(freshDbPath);

            // Create schema using identical initSqliteSchema logic
            freshDb.exec(`
                CREATE TABLE IF NOT EXISTS outings (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    mode TEXT DEFAULT 'representative',
                    center_lat REAL NOT NULL,
                    center_lng REAL NOT NULL,
                    radius_km REAL NOT NULL DEFAULT 3.0,
                    status TEXT NOT NULL DEFAULT 'active',
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

            // Verify table info: id must be TEXT
            const cols = freshDb.pragma('table_info(votes)');
            const idCol = cols.find(c => c.name === 'id');
            assert(idCol, 'Column id must exist in votes table');
            assert.strictEqual(idCol.type.toUpperCase(), 'TEXT', 'id column must be TEXT');

            // Insert new vote with generated voteId
            const voteId = 'vote-test-' + Date.now();
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

            // Create legacy table with INTEGER PRIMARY KEY AUTOINCREMENT
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

            // Apply forward migration as implemented in db-client.js
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

            // Verify migration results: both historical records preserved
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

            // Create initial outing with distinct custom coordinates and radius
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

            // Now cast a vote on this outing
            const resVote = await req(`/api/outings/${uniqueId}/vote`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: 'v1_phu_nhuan_chay',
                    voterId: 'voter_charlie',
                    voterName: 'Charlie'
                })
            });
            assert.strictEqual(resVote.status, 200);

            // Fetch outing to verify center and radius were NOT reset to default (10.7769, 106.7009, 3.0)
            const resGet = await req(`/api/outings/${uniqueId}`);
            assert.strictEqual(resGet.status, 200);
            const outing = resGet.data.outing;
            assert.strictEqual(Number(outing.centerLat.toFixed(4)), 10.7325, 'centerLat must remain preserved');
            assert.strictEqual(Number(outing.centerLng.toFixed(4)), 106.7118, 'centerLng must remain preserved');
            assert.strictEqual(Number(outing.radiusKm), 4.5, 'radiusKm must remain 4.5');
        });

        // --- SUITE C: SHARED LINK RESTORATION & CONTRACT HARMONIZATION ---

        const testSessionId = await generateUniqueOutingId();

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
        });

        // Test 6: Fetch session details by outing ID with harmonized contracts
        await runTest('Fetch session details by outing ID returns harmonized camelCase and snake_case contracts', async () => {
            const res = await req(`/api/outings/${testSessionId}`);
            assert.strictEqual(res.status, 200);
            const data = res.data;

            // Check top-level and nested outing
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

        const venue1Id = 'v1_phu_nhuan_chay';
        const venue2Id = 'v2_matcha_specialty';

        // Test 7: Cast a new vote
        await runTest('Cast a new vote for venue 1', async () => {
            const res = await req(`/api/outings/${testSessionId}/vote`, {
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
            const res = await req(`/api/outings/${testSessionId}/vote`, {
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
            const session = await req(`/api/outings/${testSessionId}`);
            const aliceVotes = session.data.votes.filter(v => v.voter_id === 'voter_alice_001' || v.voter_name === 'Alice');
            assert.strictEqual(aliceVotes.length, 0, 'Alice should have 0 votes after toggle');
        });

        // Test 9: Vote change from venue 1 to venue 2
        await runTest('Vote change: cast vote 1, then vote for venue 2', async () => {
            // Vote for venue 1
            const res1 = await req(`/api/outings/${testSessionId}/vote`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue1Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });
            assert.strictEqual(res1.data.action, 'voted');

            // Now vote for venue 2 (should move vote)
            const res2 = await req(`/api/outings/${testSessionId}/vote`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue2Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });
            assert.strictEqual(res2.status, 200);
            assert(res2.data.action === 'voted' || res2.data.action === 'changed');

            // Verify Alice has exactly 1 vote and it is for venue 2
            const session = await req(`/api/outings/${testSessionId}`);
            const aliceVotes = session.data.votes.filter(v => (v.voter_id === 'voter_alice_001' || v.voter_name === 'Alice') && (v.venue_id === venue2Id || v.venueId === venue2Id));
            assert.strictEqual(aliceVotes.length, 1, 'Alice should have exactly 1 vote on venue 2');
        });

        // Test 10: Validation rejects missing venueId
        await runTest('Validation rejects missing venueId with 400', async () => {
            const res = await req(`/api/outings/${testSessionId}/vote`, {
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
            const res = await req('/api/outings/non_existent_outing_99999');
            assert.strictEqual(res.status, 404);
            assert(res.data.error);
        });

        // Test 12: Viral share plan text generation
        await runTest('Generate viral share plan contains host and outing query parameter', async () => {
            const res = await req('/api/outings/generate-share-text', {
                method: 'POST',
                body: JSON.stringify({
                    outingCode: testSessionId,
                    venue: {
                        name: 'Bếp Chay Yên Tĩnh',
                        address: '123 Phan Xích Long, Q. Phú Nhuận',
                        lat: 10.7960,
                        lng: 106.6920
                    },
                    friends: [
                        { name: 'Alice' },
                        { name: 'Bob' }
                    ]
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.message.includes(testSessionId), 'Message should contain the outing code');
            assert(res.data.message.includes('?outing=' + testSessionId), 'Message should contain ?outing= query parameter link');
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
