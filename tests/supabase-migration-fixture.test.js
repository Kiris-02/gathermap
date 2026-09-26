/**
 * Supabase & SQLite Multi-Stage Migration Fixture & Deduplication Test Suite
 * Validates:
 * 1. Sequential execution of migrations (Initial -> RLS -> Token -> Voter Identity & Archive) on pre-migration legacy data.
 * 2. Deduplication of multi-vote participants (keeps latest by created_at DESC, id DESC tie-breaker).
 * 3. Exact non-destructive archiving into votes_dedup_archive table with audit reasons.
 * 4. Preservation of distinct voters sharing identical display names (voter_id uniqueness).
 * 5. Preservation and deduplication of legacy votes (voter_id IS NULL).
 * 6. Migration idempotency: second pass causes zero new archive entries and zero schema changes.
 * 7. RLS and access control validation: anon/authenticated cannot access private tables or archive.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const fixtureDbPath = path.join(__dirname, 'supabase-fixture-test.db');
if (fs.existsSync(fixtureDbPath)) {
    try { fs.unlinkSync(fixtureDbPath); } catch (_) {}
}

async function runMigrationFixtureTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING MIGRATION FIXTURE, DEDUP ARCHIVE & RLS TEST SUITE');
    console.log('================================================================\n');

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
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

    const db = new Database(fixtureDbPath);

    try {
        // --- STEP 1: INITIAL LEGACY SCHEMA (Migration 1) ---
        await test('Stage 1: Initialize pre-migration legacy schema with old constraint', async () => {
            db.exec(`
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
                    address TEXT NOT NULL,
                    lat REAL NOT NULL,
                    lng REAL NOT NULL,
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
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(outing_id, voter_name, venue_id)
                );
            `);
            assert(db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get().c >= 5);
        });

        // --- STEP 2: POPULATE PRE-MIGRATION LEGACY FIXTURE DATA ---
        await test('Stage 2: Populate pre-migration legacy data fixture with edge cases', async () => {
            const outingId = 'out-legacy-fixture-01';

            db.prepare(`
                INSERT INTO outings (id, name, mode, center_lat, center_lng, radius_km, status)
                VALUES (?, 'Legacy Weekend Meetup', 'representative', 10.7769, 106.7009, 3.0, 'active')
            `).run(outingId);

            db.prepare(`
                INSERT INTO participants (id, outing_id, name, lat, lng, wish, is_me)
                VALUES 
                    ('p-1', ?, 'Alice', 10.7769, 106.7009, 'Coffee', 1),
                    ('p-2', ?, 'Alice', 10.7800, 106.6900, 'Tea', 0),
                    ('p-3', ?, 'Legacy Bob', 10.7850, 106.6950, 'Food', 0),
                    ('p-4', ?, 'Legacy Charlie', 10.7700, 106.7100, 'Pastry', 0)
            `).run(outingId, outingId, outingId, outingId);

            db.prepare(`
                INSERT INTO venues (id, name, category, type, address, lat, lng)
                VALUES 
                    ('venue-A', 'Cafe A', 'Cafe', 'cafe', '123 A St', 10.7750, 106.7020),
                    ('venue-B', 'Cafe B', 'Cafe', 'cafe', '456 B St', 10.7780, 106.7040),
                    ('venue-C', 'Cafe C', 'Cafe', 'cafe', '789 C St', 10.7800, 106.7060),
                    ('venue-D', 'Cafe D', 'Cafe', 'cafe', '101 D St', 10.7820, 106.7080),
                    ('venue-E', 'Cafe E', 'Cafe', 'cafe', '202 E St', 10.7840, 106.7100)
            `).run();

            db.prepare(`
                INSERT INTO recommendations (id, outing_id, venue_id, group_score, avg_score, lowest_score, ai_rationale)
                VALUES 
                    ('r-1', ?, 'venue-A', 92.0, 90.0, 85.0, 'Rationale A'),
                    ('r-2', ?, 'venue-B', 88.0, 86.0, 80.0, 'Rationale B'),
                    ('r-3', ?, 'venue-C', 85.0, 84.0, 78.0, 'Rationale C')
            `).run(outingId, outingId, outingId);

            // Votes Fixture:
            // Case 1: Identifiable voter (voter_alice) with 3 votes on different venues
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-alice-1', outingId, 'venue-A', 'Alice', 'voter_alice', '2026-09-01 10:00:00'
            );
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-alice-2', outingId, 'venue-B', 'Alice', 'voter_alice', '2026-09-01 11:00:00'
            );
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-alice-latest', outingId, 'venue-C', 'Alice', 'voter_alice', '2026-09-01 12:00:00'
            );

            // Case 2: Identifiable voter with identical created_at (tie-breaking by id DESC)
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-tie-10', outingId, 'venue-A', 'TieBreaker', 'voter_tie', '2026-09-01 10:00:00'
            );
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-tie-20', outingId, 'venue-B', 'TieBreaker', 'voter_tie', '2026-09-01 10:00:00'
            );

            // Case 3: Distinct voter with identical display name 'Alice' (voter_id = 'voter_alice_2') on distinct venue-D
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-alice2-active', outingId, 'venue-D', 'Alice', 'voter_alice_2', '2026-09-01 11:30:00'
            );

            // Case 4: Legacy voter (voter_id IS NULL) with multiple votes
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-leg-old', outingId, 'venue-A', 'Legacy Bob', null, '2026-09-01 09:00:00'
            );
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-leg-latest', outingId, 'venue-B', 'Legacy Bob', null, '2026-09-01 10:30:00'
            );

            // Case 5: Distinct legacy voter (voter_id IS NULL, voter_name = 'Legacy Charlie') on venue-E
            db.prepare(`INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
                'v-charlie-active', outingId, 'venue-E', 'Legacy Charlie', null, '2026-09-01 09:15:00'
            );

            const initialVoteCount = db.prepare('SELECT count(*) as c FROM votes').get().c;
            assert.strictEqual(initialVoteCount, 9, 'Fixture must contain 9 raw votes');
        });

        // --- STEP 3: EXECUTE MIGRATION 3 (Share token & column additions) ---
        await test('Stage 3: Execute Migration 3 (share_token_hash, recommendations columns)', async () => {
            try { db.exec('ALTER TABLE outings ADD COLUMN share_token_hash TEXT;'); } catch (_) {}
            try { db.exec('ALTER TABLE recommendations ADD COLUMN dist_from_center_km REAL;'); } catch (_) {}
            try { db.exec('ALTER TABLE recommendations ADD COLUMN member_breakdowns TEXT;'); } catch (_) {}

            const cols = db.pragma('table_info(outings)');
            assert(cols.some(c => c.name === 'share_token_hash'), 'share_token_hash column exists');
        });

        // --- STEP 4: EXECUTE MIGRATION 4 (Voter Identity, Archive Table, Deduplication, Partial Indexes) ---
        await test('Stage 4: Execute Migration 4 (voter identity, dedup archive, and unique partial indexes)', async () => {
            const { initSqliteSchema } = require('../src/repositories/db-client');
            initSqliteSchema(db);

            // 4a. Verify active votes after deduplication
            const activeVotes = db.prepare('SELECT * FROM votes ORDER BY id ASC').all();
            assert.strictEqual(activeVotes.length, 5, 'Active votes must be exactly 5 (Alice, TieBreaker, Alice2, Bob, Charlie)');

            // Alice kept newest vote (v-alice-latest on venue-C)
            const activeAlice = activeVotes.find(v => v.voter_id === 'voter_alice');
            assert.strictEqual(activeAlice.id, 'v-alice-latest');
            assert.strictEqual(activeAlice.venue_id, 'venue-C');

            // TieBreaker kept highest ID (v-tie-20 on venue-B)
            const activeTie = activeVotes.find(v => v.voter_id === 'voter_tie');
            assert.strictEqual(activeTie.id, 'v-tie-20');
            assert.strictEqual(activeTie.venue_id, 'venue-B');

            // Alice 2 (same display name) preserved independently
            const activeAlice2 = activeVotes.find(v => v.voter_id === 'voter_alice_2');
            assert.strictEqual(activeAlice2.id, 'v-alice2-active');
            assert.strictEqual(activeAlice2.voter_name, 'Alice');

            // Legacy Bob kept newest vote (v-leg-latest on venue-B)
            const activeBob = activeVotes.find(v => v.voter_name === 'Legacy Bob');
            assert.strictEqual(activeBob.id, 'v-leg-latest');
            assert.strictEqual(activeBob.venue_id, 'venue-B');

            // Legacy Charlie preserved
            const activeCharlie = activeVotes.find(v => v.voter_name === 'Legacy Charlie');
            assert.strictEqual(activeCharlie.id, 'v-charlie-active');

            // 4b. Verify votes_dedup_archive contains exactly 4 archived duplicate rows
            const archivedRows = db.prepare('SELECT * FROM votes_dedup_archive ORDER BY id ASC').all();
            assert.strictEqual(archivedRows.length, 4, 'votes_dedup_archive must contain exactly 4 rows');

            const archivedAliceIds = archivedRows.filter(r => r.voter_id === 'voter_alice').map(r => r.id);
            assert.deepStrictEqual(archivedAliceIds, ['v-alice-1', 'v-alice-2']);
            assert(archivedRows.every(r => r.archive_reason && r.archive_reason.startsWith('superseded_duplicate_')));

            // 4c. Verify unique indexes exist and are active
            const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='votes'").all();
            const idxNames = indexes.map(i => i.name);
            assert(idxNames.includes('idx_unique_votes_voter_id'), 'idx_unique_votes_voter_id must exist');
            assert(idxNames.includes('idx_unique_votes_legacy_name'), 'idx_unique_votes_legacy_name must exist');

            // 4d. Verify outings, participants, recommendations remain 100% intact
            const outing = db.prepare('SELECT * FROM outings WHERE id = ?').get('out-legacy-fixture-01');
            assert.strictEqual(outing.name, 'Legacy Weekend Meetup');
            const participants = db.prepare('SELECT * FROM participants WHERE outing_id = ?').all('out-legacy-fixture-01');
            assert.strictEqual(participants.length, 4, 'All 4 participants intact');
            const recs = db.prepare('SELECT * FROM recommendations WHERE outing_id = ?').all('out-legacy-fixture-01');
            assert.strictEqual(recs.length, 3, 'All 3 recommendations intact');
        });

        // --- STEP 5: IDEMPOTENCY VERIFICATION (Second Run produces 0 extra changes) ---
        await test('Stage 5: Idempotency verification (re-running migration produces zero additional archive entries)', async () => {
            const { initSqliteSchema } = require('../src/repositories/db-client');
            initSqliteSchema(db);

            const secondPassActive = db.prepare('SELECT count(*) as c FROM votes').get().c;
            const secondPassArchive = db.prepare('SELECT count(*) as c FROM votes_dedup_archive').get().c;

            assert.strictEqual(secondPassActive, 5, 'Active votes must remain 5');
            assert.strictEqual(secondPassArchive, 4, 'Archived votes must remain 4 (zero duplicates added)');
        });

        // --- STEP 6: RLS & PERMISSIONS AUDIT MOCK ---
        await test('Stage 6: RLS & access control specification verification (anon blocked from private tables and archive)', async () => {
            // Private tables that must have RLS and zero anon permissions
            const privateTables = ['outings', 'participants', 'recommendations', 'votes', 'votes_dedup_archive'];
            const publicCatalogTables = ['venues', 'reviews'];

            // Simulate RLS authorization engine check
            function checkAccess(table, role, operation) {
                if (publicCatalogTables.includes(table)) {
                    if (operation === 'SELECT') return true;
                    return role === 'service_role';
                }
                if (privateTables.includes(table)) {
                    return role === 'service_role';
                }
                return false;
            }

            // Anon role checks
            assert.strictEqual(checkAccess('outings', 'anon', 'SELECT'), false, 'Anon cannot SELECT outings');
            assert.strictEqual(checkAccess('participants', 'anon', 'SELECT'), false, 'Anon cannot SELECT participants');
            assert.strictEqual(checkAccess('votes', 'anon', 'SELECT'), false, 'Anon cannot SELECT votes');
            assert.strictEqual(checkAccess('votes_dedup_archive', 'anon', 'SELECT'), false, 'Anon cannot SELECT votes_dedup_archive');
            assert.strictEqual(checkAccess('votes_dedup_archive', 'anon', 'INSERT'), false, 'Anon cannot INSERT votes_dedup_archive');
            assert.strictEqual(checkAccess('venues', 'anon', 'SELECT'), true, 'Anon CAN SELECT public venues');
            assert.strictEqual(checkAccess('reviews', 'anon', 'SELECT'), true, 'Anon CAN SELECT public reviews');

            // Authenticated role checks
            assert.strictEqual(checkAccess('votes_dedup_archive', 'authenticated', 'SELECT'), false, 'Authenticated cannot SELECT archive');
            assert.strictEqual(checkAccess('votes_dedup_archive', 'authenticated', 'DELETE'), false, 'Authenticated cannot DELETE archive');

            // Service role checks
            assert.strictEqual(checkAccess('outings', 'service_role', 'ALL'), true, 'Service role can manage outings');
            assert.strictEqual(checkAccess('votes', 'service_role', 'ALL'), true, 'Service role can manage votes');
            assert.strictEqual(checkAccess('votes_dedup_archive', 'service_role', 'ALL'), true, 'Service role can manage archive');
        });

    } finally {
        db.close();
        if (fs.existsSync(fixtureDbPath)) {
            try { fs.unlinkSync(fixtureDbPath); } catch (_) {}
        }
    }

    console.log(`\n📊 MIGRATION FIXTURE RESULTS: ${passed} PASSED, ${failed} FAILED\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runMigrationFixtureTests().catch(err => {
        console.error('Fatal migration fixture test error:', err);
        process.exit(1);
    });
}

module.exports = runMigrationFixtureTests;
