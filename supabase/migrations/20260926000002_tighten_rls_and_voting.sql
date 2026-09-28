-- GatherMap Migration: Enforce Single-Vote per Outing Participant & Tighten Table Access
-- Revokes broad public write policies from migration 20260913000001_gathermap_complete.sql
-- All client reads are permitted; writes are strictly proxied via Node.js backend using service_role.

-- 1. Add unique constraint on votes if not already present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'unique_outing_voter_venue'
    ) THEN
        ALTER TABLE votes ADD CONSTRAINT unique_outing_voter_venue UNIQUE (outing_id, voter_name, venue_id);
    END IF;
END $$;

-- 2. Outings RLS: Public anonymous clients can read active outings; writes reserved to service_role
ALTER TABLE outings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public outings" ON outings;
DROP POLICY IF EXISTS "Public read outings" ON outings;
DROP POLICY IF EXISTS "Service write outings" ON outings;
CREATE POLICY "Public read outings" ON outings FOR SELECT USING (status = 'active');
CREATE POLICY "Service write outings" ON outings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Participants RLS: Revoke old permissive public write policy; allow public read, restrict writes to service_role
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public participants" ON participants;
DROP POLICY IF EXISTS "Public read participants" ON participants;
DROP POLICY IF EXISTS "Service write participants" ON participants;
CREATE POLICY "Public read participants" ON participants FOR SELECT USING (true);
CREATE POLICY "Service write participants" ON participants FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Recommendations RLS: Revoke old permissive public write policy; allow public read, restrict writes to service_role
ALTER TABLE recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public recommendations" ON recommendations;
DROP POLICY IF EXISTS "Public read recommendations" ON recommendations;
DROP POLICY IF EXISTS "Service write recommendations" ON recommendations;
CREATE POLICY "Public read recommendations" ON recommendations FOR SELECT USING (true);
CREATE POLICY "Service write recommendations" ON recommendations FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 5. Venues RLS: Read-only for public; writes reserved to service_role
ALTER TABLE venues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public venues" ON venues;
DROP POLICY IF EXISTS "Public read venues" ON venues;
DROP POLICY IF EXISTS "Service write venues" ON venues;
CREATE POLICY "Public read venues" ON venues FOR SELECT USING (true);
CREATE POLICY "Service write venues" ON venues FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 6. Reviews RLS: Public can read reviews; writes reserved to service_role
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public reviews" ON reviews;
DROP POLICY IF EXISTS "Public read reviews" ON reviews;
DROP POLICY IF EXISTS "Service write reviews" ON reviews;
CREATE POLICY "Public read reviews" ON reviews FOR SELECT USING (true);
CREATE POLICY "Service write reviews" ON reviews FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 7. Votes RLS: Public can read votes; writes strictly proxied via Node.js backend using service_role
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public votes" ON votes;
DROP POLICY IF EXISTS "Public read votes" ON votes;
DROP POLICY IF EXISTS "Service write votes" ON votes;
CREATE POLICY "Public read votes" ON votes FOR SELECT USING (true);
CREATE POLICY "Service write votes" ON votes FOR ALL TO service_role USING (true) WITH CHECK (true);
