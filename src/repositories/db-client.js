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
const dbPath = path.join(__dirname, '..', '..', 'gathermap.db');
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

    // Safe forward-compatible migrations on existing SQLite databases
    try {
        sqliteDb.exec(`ALTER TABLE votes ADD COLUMN voter_id TEXT;`);
    } catch (_) {}
}

module.exports = {
    isSupabaseConfigured,
    dbType: isSupabaseConfigured ? 'Supabase Cloud Database (PostgreSQL)' : 'Local SQLite Database (gathermap.db)',
    getSupabaseClient: () => supabaseClient,
    getSqliteDb: () => sqliteDb
};
