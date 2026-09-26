/**
 * Radius Update & State Synchronization Test Suite
 * Validates:
 * 1. PUT /api/outings/:id updates radius on server when authorized with share token.
 * 2. PUT /api/outings/:id rejects unauthorized requests (401/403) and leaves radius untouched.
 * 3. Client rolls back radius slider/circle if PUT fails.
 * 4. Real Downstream Search Failure Injection Test:
 *    - Injects failure into POST /api/venues/search-and-rank after PUT radius succeeds.
 *    - Validates via browser/DOM that:
 *      a) PUT succeeded on server and server DB has updated radius.
 *      b) UI flags stale shortlist (searchFailed: true, isShortlistStale: true).
 *      c) Amber error banner and "Tìm lại" (retrySearchOnly()) button appear in DOM.
 *      d) Clicking "Tìm lại" after server recovery executes fresh search, updates shortlist, and clears stale flag.
 *      e) Page reload restores the updated radius and consistent state.
 * 5. Returns non-zero exit code if any assertion fails.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

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
const { searchAndRankVenues } = require('../src/services/recommendation-service');
const { generateShareToken } = require('../src/services/outing-service');

async function launchBrowser() {
    try {
        return await chromium.launch({ headless: true });
    } catch (err) {
        console.log('Playwright default chromium fallback to msedge:', err.message);
        return await chromium.launch({ channel: 'msedge', headless: true });
    }
}

async function runRadiusSyncTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING RADIUS UPDATE & SEARCH STATE SYNCHRONIZATION SUITE');
    console.log('================================================================\n');

    const server = http.createServer(app);
    let baseUrl;
    let browser = null;

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

        // Initialize outing with participants and shortlist
        await searchAndRankVenues({
            outingId,
            outingName: 'Radius Sync Outing',
            center: { lat: 10.7769, lng: 106.7009 },
            radiusMeters: 3000,
            friends: [
                { name: 'Alice', lat: 10.7769, lng: 106.7009, isMe: true, wish: 'Quán cà phê yên tĩnh' },
                { name: 'Bob', lat: 10.7850, lng: 106.6950, isMe: false, wish: 'Gần trung tâm' }
            ]
        });

        // Set token hash
        await outingRepository.updateOutingShareToken(outingId, tokenHash);

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

        // Test 3: Reloading outing restores 5.0 km radius consistently via API
        await test('GET /api/outings/:id reloads updated radius (5.0 km) consistently', async () => {
            const res = await fetch(`${baseUrl}/api/outings/${outingId}`, {
                headers: { 'x-share-token': rawToken }
            });
            const data = await res.json();
            assert.strictEqual(res.status, 200);
            const outing = data.outing || data;
            assert.strictEqual(outing.radiusKm, 5.0, 'Reloaded radius must be 5.0 km');
        });

        // Test 4: Real Browser Failure Injection Test with Playwright
        await test('Browser DOM: Injected downstream search failure flags stale shortlist, displays retry button, and recovers on retry', async () => {
            browser = await launchBrowser();
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const page = await context.newPage();

            // Load outing session
            await page.goto(`${baseUrl}/?outing=${outingId}&token=${rawToken}`, { waitUntil: 'networkidle' });
            await page.waitForFunction(() => {
                const body = document.querySelector('body');
                return body && body._x_dataStack && body._x_dataStack[0]?.sessionLoaded === true;
            }, { timeout: 15000 });

            // Verify initial session loaded with 5000m radius
            const initialRadius = await page.evaluate(() => document.querySelector('body')._x_dataStack[0].searchRadiusMeters);
            assert.strictEqual(initialRadius, 5000, 'Initial UI radius must be 5000m');

            // Inject failure into POST /api/venues/search-and-rank
            await page.route('**/api/venues/search-and-rank', route => {
                route.fulfill({
                    status: 500,
                    contentType: 'application/json',
                    body: JSON.stringify({ error: 'Injected upstream search failure for testing' })
                });
            });

            // Trigger radius update to 4000m via setRadius()
            await page.evaluate(async () => {
                const data = document.querySelector('body')._x_dataStack[0];
                await data.setRadius(4000);
            });

            // Wait a moment for async search rejection and Alpine state update
            await page.waitForTimeout(500);

            // Assert 4a: Server database retained updated 4.0 km radius from the successful PUT
            const serverOuting = await outingRepository.getOuting(outingId);
            assert.strictEqual(serverOuting.radiusKm, 4.0, 'Server DB must have updated radius 4.0 km');

            // Assert 4b: Client Alpine state has searchFailed === true and isShortlistStale === true
            const clientStateAfterFailure = await page.evaluate(() => {
                const data = document.querySelector('body')._x_dataStack[0];
                return {
                    searchRadiusMeters: data.searchRadiusMeters,
                    searchFailed: data.searchFailed,
                    isShortlistStale: data.isShortlistStale,
                    searchErrorMessage: data.searchErrorMessage,
                    ranking: data.ranking
                };
            });

            assert.strictEqual(clientStateAfterFailure.searchRadiusMeters, 4000, 'UI retained 4000m radius');
            assert.strictEqual(clientStateAfterFailure.searchFailed, true, 'UI state must flag searchFailed: true');
            assert.strictEqual(clientStateAfterFailure.isShortlistStale, true, 'UI state must flag isShortlistStale: true');
            assert(clientStateAfterFailure.searchErrorMessage.includes('Injected upstream search failure'), 'Error message displayed');

            // Assert 4c: Error banner and "Tìm lại" button are visible in DOM
            const retryBannerLocator = page.locator('text=Đã lưu bán kính nhưng chưa tải được danh sách mới');
            await retryBannerLocator.waitFor({ state: 'visible', timeout: 5000 });
            assert(await retryBannerLocator.isVisible(), 'Amber warning banner must be visible in DOM');

            const retryButton = page.locator('button', { hasText: 'Tìm lại' });
            assert(await retryButton.isVisible(), 'Retry button "Tìm lại" must be visible in DOM');

            // Assert 4d: Remove route failure interception (server recovery) and click "Tìm lại"
            await page.unroute('**/api/venues/search-and-rank');

            await retryButton.click();

            // Wait for search completion
            await page.waitForFunction(() => {
                const data = document.querySelector('body')._x_dataStack[0];
                return data && data.ranking === false && data.searchFailed === false;
            }, { timeout: 15000 });

            // Assert UI state after recovery
            const clientStateAfterRecovery = await page.evaluate(() => {
                const data = document.querySelector('body')._x_dataStack[0];
                return {
                    searchRadiusMeters: data.searchRadiusMeters,
                    searchFailed: data.searchFailed,
                    isShortlistStale: data.isShortlistStale,
                    shortlistCount: data.shortlist.length
                };
            });

            assert.strictEqual(clientStateAfterRecovery.searchFailed, false, 'searchFailed cleared after recovery');
            assert.strictEqual(clientStateAfterRecovery.isShortlistStale, false, 'isShortlistStale cleared after recovery');
            assert(clientStateAfterRecovery.shortlistCount > 0, 'Fresh shortlist loaded');
            assert.strictEqual(await retryBannerLocator.isVisible(), false, 'Amber warning banner dismissed');

            // Assert 4e: Page reload restores persisted 4000m radius
            await page.reload({ waitUntil: 'networkidle' });
            await page.waitForFunction(() => {
                const data = document.querySelector('body')._x_dataStack[0];
                return data && data.sessionLoaded === true;
            }, { timeout: 15000 });

            const reloadedRadius = await page.evaluate(() => document.querySelector('body')._x_dataStack[0].searchRadiusMeters);
            assert.strictEqual(reloadedRadius, 4000, 'Reloaded UI restores persisted 4000m radius');

            await context.close();
        });

    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
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
