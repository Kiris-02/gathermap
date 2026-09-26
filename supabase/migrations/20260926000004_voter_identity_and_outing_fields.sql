-- GatherMap Migration: Stable Voter Identity, Additive Outing Fields & Compatibility Constraints
-- 1. Ensure outings table has name and mode columns
-- 2. Ensure votes table has voter_id column
-- 3. Replace unique_outing_voter_venue constraint with stable voter identity constraints
--    - Identifiable voters (voter_id IS NOT NULL): one vote per outing (outing_id, voter_id)
--    - Legacy voters (voter_id IS NULL): one vote per outing & voter_name (outing_id, voter_name)
-- 4. Preserve all existing historical vote data without destructive changes.

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

-- 4. Create partial unique indexes for stable voter identity
-- Enforce 1 vote per participant per outing when voter_id is present
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_votes_outing_voter_id 
ON votes(outing_id, voter_id) 
WHERE voter_id IS NOT NULL;

-- Enforce 1 vote per participant per outing for legacy records where voter_id is NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_votes_outing_voter_name_legacy 
ON votes(outing_id, voter_name) 
WHERE voter_id IS NULL;
