-- ============================================================================
-- GatherMap Supabase Test Suite: RLS Security, Permissions & Migration Dedup
-- Target: Migration 20260926000004_voter_identity_and_outing_fields.sql
-- ============================================================================

BEGIN;

-- 1. Setup Test Fixture: Pre-migration data in legacy format
-- Simulate pre-migration tables
CREATE TEMP TABLE fixture_outings (
    id TEXT PRIMARY KEY,
    name TEXT,
    mode TEXT,
    center_lat REAL,
    center_lng REAL,
    radius_km REAL,
    status TEXT DEFAULT 'active'
);

CREATE TEMP TABLE fixture_votes (
    id TEXT PRIMARY KEY,
    outing_id TEXT NOT NULL,
    venue_id TEXT NOT NULL,
    voter_name TEXT NOT NULL,
    voter_id TEXT,
    created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO fixture_outings (id, name, mode, center_lat, center_lng, radius_km)
VALUES ('out-fixture-01', 'Old Group Meetup', 'representative', 10.7769, 106.7009, 3.0);

-- Case 1: Identifiable voter (voter_1) with 3 votes (2 older, 1 newer)
INSERT INTO fixture_votes (id, outing_id, venue_id, voter_name, voter_id, created_at)
VALUES
    ('v-1-old-1', 'out-fixture-01', 'venue-A', 'Alice', 'voter_alice', '2026-09-01 10:00:00+07'),
    ('v-1-old-2', 'out-fixture-01', 'venue-B', 'Alice', 'voter_alice', '2026-09-01 11:00:00+07'),
    ('v-1-latest', 'out-fixture-01', 'venue-C', 'Alice', 'voter_alice', '2026-09-01 12:00:00+07');

-- Case 2: Identifiable voter with identical created_at to test tie-breaking by id
INSERT INTO fixture_votes (id, outing_id, venue_id, voter_name, voter_id, created_at)
VALUES
    ('v-tie-10', 'out-fixture-01', 'venue-A', 'TieBreaker', 'voter_tie', '2026-09-01 10:00:00+07'),
    ('v-tie-20', 'out-fixture-01', 'venue-B', 'TieBreaker', 'voter_tie', '2026-09-01 10:00:00+07');

-- Case 3: Distinct voter with identical display name 'Alice' (voter_id = 'voter_alice_2')
INSERT INTO fixture_votes (id, outing_id, venue_id, voter_name, voter_id, created_at)
VALUES
    ('v-alice2-active', 'out-fixture-01', 'venue-A', 'Alice', 'voter_alice_2', '2026-09-01 11:30:00+07');

-- Case 4: Legacy voter (voter_id IS NULL) with multiple votes
INSERT INTO fixture_votes (id, outing_id, venue_id, voter_name, voter_id, created_at)
VALUES
    ('v-leg-old', 'out-fixture-01', 'venue-A', 'Legacy Bob', NULL, '2026-09-01 09:00:00+07'),
    ('v-leg-latest', 'out-fixture-01', 'venue-B', 'Legacy Bob', NULL, '2026-09-01 10:30:00+07');

-- Case 5: Distinct legacy voter (voter_id IS NULL, voter_name = 'Legacy Charlie')
INSERT INTO fixture_votes (id, outing_id, venue_id, voter_name, voter_id, created_at)
VALUES
    ('v-charlie-active', 'out-fixture-01', 'venue-A', 'Legacy Charlie', NULL, '2026-09-01 09:15:00+07');

-- Total initial rows = 9
DO $$
DECLARE
    cnt INT;
BEGIN
    SELECT count(*) INTO cnt FROM fixture_votes;
    IF cnt <> 9 THEN
        RAISE EXCEPTION 'Fixture setup failed: expected 9 initial votes, got %', cnt;
    END IF;
END $$;

-- 2. Execute deduplication CTE on fixture
CREATE TEMP TABLE fixture_votes_archive (
    archive_id BIGSERIAL PRIMARY KEY,
    id TEXT,
    outing_id TEXT,
    venue_id TEXT,
    voter_name TEXT,
    voter_id TEXT,
    created_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    archive_reason TEXT
);

-- Dedup identifiable voters
WITH ranked_voter_id_votes AS (
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at,
           ROW_NUMBER() OVER (
               PARTITION BY outing_id, voter_id
               ORDER BY created_at DESC NULLS LAST, id DESC
           ) as rn
    FROM fixture_votes
    WHERE voter_id IS NOT NULL
),
duplicates_voter_id AS (
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at
    FROM ranked_voter_id_votes
    WHERE rn > 1
)
INSERT INTO fixture_votes_archive (id, outing_id, venue_id, voter_name, voter_id, created_at, archive_reason)
SELECT id, outing_id, venue_id, voter_name, voter_id, created_at, 'superseded_duplicate_voter_id'
FROM duplicates_voter_id;

DELETE FROM fixture_votes
WHERE id IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY outing_id, voter_id
            ORDER BY created_at DESC NULLS LAST, id DESC
        ) as rn
        FROM fixture_votes
        WHERE voter_id IS NOT NULL
    ) ranked WHERE rn > 1
);

-- Dedup legacy voters
WITH ranked_legacy_votes AS (
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at,
           ROW_NUMBER() OVER (
               PARTITION BY outing_id, voter_name
               ORDER BY created_at DESC NULLS LAST, id DESC
           ) as rn
    FROM fixture_votes
    WHERE voter_id IS NULL
),
duplicates_legacy AS (
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at
    FROM ranked_legacy_votes
    WHERE rn > 1
)
INSERT INTO fixture_votes_archive (id, outing_id, venue_id, voter_name, voter_id, created_at, archive_reason)
SELECT id, outing_id, venue_id, voter_name, voter_id, created_at, 'superseded_duplicate_legacy_voter_name'
FROM duplicates_legacy;

DELETE FROM fixture_votes
WHERE id IN (
    SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
            PARTITION BY outing_id, voter_name
            ORDER BY created_at DESC NULLS LAST, id DESC
        ) as rn
        FROM fixture_votes
        WHERE voter_id IS NULL
    ) ranked WHERE rn > 1
);

-- 3. Assert Deduplication Results
DO $$
DECLARE
    active_cnt INT;
    archive_cnt INT;
    alice_vote TEXT;
    tie_vote TEXT;
    alice2_vote TEXT;
    bob_vote TEXT;
    charlie_vote TEXT;
BEGIN
    SELECT count(*) INTO active_cnt FROM fixture_votes;
    SELECT count(*) INTO archive_cnt FROM fixture_votes_archive;

    -- Expected active votes = 5 (Alice, TieBreaker, Alice2, Bob, Charlie)
    IF active_cnt <> 5 THEN
        RAISE EXCEPTION 'Assertion Failed: expected 5 active votes, got %', active_cnt;
    END IF;

    -- Expected archived votes = 4 (v-1-old-1, v-1-old-2, v-tie-10, v-leg-old)
    IF archive_cnt <> 4 THEN
        RAISE EXCEPTION 'Assertion Failed: expected 4 archived votes, got %', archive_cnt;
    END IF;

    -- Verify Alice retained newest vote (v-1-latest)
    SELECT id INTO alice_vote FROM fixture_votes WHERE voter_id = 'voter_alice';
    IF alice_vote <> 'v-1-latest' THEN
        RAISE EXCEPTION 'Assertion Failed: Alice active vote should be v-1-latest, got %', alice_vote;
    END IF;

    -- Verify tie breaker retained larger id (v-tie-20)
    SELECT id INTO tie_vote FROM fixture_votes WHERE voter_id = 'voter_tie';
    IF tie_vote <> 'v-tie-20' THEN
        RAISE EXCEPTION 'Assertion Failed: Tie breaker active vote should be v-tie-20, got %', tie_vote;
    END IF;

    -- Verify Alice2 (same display name) was preserved independently
    SELECT id INTO alice2_vote FROM fixture_votes WHERE voter_id = 'voter_alice_2';
    IF alice2_vote <> 'v-alice2-active' THEN
        RAISE EXCEPTION 'Assertion Failed: Alice2 should be preserved, got %', alice2_vote;
    END IF;

    -- Verify legacy Bob retained newest vote (v-leg-latest)
    SELECT id INTO bob_vote FROM fixture_votes WHERE voter_name = 'Legacy Bob';
    IF bob_vote <> 'v-leg-latest' THEN
        RAISE EXCEPTION 'Assertion Failed: Legacy Bob active vote should be v-leg-latest, got %', bob_vote;
    END IF;

    -- Verify legacy Charlie was preserved
    SELECT id INTO charlie_vote FROM fixture_votes WHERE voter_name = 'Legacy Charlie';
    IF charlie_vote <> 'v-charlie-active' THEN
        RAISE EXCEPTION 'Assertion Failed: Legacy Charlie should be preserved, got %', charlie_vote;
    END IF;

    RAISE NOTICE '✅ Migration CTE Deduplication Test: ALL ASSERTIONS PASSED (5 active, 4 archived).';
END $$;

-- 4. Assert Idempotency (Second Pass causes 0 additional archive rows)
DO $$
DECLARE
    second_pass_archive_cnt INT;
BEGIN
    -- Re-run deduplication CTE on already deduplicated fixture
    WITH ranked_voter_id_votes AS (
        SELECT id, outing_id, venue_id, voter_name, voter_id, created_at,
               ROW_NUMBER() OVER (
                   PARTITION BY outing_id, voter_id
                   ORDER BY created_at DESC NULLS LAST, id DESC
               ) as rn
        FROM fixture_votes
        WHERE voter_id IS NOT NULL
    ),
    duplicates_voter_id AS (
        SELECT id, outing_id, venue_id, voter_name, voter_id, created_at
        FROM ranked_voter_id_votes
        WHERE rn > 1
    )
    INSERT INTO fixture_votes_archive (id, outing_id, venue_id, voter_name, voter_id, created_at, archive_reason)
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at, 'superseded_duplicate_voter_id'
    FROM duplicates_voter_id;

    SELECT count(*) INTO second_pass_archive_cnt FROM fixture_votes_archive;
    IF second_pass_archive_cnt <> 4 THEN
        RAISE EXCEPTION 'Idempotency Assertion Failed: archive count increased from 4 to %', second_pass_archive_cnt;
    END IF;

    RAISE NOTICE '✅ Migration Idempotency Test: PASSED (0 additional rows archived on second pass).';
END $$;

-- 5. Row Level Security & Grants Audit Query for Production Validation
-- This query can be run on Supabase database to verify strict privacy
SELECT
    schemaname,
    tablename,
    rowsecurity as rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('outings', 'participants', 'recommendations', 'votes', 'votes_dedup_archive', 'venues', 'reviews')
ORDER BY tablename;

-- Verify policies
SELECT
    schemaname,
    tablename,
    policyname,
    roles,
    cmd,
    qual
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

ROLLBACK;
