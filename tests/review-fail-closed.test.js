const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testDbPath = path.join(__dirname, 'review-fail-closed.test.db');
process.env.SQLITE_DB_PATH = testDbPath;
process.env.SUPABASE_URL = '';
process.env.SUPABASE_SERVICE_ROLE_KEY = '';

const dbClient = require('../src/repositories/db-client');
const reviewRepository = require('../src/repositories/review-repository');
const app = require('../src/app');

async function run() {
    const original = {
        configured: dbClient.isSupabaseConfigured,
        client: dbClient.getSupabaseClient,
        sqlite: dbClient.getSqliteDb,
        mapsKey: process.env.GOOGLE_MAPS_API_KEY
    };
    const server = app.listen(0);
    try {
        await new Promise(resolve => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        process.env.GOOGLE_MAPS_API_KEY = 'operator-managed-key';
        const configResponse = await fetch(`${base}/api/config/maps-key`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: 'attacker-controlled' })
        });
        assert.equal(configResponse.status, 404);
        assert.equal(process.env.GOOGLE_MAPS_API_KEY, 'operator-managed-key');

        dbClient.isSupabaseConfigured = true;
        dbClient.getSqliteDb = () => { throw new Error('SQLite fallback attempted'); };
        const dbError = { code: '42501', message: 'review access denied' };
        let reads = 0;
        dbClient.getSupabaseClient = () => ({
            from(table) {
                assert.equal(table, 'reviews');
                return {
                    select() {
                        return {
                            eq() {
                                return {
                                    order() {
                                        return { limit: async () => {
                                            reads++;
                                            return { data: null, error: dbError };
                                        } };
                                    }
                                };
                            },
                            order: async () => ({ data: null, error: dbError })
                        };
                    },
                    insert: async () => ({ data: null, error: dbError })
                };
            }
        });

        await assert.rejects(reviewRepository.getVenueReviews('read-error'), e => e === dbError);
        await assert.rejects(reviewRepository.getVenueReviews('read-error'), e => e === dbError);
        assert.equal(reads, 2, 'a failed read must not cache an empty result');
        await assert.rejects(reviewRepository.preloadAllReviews(), e => e === dbError);
        await assert.rejects(reviewRepository.addVenueReview({ venueId: 'write-error', content: 'Test' }), e => e === dbError);

        const readResponse = await fetch(`${base}/api/venues/api-read-error/reviews`);
        assert.equal(readResponse.status, 500);
        const writeResponse = await fetch(`${base}/api/venues/api-write-error/reviews`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: 'Test', rating: 4 })
        });
        assert.equal(writeResponse.status, 500, 'database denial must not become HTTP 201');

        dbClient.getSupabaseClient = () => ({
            from(table) {
                assert.equal(table, 'reviews');
                return {
                    select() {
                        return { eq() { return { order() { return {
                            limit: async () => ({ data: [{ id: 'ok', venue_id: 'read-success', rating: 4 }], error: null })
                        }; } }; } };
                    },
                    insert: async () => ({ data: null, error: null })
                };
            }
        });
        const reviews = await reviewRepository.getVenueReviews('read-success');
        assert.equal(reviews.length, 1);
        assert.equal(reviews[0].id, 'ok');
        assert.equal((await reviewRepository.addVenueReview({ venueId: 'write-success', content: 'Test' })).success, true);

        dbClient.getSupabaseClient = () => null;
        await assert.rejects(reviewRepository.getVenueReviews('no-client'), /Supabase review client is unavailable/);
        await assert.rejects(reviewRepository.addVenueReview({ venueId: 'no-client', content: 'Test' }), /Supabase review client is unavailable/);

        dbClient.isSupabaseConfigured = false;
        dbClient.getSqliteDb = () => null;
        await assert.rejects(reviewRepository.addVenueReview({ venueId: 'no-db', content: 'Test' }), /Review database is unavailable/);
        console.log('Review security regression tests passed');
    } finally {
        dbClient.isSupabaseConfigured = original.configured;
        dbClient.getSupabaseClient = original.client;
        dbClient.getSqliteDb = original.sqlite;
        if (original.mapsKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
        else process.env.GOOGLE_MAPS_API_KEY = original.mapsKey;
        await new Promise(resolve => server.close(resolve));
        try { fs.unlinkSync(testDbPath); } catch (_) {}
    }
}

run().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
