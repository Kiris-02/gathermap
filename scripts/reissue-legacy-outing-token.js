#!/usr/bin/env node
/**
 * Operator CLI Tool: Reissue / Upgrade Share Token for Legacy Outings
 * 
 * Usage:
 *   node scripts/reissue-legacy-outing-token.js --outing=EAT-ABC123
 *   node scripts/reissue-legacy-outing-token.js EAT-ABC123
 *   node scripts/reissue-legacy-outing-token.js --outing=EAT-ABC123 --force
 * 
 * Security Notes:
 * - Raw token is printed ONCE to stdout for the operator to share securely with the outing owner.
 * - Raw token is never written to disk or logged in persistent files.
 * - Only the SHA-256 hash is saved to SQLite / Supabase database.
 */

require('dotenv').config();
const { reissueLegacyOutingShareToken } = require('../src/services/outing-service');

function parseArgs() {
    const args = process.argv.slice(2);
    let outingId = null;
    let force = false;
    let confirm = false;

    for (const arg of args) {
        if (arg.startsWith('--outing=')) {
            outingId = arg.split('=')[1].trim();
        } else if (arg === '--force' || arg === '-f') {
            force = true;
        } else if (arg === '--confirm' || arg === '-y') {
            confirm = true;
        } else if (!arg.startsWith('-') && !outingId) {
            outingId = arg.trim();
        }
    }

    return { outingId, force, confirm };
}

async function main() {
    const { outingId, force, confirm } = parseArgs();

    if (!outingId) {
        console.error('❌ Error: Outing ID is required.');
        console.error('Usage: node scripts/reissue-legacy-outing-token.js --outing=<OUTING_ID> [--force] [--confirm]');
        process.exit(1);
    }

    const isProduction = process.env.NODE_ENV === 'production' || process.env.IS_PRODUCTION === 'true';
    if (force && isProduction && !confirm) {
        console.error('🚨 SAFETY GUARD: You are executing a forced token rotation in PRODUCTION.');
        console.error('   This will instantly revoke all existing active links for this outing session.');
        console.error('   To proceed, re-run with: --force --confirm');
        process.exit(1);
    }

    const isCI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

    console.log('================================================================');
    console.log('🔐 GATHERMAP OPERATOR TOKEN REISSUE / UPGRADE UTILITY');
    console.log('================================================================');
    console.log(`Target Outing ID: ${outingId}`);
    console.log(`Force Override:   ${force ? 'YES' : 'NO'}`);
    console.log(`Confirmed:        ${confirm ? 'YES' : 'NO'}\n`);

    try {
        const result = await reissueLegacyOutingShareToken({ outingId, force });

        if (!result.success) {
            console.error(`⚠️ Operation aborted: ${result.message}`);
            if (result.reason === 'already_secured') {
                console.error('👉 If you intend to rotate the existing token, re-run with --force.');
            }
            process.exit(1);
        }

        const host = process.env.PUBLIC_APP_URL || 'https://gathermap.onrender.com';
        const displayToken = isCI ? '[REDACTED_IN_CI_ENVIRONMENT]' : result.shareToken;
        const fullShareUrl = isCI 
            ? `${host}/?outing=${encodeURIComponent(result.outingId)}&token=[REDACTED_IN_CI]`
            : `${host}/?outing=${encodeURIComponent(result.outingId)}&token=${encodeURIComponent(result.shareToken)}`;

        console.log('✅ TOKEN SUCCESSFULLY GENERATED & SAVED TO DATABASE');
        console.log('----------------------------------------------------------------');
        console.log(`🔑 Raw Share Token (1-Time Output):`);
        console.log(`   ${displayToken}`);
        console.log('');
        console.log(`🔗 Ready-to-use Share Link:`);
        console.log(`   ${fullShareUrl}`);
        console.log('----------------------------------------------------------------');
        console.log('⚠️  SECURITY NOTICE:');
        console.log('   Send this URL directly to the group host/members.');
        console.log('   The raw token is NEVER persisted in plaintext anywhere on the server.');
        console.log('================================================================\n');

        process.exit(0);
    } catch (err) {
        console.error(`💥 Execution failed: ${err.message}`);
        process.exit(1);
    }
}

main();
