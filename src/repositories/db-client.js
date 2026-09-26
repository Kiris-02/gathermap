/**
 * Database Client & Connection Manager
 * Manages dual-mode connectivity: Supabase Cloud (PostgreSQL) and Local SQLite (better-sqlite3)
 */

const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let isSupabaseConfigured = false;
let supabaseClient = null;
let sqliteDb = null;

if (SUPABASE_URL && SUPABASE_URL.startsWith('http')) {
    if (SUPABASE_SERVICE_ROLE_KEY) {
        try {
            supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
                auth: { persistSession: false }
            });
            isSupabaseConfigured = true;
            console.log('✅ Connected to Supabase Cloud Database (service_role):', SUPABASE_URL);
        } catch (err) {
            console.warn('⚠️ Supabase service_role connection failed, falling back to SQLite:', err.message);
            supabaseClient = null;
            isSupabaseConfigured = false;
        }
    } else {
        console.warn('⚠️ Warning: SUPABASE_URL is set, but SUPABASE_SERVICE_ROLE_KEY is missing.');
        console.warn('   Under strict Row Level Security (RLS), the backend requires SUPABASE_SERVICE_ROLE_KEY for private session storage.');
        console.warn('   Disabling Supabase cloud persistence and falling back safely to local SQLite storage.');
        isSupabaseConfigured = false;
        supabaseClient = null;
    }
}

// Always ensure SQLite is available as local storage & deterministic test engine
const dbPath = process.env.SQLITE_DB_PATH || path.join(__dirname, '..', '..', 'gathermap.db');
try {
    sqliteDb = new Database(dbPath);
    initSqliteSchema(sqliteDb);
} catch (err) {
    console.error('❌ SQLite initialization error:', err.message);
}

function initSqliteSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS outings (
            id TEXT PRIMARY KEY,
            name TEXT,
            mode TEXT DEFAULT 'representative',
            center_lat REAL NOT NULL,
            center_lng REAL NOT NULL,
            radius_km REAL NOT NULL DEFAULT 3.0,
            status TEXT NOT NULL DEFAULT 'active',
            share_token_hash TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS participants (
            id TEXT PRIMARY KEY,
            outing_id TEXT NOT NULL,
            name TEXT NOT NULL,
            district TEXT,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            wish TEXT,
            is_me INTEGER DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(outing_id) REFERENCES outings(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS venues (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            category TEXT NOT NULL,
            type TEXT NOT NULL,
            is_alley INTEGER DEFAULT 0,
            alley_note TEXT,
            address TEXT NOT NULL,
            place_id TEXT,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            rating REAL DEFAULT 4.5,
            reviews_count INTEGER DEFAULT 100,
            price_per_person_vnd INTEGER DEFAULT 60000,
            avg_price TEXT DEFAULT '35k - 80k VND',
            tags TEXT DEFAULT '[]',
            attributes TEXT DEFAULT '{}',
            unknowns TEXT DEFAULT '[]',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS recommendations (
            id TEXT PRIMARY KEY,
            outing_id TEXT NOT NULL,
            venue_id TEXT NOT NULL,
            group_score REAL NOT NULL,
            avg_score REAL NOT NULL,
            lowest_score REAL NOT NULL,
            ai_rationale TEXT NOT NULL,
            dist_from_center_km REAL,
            member_breakdowns TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(outing_id) REFERENCES outings(id) ON DELETE CASCADE,
            FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS votes (
            id TEXT PRIMARY KEY,
            outing_id TEXT NOT NULL,
            venue_id TEXT NOT NULL,
            voter_name TEXT NOT NULL,
            voter_id TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(outing_id) REFERENCES outings(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY,
            venue_id TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'google',
            author_name TEXT NOT NULL,
            author_avatar TEXT,
            rating REAL DEFAULT 5.0,
            content TEXT NOT NULL,
            sentiment TEXT DEFAULT 'positive',
            tags TEXT DEFAULT '[]',
            likes_count INTEGER DEFAULT 0,
            review_date TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(venue_id) REFERENCES venues(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_venues_spatial ON venues(lat, lng);
        CREATE INDEX IF NOT EXISTS idx_reviews_venue ON reviews(venue_id);
        CREATE INDEX IF NOT EXISTS idx_votes_outing ON votes(outing_id);
        CREATE INDEX IF NOT EXISTS idx_participants_outing ON participants(outing_id);
    `);

    // Migration 1: Safe migration of legacy INTEGER id in votes to TEXT PRIMARY KEY without data loss
    try {
        const columns = db.pragma('table_info(votes)');
        const idCol = columns.find(c => c.name === 'id');
        if (idCol && idCol.type && idCol.type.toUpperCase().includes('INT')) {
            db.transaction(() => {
                db.exec(`
                    CREATE TABLE IF NOT EXISTS votes_new_text_pk (
                        id TEXT PRIMARY KEY,
                        outing_id TEXT NOT NULL,
                        venue_id TEXT NOT NULL,
                        voter_name TEXT NOT NULL,
                        voter_id TEXT,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY(outing_id) REFERENCES outings(id) ON DELETE CASCADE
                    );
                    INSERT OR IGNORE INTO votes_new_text_pk (id, outing_id, venue_id, voter_name, voter_id, created_at)
                    SELECT 'vote-' || CAST(id AS TEXT), outing_id, venue_id, voter_name, voter_id, created_at FROM votes;
                    DROP TABLE votes;
                    ALTER TABLE votes_new_text_pk RENAME TO votes;
                    CREATE INDEX IF NOT EXISTS idx_votes_outing ON votes(outing_id);
                `);
            })();
        }
    } catch (_) {}

    // Migration 2: Ensure voter_id column exists
    try {
        db.exec(`ALTER TABLE votes ADD COLUMN voter_id TEXT;`);
    } catch (_) {}

    // Migration 3: Ensure share_token_hash column exists on outings
    try {
        const outingCols = db.pragma('table_info(outings)');
        const tokenCol = outingCols.find(c => c.name === 'share_token_hash');
        if (!tokenCol) {
            db.exec(`ALTER TABLE outings ADD COLUMN share_token_hash TEXT;`);
        }
    } catch (_) {}

    // Migration 4: Safe column additions for recommendations (dist_from_center_km, member_breakdowns)
    try {
        db.exec(`ALTER TABLE recommendations ADD COLUMN dist_from_center_km REAL;`);
    } catch (_) {}
    try {
        db.exec(`ALTER TABLE recommendations ADD COLUMN member_breakdowns TEXT;`);
    } catch (_) {}

    // Migration 5: Replace old UNIQUE(outing_id, voter_name, venue_id) with stable voter identity indexes & audit archive
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS votes_dedup_archive (
                archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT,
                outing_id TEXT,
                venue_id TEXT,
                voter_name TEXT,
                voter_id TEXT,
                created_at TEXT,
                archived_at TEXT DEFAULT CURRENT_TIMESTAMP,
                archive_reason TEXT
            );
        `);

        const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='votes'").get();
        if (tableSql && tableSql.sql && tableSql.sql.includes('UNIQUE(outing_id, voter_name, venue_id)')) {
            db.transaction(() => {
                db.exec(`
                    CREATE TABLE votes_voter_id_clean (
                        id TEXT PRIMARY KEY,
                        outing_id TEXT NOT NULL,
                        venue_id TEXT NOT NULL,
                        voter_name TEXT NOT NULL,
                        voter_id TEXT,
                        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY(outing_id) REFERENCES outings(id) ON DELETE CASCADE
                    );
                    INSERT OR IGNORE INTO votes_voter_id_clean (id, outing_id, venue_id, voter_name, voter_id, created_at)
                    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at FROM votes;
                    DROP TABLE votes;
                    ALTER TABLE votes_voter_id_clean RENAME TO votes;
                    CREATE INDEX IF NOT EXISTS idx_votes_outing ON votes(outing_id);
                `);
            })();
        }

        // Deduplicate identifiable voters (voter_id IS NOT NULL) before creating unique index
        db.transaction(() => {
            db.exec(`
                INSERT INTO votes_dedup_archive (id, outing_id, venue_id, voter_name, voter_id, created_at, archive_reason)
                SELECT id, outing_id, venue_id, voter_name, voter_id, created_at, 'superseded_duplicate_voter_id'
                FROM votes
                WHERE voter_id IS NOT NULL AND id NOT IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY outing_id, voter_id 
                            ORDER BY created_at DESC, id DESC
                        ) as rn
                        FROM votes
                        WHERE voter_id IS NOT NULL
                    ) WHERE rn = 1
                );

                DELETE FROM votes
                WHERE voter_id IS NOT NULL AND id NOT IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY outing_id, voter_id 
                            ORDER BY created_at DESC, id DESC
                        ) as rn
                        FROM votes
                        WHERE voter_id IS NOT NULL
                    ) WHERE rn = 1
                );

                INSERT INTO votes_dedup_archive (id, outing_id, venue_id, voter_name, voter_id, created_at, archive_reason)
                SELECT id, outing_id, venue_id, voter_name, voter_id, created_at, 'superseded_duplicate_legacy_voter_name'
                FROM votes
                WHERE voter_id IS NULL AND id NOT IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY outing_id, voter_name 
                            ORDER BY created_at DESC, id DESC
                        ) as rn
                        FROM votes
                        WHERE voter_id IS NULL
                    ) WHERE rn = 1
                );

                DELETE FROM votes
                WHERE voter_id IS NULL AND id NOT IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY outing_id, voter_name 
                            ORDER BY created_at DESC, id DESC
                        ) as rn
                        FROM votes
                        WHERE voter_id IS NULL
                    ) WHERE rn = 1
                );
            `);
        })();
    } catch (_) {}

    // Ensure non-colliding unique partial indexes exist in SQLite
    try {
        db.exec(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_votes_voter_id ON votes(outing_id, voter_id) WHERE voter_id IS NOT NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_votes_legacy_name ON votes(outing_id, voter_name) WHERE voter_id IS NULL;
        `);
    } catch (_) {}

    // Seed: Ensure venues table is populated from initial-venues.json if empty
    try {
        const countRow = db.prepare('SELECT count(*) as count FROM venues').get();
        if (!countRow || countRow.count === 0) {
            const initialVenues = require('../data/initial-venues.json');
            const insertStmt = db.prepare(`
                INSERT OR IGNORE INTO venues (
                    id, name, category, type, is_alley, alley_note, address, place_id,
                    lat, lng, rating, reviews_count, price_per_person_vnd, avg_price,
                    tags, attributes, unknowns
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertMany = db.transaction((venues) => {
                for (const v of venues) {
                    insertStmt.run(
                        v.id,
                        v.name,
                        v.category || 'Ăn uống',
                        v.type || 'restaurant',
                        v.isAlley ? 1 : 0,
                        v.alleyNote || '',
                        v.address || '',
                        v.placeId || '',
                        Number(v.lat),
                        Number(v.lng),
                        v.rating != null ? Number(v.rating) : 4.5,
                        v.reviewsCount != null ? Number(v.reviewsCount) : 100,
                        v.pricePerPersonVnd != null ? Number(v.pricePerPersonVnd) : 60000,
                        v.avgPrice || '35k - 80k VND',
                        JSON.stringify(v.tags || []),
                        JSON.stringify(v.attributes || v.traits || {}),
                        JSON.stringify(v.unknowns || [])
                    );
                }
            });
            insertMany(initialVenues);
        }
    } catch (_) {}

    // Seed: Ensure reviews table is populated from initial-reviews.json if empty
    try {
        const revCountRow = db.prepare('SELECT count(*) as count FROM reviews').get();
        if (!revCountRow || revCountRow.count === 0) {
            const initialReviews = require('../data/initial-reviews.json');
            const insertRevStmt = db.prepare(`
                INSERT OR IGNORE INTO reviews (
                    id, venue_id, source, author_name, author_avatar, rating,
                    content, sentiment, tags, likes_count, review_date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const insertManyReviews = db.transaction((revs) => {
                for (const r of revs) {
                    insertRevStmt.run(
                        r.id,
                        r.venue_id,
                        r.source || 'google',
                        r.author_name || 'Khách hàng',
                        r.author_avatar || null,
                        r.rating != null ? Number(r.rating) : 5.0,
                        r.content || '',
                        r.sentiment || 'positive',
                        JSON.stringify(r.tags || []),
                        r.likes_count != null ? Number(r.likes_count) : 0,
                        r.review_date || null
                    );
                }
            });
            insertManyReviews(initialReviews);
        }
    } catch (_) {}
}

module.exports = {
    get isSupabaseConfigured() {
        return isSupabaseConfigured;
    },
    set isSupabaseConfigured(val) {
        isSupabaseConfigured = val;
    },
    get dbType() {
        return isSupabaseConfigured ? 'Supabase Cloud Database (PostgreSQL)' : 'Local SQLite Database (gathermap.db)';
    },
    getSupabaseClient: () => supabaseClient,
    getSqliteDb: () => sqliteDb,
    initSqliteSchema
};
