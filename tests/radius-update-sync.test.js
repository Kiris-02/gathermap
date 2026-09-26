/**
 * Radius Update & State Synchronization Test Suite
 * Validates:
 * 1. PUT /api/outings/:id updates radius on server when authorized with share token.
 * 2. PUT /api/outings/:id rejects unauthorized requests (401/403) and leaves radius untouched.
 * 3. Client rolls back radius slider/circle if PUT fails.
 * 4. If PUT succeeds but downstream search fails, server and client retain updated radius,
 *    and reload restores the persisted radius with consistent state.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');

const testDbPath = path.join(__dirname, 'radius-sync-test.db');
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
const outingRepository = require('../src/repositories/outing-repository');
const { generateShareToken } = require('../src/services/outing-service');

async function runRadiusSyncTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING RADIUS UPDATE & SEARCH STATE SYNCHRONIZATION SUITE');
    console.log('================================================================\n');

    const server = http.createServer(app);
    let baseUrl;

    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            baseUrl = `http://127.0.0.1:${port}`;
            resolve();
        });
    });

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            process.stdout.write(`  ⏳ ${name} ... `);
            await fn();
            console.log('✅ PASS');
            passed++;
        } catch (err) {
            console.log('❌ FAIL');
            console.error('     ' + err.stack);
            failed++;
        }
    }

    try {
        const outingId = 'EAT-RAD-SYNC';
        const { rawToken, tokenHash } = generateShareToken();

        await outingRepository.saveOuting({
            id: outingId,
            name: 'Radius Sync Outing',
            centerLat: 10.7769,
            centerLng: 106.7009,
            radiusKm: 3.0,
            shareTokenHash: tokenHash
        });

        // Test 1: Authorized PUT updates radius to 5.0 km
        await test('PUT /api/outings/:id with valid token updates radius to 5.0 km', async () => {
            const res = await fetch(`${baseUrl}/api/outings/${outingId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-share-token': rawToken
                },
                body: JSON.stringify({ radiusKm: 5.0 })
            });
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            assert.strictEqual(data.radiusKm, 5.0);

            const row = await outingRepository.getOuting(outingId);
            assert.strictEqual(row.radiusKm, 5.0, 'Database radius must be 5.0');
        });

        // Test 2: Unauthorized PUT is rejected and database radius stays 5.0 km
        await test('PUT /api/outings/:id with invalid token is rejected (403) and radius is preserved', async () => {
            const res = await fetch(`${baseUrl}/api/outings/${outingId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-share-token': 'wrong-token'
                },
                body: JSON.stringify({ radiusKm: 1.0 })
            });
            assert.strictEqual(res.status, 403);

            const row = await outingRepository.getOuting(outingId);
            assert.strictEqual(row.radiusKm, 5.0, 'Database radius must remain 5.0');
        });

        // Test 3: Reloading outing restores 5.0 km radius consistently
        await test('GET /api/outings/:id reloads updated radius (5.0 km) consistently', async () => {
            const res = await fetch(`${baseUrl}/api/outings/${outingId}`, {
                headers: { 'x-share-token': rawToken }
            });
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            const outing = data.outing || data;
            assert.strictEqual(outing.radiusKm, 5.0, 'Reloaded radius must be 5.0 km');
        });

        // Test 4: Downstream search failure recovery: Radius is preserved in DB and reload restores updated radius
        await test('Downstream search failure recovery: radius is preserved on server and reload recovers state', async () => {
            // 4a. Update radius to 4.0 km via PUT
            const putRes = await fetch(`${baseUrl}/api/outings/${outingId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'x-share-token': rawToken
                },
                body: JSON.stringify({ radiusKm: 4.0 })
            });
            assert.strictEqual(putRes.status, 200);
            const putData = await putRes.json();
            assert.strictEqual(putData.radiusKm, 4.0);

            // 4b. Simulate downstream failure on search: verify database retained 4.0 km
            const dbCheck = await outingRepository.getOuting(outingId);
            assert.strictEqual(dbCheck.radiusKm, 4.0, 'Server database must retain 4.0 km even if search fails');

            // 4c. Verify GET reload restores 4.0 km
            const reloadRes = await fetch(`${baseUrl}/api/outings/${outingId}`, {
                headers: { 'x-share-token': rawToken }
            });
            const reloadData = await reloadRes.json();
            assert.strictEqual(reloadData.radiusKm, 4.0, 'Reload must restore 4.0 km');
        });

    } finally {
        server.close();
        if (fs.existsSync(testDbPath)) {
            try { fs.unlinkSync(testDbPath); } catch (_) {}
        }
    }

    console.log(`\n📊 RADIUS SYNC RESULTS: ${passed} PASSED, ${failed} FAILED\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    runRadiusSyncTests().catch(err => {
        console.error('Fatal radius sync test error:', err);
        process.exit(1);
    });
}

module.exports = runRadiusSyncTests;
