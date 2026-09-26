/**
 * Outing & Session Repository
 * Manages group outings, participant locations, recommendations, and voting synchronization.
 */

const { getSupabaseClient, getSqliteDb, isSupabaseConfigured } = require('./db-client');

async function saveOuting({ id, name = 'Weekend Hangout', mode = 'representative', centerLat = 10.7769, centerLng = 106.7009, radiusKm = 3.0 }) {
    const outingId = id || ('EAT-' + Math.floor(1000 + Math.random() * 9000));
    const cLat = centerLat != null ? Number(centerLat) : 10.7769;
    const cLng = centerLng != null ? Number(centerLng) : 106.7009;
    const rKm = radiusKm != null ? Number(radiusKm) : 3.0;

    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            await client.from('outings').upsert([{
                id: outingId,
                center_lat: cLat,
                center_lng: cLng,
                radius_km: rKm,
                status: 'active'
            }]);
        } catch (e) {
            console.error('Supabase saveOuting error:', e.message);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            sqliteDb.prepare(`
                INSERT INTO outings (id, name, mode, center_lat, center_lng, radius_km, status)
                VALUES (?, ?, ?, ?, ?, ?, 'active')
                ON CONFLICT(id) DO UPDATE SET
                    center_lat = excluded.center_lat,
                    center_lng = excluded.center_lng,
                    radius_km = excluded.radius_km,
                    status = 'active'
            `).run(outingId, name, mode, cLat, cLng, rKm);
        } catch (e) {
            console.error('SQLite saveOuting error:', e.message);
        }
    }

    return outingId;
}

async function getOuting(id) {
    if (!id) return null;
    let outing = null;

    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            const { data } = await client.from('outings').select('*').eq('id', id).single();
            if (data) {
                outing = {
                    id: data.id,
                    name: 'Weekend Hangout',
                    mode: 'representative',
                    centerLat: data.center_lat,
                    centerLng: data.center_lng,
                    radiusKm: data.radius_km,
                    status: data.status,
                    createdAt: data.created_at
                };
            }
        } catch (e) {
            // Not found in Supabase or error
        }
    }

    if (!outing) {
        const sqliteDb = getSqliteDb();
        if (sqliteDb) {
            const row = sqliteDb.prepare('SELECT * FROM outings WHERE id = ?').get(id);
            if (row) {
                outing = {
                    id: row.id,
                    name: row.name,
                    mode: row.mode,
                    centerLat: row.center_lat,
                    centerLng: row.center_lng,
                    radiusKm: row.radius_km,
                    status: row.status,
                    createdAt: row.created_at
                };
            }
        }
    }

    if (!outing) return null;

    const participants = await getParticipants(id);
    const votesList = await getRawVotesList(id);
    const votesMap = {};
    votesList.forEach(v => {
        const vid = v.venue_id || v.venueId;
        if (!votesMap[vid]) votesMap[vid] = [];
        votesMap[vid].push(v.voter_name || 'Guest');
    });

    return {
        ...outing,
        participants,
        votes: votesList,
        votesMap
    };
}

async function saveParticipants(outingId, participants = []) {
    if (!outingId || !Array.isArray(participants) || participants.length === 0) return;

    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            const records = participants.map((p, idx) => ({
                id: p.id ? String(p.id) : `p-${outingId}-${idx}-${Date.now()}`,
                outing_id: outingId,
                name: p.name || 'Friend',
                lat: p.lat != null ? Number(p.lat) : 10.7769,
                lng: p.lng != null ? Number(p.lng) : 106.7009,
                wish: p.wish || '',
                is_me: Boolean(p.isMe)
            }));
            await client.from('participants').upsert(records);
        } catch (e) {
            console.error('Supabase saveParticipants error:', e.message);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            const stmt = sqliteDb.prepare(`
                INSERT OR REPLACE INTO participants (id, outing_id, name, lat, lng, wish, is_me)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (let idx = 0; idx < participants.length; idx++) {
                const p = participants[idx];
                const pId = p.id ? String(p.id) : `p-${outingId}-${idx}`;
                stmt.run(
                    pId,
                    outingId,
                    p.name || 'Friend',
                    p.lat != null ? Number(p.lat) : 10.7769,
                    p.lng != null ? Number(p.lng) : 106.7009,
                    p.wish || '',
                    p.isMe ? 1 : 0
                );
            }
        } catch (e) {
            console.error('SQLite saveParticipants error:', e.message);
        }
    }
}

async function getParticipants(outingId) {
    if (!outingId) return [];
    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            const { data } = await client.from('participants').select('*').eq('outing_id', outingId);
            if (data && data.length > 0) {
                return data.map(p => ({
                    id: p.id,
                    name: p.name,
                    lat: p.lat,
                    lng: p.lng,
                    wish: p.wish,
                    isMe: p.is_me
                }));
            }
        } catch (e) {
            console.warn('Supabase getParticipants warning:', e.message);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        const rows = sqliteDb.prepare('SELECT * FROM participants WHERE outing_id = ?').all(outingId);
        return rows.map(p => ({
            id: p.id,
            name: p.name,
            lat: p.lat,
            lng: p.lng,
            wish: p.wish,
            isMe: Boolean(p.is_me)
        }));
    }
    return [];
}

async function saveRecommendations(outingId, recommendations = []) {
    if (!outingId || !Array.isArray(recommendations) || recommendations.length === 0) return;

    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            const recs = recommendations.map(r => ({
                id: `rec-${outingId}-${r.id}`,
                outing_id: outingId,
                venue_id: r.id,
                group_score: r.groupScore || 0,
                avg_score: r.avgScore || 0,
                lowest_score: r.minScore || (r.fairness?.minScore || 0),
                ai_rationale: r.aiRationale || ''
            }));
            await client.from('recommendations').upsert(recs);
        } catch (e) {
            console.error('Supabase saveRecommendations error:', e.message);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            const stmt = sqliteDb.prepare(`
                INSERT OR REPLACE INTO recommendations (id, outing_id, venue_id, group_score, avg_score, lowest_score, ai_rationale)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (const r of recommendations) {
                const recId = `rec-${outingId}-${r.id}`;
                stmt.run(
                    recId,
                    outingId,
                    r.id,
                    r.groupScore || 0,
                    r.avgScore || 0,
                    r.minScore || 0,
                    r.aiRationale || ''
                );
            }
        } catch (e) {
            console.error('SQLite saveRecommendations error:', e.message);
        }
    }
}

/**
 * Record a vote with strict 1-vote-per-user enforcement:
 * - If user voted for the same venue again -> retract/toggle vote.
 * - If user voted for a different venue -> move their vote.
 * - If user hasn't voted yet -> register vote.
 */
async function recordVote(outingId, venueId, voterName = 'Guest', voterId = null) {
    if (!outingId || !venueId) {
        throw new Error('outingId and venueId are required to record a vote');
    }

    // Ensure outing exists
    await saveOuting({ id: outingId });

    const effectiveVoterKey = voterId ? String(voterId) : String(voterName).trim();
    let action = 'voted';
    let currentVotedVenue = null;

    // Check existing votes in SQLite
    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        const existingVote = sqliteDb.prepare(`
            SELECT id, venue_id FROM votes
            WHERE outing_id = ? AND (voter_name = ? OR voter_id = ?)
        `).get(outingId, effectiveVoterKey, effectiveVoterKey);

        if (existingVote) {
            if (existingVote.venue_id === venueId) {
                // Toggle off
                sqliteDb.prepare('DELETE FROM votes WHERE id = ?').run(existingVote.id);
                action = 'unvoted';
                currentVotedVenue = null;
            } else {
                // Change vote
                sqliteDb.prepare(`
                    UPDATE votes SET venue_id = ?, voter_name = ?, voter_id = ?, created_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(venueId, voterName, effectiveVoterKey, existingVote.id);
                action = 'changed';
                currentVotedVenue = venueId;
            }
        } else {
            // New vote - let SQLite AUTOINCREMENT assign integer PK
            sqliteDb.prepare(`
                INSERT INTO votes (outing_id, venue_id, voter_name, voter_id)
                VALUES (?, ?, ?, ?)
            `).run(outingId, venueId, voterName, effectiveVoterKey);
            action = 'voted';
            currentVotedVenue = venueId;
        }
    }

    // Mirror to Supabase if configured
    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            if (action === 'unvoted') {
                await client.from('votes').delete().eq('outing_id', outingId).eq('voter_name', voterName);
            } else if (action === 'changed') {
                await client.from('votes').delete().eq('outing_id', outingId).eq('voter_name', voterName);
                const voteId = 'vote-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
                await client.from('votes').insert([{
                    id: voteId,
                    outing_id: outingId,
                    venue_id: venueId,
                    voter_name: voterName,
                    voter_id: effectiveVoterKey
                }]);
            } else {
                const voteId = 'vote-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
                await client.from('votes').insert([{
                    id: voteId,
                    outing_id: outingId,
                    venue_id: venueId,
                    voter_name: voterName,
                    voter_id: effectiveVoterKey
                }]);
            }
        } catch (e) {
            console.error('Supabase recordVote mirror error:', e.message);
        }
    }

    const rawVotes = await getRawVotesList(outingId);
    const votesMap = {};
    rawVotes.forEach(v => {
        const vid = v.venue_id || v.venueId;
        if (!votesMap[vid]) votesMap[vid] = [];
        votesMap[vid].push(v.voter_name || 'Guest');
    });

    return {
        success: true,
        action,
        currentVotedVenue,
        votes: rawVotes,
        votesMap,
        totalVotesForVenue: (votesMap[venueId] || []).length
    };
}

async function getRawVotesList(outingId) {
    if (!outingId) return [];

    const client = getSupabaseClient();
    if (isSupabaseConfigured && client) {
        try {
            const { data } = await client.from('votes').select('*').eq('outing_id', outingId);
            if (data && data.length > 0) return data;
        } catch (_) {}
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            const rows = sqliteDb.prepare('SELECT id, outing_id, venue_id, voter_name, voter_id, created_at FROM votes WHERE outing_id = ?').all(outingId);
            return rows || [];
        } catch (_) {
            return [];
        }
    }

    return [];
}

async function getVotes(outingId) {
    if (!outingId) return {};

    const rawVotes = await getRawVotesList(outingId);
    const votesMap = {};
    rawVotes.forEach(v => {
        const vid = v.venue_id || v.venueId;
        if (!votesMap[vid]) votesMap[vid] = [];
        votesMap[vid].push(v.voter_name || 'Guest');
    });
    return votesMap;
}

module.exports = {
    saveOuting,
    getOuting,
    saveParticipants,
    getParticipants,
    saveRecommendations,
    recordVote,
    getVotes,
    getRawVotesList
};
