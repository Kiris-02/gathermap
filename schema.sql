-- Group Eatery App: Unified PostgreSQL Database Schema (Supabase & Production)
-- Conforms to Version 1 Product and Technical Specification & Modern Architectural Standards

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Outings Table (Temporary or persistent group sessions)
CREATE TABLE IF NOT EXISTS outings (
    id TEXT PRIMARY KEY,
    name TEXT DEFAULT 'Weekend Hangout',
    mode TEXT DEFAULT 'representative',
    center_lat DOUBLE PRECISION NOT NULL,
    center_lng DOUBLE PRECISION NOT NULL,
    radius_km DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours')
);

-- 2. Participants Table (Group members, starting locations, and freestyle wishes)
CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    outing_id TEXT NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    district TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    wish TEXT,
    is_me BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Venues Table (Hybrid database: Place IDs + First-party curated attributes)
CREATE TABLE IF NOT EXISTS venues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'restaurant',
    is_alley BOOLEAN DEFAULT false,
    alley_note TEXT DEFAULT '',
    address TEXT NOT NULL,
    place_id TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    rating DOUBLE PRECISION DEFAULT 4.5,
    reviews_count INT DEFAULT 100,
    price_per_person_vnd INT DEFAULT 60000,
    avg_price TEXT DEFAULT '35k - 80k VND',
    tags JSONB DEFAULT '[]'::jsonb,
    traits JSONB DEFAULT '{}'::jsonb,
    attributes JSONB DEFAULT '{}'::jsonb,
    unknowns JSONB DEFAULT '[]'::jsonb,
    verified BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Recommendations Table (Historical run scores and AI rationales)
CREATE TABLE IF NOT EXISTS recommendations (
    id TEXT PRIMARY KEY,
    outing_id TEXT NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
    venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    group_score DOUBLE PRECISION NOT NULL,
    avg_score DOUBLE PRECISION NOT NULL,
    lowest_score DOUBLE PRECISION NOT NULL,
    ai_rationale TEXT NOT NULL,
    travel_times JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Votes Table (One vote per user per venue per outing)
CREATE TABLE IF NOT EXISTS votes (
    id TEXT PRIMARY KEY,
    outing_id TEXT NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
    venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    voter_name TEXT NOT NULL,
    voter_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT unique_outing_voter_venue UNIQUE (outing_id, voter_name, venue_id)
);

-- 6. Reviews Table (Authentic reviews from Google, TikTok, Facebook, ShopeeFood, Users)
CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'user',
    author_name TEXT NOT NULL,
    author_avatar TEXT,
    rating DOUBLE PRECISION NOT NULL DEFAULT 5.0,
    date_text TEXT,
    content TEXT NOT NULL,
    sentiment TEXT DEFAULT 'positive',
    tags JSONB DEFAULT '[]'::jsonb,
    likes_count INT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance & spatial queries
CREATE INDEX IF NOT EXISTS idx_venues_lat_lng ON venues(lat, lng);
CREATE INDEX IF NOT EXISTS idx_participants_outing ON participants(outing_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_outing ON recommendations(outing_id);
CREATE INDEX IF NOT EXISTS idx_votes_outing ON votes(outing_id);
CREATE INDEX IF NOT EXISTS idx_reviews_venue ON reviews(venue_id);
