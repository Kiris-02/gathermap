/**
 * Database Client & Connection Manager
 * Manages dual-mode connectivity: Supabase Cloud (PostgreSQL) and Local SQLite (better-sqlite3)
 */

const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
require('dotenv').config();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY && SUPABASE_URL.startsWith('http'));

let supabaseClient = null;
let sqliteDb = null;

if (isSupabaseConfigured) {
    try {
        supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
            auth: { persistSession: false }
        });
        console.log('✅ Connected to Supabase Cloud Database:', SUPABASE_URL);
    } catch (err) {
        console.warn('⚠️ Supabase connection failed, falling back to SQLite:', err.message);
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
            UNIQUE(outing_id, voter_name, venue_id)
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
                        UNIQUE(outing_id, voter_name, venue_id)
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
}

module.exports = {
    isSupabaseConfigured,
    dbType: isSupabaseConfigured ? 'Supabase Cloud Database (PostgreSQL)' : 'Local SQLite Database (gathermap.db)',
    getSupabaseClient: () => supabaseClient,
    getSqliteDb: () => sqliteDb
};
