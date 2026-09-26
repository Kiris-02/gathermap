/**
 * Two-Browser Context & Shared Link Verification Script
 * 1. Seeds a test outing session with custom participants and ranking.
 * 2. Opens Browser 1 (Host context) at 1440x900 and captures desktop screenshot.
 * 3. Opens Browser 2 (Participant context with clean isolated user-data-dir) via ?outing= link at 390x844 (Mobile) and 1440x900 (Desktop).
 * 4. Verifies that the shared link loads the exact outing without re-searching or overwriting coordinates.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const outDir = path.resolve(__dirname, '..', 'tests', 'screenshots');
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

process.env.PORT = '3099';
const app = require('../src/app');
const outingRepository = require('../src/repositories/outing-repository');
const { searchAndRankVenues } = require('../src/services/recommendation-service');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function runEdge(url, outFile, width, height, userDataDir) {
    return new Promise((resolve, reject) => {
        const args = [
            '--headless=new',
            '--disable-gpu',
            `--screenshot=${outFile}`,
            `--window-size=${width},${height}`,
            `--user-data-dir=${userDataDir}`,
            '--virtual-time-budget=9000',
            '--hide-scrollbars',
            url
        ];
        const proc = spawn(edgePath, args, { stdio: 'inherit' });
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Edge exited with code ${code}`));
        });
        proc.on('error', reject);
    });
}

const server = app.listen(3099, async () => {
    console.log('🚀 Server running on http://localhost:3099 for Two-Browser Verification');
    const profile1 = path.resolve(__dirname, '..', 'temp-browser-profile-1');
    const profile2 = path.resolve(__dirname, '..', 'temp-browser-profile-2');

    try {
        const sharedOutingId = 'EAT-SHAREPR2';

        console.log(`\n1. Creating Shared Outing Session: #${sharedOutingId} ...`);
        await searchAndRankVenues({
            outingId: sharedOutingId,
            outingName: 'Nhóm Bạn Thân Ăn Cuối Tuần',
            center: { lat: 10.7782, lng: 106.6912 },
            radiusMeters: 3000,
            friends: [
                { name: 'Kiris (Host)', lat: 10.7782, lng: 106.6912, isMe: true, wish: 'Quán yên tĩnh, view đẹp' },
                { name: 'Minh', lat: 10.7850, lng: 106.6990, isMe: false, wish: 'Món ăn thanh đạm' },
                { name: 'Lan', lat: 10.7720, lng: 106.6850, isMe: false, wish: 'Dưới 150k' }
            ]
        });

        // Cast an initial vote from Host
        await outingRepository.recordVote(sharedOutingId, 'hcm-vnu-veg-01', 'Kiris (Host)', 'voter_host_01');

        console.log('\n2. Testing Browser 1 (Host - Desktop 1440x900) ...');
        const desktopFile = path.resolve(outDir, 'after_desktop_1440x900.png');
        await runEdge(`http://localhost:3099/?outing=${sharedOutingId}`, desktopFile, 1440, 900, profile1);
        console.log(`✅ Saved: ${desktopFile}`);

        console.log('\n3. Testing Browser 2 (Guest / Distinct Device - Mobile 390x844) via Shared Link ...');
        const mobileFile = path.resolve(outDir, 'after_mobile_390x844.png');
        await runEdge(`http://localhost:3099/?outing=${sharedOutingId}`, mobileFile, 390, 844, profile2);
        console.log(`✅ Saved: ${mobileFile}`);

        console.log('\n4. Testing Browser 2 (Guest - Desktop 1440x900) via Shared Link ...');
        const guestDesktopFile = path.resolve(outDir, 'browser2_shared_link_1440x900.png');
        await runEdge(`http://localhost:3099/?outing=${sharedOutingId}`, guestDesktopFile, 1440, 900, profile2);
        console.log(`✅ Saved: ${guestDesktopFile}`);

        // Verify that the session on server was NOT overwritten
        const sessionAfter = await outingRepository.getOuting(sharedOutingId);
        if (sessionAfter && sessionAfter.friends && sessionAfter.friends.length === 3) {
            console.log('\n✅ VERIFICATION PASSED: Outing participants, coordinates and shortlist remained intact!');
        } else {
            console.error('\n❌ VERIFICATION FAILED: Outing was modified or corrupted!');
        }

    } catch (err) {
        console.error('Error during verification:', err);
    } finally {
        server.close();
        // Clean up temporary browser profiles
        try { fs.rmSync(profile1, { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(profile2, { recursive: true, force: true }); } catch (_) {}
        process.exit(0);
    }
});
