/**
 * Voting & Session Lifecycle Integration Test Suite
 * Tests session loading, vote deduplication (toggle off / vote change), and error resilience.
 */
const assert = require('assert');
const http = require('http');
const express = require('express');

// Set dummy env variables if needed
process.env.PORT = '0';
process.env.NODE_ENV = 'test';

const app = require('../src/app');

async function runVotingSessionTests() {
    console.log('================================================================');
    console.log('🧪 RUNNING VOTING & SESSION LIFECYCLE TEST SUITE');
    console.log('================================================================\n');

    const server = http.createServer(app);

    await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve();
        });
    });

    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`[Test Server] Running on ${baseUrl}\n`);

    async function req(path, options = {}) {
        const url = `${baseUrl}${path}`;
        const res = await fetch(url, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        const contentType = res.headers.get('content-type') || '';
        let data = null;
        if (contentType.includes('application/json')) {
            data = await res.json();
        } else {
            data = await res.text();
        }
        return { status: res.status, ok: res.ok, data };
    }

    let passed = 0;
    let failed = 0;

    async function runTest(name, fn) {
        process.stdout.write(`  ⏳ ${name} ... `);
        try {
            await fn();
            process.stdout.write('✅ PASS\n');
            passed++;
        } catch (err) {
            process.stdout.write(`❌ FAIL: ${err.message}\n`);
            failed++;
        }
    }

    try {
        const testOutingId = 'test_outing_' + Date.now();

        // 1. Search and rank creates / registers session under unified outingId
        await runTest('Unified outing creation via search-and-rank', async () => {
            const res = await req('/api/venues/search-and-rank', {
                method: 'POST',
                body: JSON.stringify({
                    outingId: testOutingId,
                    center: { lat: 10.7782, lng: 106.6912 },
                    radiusMeters: 3000,
                    friends: [
                        { name: 'Alice', lat: 10.7782, lng: 106.6912 },
                        { name: 'Bob', lat: 10.7800, lng: 106.6950 }
                    ]
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.shortlist && res.data.shortlist.length > 0, 'Expected non-empty shortlist');
            assert.strictEqual(res.data.outingId, testOutingId, 'Outing ID must match request');
        });

        // 2. Fetch session details by outing ID
        await runTest('Fetch session details by outing ID', async () => {
            const res = await req(`/api/outings/${testOutingId}`);
            assert.strictEqual(res.status, 200);
            assert(res.data.outing, 'Expected outing object');
            assert.strictEqual(res.data.outing.id, testOutingId);
            assert(Array.isArray(res.data.votes), 'Expected votes array');
        });

        // 3. Cast a vote for venue #1
        const venue1Id = 'v1_phu_nhuan_chay';
        const venue2Id = 'v2_matcha_specialty';

        await runTest('Cast a new vote for venue 1', async () => {
            const res = await req(`/api/outings/${testOutingId}/vote`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue1Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.success);
            assert.strictEqual(res.data.action, 'voted');
        });

        // 4. Toggle off vote by voting for the same venue again
        await runTest('Toggle off vote by voting again for the same venue', async () => {
            const res = await req(`/api/outings/${testOutingId}/vote`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue1Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.success);
            assert.strictEqual(res.data.action, 'unvoted', 'Second click should unvote (toggle off)');

            // Verify vote was removed
            const session = await req(`/api/outings/${testOutingId}`);
            const aliceVotes = session.data.votes.filter(v => v.voter_id === 'voter_alice_001' || v.voter_name === 'Alice');
            assert.strictEqual(aliceVotes.length, 0, 'Alice should have 0 votes after toggle');
        });

        // 5. Change vote from venue 1 to venue 2
        await runTest('Vote change: cast vote 1, then vote for venue 2', async () => {
            // Vote for venue 1
            const res1 = await req(`/api/outings/${testOutingId}/vote`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue1Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });
            assert.strictEqual(res1.data.action, 'voted');

            // Now vote for venue 2 (should update / move vote)
            const res2 = await req(`/api/outings/${testOutingId}/vote`, {
                method: 'POST',
                body: JSON.stringify({
                    venueId: venue2Id,
                    voterId: 'voter_alice_001',
                    voterName: 'Alice'
                })
            });
            assert.strictEqual(res2.status, 200);
            assert(res2.data.action === 'voted' || res2.data.action === 'changed');

            // Verify Alice has exactly 1 vote and it is for venue 2
            const session = await req(`/api/outings/${testOutingId}`);
            const aliceVotes = session.data.votes.filter(v => (v.voter_id === 'voter_alice_001' || v.voter_name === 'Alice') && (v.venue_id === venue2Id || v.venueId === venue2Id));
            assert.strictEqual(aliceVotes.length, 1, 'Alice should have exactly 1 vote on venue 2');
        });

        // 6. Validation error for missing voter or venue
        await runTest('Validation rejects missing venueId with 400', async () => {
            const res = await req(`/api/outings/${testOutingId}/vote`, {
                method: 'POST',
                body: JSON.stringify({
                    voterName: 'Alice'
                })
            });
            assert.strictEqual(res.status, 400);
            assert(res.data.error, 'Expected error message in response');
        });

        // 7. Non-existent outing polling resilience (returns 404, not 500)
        await runTest('Polling non-existent outing returns 404 gracefully', async () => {
            const res = await req('/api/outings/non_existent_outing_99999');
            assert.strictEqual(res.status, 404);
            assert(res.data.error);
        });

        // 8. Generate share plan text with unified outing code and host link
        await runTest('Generate viral share plan contains host and outing query parameter', async () => {
            const res = await req('/api/outings/generate-share-text', {
                method: 'POST',
                body: JSON.stringify({
                    outingCode: testOutingId,
                    venue: {
                        name: 'Bếp Chay Yên Tĩnh',
                        address: '123 Phan Xích Long, Q. Phú Nhuận',
                        lat: 10.7960,
                        lng: 106.6920
                    },
                    friends: [
                        { name: 'Alice' },
                        { name: 'Bob' }
                    ]
                })
            });

            assert.strictEqual(res.status, 200);
            assert(res.data.message.includes(testOutingId), 'Message should contain the outing code');
            assert(res.data.message.includes('?outing=' + testOutingId), 'Message should contain ?outing= query parameter link');
        });

    } finally {
        server.close();
    }

    console.log(`\n================================================================`);
    console.log(`📊 TEST RESULTS: ${passed} PASSED, ${failed} FAILED`);
    console.log(`================================================================\n`);

    if (failed > 0) {
        process.exit(1);
    }
}

runVotingSessionTests().catch(err => {
    console.error('Fatal test error:', err);
    process.exit(1);
});
