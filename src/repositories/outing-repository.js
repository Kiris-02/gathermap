/**
 * Outing & Session Repository
 * Manages group outings, participant locations, recommendations, and voting synchronization.
 */

const dbClient = require('./db-client');
const venueRepository = require('./venue-repository');
const { calcDistanceKm } = require('../algorithms/geometric-median');

const getSupabaseClient = () => dbClient.getSupabaseClient();
const getSqliteDb = () => dbClient.getSqliteDb();

async function saveOuting({ id, name = 'Weekend Hangout', mode = 'representative', centerLat, centerLng, radiusKm, shareTokenHash }) {
    if (!id) {
        throw new Error('Outing id is required to save');
    }
    const outingId = id;
    const cLat = centerLat != null ? Number(centerLat) : 10.7769;
    const cLng = centerLng != null ? Number(centerLng) : 106.7009;
    const rKm = radiusKm != null ? Number(radiusKm) : 3.0;

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        const { data: existing, error: selectErr } = await client
            .from('outings')
            .select('*')
            .eq('id', outingId)
            .maybeSingle();

        if (selectErr && selectErr.code !== 'PGRST116') {
            throw new Error(`Supabase query outing failed: ${selectErr.message}`);
        }

        if (!existing) {
            const payload = {
                id: outingId,
                center_lat: cLat,
                center_lng: cLng,
                radius_km: rKm,
                status: 'active'
            };
            if (shareTokenHash) payload.share_token_hash = shareTokenHash;
            if (name) payload.name = name;
            if (mode) payload.mode = mode;

            let { error: insertErr } = await client.from('outings').insert([payload]);
            if (insertErr && (insertErr.code === 'PGRST204' || (insertErr.message && insertErr.message.includes('column')))) {
                // If remote Supabase hasn't run the migration yet, insert baseline columns
                const fallbackPayload = {
                    id: outingId,
                    center_lat: cLat,
                    center_lng: cLng,
                    radius_km: rKm,
                    status: 'active'
                };
                const fallbackResult = await client.from('outings').insert([fallbackPayload]);
                insertErr = fallbackResult.error;
            }
            if (insertErr) {
                throw new Error(`Supabase saveOuting insert failed: ${insertErr.message}`);
            }
        } else {
            // Existing outing: NEVER overwrite center_lat, center_lng, radius_km, name, or mode!
            if (!existing.share_token_hash && shareTokenHash) {
                const { error: updateErr } = await client
                    .from('outings')
                    .update({ share_token_hash: shareTokenHash })
                    .eq('id', outingId);
                if (updateErr && updateErr.code !== 'PGRST204') {
                    throw new Error(`Supabase backfill share_token_hash failed: ${updateErr.message}`);
                }
            }
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        const existing = sqliteDb.prepare('SELECT id, share_token_hash FROM outings WHERE id = ?').get(outingId);
        if (!existing) {
            sqliteDb.prepare(`
                INSERT INTO outings (id, name, mode, center_lat, center_lng, radius_km, status, share_token_hash)
                VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
            `).run(outingId, name, mode, cLat, cLng, rKm, shareTokenHash || null);
        } else {
            // Existing outing: NEVER overwrite center_lat, center_lng, radius_km, name, or mode!
            if (!existing.share_token_hash && shareTokenHash) {
                sqliteDb.prepare('UPDATE outings SET share_token_hash = ? WHERE id = ?').run(shareTokenHash, outingId);
            }
        }
    }

    return outingId;
}

async function updateOutingSettings(outingId, updates = {}) {
    if (!outingId) throw new Error('Outing id is required');
    const { name, mode, centerLat, centerLng, radiusKm, status } = updates;

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (mode !== undefined) patch.mode = mode;
        if (centerLat !== undefined) patch.center_lat = Number(centerLat);
        if (centerLng !== undefined) patch.center_lng = Number(centerLng);
        if (radiusKm !== undefined) patch.radius_km = Number(radiusKm);
        if (status !== undefined) patch.status = status;

        if (Object.keys(patch).length > 0) {
            let { error } = await client.from('outings').update(patch).eq('id', outingId);
            if (error && error.code === 'PGRST204') {
                const baselinePatch = {};
                if (centerLat !== undefined) baselinePatch.center_lat = Number(centerLat);
                if (centerLng !== undefined) baselinePatch.center_lng = Number(centerLng);
                if (radiusKm !== undefined) baselinePatch.radius_km = Number(radiusKm);
                if (status !== undefined) baselinePatch.status = status;
                if (Object.keys(baselinePatch).length > 0) {
                    const res = await client.from('outings').update(baselinePatch).eq('id', outingId);
                    error = res.error;
                } else {
                    error = null;
                }
            }
            if (error) {
                throw new Error(`Supabase updateOutingSettings failed: ${error.message}`);
            }
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        sqliteDb.prepare(`
            UPDATE outings SET
                name = COALESCE(?, name),
                mode = COALESCE(?, mode),
                center_lat = COALESCE(?, center_lat),
                center_lng = COALESCE(?, center_lng),
                radius_km = COALESCE(?, radius_km),
                status = COALESCE(?, status)
            WHERE id = ?
        `).run(
            name !== undefined ? name : null,
            mode !== undefined ? mode : null,
            centerLat !== undefined ? Number(centerLat) : null,
            centerLng !== undefined ? Number(centerLng) : null,
            radiusKm !== undefined ? Number(radiusKm) : null,
            status !== undefined ? status : null,
            outingId
        );
    }

    return await getOuting(outingId);
}

async function getRecommendations(outingId, participants = [], votesMap = {}) {
    if (!outingId) return [];
    let recRows = [];

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        try {
            const { data } = await client.from('recommendations')
                .select('*')
                .eq('outing_id', outingId)
                .order('group_score', { ascending: false });
            if (data && data.length > 0) recRows = data;
        } catch (_) {}
    }

    if (recRows.length === 0) {
        const sqliteDb = getSqliteDb();
        if (sqliteDb) {
            try {
                recRows = sqliteDb.prepare(`
                    SELECT venue_id, group_score, avg_score, lowest_score, ai_rationale
                    FROM recommendations
                    WHERE outing_id = ?
                    ORDER BY group_score DESC
                `).all(outingId);
            } catch (_) {}
        }
    }

    if (!recRows || recRows.length === 0) return [];

    const shortlist = [];
    for (const r of recRows) {
        const venue = await venueRepository.getVenueById(r.venue_id || r.venueId);
        if (venue) {
            const memberBreakdowns = participants.map(p => {
                const distKm = calcDistanceKm({ lat: p.lat, lng: p.lng }, { lat: venue.lat, lng: venue.lng });
                const travelMins = Math.max(3, Math.round(distKm * 3.2));
                return {
                    friendName: p.name || 'Friend',
                    distanceKm: Number(distKm.toFixed(1)),
                    travelMins,
                    travelScore: Math.max(0, Math.min(100, Math.round(100 - distKm * 12))),
                    score: Math.round(r.group_score || r.groupScore || 85)
                };
            });

            shortlist.push({
                ...venue,
                groupScore: r.group_score ?? r.groupScore,
                fairnessScore: r.group_score ?? r.groupScore,
                avgScore: r.avg_score ?? r.avgScore,
                lowestScore: r.lowest_score ?? r.lowestScore,
                minScore: r.lowest_score ?? r.lowestScore,
                aiRationale: r.ai_rationale ?? r.aiRationale,
                memberBreakdowns,
                votes: (votesMap[venue.id] || []).length,
                voters: votesMap[venue.id] || [],
                directionsUrl: `https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}`,
                searchUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue.name + ' ' + (venue.address || ''))}`
            });
        }
    }
    return shortlist;
}

async function getOuting(id) {
    if (!id) return null;
    let outing = null;

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        try {
            const { data, error } = await client.from('outings').select('*').eq('id', id).maybeSingle();
            if (error && error.code !== 'PGRST116') {
                console.warn('Supabase getOuting warning:', error.message);
            }
            if (data) {
                outing = {
                    id: data.id,
                    name: data.name || 'Weekend Hangout',
                    mode: data.mode || 'representative',
                    centerLat: data.center_lat,
                    centerLng: data.center_lng,
                    radiusKm: data.radius_km,
                    status: data.status,
                    share_token_hash: data.share_token_hash || null,
                    createdAt: data.created_at
                };
            }
        } catch (e) {
            // Not found in Supabase or network error
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        const row = sqliteDb.prepare('SELECT * FROM outings WHERE id = ?').get(id);
        if (row) {
            if (!outing) {
                outing = {
                    id: row.id,
                    name: row.name,
                    mode: row.mode,
                    centerLat: row.center_lat,
                    centerLng: row.center_lng,
                    radiusKm: row.radius_km,
                    status: row.status,
                    share_token_hash: row.share_token_hash || null,
                    createdAt: row.created_at
                };
            } else {
                if (!outing.share_token_hash && row.share_token_hash) {
                    outing.share_token_hash = row.share_token_hash;
                }
                if (row.name && (!outing.name || outing.name === 'Weekend Hangout')) {
                    outing.name = row.name;
                }
                if (row.mode && (!outing.mode || outing.mode === 'representative')) {
                    outing.mode = row.mode;
                }
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

    const recommendations = await getRecommendations(id, participants, votesMap);

    return {
        ...outing,
        center_lat: outing.centerLat,
        center_lng: outing.centerLng,
        center: { lat: outing.centerLat, lng: outing.centerLng },
        radius_km: outing.radiusKm,
        radiusMeters: Math.round(outing.radiusKm * 1000),
        radius_meters: Math.round(outing.radiusKm * 1000),
        participants,
        friends: participants,
        recommendations,
        shortlist: recommendations,
        votes: votesList,
        votesMap
    };
}

async function saveParticipants(outingId, participants = []) {
    if (!outingId || !Array.isArray(participants) || participants.length === 0) return;

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        try {
            await client.from('participants').delete().eq('outing_id', outingId);
        } catch (_) {}
        const records = participants.map((p, idx) => ({
            id: p.id ? String(p.id) : `p-${outingId}-${idx}`,
            outing_id: outingId,
            name: p.name || 'Friend',
            lat: p.lat != null ? Number(p.lat) : 10.7769,
            lng: p.lng != null ? Number(p.lng) : 106.7009,
            wish: p.wish || '',
            is_me: Boolean(p.isMe)
        }));
        const { error } = await client.from('participants').upsert(records, { onConflict: 'id' });
        if (error) {
            throw new Error(`Supabase saveParticipants failed: ${error.message}`);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            sqliteDb.prepare('DELETE FROM participants WHERE outing_id = ?').run(outingId);
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
    if (dbClient.isSupabaseConfigured && client) {
        try {
            const { data, error } = await client.from('participants').select('*').eq('outing_id', outingId);
            if (error) throw new Error(error.message);
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
    if (dbClient.isSupabaseConfigured && client) {
        try {
            const venuePayloads = [];
            for (const r of recommendations) {
                if (r.id && r.name && r.lat != null && r.lng != null) {
                    venuePayloads.push({
                        id: r.id,
                        name: r.name,
                        category: r.category || 'Ăn uống',
                        address: r.address || '',
                        lat: Number(r.lat),
                        lng: Number(r.lng),
                        rating: r.rating != null ? Number(r.rating) : 4.5,
                        reviews_count: r.reviewsCount != null ? Number(r.reviewsCount) : 100,
                        avg_price: r.avgPrice || '35k - 80k VND',
                        tags: Array.isArray(r.tags) ? r.tags : [],
                        traits: r.attributes || r.traits || {},
                        verified: true
                    });
                }
            }
            if (venuePayloads.length > 0) {
                const { error: vErr } = await client.from('venues').upsert(venuePayloads, { onConflict: 'id' });
                if (vErr) {
                    console.warn('Supabase ensure venues warning:', vErr.message);
                }
            }
        } catch (vErr) {
            console.warn('Supabase ensure venues exception:', vErr.message);
        }

        const recs = recommendations.map(r => ({
            id: `rec-${outingId}-${r.id}`,
            outing_id: outingId,
            venue_id: r.id,
            group_score: r.groupScore || 0,
            avg_score: r.avgScore || 0,
            lowest_score: r.minScore || (r.fairness?.minScore || 0),
            ai_rationale: r.aiRationale || ''
        }));
        const { error } = await client.from('recommendations').upsert(recs);
        if (error) {
            throw new Error(`Supabase saveRecommendations failed: ${error.message}`);
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            const ensureVenueStmt = sqliteDb.prepare(`
                INSERT OR IGNORE INTO venues (
                    id, name, category, type, is_alley, alley_note, address, place_id,
                    lat, lng, rating, reviews_count, price_per_person_vnd, avg_price,
                    tags, attributes, unknowns
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const stmt = sqliteDb.prepare(`
                INSERT OR REPLACE INTO recommendations (id, outing_id, venue_id, group_score, avg_score, lowest_score, ai_rationale)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            for (const r of recommendations) {
                if (r.name && r.lat != null && r.lng != null) {
                    try {
                        ensureVenueStmt.run(
                            r.id,
                            r.name,
                            r.category || 'Ăn uống',
                            r.type || 'restaurant',
                            r.isAlley ? 1 : 0,
                            r.alleyNote || '',
                            r.address || '',
                            r.placeId || '',
                            Number(r.lat),
                            Number(r.lng),
                            r.rating != null ? Number(r.rating) : 4.5,
                            r.reviewsCount != null ? Number(r.reviewsCount) : 100,
                            r.pricePerPersonVnd != null ? Number(r.pricePerPersonVnd) : 60000,
                            r.avgPrice || '35k - 80k VND',
                            JSON.stringify(r.tags || []),
                            JSON.stringify(r.attributes || r.traits || {}),
                            JSON.stringify(r.unknowns || [])
                        );
                    } catch (_) {}
                }

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

    const effectiveVoterKey = voterId ? String(voterId) : String(voterName).trim();
    let action = 'voted';
    let currentVotedVenue = null;

    // Check existing votes in SQLite
    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        // Ensure outing exists without resetting existing center/radius
        const existingOuting = sqliteDb.prepare('SELECT id FROM outings WHERE id = ?').get(outingId);
        if (!existingOuting) {
            sqliteDb.prepare(`
                INSERT INTO outings (id, name, mode, center_lat, center_lng, radius_km, status)
                VALUES (?, 'Weekend Hangout', 'representative', 10.7769, 106.7009, 3.0, 'active')
            `).run(outingId);
        }

        const existingVote = sqliteDb.prepare(`
            SELECT id, venue_id FROM votes
            WHERE outing_id = ? AND (voter_name = ? OR voter_id = ?)
        `).get(outingId, effectiveVoterKey, effectiveVoterKey);

        if (existingVote) {
            if (existingVote.venue_id === venueId) {
                // Toggle off
                if (existingVote.id != null) {
                    sqliteDb.prepare('DELETE FROM votes WHERE id = ?').run(existingVote.id);
                } else {
                    sqliteDb.prepare('DELETE FROM votes WHERE outing_id = ? AND (voter_name = ? OR voter_id = ?)').run(outingId, effectiveVoterKey, effectiveVoterKey);
                }
                action = 'unvoted';
                currentVotedVenue = null;
            } else {
                // Change vote
                if (existingVote.id != null) {
                    sqliteDb.prepare(`
                        UPDATE votes SET venue_id = ?, voter_name = ?, voter_id = ?, created_at = CURRENT_TIMESTAMP
                        WHERE id = ?
                    `).run(venueId, voterName, effectiveVoterKey, existingVote.id);
                } else {
                    sqliteDb.prepare(`
                        UPDATE votes SET venue_id = ?, voter_name = ?, voter_id = ?, created_at = CURRENT_TIMESTAMP
                        WHERE outing_id = ? AND (voter_name = ? OR voter_id = ?)
                    `).run(venueId, voterName, effectiveVoterKey, outingId, effectiveVoterKey, effectiveVoterKey);
                }
                action = 'changed';
                currentVotedVenue = venueId;
            }
        } else {
            // New vote - always populate with non-null string ID
            const voteId = 'vote-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
            try {
                sqliteDb.prepare(`
                    INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id)
                    VALUES (?, ?, ?, ?, ?)
                `).run(voteId, outingId, venueId, voterName, effectiveVoterKey);
            } catch (err) {
                // Fallback for legacy tables requiring integer PK
                if (err.message && err.message.includes('datatype mismatch')) {
                    sqliteDb.prepare(`
                        INSERT INTO votes (outing_id, venue_id, voter_name, voter_id)
                        VALUES (?, ?, ?, ?)
                    `).run(outingId, venueId, voterName, effectiveVoterKey);
                } else {
                    throw err;
                }
            }
            action = 'voted';
            currentVotedVenue = venueId;
        }
    }

    // Mirror to Supabase if configured
    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        if (action === 'unvoted') {
            const { error } = await client.from('votes').delete().eq('outing_id', outingId).eq('voter_name', voterName);
            if (error) throw new Error(`Supabase recordVote unvoted failed: ${error.message}`);
        } else {
            // Ensure venue exists in Supabase to satisfy foreign key constraint
            try {
                const venue = await venueRepository.getVenueById(venueId);
                if (venue) {
                    await client.from('venues').upsert([{
                        id: venue.id,
                        name: venue.name,
                        category: venue.category || 'Ăn uống',
                        address: venue.address || '',
                        lat: Number(venue.lat),
                        lng: Number(venue.lng),
                        rating: venue.rating != null ? Number(venue.rating) : 4.5,
                        reviews_count: venue.reviewsCount != null ? Number(venue.reviewsCount) : 100,
                        avg_price: venue.avgPrice || '35k - 80k VND',
                        tags: Array.isArray(venue.tags) ? venue.tags : [],
                        traits: venue.attributes || venue.traits || {},
                        verified: true
                    }], { onConflict: 'id' });
                } else {
                    await client.from('venues').upsert([{
                        id: venueId,
                        name: venueId,
                        category: 'Ăn uống',
                        address: 'TP. Hồ Chí Minh',
                        lat: 10.7769,
                        lng: 106.7009,
                        verified: true
                    }], { onConflict: 'id' });
                }
            } catch (_) {}

            if (action === 'changed') {
                const { error: delErr } = await client.from('votes').delete().eq('outing_id', outingId).eq('voter_name', voterName);
                if (delErr) throw new Error(`Supabase recordVote changed delete failed: ${delErr.message}`);
            }

            const voteId = 'vote-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);
            const { error: insErr } = await client.from('votes').insert([{
                id: voteId,
                outing_id: outingId,
                venue_id: venueId,
                voter_name: voterName
            }]);
            if (insErr) throw new Error(`Supabase recordVote ${action} insert failed: ${insErr.message}`);
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
    if (dbClient.isSupabaseConfigured && client) {
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
    updateOutingSettings,
    getOuting,
    saveParticipants,
    getParticipants,
    saveRecommendations,
    getRecommendations,
    recordVote,
    getVotes,
    getRawVotesList
};
