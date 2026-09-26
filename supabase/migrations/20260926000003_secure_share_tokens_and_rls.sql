-- GatherMap Migration: Secure Share Tokens, Data Preservation & Strict Privacy RLS
-- 1. Add share_token_hash column to outings for cryptographically secure access delegation.
--    NOTE: Does NOT destructively backfill legacy outings with unrecoverable hashes.
--    Legacy outings (share_token_hash IS NULL) transition smoothly via application-level upgrade upon access.
-- 2. Add dist_from_center_km and member_breakdowns to recommendations for complete data restoration.
-- 3. Revoke public direct SELECT access on private tables (outings, participants, recommendations, votes).
--    All private outing and location access must be authorized via the backend service_role using valid share tokens.
-- 4. Venues and reviews remain public read-only.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Add share_token_hash to outings if not already present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'outings' AND column_name = 'share_token_hash'
    ) THEN
        ALTER TABLE outings ADD COLUMN share_token_hash TEXT;
    END IF;
END $$;

-- 2. Add dist_from_center_km and member_breakdowns to recommendations if not present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'recommendations' AND column_name = 'dist_from_center_km'
    ) THEN
        ALTER TABLE recommendations ADD COLUMN dist_from_center_km REAL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'recommendations' AND column_name = 'member_breakdowns'
    ) THEN
        ALTER TABLE recommendations ADD COLUMN member_breakdowns TEXT;
    END IF;
END $$;

-- 3. Strict Row Level Security: Revoke public direct read on private tables
ALTER TABLE outings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public outings" ON outings;
DROP POLICY IF EXISTS "Public read outings" ON outings;
DROP POLICY IF EXISTS "Service write outings" ON outings;
DROP POLICY IF EXISTS "Service manage outings" ON outings;
CREATE POLICY "Service manage outings" ON outings FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public participants" ON participants;
DROP POLICY IF EXISTS "Public read participants" ON participants;
DROP POLICY IF EXISTS "Service write participants" ON participants;
DROP POLICY IF EXISTS "Service manage participants" ON participants;
CREATE POLICY "Service manage participants" ON participants FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public recommendations" ON recommendations;
DROP POLICY IF EXISTS "Public read recommendations" ON recommendations;
DROP POLICY IF EXISTS "Service write recommendations" ON recommendations;
DROP POLICY IF EXISTS "Service manage recommendations" ON recommendations;
CREATE POLICY "Service manage recommendations" ON recommendations FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public votes" ON votes;
DROP POLICY IF EXISTS "Public read votes" ON votes;
DROP POLICY IF EXISTS "Service write votes" ON votes;
DROP POLICY IF EXISTS "Service manage votes" ON votes;
CREATE POLICY "Service manage votes" ON votes FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Public Restaurant Catalog: Venues and Reviews remain public read-only
ALTER TABLE venues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public venues" ON venues;
DROP POLICY IF EXISTS "Public read venues" ON venues;
DROP POLICY IF EXISTS "Service write venues" ON venues;
CREATE POLICY "Public read venues" ON venues FOR SELECT USING (true);
CREATE POLICY "Service write venues" ON venues FOR ALL TO service_role USING (true) WITH CHECK (true);

ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public reviews" ON reviews;
DROP POLICY IF EXISTS "Public read reviews" ON reviews;
DROP POLICY IF EXISTS "Service write reviews" ON reviews;
CREATE POLICY "Public read reviews" ON reviews FOR SELECT USING (true);
CREATE POLICY "Service write reviews" ON reviews FOR ALL TO service_role USING (true) WITH CHECK (true);
