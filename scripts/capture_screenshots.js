const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const prefix = process.argv[2] || 'after';
const outDir = path.resolve(__dirname, '..', 'tests', 'screenshots');
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

process.env.PORT = '3099';
const app = require('../server.js');

const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function runEdge(url, outFile, width, height) {
    return new Promise((resolve, reject) => {
        const args = [
            '--headless=new',
            '--disable-gpu',
            `--screenshot=${outFile}`,
            `--window-size=${width},${height}`,
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
    console.log('Temporary server running on http://localhost:3099');
    try {
        const desktopFile = path.resolve(outDir, `${prefix}_desktop_1440x900.png`);
        const mobileFile = path.resolve(outDir, `${prefix}_mobile_390x844.png`);

        console.log(`Capturing ${prefix} Desktop (1440x900)...`);
        await runEdge('http://localhost:3099', desktopFile, 1440, 900);
        console.log(`Saved: ${desktopFile}`);

        console.log(`Capturing ${prefix} Mobile (390x844)...`);
        await runEdge('http://localhost:3099', mobileFile, 390, 844);
        console.log(`Saved: ${mobileFile}`);

        console.log('All screenshots captured successfully.');
    } catch (err) {
        console.error('Screenshot error:', err);
    } finally {
        server.close();
        process.exit(0);
    }
});
