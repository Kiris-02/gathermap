-- GatherMap Migration: Stable Voter Identity, Additive Outing Fields & Compatibility Constraints
-- 1. Ensure outings table has name and mode columns
-- 2. Ensure votes table has voter_id column
-- 3. Replace unique_outing_voter_venue constraint with stable voter identity constraints
--    - Identifiable voters (voter_id IS NOT NULL): one vote per outing (outing_id, voter_id)
--    - Legacy voters (voter_id IS NULL): one vote per outing & voter_name (outing_id, voter_name)
-- 4. Pre-index Deduplication with Non-Destructive Audit Archive:
--    - Preserves the latest vote per voter identity (by created_at DESC, id DESC).
--    - Archives superseded duplicate rows into votes_dedup_archive with clear audit metadata.
-- 5. Safe, idempotent, and re-runnable without side-effects.

-- 1. Add missing name and mode columns to outings if not already present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'outings' AND column_name = 'name'
    ) THEN
        ALTER TABLE outings ADD COLUMN name TEXT DEFAULT 'Weekend Hangout';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'outings' AND column_name = 'mode'
    ) THEN
        ALTER TABLE outings ADD COLUMN mode TEXT DEFAULT 'representative';
    END IF;
END $$;

-- 2. Add voter_id column to votes if not already present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'votes' AND column_name = 'voter_id'
    ) THEN
        ALTER TABLE votes ADD COLUMN voter_id TEXT;
    END IF;
END $$;

-- 3. Drop old constraint that collided distinct voters with identical display names
ALTER TABLE votes DROP CONSTRAINT IF EXISTS unique_outing_voter_venue;

-- 4. Create audit / backup table for archived superseded votes
CREATE TABLE IF NOT EXISTS votes_dedup_archive (
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

-- 5. Pre-index Deduplication for Identifiable Voters (voter_id IS NOT NULL)
-- Archive superseded votes (keeps the most recent vote by created_at DESC, id DESC)
WITH ranked_voter_id_votes AS (
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at,
           ROW_NUMBER() OVER (
               PARTITION BY outing_id, voter_id 
               ORDER BY created_at DESC NULLS LAST, id DESC
           ) as rn
    FROM votes
    WHERE voter_id IS NOT NULL
),
duplicates_voter_id AS (
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at
    FROM ranked_voter_id_votes
    WHERE rn > 1
)
INSERT INTO votes_dedup_archive (id, outing_id, venue_id, voter_name, voter_id, created_at, archive_reason)
SELECT id, outing_id, venue_id, voter_name, voter_id, created_at, 'superseded_duplicate_voter_id'
FROM duplicates_voter_id;

-- Delete superseded duplicate votes where voter_id IS NOT NULL
WITH ranked_voter_id_votes AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY outing_id, voter_id 
               ORDER BY created_at DESC NULLS LAST, id DESC
           ) as rn
    FROM votes
    WHERE voter_id IS NOT NULL
)
DELETE FROM votes
WHERE id IN (
    SELECT id FROM ranked_voter_id_votes WHERE rn > 1
);

-- 6. Pre-index Deduplication for Legacy Voters (voter_id IS NULL)
-- Archive superseded votes (keeps the most recent vote by created_at DESC, id DESC)
WITH ranked_legacy_votes AS (
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at,
           ROW_NUMBER() OVER (
               PARTITION BY outing_id, voter_name 
               ORDER BY created_at DESC NULLS LAST, id DESC
           ) as rn
    FROM votes
    WHERE voter_id IS NULL
),
duplicates_legacy AS (
    SELECT id, outing_id, venue_id, voter_name, voter_id, created_at
    FROM ranked_legacy_votes
    WHERE rn > 1
)
INSERT INTO votes_dedup_archive (id, outing_id, venue_id, voter_name, voter_id, created_at, archive_reason)
SELECT id, outing_id, venue_id, voter_name, voter_id, created_at, 'superseded_duplicate_legacy_voter_name'
FROM duplicates_legacy;

-- Delete superseded duplicate legacy votes where voter_id IS NULL
WITH ranked_legacy_votes AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY outing_id, voter_name 
               ORDER BY created_at DESC NULLS LAST, id DESC
           ) as rn
    FROM votes
    WHERE voter_id IS NULL
)
DELETE FROM votes
WHERE id IN (
    SELECT id FROM ranked_legacy_votes WHERE rn > 1
);

-- 7. Create partial unique indexes for stable voter identity
-- Enforce 1 vote per participant per outing when voter_id is present
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_votes_outing_voter_id 
ON votes(outing_id, voter_id) 
WHERE voter_id IS NOT NULL;

-- Enforce 1 vote per participant per outing for legacy records where voter_id is NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_votes_outing_voter_name_legacy 
ON votes(outing_id, voter_name) 
WHERE voter_id IS NULL;
