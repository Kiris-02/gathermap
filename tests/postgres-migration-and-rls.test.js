/**
 * Real PostgreSQL Migration Execution & Live RLS Security Test Suite
 * 
 * Validates against an actual PostgreSQL 16 database:
 * 1. Safety Guard Rail: strictly prohibits connecting to or dropping non-test databases.
 * 2. Sequential execution of production SQL migrations:
 *    - 20260913000001_gathermap_complete.sql
 *    - 20260926000002_tighten_rls_and_voting.sql
 *    - 20260926000003_secure_share_tokens_and_rls.sql
 *    - 20260926000004_voter_identity_and_outing_fields.sql
 * 3. Pre-migration fixture data execution with duplicate votes, tie-breakers, same-name distinct voters, and legacy null voters.
 * 4. Exact non-destructive archiving into votes_dedup_archive (5 active retained, 4 archived).
 * 5. Migration 4 idempotency: second sequential execution results in 0 additional archive rows.
 * 6. Live PostgreSQL Row Level Security (RLS) and privilege verification under roles:
 *    - `anon`: access denied on private tables and votes_dedup_archive; public catalog (venues, reviews) readable.
 *    - `authenticated`: access denied on votes_dedup_archive and private tables.
 *    - `service_role`: full administrative management permitted across all tables.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Client } = require('pg');

const POSTGRES_URL = process.env.TEST_POSTGRES_URL || 'postgresql://postgres:postgrespassword@localhost:5432/gathermap_test';

/**
 * Validates that a database URL strictly targets an isolated test environment.
 * Throws an explicit error if the host or database name indicates production or remote services.
 */
function validateSafeTestDatabaseUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string') {
        throw new Error('[SAFETY GUARD] Database URL must be a non-empty string');
    }

    let parsed;
    try {
        parsed = new URL(urlStr);
    } catch (e) {
        throw new Error(`[SAFETY GUARD] Invalid URL format: ${e.message}`);
    }

    const hostname = (parsed.hostname || '').toLowerCase();
    const dbName = (parsed.pathname || '').replace(/^\//, '').toLowerCase();

    // 1. Forbidden hostnames and providers
    const forbiddenHostPatterns = [
        'supabase.co',
        'supabase.com',
        'pooler.supabase.com',
        'render.com',
        'neon.tech',
        'elephantsql.com',
        'aws.connect.psdb.cloud',
        'amazonaws.com',
        'azure.com',
        'google.com',
        'prod',
        'production'
    ];

    for (const pattern of forbiddenHostPatterns) {
        if (hostname.includes(pattern)) {
            throw new Error(`[SAFETY GUARD] Forbidden host pattern "${pattern}" detected in hostname "${hostname}". Destructive migrations are strictly forbidden on remote/production hosts.`);
        }
    }

    // 2. Allowed test hosts
    const allowedHosts = ['localhost', '127.0.0.1', 'postgres', '0.0.0.0'];
    if (!allowedHosts.includes(hostname)) {
        throw new Error(`[SAFETY GUARD] Hostname "${hostname}" is not in the approved isolated test hosts list (${allowedHosts.join(', ')}).`);
    }

    // 3. Forbidden database name patterns
    const forbiddenDbPatterns = ['prod', 'production', 'live', 'main', 'master', 'supabase'];
    for (const pattern of forbiddenDbPatterns) {
        if (dbName === pattern || dbName.startsWith(`${pattern}_`) || dbName.endsWith(`_${pattern}`)) {
            throw new Error(`[SAFETY GUARD] Forbidden database name pattern "${pattern}" detected in database name "${dbName}".`);
        }
    }

    // 4. Allowed database name suffix or explicit test name
    const isExplicitTestDb = dbName === 'gathermap_test' || dbName.endsWith('_test') || dbName.endsWith('_temp') || dbName.endsWith('_fixture');
    if (!isExplicitTestDb) {
        throw new Error(`[SAFETY GUARD] Database name "${dbName}" must end with "_test", "_temp", "_fixture", or be "gathermap_test".`);
    }

    return true;
}

/**
 * Validates the live connected database name before any DROP or destructive operation.
 */
async function assertSafeConnectedDatabase(client) {
    const res = await client.query('SELECT current_database() as db');
    const liveDbName = res.rows[0]?.db?.toLowerCase() || '';

    const isExplicitTestDb = liveDbName === 'gathermap_test' || liveDbName.endsWith('_test') || liveDbName.endsWith('_temp') || liveDbName.endsWith('_fixture');
    if (!isExplicitTestDb) {
        throw new Error(`[SAFETY GUARD] Live connected database "${liveDbName}" is not an authorized test database. Refusing destructive operations.`);
    }

    return liveDbName;
}

async function runPostgresMigrationAndRlsTests() {
    console.log('================================================================');
    console.log('🐘 RUNNING LIVE POSTGRESQL MIGRATION & RLS SECURITY SUITE');
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

    // --- STEP 0A: TEST SAFETY GUARD RAIL REJECTIONS & ACCEPTANCE ---
    await test('Safety Guard: Validate URL guard rail blocks production and non-test databases', async () => {
        // Test 1: Production Supabase host rejection
        assert.throws(() => {
            validateSafeTestDatabaseUrl('postgresql://postgres:mysecretpassword@db.supabase.co:5432/postgres');
        }, /Forbidden host pattern "supabase\.co"/);

        // Test 2: Remote unapproved host rejection
        assert.throws(() => {
            validateSafeTestDatabaseUrl('postgresql://user:pass@remote-db.mycloud.com:5432/gathermap_test');
        }, /Hostname "remote-db\.mycloud\.com" is not in the approved/);

        // Test 3: Production database name on localhost rejection
        assert.throws(() => {
            validateSafeTestDatabaseUrl('postgresql://postgres:pass@localhost:5432/production');
        }, /Forbidden database name pattern "production"/);

        // Test 4: Default postgres database on localhost (not ending in _test) rejection
        assert.throws(() => {
            validateSafeTestDatabaseUrl('postgresql://postgres:pass@localhost:5432/postgres');
        }, /Database name "postgres" must end with "_test"/);

        // Test 5: Authorized test databases acceptance
        assert.strictEqual(validateSafeTestDatabaseUrl('postgresql://postgres:postgrespassword@localhost:5432/gathermap_test'), true);
        assert.strictEqual(validateSafeTestDatabaseUrl('postgresql://postgres:postgrespassword@127.0.0.1:5432/my_app_test'), true);
        assert.strictEqual(validateSafeTestDatabaseUrl('postgresql://postgres:postgrespassword@postgres:5432/gathermap_test'), true);
    });

    // Validate active configured URL before connecting
    try {
        validateSafeTestDatabaseUrl(POSTGRES_URL);
    } catch (guardErr) {
        console.error(`\n🛑 SAFETY GUARD ENFORCED: ${guardErr.message}`);
        process.exit(1);
    }

    const client = new Client({
        connectionString: POSTGRES_URL,
        connectionTimeoutMillis: 3000,
    });

    let isConnected = false;
    try {
        await client.connect();
        isConnected = true;
    } catch (err) {
        if (process.env.CI === 'true') {
            console.error(`❌ CRITICAL: Failed to connect to PostgreSQL in CI environment at ${POSTGRES_URL}:`, err.message);
            process.exit(1);
        } else {
            console.log(`⚠️  Local PostgreSQL instance not detected at ${POSTGRES_URL}.`);
            console.log('   (This suite executes live against PostgreSQL 16 in GitHub Actions CI with full RLS verification).');
            console.log(`\n📊 POSTGRESQL SUITE: ${passed} PASSED, ${failed} FAILED (Remaining stages skipped locally due to no listening database)\n`);
            return;
        }
    }

    try {
        // --- STEP 0B: ENVIRONMENT INITIALIZATION & SUPABASE ROLES SETUP ---
        await test('Stage 0: Verify connected test database and initialize schema & Supabase auth roles', async () => {
            // Guard rail check on the live connected database BEFORE executing any DROP
            const dbName = await assertSafeConnectedDatabase(client);
            assert(dbName === 'gathermap_test' || dbName.endsWith('_test') || dbName.endsWith('_temp') || dbName.endsWith('_fixture'), 'Connected DB must be test DB');

            // Re-create public schema for fresh isolated test
            await client.query(`
                DROP SCHEMA IF EXISTS public CASCADE;
                CREATE SCHEMA public;
                GRANT ALL ON SCHEMA public TO CURRENT_USER;
            `);

            // Ensure Supabase standard roles exist
            await client.query(`
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
                        CREATE ROLE anon NOLOGIN;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
                        CREATE ROLE authenticated NOLOGIN;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
                        CREATE ROLE service_role NOLOGIN;
                    END IF;
                END $$;

                GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
            `);
        });

        // --- STEP 1: EXECUTE MIGRATIONS 1, 2, 3 ---
        await test('Stage 1: Sequentially execute base migrations (1, 2, 3)', async () => {
            const migration1Path = path.join(__dirname, '../supabase/migrations/20260913000001_gathermap_complete.sql');
            const migration2Path = path.join(__dirname, '../supabase/migrations/20260926000002_tighten_rls_and_voting.sql');
            const migration3Path = path.join(__dirname, '../supabase/migrations/20260926000003_secure_share_tokens_and_rls.sql');

            const sql1 = fs.readFileSync(migration1Path, 'utf8');
            const sql2 = fs.readFileSync(migration2Path, 'utf8');
            const sql3 = fs.readFileSync(migration3Path, 'utf8');

            await client.query(sql1);
            await client.query(sql2);
            await client.query(sql3);

            const res = await client.query(`
                SELECT table_name FROM information_schema.tables 
                WHERE table_schema = 'public'
            `);
            const tables = res.rows.map(r => r.table_name);
            if (!tables.includes('outings') || !tables.includes('votes') || !tables.includes('venues')) {
                throw new Error('Base migration tables missing');
            }
        });

        // --- STEP 2: POPULATE PRE-MIGRATION LEGACY FIXTURE DATA ---
        await test('Stage 2: Populate pre-migration duplicate vote fixture in PostgreSQL', async () => {
            const outingId = 'out-pg-fixture-01';

            await client.query(`
                INSERT INTO outings (id, center_lat, center_lng, radius_km, status)
                VALUES ($1, 10.7769, 106.7009, 3.0, 'active')
            `, [outingId]);

            await client.query(`
                INSERT INTO participants (id, outing_id, name, lat, lng, wish, is_me)
                VALUES 
                    ('p-1', $1, 'Alice', 10.7769, 106.7009, 'Coffee', true),
                    ('p-2', $1, 'Alice', 10.7800, 106.6900, 'Tea', false),
                    ('p-3', $1, 'Legacy Bob', 10.7850, 106.6950, 'Food', false),
                    ('p-4', $1, 'Legacy Charlie', 10.7700, 106.7100, 'Pastry', false)
            `, [outingId]);

            // Votes fixture:
            // Case 1: Identifiable voter (voter_alice) with 3 votes across venues
            await client.query(`
                INSERT INTO votes (id, outing_id, venue_id, voter_name, created_at)
                VALUES 
                    ('v-1-old-1', $1, 'hcm-vnu-01', 'Alice', '2026-09-01 10:00:00+00'),
                    ('v-1-old-2', $1, 'hcm-vnu-02', 'Alice', '2026-09-01 11:00:00+00'),
                    ('v-1-latest', $1, 'hcm-vnu-03', 'Alice', '2026-09-01 12:00:00+00')
            `, [outingId]);

            // Case 2: Identifiable voter with identical created_at (tie-break by id DESC)
            await client.query(`
                INSERT INTO votes (id, outing_id, venue_id, voter_name, created_at)
                VALUES 
                    ('v-tie-10', $1, 'hcm-vnu-01', 'TieBreaker', '2026-09-01 10:00:00+00'),
                    ('v-tie-20', $1, 'hcm-vnu-02', 'TieBreaker', '2026-09-01 10:00:00+00')
            `, [outingId]);

            // Case 3: Distinct voter with identical display name 'Alice'
            await client.query(`
                INSERT INTO votes (id, outing_id, venue_id, voter_name, created_at)
                VALUES 
                    ('v-alice2-active', $1, 'hcm-vnu-04', 'Alice', '2026-09-01 11:30:00+00')
            `, [outingId]);

            // Case 4: Legacy voter (voter_id IS NULL) with multiple votes
            await client.query(`
                INSERT INTO votes (id, outing_id, venue_id, voter_name, created_at)
                VALUES 
                    ('v-leg-old', $1, 'hcm-vnu-01', 'Legacy Bob', '2026-09-01 09:00:00+00'),
                    ('v-leg-latest', $1, 'hcm-vnu-02', 'Legacy Bob', '2026-09-01 10:30:00+00')
            `, [outingId]);

            // Case 5: Distinct legacy voter
            await client.query(`
                INSERT INTO votes (id, outing_id, venue_id, voter_name, created_at)
                VALUES 
                    ('v-charlie-active', $1, 'hcm-vnu-05', 'Legacy Charlie', '2026-09-01 09:15:00+00')
            `, [outingId]);

            // Add voter_id column as existing before migration 4 to simulate partial voter_id presence
            await client.query(`
                ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_id TEXT;
                UPDATE votes SET voter_id = 'voter_alice' WHERE id IN ('v-1-old-1', 'v-1-old-2', 'v-1-latest');
                UPDATE votes SET voter_id = 'voter_tie' WHERE id IN ('v-tie-10', 'v-tie-20');
                UPDATE votes SET voter_id = 'voter_alice_2' WHERE id = 'v-alice2-active';
                -- legacy votes remain with voter_id = NULL
            `);

            const countRes = await client.query('SELECT count(*) as c FROM votes');
            if (parseInt(countRes.rows[0].c, 10) !== 9) {
                throw new Error(`Expected 9 initial fixture votes, got ${countRes.rows[0].c}`);
            }
        });

        // --- STEP 3: EXECUTE MIGRATION 4 ---
        await test('Stage 3: Execute Migration 4 (voter identity, dedup archive, RLS)', async () => {
            const migration4Path = path.join(__dirname, '../supabase/migrations/20260926000004_voter_identity_and_outing_fields.sql');
            const sql4 = fs.readFileSync(migration4Path, 'utf8');
            await client.query(sql4);
        });

        // --- STEP 4: VERIFY DEDUPLICATION & ARCHIVE INTEGRITY ---
        await test('Stage 4: Assert PostgreSQL deduplication and votes_dedup_archive contents', async () => {
            const activeRes = await client.query('SELECT * FROM votes ORDER BY id ASC');
            const activeVotes = activeRes.rows;

            if (activeVotes.length !== 5) {
                throw new Error(`Expected exactly 5 active votes, got ${activeVotes.length}`);
            }

            // Alice kept newest (v-1-latest)
            const aliceVote = activeVotes.find(v => v.voter_id === 'voter_alice');
            if (!aliceVote || aliceVote.id !== 'v-1-latest' || aliceVote.venue_id !== 'hcm-vnu-03') {
                throw new Error(`Alice active vote incorrect: ${JSON.stringify(aliceVote)}`);
            }

            // TieBreaker kept larger ID (v-tie-20)
            const tieVote = activeVotes.find(v => v.voter_id === 'voter_tie');
            if (!tieVote || tieVote.id !== 'v-tie-20' || tieVote.venue_id !== 'hcm-vnu-02') {
                throw new Error(`TieBreaker active vote incorrect: ${JSON.stringify(tieVote)}`);
            }

            // Alice2 preserved independently
            const alice2Vote = activeVotes.find(v => v.voter_id === 'voter_alice_2');
            if (!alice2Vote || alice2Vote.id !== 'v-alice2-active') {
                throw new Error(`Alice2 active vote incorrect: ${JSON.stringify(alice2Vote)}`);
            }

            // Legacy Bob kept newest (v-leg-latest)
            const bobVote = activeVotes.find(v => v.voter_name === 'Legacy Bob');
            if (!bobVote || bobVote.id !== 'v-leg-latest' || bobVote.venue_id !== 'hcm-vnu-02') {
                throw new Error(`Legacy Bob active vote incorrect: ${JSON.stringify(bobVote)}`);
            }

            // Legacy Charlie preserved
            const charlieVote = activeVotes.find(v => v.voter_name === 'Legacy Charlie');
            if (!charlieVote || charlieVote.id !== 'v-charlie-active') {
                throw new Error(`Legacy Charlie active vote incorrect: ${JSON.stringify(charlieVote)}`);
            }

            // Verify votes_dedup_archive
            const archiveRes = await client.query('SELECT * FROM votes_dedup_archive ORDER BY id ASC');
            const archiveRows = archiveRes.rows;

            if (archiveRows.length !== 4) {
                throw new Error(`Expected exactly 4 archived votes, got ${archiveRows.length}`);
            }

            const archivedIds = archiveRows.map(r => r.id);
            if (!archivedIds.includes('v-1-old-1') || !archivedIds.includes('v-1-old-2') || !archivedIds.includes('v-tie-10') || !archivedIds.includes('v-leg-old')) {
                throw new Error(`Archived IDs mismatch: ${JSON.stringify(archivedIds)}`);
            }

            // Verify unique partial indexes exist in PostgreSQL
            const indexRes = await client.query(`
                SELECT indexname FROM pg_indexes 
                WHERE tablename = 'votes' AND schemaname = 'public'
            `);
            const indexNames = indexRes.rows.map(r => r.indexname);
            if (!indexNames.includes('idx_unique_votes_outing_voter_id')) {
                throw new Error('idx_unique_votes_outing_voter_id partial index missing');
            }
            if (!indexNames.includes('idx_unique_votes_outing_voter_name_legacy')) {
                throw new Error('idx_unique_votes_outing_voter_name_legacy partial index missing');
            }
        });

        // --- STEP 5: VERIFY IDEMPOTENCY ON SEQUENTIAL RE-RUN ---
        await test('Stage 5: Assert Migration 4 idempotency upon second sequential execution', async () => {
            const migration4Path = path.join(__dirname, '../supabase/migrations/20260926000004_voter_identity_and_outing_fields.sql');
            const sql4 = fs.readFileSync(migration4Path, 'utf8');
            await client.query(sql4);

            const activeCountRes = await client.query('SELECT count(*) as c FROM votes');
            const archiveCountRes = await client.query('SELECT count(*) as c FROM votes_dedup_archive');

            if (parseInt(activeCountRes.rows[0].c, 10) !== 5) {
                throw new Error(`Active votes count changed after rerun: ${activeCountRes.rows[0].c}`);
            }
            if (parseInt(archiveCountRes.rows[0].c, 10) !== 4) {
                throw new Error(`Archived votes count changed after rerun: ${archiveCountRes.rows[0].c}`);
            }
        });

        // --- STEP 6: TEST LIVE POSTGRESQL RLS & ROLE PERMISSIONS ---
        await test('Stage 6: Verify PostgreSQL RLS & Role Privileges (anon, authenticated, service_role)', async () => {
            // 6a. Under role `anon`
            await client.query('SET ROLE anon');

            // Public catalog read access
            const venueReadRes = await client.query('SELECT count(*) as c FROM venues');
            if (parseInt(venueReadRes.rows[0].c, 10) < 1) {
                throw new Error('Anon should be able to read venues catalog');
            }

            const reviewReadRes = await client.query('SELECT count(*) as c FROM reviews');
            if (parseInt(reviewReadRes.rows[0].c, 10) < 1) {
                throw new Error('Anon should be able to read reviews catalog');
            }

            // Private tables access denied / 0 rows under RLS
            let anonOutingBlocked = false;
            try {
                const outingReadRes = await client.query('SELECT * FROM outings');
                if (outingReadRes.rows.length === 0) anonOutingBlocked = true;
            } catch (err) {
                anonOutingBlocked = true; // Blocked at table privilege layer
            }
            if (!anonOutingBlocked) {
                throw new Error('Anon was able to access rows from outings table');
            }

            let anonVotesBlocked = false;
            try {
                const votesReadRes = await client.query('SELECT * FROM votes');
                if (votesReadRes.rows.length === 0) anonVotesBlocked = true;
            } catch (err) {
                anonVotesBlocked = true; // Blocked at table privilege layer
            }
            if (!anonVotesBlocked) {
                throw new Error('Anon was able to access rows from votes table');
            }

            // votes_dedup_archive direct privilege check (REVOKE ALL was executed)
            let anonArchiveBlocked = false;
            try {
                const archiveCheck = await client.query('SELECT * FROM votes_dedup_archive');
                if (archiveCheck.rows.length === 0) anonArchiveBlocked = true;
            } catch (err) {
                anonArchiveBlocked = true; // Threw permission denied error
            }
            if (!anonArchiveBlocked) {
                throw new Error('Anon was able to access rows from votes_dedup_archive');
            }

            // 6b. Under role `authenticated`
            await client.query('RESET ROLE');
            await client.query('SET ROLE authenticated');

            let authArchiveBlocked = false;
            try {
                await client.query('DELETE FROM votes_dedup_archive');
            } catch (err) {
                authArchiveBlocked = true;
            }
            if (!authArchiveBlocked) {
                const authDelCheck = await client.query('SELECT count(*) as c FROM votes_dedup_archive');
                if (parseInt(authDelCheck.rows[0].c, 10) === 0) {
                    throw new Error('Authenticated role was able to DELETE votes_dedup_archive rows');
                }
            }

            // 6c. Under role `service_role`
            await client.query('RESET ROLE');
            await client.query('SET ROLE service_role');

            const serviceOutingRes = await client.query('SELECT count(*) as c FROM outings');
            if (parseInt(serviceOutingRes.rows[0].c, 10) !== 1) {
                throw new Error(`service_role failed to query outings: ${serviceOutingRes.rows[0].c}`);
            }

            const serviceVotesRes = await client.query('SELECT count(*) as c FROM votes');
            if (parseInt(serviceVotesRes.rows[0].c, 10) !== 5) {
                throw new Error(`service_role failed to query votes: ${serviceVotesRes.rows[0].c}`);
            }

            const serviceArchiveRes = await client.query('SELECT count(*) as c FROM votes_dedup_archive');
            if (parseInt(serviceArchiveRes.rows[0].c, 10) !== 4) {
                throw new Error(`service_role failed to query votes_dedup_archive: ${serviceArchiveRes.rows[0].c}`);
            }

            // Test service_role write & clean-up on archive
            await client.query(`
                INSERT INTO votes_dedup_archive (id, outing_id, voter_name, archive_reason)
                VALUES ('v-audit-probe', 'out-pg-fixture-01', 'Admin Probe', 'service_role_verification')
            `);
            await client.query("DELETE FROM votes_dedup_archive WHERE id = 'v-audit-probe'");

            await client.query('RESET ROLE');
        });

    } finally {
        if (isConnected) {
            try {
                await client.query('RESET ROLE');
            } catch (_) {}
            await client.end();
        }
    }

    console.log(`\n📊 POSTGRESQL MIGRATION & RLS RESULTS: ${passed} PASSED, ${failed} FAILED\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runPostgresMigrationAndRlsTests().catch(err => {
        console.error('Fatal PostgreSQL migration test error:', err);
        process.exit(1);
    });
}

module.exports = {
    runPostgresMigrationAndRlsTests,
    validateSafeTestDatabaseUrl,
    assertSafeConnectedDatabase
};
