/**
 * Two-Browser Context & Shared Link Verification Suite (Playwright E2E)
 *
 * Requirements:
 * 1. Independent browser contexts: Host creates outing, Guest opens ?outing=...&token=...
 * 2. Assertions on UI and API:
 *    - Map center coordinates (lat, lng)
 *    - Search radius
 *    - Participant count and details (friends, wishes)
 *    - Shortlist recommendations
 *    - Live voting synchronization
 * 3. Verify Guest NEVER triggers search-and-rank and does not mutate server outing metadata.
 * 4. Verify Access Control: Missing token -> 401, Invalid token -> 403.
 * 5. Deterministic exit codes: Exit code 0 ONLY when ALL assertions pass, exit code 1 on failure.
 * 6. Visual evidence capture (Desktop 1440x900, Mobile 390x844, Guest Desktop 1440x900).
 */

const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');

// Set isolated SQLite database before requiring application modules
const tempDbPath = path.resolve(__dirname, '..', 'tests', 'e2e-playwright-temp.db');
if (fs.existsSync(tempDbPath)) {
    try { fs.unlinkSync(tempDbPath); } catch (_) {}
}
process.env.SQLITE_DB_PATH = tempDbPath;
process.env.SUPABASE_URL = '';
process.env.SUPABASE_KEY = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const outDir = path.resolve(__dirname, '..', 'tests', 'screenshots');
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

const artifactDir = 'C:\\Users\\HN\\.gemini\\antigravity\\brain\\18b84ed6-6769-4c09-9dd9-0e13faaf385c';

const app = require('../src/app');
const outingRepository = require('../src/repositories/outing-repository');
const { searchAndRankVenues } = require('../src/services/recommendation-service');
const { generateUniqueOutingId } = require('../src/services/outing-service');

async function launchBrowser() {
    try {
        return await chromium.launch({ headless: true });
    } catch (err) {
        console.log('Playwright default chromium unavailable, falling back to msedge channel:', err.message);
        return await chromium.launch({ channel: 'msedge', headless: true });
    }
}

function copyToArtifacts(filename) {
    const src = path.resolve(outDir, filename);
    const dest = path.resolve(artifactDir, filename);
    if (fs.existsSync(src) && fs.existsSync(artifactDir)) {
        try {
            fs.copyFileSync(src, dest);
            console.log(`📸 Updated artifact: ${dest}`);
        } catch (e) {
            console.warn(`Artifact copy warning for ${filename}:`, e.message);
        }
    }
}

async function runE2ESharedLinkTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING PLAYWRIGHT TWO-BROWSER SHARED LINK E2E TEST SUITE');
    console.log('================================================================');

    let server = null;
    let browser = null;
    let failedAssertions = 0;

    function recordPass(testName) {
        console.log(`  ⏳ ${testName} ... ✅ PASS`);
    }

    function recordFail(testName, err) {
        console.error(`  ⏳ ${testName} ... ❌ FAIL: ${err.message}`);
        console.error(err.stack);
        failedAssertions++;
    }

    try {
        // 1. Start server on an ephemeral port
        const port = await new Promise((resolve, reject) => {
            const s = app.listen(0, '127.0.0.1', () => {
                const p = s.address().port;
                server = s;
                resolve(p);
            });
            s.on('error', reject);
        });
        const baseUrl = `http://127.0.0.1:${port}`;
        console.log(`[E2E Server] Running on ${baseUrl} (isolated DB: ${tempDbPath})`);

        // 2. Launch browser
        browser = await launchBrowser();

        // 3. Create Outing Session with Host and 2 friends
        const sharedOutingId = await generateUniqueOutingId();
        const expectedCenter = { lat: 10.7782, lng: 106.6912 };
        const expectedRadiusMeters = 3000;
        const hostFriends = [
            { name: 'Kiris (Host)', lat: 10.7782, lng: 106.6912, isMe: true, wish: 'Quán yên tĩnh, view đẹp' },
            { name: 'Minh', lat: 10.7850, lng: 106.6990, isMe: false, wish: 'Món ăn thanh đạm' },
            { name: 'Lan', lat: 10.7720, lng: 106.6850, isMe: false, wish: 'Dưới 150k' }
        ];

        console.log(`\n--- STEP 1: INITIAL OUTING CREATION ---`);
        const searchResult = await searchAndRankVenues({
            outingId: sharedOutingId,
            outingName: 'Nhóm Bạn Thân Ăn Cuối Tuần',
            center: expectedCenter,
            radiusMeters: expectedRadiusMeters,
            friends: hostFriends
        });

        assert(searchResult.shareToken, 'searchAndRankVenues must generate a shareToken');
        const shareToken = searchResult.shareToken;
        assert(searchResult.shortlist.length > 0, 'Outing must contain recommendations in shortlist');
        const expectedVenue1 = searchResult.shortlist[0];
        const expectedVenue2 = searchResult.shortlist[1] || searchResult.shortlist[0];

        // Host casts an initial vote for venue 1
        await outingRepository.recordVote(sharedOutingId, expectedVenue1.id, 'Kiris (Host)', 'voter_host_01');
        const serverSnapshotBefore = await outingRepository.getOuting(sharedOutingId);
        recordPass('Host creates outing session, shortlist is ranked, and host vote is recorded');

        // --- STEP 2: BROWSER CONTEXT 1 (HOST - DESKTOP 1440x900) ---
        console.log(`\n--- STEP 2: BROWSER CONTEXT 1 (HOST) ---`);
        const hostContext = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            userAgent: 'GatherMap-E2E-Host/1.0'
        });
        const hostPage = await hostContext.newPage();

        await hostPage.goto(`${baseUrl}/?outing=${sharedOutingId}&token=${shareToken}`, { waitUntil: 'networkidle' });
        await hostPage.waitForFunction(() => {
            const body = document.querySelector('body');
            return body && body._x_dataStack && body._x_dataStack[0]?.sessionLoaded === true;
        }, { timeout: 15000 });

        // Assert Host UI state
        const hostState = await hostPage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            return {
                outingCode: data.outingCode,
                friendsCount: data.friends.length,
                friends: data.friends.map(f => ({ name: f.name, wish: f.wish })),
                centerCoords: data.centerCoords,
                searchRadiusMeters: data.searchRadiusMeters,
                shortlistCount: data.shortlist.length,
                firstVenueId: data.shortlist[0]?.id,
                votesMap: data.votesMap
            };
        });

        try {
            assert.strictEqual(hostState.outingCode, sharedOutingId, 'Host UI outingCode matches');
            assert.strictEqual(hostState.friendsCount, 3, 'Host UI has 3 friends');
            assert.strictEqual(Number(hostState.centerCoords.lat.toFixed(4)), 10.7782, 'Host UI center lat matches');
            assert.strictEqual(Number(hostState.centerCoords.lng.toFixed(4)), 106.6912, 'Host UI center lng matches');
            assert.strictEqual(hostState.searchRadiusMeters, 3000, 'Host UI radius matches 3000m');
            assert(hostState.shortlistCount > 0, 'Host UI shortlist rendered');
            assert.strictEqual(hostState.votesMap[expectedVenue1.id], 1, 'Host vote appears in votesMap');
            recordPass('Browser 1 (Host Desktop) renders correct outing code, coordinates, friends, shortlist & vote');
        } catch (err) {
            recordFail('Browser 1 (Host Desktop) UI state assertion', err);
        }

        const hostDesktopFile = path.resolve(outDir, 'after_desktop_1440x900.png');
        await hostPage.screenshot({ path: hostDesktopFile, fullPage: false });
        copyToArtifacts('after_desktop_1440x900.png');

        // Host updates radius to 2000m via real DOM interaction
        console.log(`\n--- STEP 2B: HOST UPDATES RADIUS TO 2000M VIA REAL DOM INTERACTION ---`);
        const wishesButton = hostPage.locator('button', { hasText: 'Wishes' });
        await wishesButton.click();
        await hostPage.waitForSelector('text=Tâm điểm & Bán kính tìm kiếm', { timeout: 5000 });

        // Click the "2 km" radius button inside the modal
        const radius2KmButton = hostPage.locator('button', { hasText: '2 km' });
        await radius2KmButton.click();

        // Close the modal
        const closeButton = hostPage.locator('button[title="Đóng"]').first();
        if (await closeButton.isVisible()) {
            await closeButton.click();
        }

        await hostPage.waitForFunction(() => {
            const body = document.querySelector('body');
            return body && body._x_dataStack && body._x_dataStack[0]?.ranking === false && body._x_dataStack[0]?.shortlist?.length > 0;
        }, { timeout: 20000 });

        const hostUpdatedState = await hostPage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            return {
                searchRadiusMeters: data.searchRadiusMeters,
                shortlistCount: data.shortlist.length,
                firstVenueDist: data.shortlist[0]?.distFromCenterKm,
                firstVenueBreakdowns: data.shortlist[0]?.memberBreakdowns
            };
        });

        try {
            assert.strictEqual(hostUpdatedState.searchRadiusMeters, 2000, 'Host radius updated to 2000m');
            assert(typeof hostUpdatedState.firstVenueDist === 'number', 'Venue distance from center must be numeric');
            assert(!isNaN(hostUpdatedState.firstVenueDist), 'Venue distance must not be NaN');
            recordPass('Host successfully updates radius to 2000m, shortlist reflects numeric distance');
        } catch (err) {
            recordFail('Host radius update assertion', err);
        }

        const serverSnapshotAfterRadiusUpdate = await outingRepository.getOuting(sharedOutingId);
        try {
            assert.strictEqual(Number(serverSnapshotAfterRadiusUpdate.radiusKm), 2, 'Database persisted radiusKm as 2.0');
            recordPass('Database correctly persisted new radius (2.0 km) via authorized PUT');
        } catch (err) {
            recordFail('Database radius persistence assertion', err);
        }

        // --- STEP 3: BROWSER CONTEXT 2 (GUEST - ISOLATED STORAGE & NETWORK SPY) ---
        console.log(`\n--- STEP 3: BROWSER CONTEXT 2 (GUEST LINK OPEN & ZERO MUTATION) ---`);
        const guestContext = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            userAgent: 'GatherMap-E2E-Guest/1.0'
        });
        const guestPage = await guestContext.newPage();

        // Spy on network requests to verify Guest NEVER triggers search-and-rank
        const guestRequests = [];
        guestPage.on('request', req => {
            guestRequests.push({ url: req.url(), method: req.method() });
        });

        await guestPage.goto(`${baseUrl}/?outing=${sharedOutingId}&token=${shareToken}`, { waitUntil: 'networkidle' });
        await guestPage.waitForFunction(() => {
            const body = document.querySelector('body');
            return body && body._x_dataStack && body._x_dataStack[0]?.sessionLoaded === true;
        }, { timeout: 15000 });

        // Check zero search-and-rank requests
        const searchAndRankCalls = guestRequests.filter(r => r.url.includes('/api/venues/search-and-rank'));
        try {
            assert.strictEqual(searchAndRankCalls.length, 0, 'Guest context MUST NOT invoke /api/venues/search-and-rank');
            recordPass('Guest opening shared link triggers ZERO fresh searches (no search-and-rank calls)');
        } catch (err) {
            recordFail('Guest search-and-rank call check', err);
        }

        // Assert Guest UI state
        const guestState = await guestPage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            return {
                outingCode: data.outingCode,
                friendsCount: data.friends.length,
                friends: data.friends.map(f => ({ name: f.name, wish: f.wish })),
                centerCoords: data.centerCoords,
                searchRadiusMeters: data.searchRadiusMeters,
                shortlistCount: data.shortlist.length,
                firstVenueId: data.shortlist[0]?.id,
                firstVenueDist: data.shortlist[0]?.distFromCenterKm,
                firstVenueBreakdowns: data.shortlist[0]?.memberBreakdowns,
                votesMap: data.votesMap
            };
        });

        try {
            assert.strictEqual(guestState.outingCode, sharedOutingId, 'Guest UI outingCode matches');
            assert.strictEqual(guestState.friendsCount, 3, 'Guest UI has exactly 3 friends');
            assert.deepStrictEqual(
                guestState.friends.map(f => f.name),
                ['Kiris (Host)', 'Minh', 'Lan'],
                'Guest UI preserves exact friend roster'
            );
            assert.strictEqual(Number(guestState.centerCoords.lat.toFixed(4)), 10.7782, 'Guest UI center lat matches');
            assert.strictEqual(Number(guestState.centerCoords.lng.toFixed(4)), 106.6912, 'Guest UI center lng matches');
            assert.strictEqual(guestState.searchRadiusMeters, 2000, 'Guest UI radius matches updated 2000m');
            assert.strictEqual(guestState.shortlistCount, hostUpdatedState.shortlistCount, 'Guest shortlist matches Host shortlist');
            assert(typeof guestState.firstVenueDist === 'number' && !isNaN(guestState.firstVenueDist), 'Guest venue distance is numeric');
            assert(Array.isArray(guestState.firstVenueBreakdowns), 'Guest receives memberBreakdowns');
            assert.strictEqual(guestState.votesMap[expectedVenue1.id], 1, 'Host vote is visible to Guest');
            recordPass('Guest UI accurately reconstructs center, updated radius (2.0km), member breakdowns, shortlist & live votes');
        } catch (err) {
            recordFail('Guest UI state fidelity check', err);
        }

        // Verify server outing metadata was NOT mutated by guest opening the link
        const serverSnapshotAfterGuestOpen = await outingRepository.getOuting(sharedOutingId);
        try {
            assert.strictEqual(Number(serverSnapshotAfterGuestOpen.centerLat.toFixed(4)), 10.7782);
            assert.strictEqual(Number(serverSnapshotAfterGuestOpen.centerLng.toFixed(4)), 106.6912);
            assert.strictEqual(Number(serverSnapshotAfterGuestOpen.radiusKm), 2);
            assert.strictEqual(serverSnapshotAfterGuestOpen.friends.length, 3);
            recordPass('Server outing session metadata strictly preserved with zero mutation on guest join');
        } catch (err) {
            recordFail('Server data mutation check', err);
        }

        // --- STEP 4: GUEST CASTS VOTE VIA REAL DOM INTERACTION ---
        console.log(`\n--- STEP 4: GUEST CASTS VOTE VIA REAL DOM INTERACTION ---`);
        const venueCardLocator = guestPage.locator(`#venue-card-${expectedVenue2.id}`);
        await venueCardLocator.scrollIntoViewIfNeeded();
        const voteButton = venueCardLocator.locator('button', { hasText: 'Vote' });
        await voteButton.click();

        // Wait for Alpine reactive state and DOM count update
        await guestPage.waitForFunction((venueId) => {
            const data = document.querySelector('body')._x_dataStack[0];
            return data && data.myVotedVenueId === venueId;
        }, expectedVenue2.id, { timeout: 10000 });

        const guestVotedState = await guestPage.evaluate((venueId) => {
            const data = document.querySelector('body')._x_dataStack[0];
            return {
                myVotedVenueId: data.myVotedVenueId,
                venueVotes: data.shortlist.find(v => v.id === venueId)?.votes
            };
        }, expectedVenue2.id);

        try {
            assert.strictEqual(guestVotedState.myVotedVenueId, expectedVenue2.id, 'Guest state reflects voted venue');
            assert(guestVotedState.venueVotes >= 1, 'Venue vote count incremented');
            recordPass('Guest successfully votes for venue by clicking UI Vote button');
        } catch (err) {
            recordFail('Guest UI vote click', err);
        }

        // Wait for polling sync on both Host and Guest pages
        await guestPage.waitForTimeout(1000);
        await hostPage.waitForTimeout(1000);

        const guestDesktopFile = path.resolve(outDir, 'browser2_shared_link_1440x900.png');
        await guestPage.screenshot({ path: guestDesktopFile, fullPage: false });
        copyToArtifacts('browser2_shared_link_1440x900.png');

        // --- STEP 5: MOBILE VIEWPORT VERIFICATION (390x844) ---
        console.log(`\n--- STEP 5: MOBILE VIEWPORT TEST (390x844) ---`);
        const mobileContext = await browser.newContext({
            viewport: { width: 390, height: 844 },
            userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
        });
        const mobilePage = await mobileContext.newPage();

        await mobilePage.goto(`${baseUrl}/?outing=${sharedOutingId}&token=${shareToken}`, { waitUntil: 'networkidle' });
        await mobilePage.waitForFunction(() => {
            const body = document.querySelector('body');
            return body && body._x_dataStack && body._x_dataStack[0]?.sessionLoaded === true;
        }, { timeout: 15000 });

        const mobileState = await mobilePage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            return {
                mobileView: data.mobileView,
                friendsCount: data.friends.length,
                shortlistCount: data.shortlist.length
            };
        });

        try {
            assert.strictEqual(mobileState.friendsCount, 3, 'Mobile session loads 3 friends');
            assert(mobileState.shortlistCount > 0, 'Mobile session displays shortlist');
            assert.strictEqual(mobileState.mobileView, 'list', 'Initial mobile view is list');
            recordPass('Mobile viewport (390x844) successfully renders responsive session list');
        } catch (err) {
            recordFail('Mobile viewport assertion', err);
        }

        // Switch to Map View on mobile
        console.log(`\n--- STEP 5B: MOBILE SWITCH TO MAP VIEW & INTERACTION ---`);
        await mobilePage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            data.switchMobileView('map');
        });
        await mobilePage.waitForTimeout(600);

        const mobileMapState = await mobilePage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            const mapContainer = document.getElementById('map-container');
            const isMapVisible = mapContainer && window.getComputedStyle(mapContainer).display !== 'none';
            const hasLeafletMap = Boolean(data.map);
            const currentZoom = data.map ? data.map.getZoom() : null;
            return {
                mobileView: data.mobileView,
                isMapVisible,
                hasLeafletMap,
                currentZoom,
                currentMapStyle: data.currentMapStyle
            };
        });

        try {
            assert.strictEqual(mobileMapState.mobileView, 'map', 'Mobile view switched to map');
            assert.strictEqual(mobileMapState.isMapVisible, true, 'Map container is visible on mobile');
            assert.strictEqual(mobileMapState.hasLeafletMap, true, 'Leaflet map instance is active');
            recordPass('Mobile map view toggled cleanly: container visible and Leaflet map initialized');
        } catch (err) {
            recordFail('Mobile map toggle assertion', err);
        }

        // Test tile style switching and zooming on mobile
        await mobilePage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            data.switchMapStyle('osm');
            data.map.setZoom(15);
        });
        await mobilePage.waitForTimeout(600);

        const mobileInteractionState = await mobilePage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            return {
                style: data.currentMapStyle,
                zoom: data.map.getZoom()
            };
        });

        try {
            assert.strictEqual(mobileInteractionState.style, 'osm', 'Map style switched to OSM');
            assert.strictEqual(mobileInteractionState.zoom, 15, 'Map zoom level updated to 15');
            recordPass('Mobile map controls: tile style switched to OSM and zoom updated smoothly');
        } catch (err) {
            recordFail('Mobile map interaction assertion', err);
        }

        const mobileFile = path.resolve(outDir, 'after_mobile_390x844.png');
        await mobilePage.screenshot({ path: mobileFile, fullPage: false });
        copyToArtifacts('after_mobile_390x844.png');

        // --- STEP 6: LOCATION PRIVACY & ACCESS CONTROL NEGATIVE TESTS ---
        console.log(`\n--- STEP 6: ACCESS CONTROL NEGATIVE TESTS ---`);
        const unauthContext = await browser.newContext();
        const unauthPage = await unauthContext.newPage();

        // 6a. Attempt access without token
        await unauthPage.goto(`${baseUrl}/?outing=${sharedOutingId}`, { waitUntil: 'networkidle' });
        await unauthPage.waitForTimeout(1500);

        const unauthState = await unauthPage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            return {
                sessionLoaded: data.sessionLoaded,
                friends: data.friends ? data.friends.map(f => f.name) : []
            };
        });

        try {
            assert.strictEqual(unauthState.sessionLoaded, false, 'Session must not be loaded without token');
            const leakedPrivateFriend = unauthState.friends.some(n => ['Kiris (Host)', 'Minh', 'Lan'].includes(n));
            assert.strictEqual(leakedPrivateFriend, false, 'Private friends must NOT be exposed without token');

            // Check direct API returns 401
            const apiRes = await unauthPage.request.get(`${baseUrl}/api/outings/${sharedOutingId}`);
            assert.strictEqual(apiRes.status(), 401, 'API without token must return 401');
            recordPass('Security: Access without share token strictly blocked (401 Unauthorized, zero data leak)');
        } catch (err) {
            recordFail('Access without token check', err);
        }

        // 6b. Attempt access with bad token
        await unauthPage.goto(`${baseUrl}/?outing=${sharedOutingId}&token=forged_token_evil_hacker_123`, { waitUntil: 'networkidle' });
        await unauthPage.waitForTimeout(1500);

        const badTokenState = await unauthPage.evaluate(() => {
            const data = document.querySelector('body')._x_dataStack[0];
            return {
                sessionLoaded: data.sessionLoaded,
                friends: data.friends ? data.friends.map(f => f.name) : []
            };
        });

        try {
            assert.strictEqual(badTokenState.sessionLoaded, false, 'Session must not load with forged token');
            const leakedPrivateFriend = badTokenState.friends.some(n => ['Kiris (Host)', 'Minh', 'Lan'].includes(n));
            assert.strictEqual(leakedPrivateFriend, false, 'Friends must NOT be revealed to forged token');

            // Check direct API returns 403
            const apiRes = await unauthPage.request.get(`${baseUrl}/api/outings/${sharedOutingId}?token=forged_token_evil_hacker_123`);
            assert.strictEqual(apiRes.status(), 403, 'API with forged token must return 403');
            recordPass('Security: Access with invalid token strictly rejected (403 Forbidden, zero data leak)');
        } catch (err) {
            recordFail('Access with forged token check', err);
        }

        // Clean up contexts
        await hostContext.close();
        await guestContext.close();
        await mobileContext.close();
        await unauthContext.close();

    } catch (unexpectedErr) {
        console.error('\n💥 Unexpected error during E2E testing:', unexpectedErr);
        failedAssertions++;
    } finally {
        if (browser) {
            try { await browser.close(); } catch (_) {}
        }
        if (server) {
            try { server.close(); } catch (_) {}
        }
        if (fs.existsSync(tempDbPath)) {
            try { fs.unlinkSync(tempDbPath); } catch (_) {}
        }

        console.log('\n================================================================');
        if (failedAssertions === 0) {
            console.log('🎉 ALL PLAYWRIGHT E2E BROWSER ASSERTIONS PASSED (100%)');
            console.log('================================================================\n');
            process.exit(0);
        } else {
            console.error(`❌ E2E SUITE FAILED WITH ${failedAssertions} FAILING ASSERTION(S)`);
            console.log('================================================================\n');
            process.exit(1);
        }
    }
}

runE2ESharedLinkTests();
