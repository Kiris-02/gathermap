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
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

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

    // 5. Voting Lifecycle & Outing Metadata Protection on Supabase
    await test('Supabase Mock: recordVote() touches ONLY votes table and never mutates outings metadata', async () => {
        const tableCalls = { outings: [], venues: [], votes: [] };
        let mockVotesInDb = [];

        const mockVotingSupabase = {
            from: (table) => {
                if (table === 'outings') {
                    return {
                        select: (cols) => ({
                            eq: (field, val) => ({
                                maybeSingle: async () => {
                                    tableCalls.outings.push({ op: 'select', field, val });
                                    return { data: { id: val }, error: null };
                                }
                            })
                        }),
                        upsert: (records) => {
                            tableCalls.outings.push({ op: 'upsert', records });
                            return { error: null };
                        },
                        update: (patch) => ({
                            eq: (field, val) => {
                                tableCalls.outings.push({ op: 'update', patch, field, val });
                                return { error: null };
                            }
                        })
                    };
                }
                if (table === 'venues') {
                    return {
                        upsert: (records) => {
                            tableCalls.venues.push({ op: 'upsert', records });
                            return { error: null };
                        }
                    };
                }
                if (table === 'votes') {
                    return {
                        select: (cols) => ({
                            eq: (field, val) => {
                                tableCalls.votes.push({ op: 'select', field, val });
                                const matched = mockVotesInDb.filter(v => v[field] === val);
                                const chain = {
                                    data: matched,
                                    error: null,
                                    eq: (f2, v2) => ({
                                        data: matched.filter(v => v[f2] === v2),
                                        error: null
                                    })
                                };
                                return chain;
                            }
                        }),
                        insert: (records) => {
                            tableCalls.votes.push({ op: 'insert', records });
                            mockVotesInDb.push(...records);
                            return { error: null };
                        },
                        update: (patch) => ({
                            eq: (f1, v1) => {
                                tableCalls.votes.push({ op: 'update', patch, f1, v1 });
                                mockVotesInDb = mockVotesInDb.map(v => {
                                    if (v[f1] === v1) return { ...v, ...patch };
                                    return v;
                                });
                                return { error: null };
                            }
                        }),
                        delete: () => ({
                            eq: (f1, v1) => {
                                tableCalls.votes.push({ op: 'delete', f1, v1 });
                                mockVotesInDb = mockVotesInDb.filter(v => v[f1] !== v1);
                                return { error: null };
                            }
                        })
                    };
                }
            }
        };

        const dbClient = require('../src/repositories/db-client');
        const origGetSupabaseClient = dbClient.getSupabaseClient;
        const origIsConfigured = dbClient.isSupabaseConfigured;

        try {
            dbClient.getSupabaseClient = () => mockVotingSupabase;
            dbClient.isSupabaseConfigured = true;

            const voteOutingId = 'EAT-VOTE-ISOLATION';

            // 5a. New Vote
            const res1 = await outingRepository.recordVote(voteOutingId, 'venue-a', 'Alice', 'v-alice');
            assert.strictEqual(res1.action, 'voted');
            assert.strictEqual(res1.currentVotedVenue, 'venue-a');

            // Assert outings table was verified via SELECT but NEVER mutated via upsert or update
            const outingMutations1 = tableCalls.outings.filter(c => c.op === 'upsert' || c.op === 'update' || c.op === 'insert');
            assert.strictEqual(outingMutations1.length, 0, 'Must NOT mutate outings table on new vote');

            // 5b. Change Vote (to venue-b) via atomic in-place UPDATE
            const res2 = await outingRepository.recordVote(voteOutingId, 'venue-b', 'Alice', 'v-alice');
            assert.strictEqual(res2.action, 'changed');
            assert.strictEqual(res2.currentVotedVenue, 'venue-b');

            const voteUpdates = tableCalls.votes.filter(c => c.op === 'update');
            assert.strictEqual(voteUpdates.length, 1, 'Must use in-place atomic UPDATE for vote changes');

            const outingMutations2 = tableCalls.outings.filter(c => c.op === 'upsert' || c.op === 'update' || c.op === 'insert');
            assert.strictEqual(outingMutations2.length, 0, 'Must NOT mutate outings table on vote change');

            // 5c. Toggle / Retract Vote (unvote venue-b)
            const res3 = await outingRepository.recordVote(voteOutingId, 'venue-b', 'Alice', 'v-alice');
            assert.strictEqual(res3.action, 'unvoted');
            assert.strictEqual(res3.currentVotedVenue, null);

            const outingMutations3 = tableCalls.outings.filter(c => c.op === 'upsert' || c.op === 'update' || c.op === 'insert');
            assert.strictEqual(outingMutations3.length, 0, 'Must NOT mutate outings table on vote retraction');
        } finally {
            dbClient.getSupabaseClient = origGetSupabaseClient;
            dbClient.isSupabaseConfigured = origIsConfigured;
        }
    });

    // 6. Supabase Error Propagation on Voting
    await test('Supabase Mock: recordVote() propagates Supabase errors without swallowing', async () => {
        const mockFailingVotingSupabase = {
            from: (table) => {
                if (table === 'outings') {
                    return {
                        select: () => ({
                            eq: () => ({
                                maybeSingle: async () => ({
                                    data: null,
                                    error: { message: 'Outings table RLS permission denied' }
                                })
                            })
                        })
                    };
                }
                return {
                    upsert: async () => ({ error: null }),
                    insert: async () => ({ error: { message: 'Insert vote permission denied' } }),
                    delete: () => ({ eq: () => ({ eq: async () => ({ error: { message: 'Delete vote error' } }) }) })
                };
            }
        };

        const dbClient = require('../src/repositories/db-client');
        const origGetSupabaseClient = dbClient.getSupabaseClient;
        const origIsConfigured = dbClient.isSupabaseConfigured;

        try {
            dbClient.getSupabaseClient = () => mockFailingVotingSupabase;
            dbClient.isSupabaseConfigured = true;

            let errorThrown = false;
            try {
                await outingRepository.recordVote('EAT-FAIL-VOTE', 'venue-x', 'Hacker', 'v-hacker');
            } catch (err) {
                errorThrown = true;
                assert(err.message.includes('Outings table RLS permission denied'), 'Must propagate exact Supabase error message');
            }
            assert.strictEqual(errorThrown, true, 'recordVote must throw when Supabase operation fails');
        } finally {
            dbClient.getSupabaseClient = origGetSupabaseClient;
            dbClient.isSupabaseConfigured = origIsConfigured;
        }
    });

    // 7. Test A: Supabase same-name independent voters (voter_A vs voter_B with voter_name = "You")
    await test('Test A: Supabase same-name independent voters (voter_A vs voter_B with name "You")', async () => {
        let mockVotesTable = [];
        const mockSupabase = {
            from: (table) => {
                if (table === 'outings') {
                    return {
                        select: () => ({
                            eq: (f, v) => ({
                                maybeSingle: async () => ({ data: { id: v }, error: null })
                            })
                        })
                    };
                }
                if (table === 'venues') {
                    return {
                        upsert: async () => ({ error: null })
                    };
                }
                if (table === 'votes') {
                    return {
                        select: () => ({
                            eq: (field, val) => {
                                const matched = mockVotesTable.filter(v => v[field] === val);
                                return {
                                    data: matched,
                                    error: null,
                                    eq: (f2, v2) => ({
                                        data: matched.filter(v => v[f2] === v2),
                                        error: null
                                    })
                                };
                            }
                        }),
                        insert: async (records) => {
                            mockVotesTable.push(...records);
                            return { error: null };
                        },
                        update: (patch) => ({
                            eq: async (f1, v1) => {
                                mockVotesTable = mockVotesTable.map(v => {
                                    if (v[f1] === v1) return { ...v, ...patch };
                                    return v;
                                });
                                return { error: null };
                            }
                        }),
                        delete: () => ({
                            eq: (f1, v1) => {
                                mockVotesTable = mockVotesTable.filter(v => v[f1] !== v1);
                                return { error: null };
                            }
                        })
                    };
                }
            }
        };

        const dbClient = require('../src/repositories/db-client');
        const origGetSupabaseClient = dbClient.getSupabaseClient;
        const origIsConfigured = dbClient.isSupabaseConfigured;

        try {
            dbClient.getSupabaseClient = () => mockSupabase;
            dbClient.isSupabaseConfigured = true;

            const outingId = 'EAT-INDEPENDENT-VOTERS';

            // 1. Both voter_A and voter_B (both named "You") vote for venue-1
            const resA1 = await outingRepository.recordVote(outingId, 'venue-1', 'You', 'voter_A');
            assert.strictEqual(resA1.action, 'voted');
            assert.strictEqual(resA1.currentVotedVenue, 'venue-1');

            const resB1 = await outingRepository.recordVote(outingId, 'venue-1', 'You', 'voter_B');
            assert.strictEqual(resB1.action, 'voted');
            assert.strictEqual(resB1.currentVotedVenue, 'venue-1');

            // 2. Verify two independent votes exist in Supabase
            assert.strictEqual(mockVotesTable.length, 2, 'Supabase must contain exactly 2 votes');
            const voteA = mockVotesTable.find(v => v.voter_id === 'voter_A');
            const voteB = mockVotesTable.find(v => v.voter_id === 'voter_B');
            assert(voteA && voteA.venue_id === 'venue-1', 'voter_A vote must exist on venue-1');
            assert(voteB && voteB.venue_id === 'venue-1', 'voter_B vote must exist on venue-1');

            // 3. voter_A changes venue to venue-2
            const resA2 = await outingRepository.recordVote(outingId, 'venue-2', 'You', 'voter_A');
            assert.strictEqual(resA2.action, 'changed');
            assert.strictEqual(resA2.currentVotedVenue, 'venue-2');

            // 4. voter_B remains untouched on venue-1
            assert.strictEqual(mockVotesTable.length, 2, 'Supabase must still have 2 votes');
            const updatedVoteA = mockVotesTable.find(v => v.voter_id === 'voter_A');
            const intactVoteB = mockVotesTable.find(v => v.voter_id === 'voter_B');
            assert.strictEqual(updatedVoteA.venue_id, 'venue-2', 'voter_A should now be on venue-2');
            assert.strictEqual(intactVoteB.venue_id, 'venue-1', 'voter_B must remain untouched on venue-1');

            // 5. voter_A toggles off (unvotes venue-2)
            const resA3 = await outingRepository.recordVote(outingId, 'venue-2', 'You', 'voter_A');
            assert.strictEqual(resA3.action, 'unvoted');
            assert.strictEqual(resA3.currentVotedVenue, null);

            // 6. voter_B still remains
            assert.strictEqual(mockVotesTable.length, 1, 'Supabase must now contain only voter_B');
            assert.strictEqual(mockVotesTable[0].voter_id, 'voter_B', 'Remaining vote must be voter_B');
            assert.strictEqual(mockVotesTable[0].venue_id, 'venue-1', 'voter_B vote must still be for venue-1');

            // 7. Supabase records persist voter_id
            assert.strictEqual(mockVotesTable[0].voter_name, 'You', 'Display name is You');
            assert.strictEqual(mockVotesTable[0].voter_id, 'voter_B', 'voter_id is preserved');
        } finally {
            dbClient.getSupabaseClient = origGetSupabaseClient;
            dbClient.isSupabaseConfigured = origIsConfigured;
        }
    });

    // 8. Test B: Remote-only legacy token reissue
    await test('Test B: Remote-only legacy token reissue (outing in Supabase, missing in SQLite)', async () => {
        let remoteOutings = [
            {
                id: 'EAT-REMOTE-ONLY',
                name: 'Legacy Cloud Outing',
                center_lat: 10.7769,
                center_lng: 106.7009,
                radius_km: 3.0,
                status: 'active',
                share_token_hash: null,
                created_at: new Date().toISOString()
            }
        ];

        const mockSupabase = {
            from: (table) => {
                if (table === 'outings') {
                    return {
                        select: (cols) => ({
                            eq: (f, v) => ({
                                maybeSingle: async () => {
                                    const found = remoteOutings.find(o => o[f] === v);
                                    return { data: found || null, error: null };
                                }
                            })
                        }),
                        update: (patch) => ({
                            eq: (f1, v1) => ({
                                is: (f2, v2) => ({
                                    select: async (selCol) => {
                                        let affected = 0;
                                        remoteOutings = remoteOutings.map(o => {
                                            if (o[f1] === v1 && (v2 === null ? (o[f2] === null || o[f2] === undefined) : o[f2] === v2)) {
                                                affected++;
                                                return { ...o, ...patch };
                                            }
                                            return o;
                                        });
                                        return { data: affected > 0 ? [{ id: v1 }] : [], error: null };
                                    }
                                }),
                                select: async (selCol) => {
                                    let affected = 0;
                                    remoteOutings = remoteOutings.map(o => {
                                        if (o[f1] === v1) {
                                            affected++;
                                            return { ...o, ...patch };
                                        }
                                        return o;
                                    });
                                    return { data: affected > 0 ? [{ id: v1 }] : [], error: null };
                                }
                            })
                        })
                    };
                }
                if (table === 'participants') return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
                if (table === 'recommendations') return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) };
                if (table === 'votes') return { select: () => ({ eq: async () => ({ data: [], error: null }) }) };
            }
        };

        const { reissueLegacyOutingShareToken, hashShareToken } = require('../src/services/outing-service');
        const dbClient = require('../src/repositories/db-client');
        const origGetSupabaseClient = dbClient.getSupabaseClient;
        const origIsConfigured = dbClient.isSupabaseConfigured;

        try {
            dbClient.getSupabaseClient = () => mockSupabase;
            dbClient.isSupabaseConfigured = true;

            // 1. Non-force reissue on remote-only legacy outing
            const result = await reissueLegacyOutingShareToken({ outingId: 'EAT-REMOTE-ONLY', force: false });
            assert.strictEqual(result.success, true, 'Reissue must succeed for remote outing');
            assert(result.shareToken, 'Must return raw shareToken');
            assert(result.tokenHash, 'Must return tokenHash');

            // Verify remote hash matches generated token
            const updatedOuting = remoteOutings.find(o => o.id === 'EAT-REMOTE-ONLY');
            assert.strictEqual(updatedOuting.share_token_hash, result.tokenHash, 'Remote DB hash must match generated hash');
            assert.strictEqual(hashShareToken(result.shareToken), result.tokenHash, 'Raw token must hash to tokenHash');

            // 2. Force token rotation on remote-only outing
            const forceResult = await reissueLegacyOutingShareToken({ outingId: 'EAT-REMOTE-ONLY', force: true });
            assert.strictEqual(forceResult.success, true, 'Force reissue must succeed for remote outing');
            assert.notStrictEqual(forceResult.shareToken, result.shareToken, 'Rotated token must be different');
            const rotatedOuting = remoteOutings.find(o => o.id === 'EAT-REMOTE-ONLY');
            assert.strictEqual(rotatedOuting.share_token_hash, forceResult.tokenHash, 'Remote DB must have new hash');
        } finally {
            dbClient.getSupabaseClient = origGetSupabaseClient;
            dbClient.isSupabaseConfigured = origIsConfigured;
        }
    });

    // 9. Test C: Recommendation snapshot replacement (SQLite and Supabase exact replacement)
    await test('Test C: Recommendation snapshot replacement (SQLite and Supabase exact replacement)', async () => {
        const sqliteOutingId = 'EAT-REC-SNAPSHOT-SQLITE';
        await outingRepository.saveOuting({ id: sqliteOutingId });

        const recA = { id: 'v_A', name: 'Venue A', lat: 10.77, lng: 106.70, groupScore: 90 };
        const recB = { id: 'v_B', name: 'Venue B', lat: 10.78, lng: 106.71, groupScore: 85 };
        const recC = { id: 'v_C', name: 'Venue C', lat: 10.79, lng: 106.72, groupScore: 80 };
        const recD = { id: 'v_D', name: 'Venue D', lat: 10.80, lng: 106.73, groupScore: 75 };

        // 1. Persist [A, B, C] in SQLite
        await outingRepository.saveRecommendations(sqliteOutingId, [recA, recB, recC]);
        let loaded = await outingRepository.getRecommendations(sqliteOutingId);
        assert.deepStrictEqual(loaded.map(r => r.id), ['v_A', 'v_B', 'v_C'], 'Should contain exact snapshot [A, B, C]');

        // 2. Persist [B, D] in SQLite -> stale A and C removed
        await outingRepository.saveRecommendations(sqliteOutingId, [recB, recD]);
        loaded = await outingRepository.getRecommendations(sqliteOutingId);
        assert.deepStrictEqual(loaded.map(r => r.id), ['v_B', 'v_D'], 'Should contain exact snapshot [B, D]');

        // 3. Persist [] in SQLite -> clears all recommendations
        await outingRepository.saveRecommendations(sqliteOutingId, []);
        loaded = await outingRepository.getRecommendations(sqliteOutingId);
        assert.deepStrictEqual(loaded, [], 'Empty list should clear all recommendations');

        // 4. Supabase Snapshot Mocking
        let mockSupabaseRecs = [];
        const mockSupabase = {
            from: (table) => {
                if (table === 'venues') {
                    return { upsert: async () => ({ error: null }) };
                }
                if (table === 'recommendations') {
                    return {
                        upsert: async (records) => {
                            for (const rec of records) {
                                const idx = mockSupabaseRecs.findIndex(r => r.id === rec.id);
                                if (idx >= 0) mockSupabaseRecs[idx] = rec;
                                else mockSupabaseRecs.push(rec);
                            }
                            return { error: null };
                        },
                        delete: () => ({
                            eq: (f1, v1) => {
                                const obj = {
                                    not: async (f2, op, inVal) => {
                                        const rawList = inVal.replace(/^\(|\)$/g, '').split(',');
                                        mockSupabaseRecs = mockSupabaseRecs.filter(r => !(r.outing_id === v1 && !rawList.includes(r.id)));
                                        return { error: null };
                                    }
                                };
                                Object.defineProperty(obj, 'then', {
                                    value: (resolve) => {
                                        mockSupabaseRecs = mockSupabaseRecs.filter(r => r[f1] !== v1);
                                        resolve({ error: null });
                                    }
                                });
                                return obj;
                            }
                        })
                    };
                }
            }
        };

        const dbClient = require('../src/repositories/db-client');
        const origGetSupabaseClient = dbClient.getSupabaseClient;
        const origIsConfigured = dbClient.isSupabaseConfigured;

        try {
            dbClient.getSupabaseClient = () => mockSupabase;
            dbClient.isSupabaseConfigured = true;

            const sbOutingId = 'EAT-REC-SNAPSHOT-SUPABASE';

            // Step 1: Save [A, B, C]
            await outingRepository.saveRecommendations(sbOutingId, [recA, recB, recC]);
            assert.deepStrictEqual(
                mockSupabaseRecs.map(r => r.venue_id),
                ['v_A', 'v_B', 'v_C'],
                'Supabase should have [A, B, C]'
            );

            // Step 2: Save [B, D] -> stale A and C removed
            await outingRepository.saveRecommendations(sbOutingId, [recB, recD]);
            assert.deepStrictEqual(
                mockSupabaseRecs.map(r => r.venue_id),
                ['v_B', 'v_D'],
                'Supabase should have exact snapshot [B, D]'
            );

            // Step 3: Save [] -> empty
            await outingRepository.saveRecommendations(sbOutingId, []);
            assert.deepStrictEqual(
                mockSupabaseRecs.filter(r => r.outing_id === sbOutingId),
                [],
                'Supabase should be empty after saving []'
            );
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
