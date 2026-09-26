/**
 * Supabase & SQLite Outing Overwrite Prevention and Error Propagation Test Suite
 * Validates that saveOuting() never clobbers coordinates, name, or mode on existing outings,
 * and that errors from Supabase are never swallowed.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const testDbPath = path.join(__dirname, 'overwrite-prevention.test.db');
if (fs.existsSync(testDbPath)) {
    try { fs.unlinkSync(testDbPath); } catch (_) {}
}
process.env.SQLITE_DB_PATH = testDbPath;

const outingRepository = require('../src/repositories/outing-repository');

async function runOverwriteTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING OUTING OVERWRITE PREVENTION & SUPABASE ERROR TESTS');
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

    // 1. SQLite Overwrite Prevention
    await test('SQLite: saveOuting() preserves custom center, radius, and name on duplicate saves', async () => {
        const outingId = 'EAT-SQLITE-PRESERVE';
        // Initial creation
        await outingRepository.saveOuting({
            id: outingId,
            name: 'Original Hangout',
            mode: 'representative',
            centerLat: 10.7325,
            centerLng: 106.7118,
            radiusKm: 4.5,
            shareTokenHash: 'hash123'
        });

        // Duplicate save with default or different coordinates
        await outingRepository.saveOuting({
            id: outingId,
            name: 'Overwritten Name?',
            mode: 'dictator',
            centerLat: 10.7769,
            centerLng: 106.7009,
            radiusKm: 3.0,
            shareTokenHash: 'hash123'
        });

        const sqliteDb = new Database(testDbPath);
        const row = sqliteDb.prepare('SELECT * FROM outings WHERE id = ?').get(outingId);
        sqliteDb.close();

        assert.strictEqual(row.name, 'Original Hangout', 'Name must not be overwritten');
        assert.strictEqual(row.mode, 'representative', 'Mode must not be overwritten');
        assert.strictEqual(Number(row.center_lat.toFixed(4)), 10.7325, 'center_lat must not be overwritten');
        assert.strictEqual(Number(row.center_lng.toFixed(4)), 106.7118, 'center_lng must not be overwritten');
        assert.strictEqual(Number(row.radius_km), 4.5, 'radius_km must not be overwritten');
    });

    // 2. Dedicated updateOutingSettings
    await test('SQLite: updateOutingSettings() updates only when explicitly requested', async () => {
        const outingId = 'EAT-SQLITE-UPDATE';
        await outingRepository.saveOuting({
            id: outingId,
            name: 'Before Update',
            mode: 'representative',
            centerLat: 10.7000,
            centerLng: 106.7000,
            radiusKm: 2.0,
            shareTokenHash: 'hash456'
        });

        await outingRepository.updateOutingSettings(outingId, {
            name: 'After Update',
            radiusKm: 5.0
        });

        const sqliteDb = new Database(testDbPath);
        const row = sqliteDb.prepare('SELECT * FROM outings WHERE id = ?').get(outingId);
        sqliteDb.close();

        assert.strictEqual(row.name, 'After Update', 'Name should be updated');
        assert.strictEqual(Number(row.radius_km), 5.0, 'radius_km should be updated');
        assert.strictEqual(Number(row.center_lat.toFixed(4)), 10.7000, 'center_lat should remain intact');
    });

    // 3. Supabase Mock Overwrite Prevention & Error Propagation
    await test('Supabase Mock: saveOuting() checks existing and never overwrites existing outing coordinates', async () => {
        const calls = [];
        const mockSupabase = {
            from: (table) => {
                if (table === 'outings') {
                    return {
                        select: (cols) => ({
                            eq: (field, val) => ({
                                maybeSingle: async () => {
                                    calls.push({ op: 'select', field, val });
                                    // Return existing outing
                                    return {
                                        data: {
                                            id: val,
                                            name: 'Existing Supabase Outing',
                                            center_lat: 10.8200,
                                            center_lng: 106.6500,
                                            radius_km: 5.0,
                                            share_token_hash: 'existing_hash'
                                        },
                                        error: null
                                    };
                                }
                            })
                        }),
                        insert: (records) => {
                            calls.push({ op: 'insert', records });
                            return { error: null };
                        },
                        update: (patch) => ({
                            eq: (field, val) => {
                                calls.push({ op: 'update', patch, field, val });
                                return { error: null };
                            }
                        })
                    };
                }
            }
        };

        // Temporarily inject mock into db-client
        const dbClient = require('../src/repositories/db-client');
        const origGetSupabaseClient = dbClient.getSupabaseClient;
        const origIsSupabaseConfigured = dbClient.isSupabaseConfigured;

        try {
            dbClient.getSupabaseClient = () => mockSupabase;
            dbClient.isSupabaseConfigured = true;

            await outingRepository.saveOuting({
                id: 'EAT-MOCK-SUPABASE',
                name: 'Attempted Overwrite',
                centerLat: 10.7769,
                centerLng: 106.7009,
                radiusKm: 3.0,
                shareTokenHash: 'existing_hash'
            });

            // Verify that insert was NOT called (because outing already existed)
            const insertCalls = calls.filter(c => c.op === 'insert');
            assert.strictEqual(insertCalls.length, 0, 'Must NOT insert over existing Supabase outing');

            // Verify that update was NOT called to change coordinates
            const updateCalls = calls.filter(c => c.op === 'update' && c.patch.center_lat !== undefined);
            assert.strictEqual(updateCalls.length, 0, 'Must NOT update coordinates on existing Supabase outing');
        } finally {
            dbClient.getSupabaseClient = origGetSupabaseClient;
            dbClient.isSupabaseConfigured = origIsSupabaseConfigured;
        }
    });

    // 4. Supabase Error Propagation (No Error Swallowing)
    await test('Supabase Mock: saveOuting() propagates database error instead of swallowing', async () => {
        const mockFailingSupabase = {
            from: (table) => ({
                select: () => ({
                    eq: () => ({
                        maybeSingle: async () => ({
                            data: null,
                            error: { message: 'Database connection terminated' }
                        })
                    })
                })
            })
        };

        const dbClient = require('../src/repositories/db-client');
        const origGetSupabaseClient = dbClient.getSupabaseClient;
        const origIsConfigured = dbClient.isSupabaseConfigured;

        try {
            dbClient.getSupabaseClient = () => mockFailingSupabase;
            dbClient.isSupabaseConfigured = true;

            let errorThrown = false;
            try {
                await outingRepository.saveOuting({
                    id: 'EAT-FAIL-TEST',
                    centerLat: 10.7769,
                    centerLng: 106.7009,
                    radiusKm: 3.0
                });
            } catch (err) {
                errorThrown = true;
                assert(err.message.includes('Database connection terminated'), 'Error must contain Supabase error message');
            }
            assert.strictEqual(errorThrown, true, 'saveOuting must throw on Supabase error');
        } finally {
            dbClient.getSupabaseClient = origGetSupabaseClient;
            dbClient.isSupabaseConfigured = origIsConfigured;
        }
    });

    console.log(`\n📊 OVERWRITE PREVENTION SUMMARY: ${passed} PASSED, ${failed} FAILED\n`);

    try { fs.unlinkSync(testDbPath); } catch (_) {}

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runOverwriteTests().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = runOverwriteTests;
