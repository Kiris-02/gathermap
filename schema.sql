-- Group Eatery App: Supabase PostgreSQL Database Schema
-- Conforms to Version 1 Product and Technical Specification (12 September 2026)

-- 1. Outings Table (Temporary or persistent group sessions)
CREATE TABLE IF NOT EXISTS outings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    center_lat DOUBLE PRECISION NOT NULL,
    center_lng DOUBLE PRECISION NOT NULL,
    radius_km DOUBLE PRECISION NOT NULL DEFAULT 3.0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '24 hours')
);

-- 2. Participants Table (Group members, starting locations, and freestyle wishes)
CREATE TABLE IF NOT EXISTS participants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outing_id UUID NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
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
    address TEXT NOT NULL,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    rating DOUBLE PRECISION DEFAULT 4.5,
    reviews_count INT DEFAULT 100,
    avg_price TEXT DEFAULT '35k - 80k VND',
    tags JSONB DEFAULT '[]'::jsonb,
    traits JSONB DEFAULT '{}'::jsonb,
    verified BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Recommendations Table (Historical run scores and AI rationales)
CREATE TABLE IF NOT EXISTS recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outing_id UUID NOT NULL REFERENCES outings(id) ON DELETE CASCADE,
    venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    group_score DOUBLE PRECISION NOT NULL,
    avg_score DOUBLE PRECISION NOT NULL,
    lowest_score DOUBLE PRECISION NOT NULL,
    ai_rationale TEXT NOT NULL,
    travel_times JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for fast spatial queries
CREATE INDEX IF NOT EXISTS idx_venues_lat_lng ON venues(lat, lng);
CREATE INDEX IF NOT EXISTS idx_participants_outing ON participants(outing_id);
