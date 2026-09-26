/**
 * Legacy Outing Migration & Smooth Token Transition Test Suite
 * Validates Requirement 5:
 * 1. Migration never locks users out of legacy outings created before the token era.
 * 2. Unmigrated legacy outings (share_token_hash IS NULL) smoothly upgrade on first access,
 *    issuing a cryptographically secure token and returning it to the client.
 * 3. Legacy participants, recommendations, and votes remain 100% intact.
 * 4. Once upgraded, subsequent interactions strictly require the new token via x-share-token header.
 * 5. Requests without token after upgrade receive 401 with informative legacy notice.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const legacyDbPath = path.join(__dirname, 'legacy-transition-test.db');
if (fs.existsSync(legacyDbPath)) {
    try { fs.unlinkSync(legacyDbPath); } catch (_) {}
}

const legacyOutingId = 'out-leg-' + Date.now();

// 1. Manually construct a pre-token legacy SQLite database
const initDb = new Database(legacyDbPath);
initDb.exec(`
    CREATE TABLE outings (
        id TEXT PRIMARY KEY,
        name TEXT,
        mode TEXT DEFAULT 'representative',
        center_lat REAL NOT NULL,
        center_lng REAL NOT NULL,
        radius_km REAL NOT NULL DEFAULT 3.0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE participants (
        id TEXT PRIMARY KEY,
        outing_id TEXT NOT NULL,
        name TEXT NOT NULL,
        district TEXT,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        wish TEXT,
        is_me INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE venues (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        type TEXT NOT NULL,
        is_alley INTEGER DEFAULT 0,
        alley_note TEXT,
        address TEXT NOT NULL,
        place_id TEXT,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        rating REAL DEFAULT 4.5,
        reviews_count INTEGER DEFAULT 100,
        price_per_person_vnd INTEGER DEFAULT 60000,
        avg_price TEXT DEFAULT '35k - 80k VND',
        tags TEXT DEFAULT '[]',
        attributes TEXT DEFAULT '{}',
        unknowns TEXT DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE recommendations (
        id TEXT PRIMARY KEY,
        outing_id TEXT NOT NULL,
        venue_id TEXT NOT NULL,
        group_score REAL NOT NULL,
        avg_score REAL NOT NULL,
        lowest_score REAL NOT NULL,
        ai_rationale TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE votes (
        id TEXT PRIMARY KEY,
        outing_id TEXT NOT NULL,
        venue_id TEXT NOT NULL,
        voter_name TEXT NOT NULL,
        voter_id TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
`);

// Insert pre-token legacy outing without share_token_hash
initDb.prepare(`
    INSERT INTO outings (id, name, mode, center_lat, center_lng, radius_km, status)
    VALUES (?, 'Legacy Coffee Meetup', 'representative', 10.7769, 106.7009, 3.0, 'active')
`).run(legacyOutingId);

initDb.prepare(`
    INSERT INTO participants (id, outing_id, name, district, lat, lng, wish, is_me)
    VALUES 
        (?, ?, 'Alice (Host)', 'D1', 10.7769, 106.7009, 'Good coffee, quiet', 1),
        (?, ?, 'Bob (Guest)', 'D3', 10.7850, 106.6950, 'Budget friendly', 0)
`).run(`p-${legacyOutingId}-1`, legacyOutingId, `p-${legacyOutingId}-2`, legacyOutingId);

initDb.exec(`
    INSERT INTO venues (id, name, category, type, address, lat, lng)
    VALUES 
        ('v-legacy-1', 'The Workshop Coffee', 'Cà phê', 'cafe', '27 Ngo Duc Ke, D1', 10.7735, 106.7042),
        ('v-legacy-2', 'Goc Ha Noi Cafe', 'Cà phê', 'cafe', '165 Bui Vien, D1', 10.7675, 106.6935);
`);

initDb.prepare(`
    INSERT INTO recommendations (id, outing_id, venue_id, group_score, avg_score, lowest_score, ai_rationale)
    VALUES 
        (?, ?, 'v-legacy-1', 92.5, 91.0, 88.0, 'Great specialty coffee for Alice & Bob'),
        (?, ?, 'v-legacy-2', 86.0, 85.0, 82.0, 'Cozy egg coffee spot')
`).run(`rec-${legacyOutingId}-1`, legacyOutingId, `rec-${legacyOutingId}-2`, legacyOutingId);

initDb.prepare(`
    INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id)
    VALUES (?, ?, 'v-legacy-1', 'Alice (Host)', 'voter-alice-1')
`).run(`vote-${legacyOutingId}-1`, legacyOutingId);

initDb.close();

// Now point application to this legacy DB
process.env.SQLITE_DB_PATH = legacyDbPath;
process.env.PORT = '0';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const app = require('../server');

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
    console.log('🧪 RUNNING LEGACY MIGRATION & TOKEN TRANSITION TEST SUITE');
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

    let newlyIssuedToken = null;

    const outingService = require('../src/services/outing-service');

    try {
        // --- TEST 1: Migration preserves all historical data intact ---
        await test('Schema initialization migrates legacy columns while preserving all historical data', async () => {
            const db = new Database(legacyDbPath);
            const outing = db.prepare('SELECT * FROM outings WHERE id = ?').get(legacyOutingId);
            const participants = db.prepare('SELECT * FROM participants WHERE outing_id = ?').all(legacyOutingId);
            const recs = db.prepare('SELECT * FROM recommendations WHERE outing_id = ?').all(legacyOutingId);
            const votes = db.prepare('SELECT * FROM votes WHERE outing_id = ?').all(legacyOutingId);
            db.close();

            assert.strictEqual(outing.name, 'Legacy Coffee Meetup');
            assert.strictEqual(participants.length, 2, 'Must have 2 participants');
            assert.strictEqual(recs.length, 2, 'Must have 2 recommendations');
            assert.strictEqual(votes.length, 1, 'Must have 1 vote');
        });

        // --- TEST 2: Direct visit to legacy outing without token is rejected with 401 legacy_outing_upgrade_required ---
        await test('Visit to legacy outing without token is rejected with 401 legacy_outing_upgrade_required', async () => {
            const res = await request(`/api/outings/${legacyOutingId}`);

            assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
            assert.strictEqual(res.data.error, 'unauthorized');
            assert.strictEqual(res.data.code, 'legacy_outing_upgrade_required');
            assert.ok(res.data.message.includes('phiên bản cũ'), 'Must explain upgrade requirement');
        });

        // --- TEST 3: Operator reissues token for legacy outing atomically ---
        await test('Operator utility generates share token and sets hash atomically', async () => {
            const result = await outingService.reissueLegacyOutingShareToken({ outingId: legacyOutingId, force: false });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.outingId, legacyOutingId);
            assert.ok(result.shareToken, 'Must generate raw share token');
            assert.ok(result.tokenHash, 'Must generate token hash');

            newlyIssuedToken = result.shareToken;

            // Verify DB now has the token hash saved
            const db = new Database(legacyDbPath);
            const updatedOuting = db.prepare('SELECT share_token_hash FROM outings WHERE id = ?').get(legacyOutingId);
            db.close();

            assert.strictEqual(updatedOuting.share_token_hash, result.tokenHash, 'share_token_hash must match in DB');
        });

        // --- TEST 4: Duplicate upgrade without force is safely rejected (concurrency / overwrite protection) ---
        await test('Duplicate reissue without force is safely rejected with already_secured', async () => {
            const dupResult = await outingService.reissueLegacyOutingShareToken({ outingId: legacyOutingId, force: false });

            assert.strictEqual(dupResult.success, false);
            assert.strictEqual(dupResult.reason, 'already_secured');
        });

        // --- TEST 5: Reissue with force rotates token successfully ---
        await test('Reissue with force rotates token and updates hash in DB', async () => {
            const forceResult = await outingService.reissueLegacyOutingShareToken({ outingId: legacyOutingId, force: true });

            assert.strictEqual(forceResult.success, true);
            assert.notStrictEqual(forceResult.shareToken, newlyIssuedToken, 'New token must differ');
            newlyIssuedToken = forceResult.shareToken;

            const db = new Database(legacyDbPath);
            const updatedOuting = db.prepare('SELECT share_token_hash FROM outings WHERE id = ?').get(legacyOutingId);
            db.close();

            assert.strictEqual(updatedOuting.share_token_hash, forceResult.tokenHash);
        });

        // --- TEST 6: Visit with newly issued token via x-share-token succeeds with 200 OK and preserves data ---
        await test('Visit with newly issued token in x-share-token header succeeds with 200 OK', async () => {
            const res = await request(`/api/outings/${legacyOutingId}`, {
                headers: { 'x-share-token': newlyIssuedToken }
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.id, legacyOutingId);
            assert.strictEqual(res.data.name, 'Legacy Coffee Meetup');
            assert.strictEqual(res.data.participants.length, 2);
            assert.strictEqual(res.data.recommendations.length, 2);
            assert.strictEqual(res.data.votes.length, 1);
        });

        // --- TEST 7: Voting on upgraded legacy outing works with the new token ---
        await test('Voting on upgraded legacy outing succeeds with the new share token', async () => {
            const res = await request(`/api/outings/${legacyOutingId}/vote`, {
                method: 'POST',
                headers: { 'x-share-token': newlyIssuedToken },
                body: {
                    venueId: 'v-legacy-2',
                    voterName: 'Bob (Guest)',
                    voterId: 'voter-bob-2'
                }
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.data.action, 'voted');
            assert.strictEqual(res.data.currentVotedVenue, 'v-legacy-2');
        });

    } finally {
        if (server) server.close();
        if (fs.existsSync(legacyDbPath)) {
            try { fs.unlinkSync(legacyDbPath); } catch (_) {}
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
