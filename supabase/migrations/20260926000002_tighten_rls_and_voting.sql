-- GatherMap Migration: Enforce Single-Vote per Outing Participant & Tighten Table Access
-- All client reads and writes are proxied via Node.js backend using service role / backend API.

-- Add unique constraint on votes if not already present
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'unique_outing_voter_venue'
    ) THEN
        ALTER TABLE votes ADD CONSTRAINT unique_outing_voter_venue UNIQUE (outing_id, voter_name, venue_id);
    END IF;
END $$;

-- Outings RLS: Public anonymous clients can read active outings
ALTER TABLE outings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public outings" ON outings;
CREATE POLICY "Public read outings" ON outings FOR SELECT USING (status = 'active');
CREATE POLICY "Service write outings" ON outings FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Venues RLS: Read-only for public
ALTER TABLE venues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public venues" ON venues;
CREATE POLICY "Public read venues" ON venues FOR SELECT USING (true);
CREATE POLICY "Service write venues" ON venues FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Reviews RLS: Public can read reviews
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public reviews" ON reviews;
CREATE POLICY "Public read reviews" ON reviews FOR SELECT USING (true);
CREATE POLICY "Service write reviews" ON reviews FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Votes RLS: Public can read votes for their outing
ALTER TABLE votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public votes" ON votes;
CREATE POLICY "Public read votes" ON votes FOR SELECT USING (true);
CREATE POLICY "Service write votes" ON votes FOR ALL TO service_role USING (true) WITH CHECK (true);
