/**
 * Outing & Session Repository
 * Manages group outings, participant locations, recommendations, and voting synchronization.
 */

const dbClient = require('./db-client');
const venueRepository = require('./venue-repository');
const { calcDistanceKm } = require('../algorithms/geometric-median');
const semanticEngine = require('../../semanticEngine');
const { buildDirectionsUrl, buildSearchUrl } = require('../services/places-service');

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

async function getRecommendations(outingId, participants = [], votesMap = {}, outingCenter = null) {
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
                    SELECT venue_id, group_score, avg_score, lowest_score, ai_rationale, dist_from_center_km, member_breakdowns
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
            let memberBreakdowns = [];
            if (r.member_breakdowns) {
                try {
                    memberBreakdowns = typeof r.member_breakdowns === 'string'
                        ? JSON.parse(r.member_breakdowns)
                        : r.member_breakdowns;
                } catch (_) {}
            }

            // Fallback calculation for legacy rows without saved member_breakdowns
            if (!Array.isArray(memberBreakdowns) || memberBreakdowns.length === 0) {
                memberBreakdowns = participants.map(p => {
                    const distKm = Number(calcDistanceKm({ lat: p.lat, lng: p.lng }, { lat: venue.lat, lng: venue.lng }).toFixed(1));
                    const travelMins = Math.max(5, Math.round((distKm / 20) * 60));
                    const travelScore = Math.max(20, Math.min(100, Math.round(100 - (travelMins * 2.2))));
                    const basePref = r.group_score || 85;
                    const indScore = Math.round(0.70 * basePref + 0.30 * travelScore);
                    return {
                        friendId: p.id,
                        friendName: p.name || 'Friend',
                        distanceKm: distKm,
                        distKm,
                        travelMins,
                        travelScore,
                        score: indScore
                    };
                });
            }

            // Accurate numeric distance from center
            let distFromCenterKm = null;
            if (r.dist_from_center_km != null) {
                distFromCenterKm = Number(Number(r.dist_from_center_km).toFixed(1));
            } else if (outingCenter && outingCenter.lat != null && outingCenter.lng != null && venue.lat != null && venue.lng != null) {
                distFromCenterKm = Number(calcDistanceKm(outingCenter, { lat: venue.lat, lng: venue.lng }).toFixed(1));
            } else {
                distFromCenterKm = 0;
            }

            const fairnessScores = memberBreakdowns.length > 0
                ? semanticEngine.calculateFairnessScores(memberBreakdowns)
                : null;

            shortlist.push({
                ...venue,
                distFromCenterKm,
                distanceKm: distFromCenterKm,
                groupScore: r.group_score ?? r.groupScore,
                fairnessScore: r.group_score ?? r.groupScore,
                avgScore: r.avg_score ?? r.avgScore,
                lowestScore: r.lowest_score ?? r.lowestScore,
                minScore: r.lowest_score ?? r.lowestScore,
                fairnessIndex: fairnessScores?.fairnessIndex || 'Cao',
                aiRationale: r.ai_rationale ?? r.aiRationale,
                whyRecommended: r.ai_rationale ?? r.aiRationale,
                memberBreakdowns,
                votes: (votesMap[venue.id] || []).length,
                voters: votesMap[venue.id] || [],
                directionsUrl: buildDirectionsUrl(venue),
                searchUrl: buildSearchUrl(venue)
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

    const outingCenter = { lat: outing.centerLat, lng: outing.centerLng };
    const recommendations = await getRecommendations(id, participants, votesMap, outingCenter);

    return {
        ...outing,
        center_lat: outing.centerLat,
        center_lng: outing.centerLng,
        center: outingCenter,
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
    if (!outingId || !Array.isArray(recommendations)) return;

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        if (recommendations.length === 0) {
            // Exact snapshot: Clear all recommendations for this outing
            const { error: delErr } = await client.from('recommendations').delete().eq('outing_id', outingId);
            if (delErr) {
                console.warn('Supabase clear recommendations warning:', delErr.message);
            }
        } else {
            // Ensure venues exist in Supabase first
            try {
                const venuePayloads = [];
                for (const r of recommendations) {
                    const vId = r.id || r.venue_id || r.venueId;
                    if (vId) {
                        venuePayloads.push({
                            id: vId,
                            name: r.name || vId,
                            category: r.category || 'Ăn uống',
                            address: r.address || '',
                            lat: r.lat != null ? Number(r.lat) : 10.7769,
                            lng: r.lng != null ? Number(r.lng) : 106.7009,
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

            const recs = recommendations.map(r => {
                const vId = r.id || r.venue_id || r.venueId;
                const distFromCenter = r.distFromCenterKm != null ? Number(r.distFromCenterKm) : (r.distanceKm != null ? Number(r.distanceKm) : null);
                const breakdownsJson = Array.isArray(r.memberBreakdowns) && r.memberBreakdowns.length > 0
                    ? JSON.stringify(r.memberBreakdowns)
                    : null;
                return {
                    id: `rec-${outingId}-${vId}`,
                    outing_id: outingId,
                    venue_id: vId,
                    group_score: r.groupScore || 0,
                    avg_score: r.avgScore || 0,
                    lowest_score: r.minScore || (r.fairness?.minScore || 0),
                    ai_rationale: r.aiRationale || '',
                    dist_from_center_km: distFromCenter,
                    member_breakdowns: breakdownsJson
                };
            });

            // Write new snapshot first to prevent discarding valid previous snapshot if write fails
            let { error: upsertErr } = await client.from('recommendations').upsert(recs);
            if (upsertErr && upsertErr.code === 'PGRST204') {
                const legacyRecs = recs.map(({ dist_from_center_km, member_breakdowns, ...rest }) => rest);
                const fallback = await client.from('recommendations').upsert(legacyRecs);
                upsertErr = fallback.error;
            }

            if (!upsertErr) {
                // Delete stale recommendations for this outing that are not in the new snapshot
                const activeRecIds = recs.map(r => r.id);
                try {
                    await client.from('recommendations')
                        .delete()
                        .eq('outing_id', outingId)
                        .not('id', 'in', `(${activeRecIds.join(',')})`);
                } catch (cleanupErr) {
                    console.warn('Supabase stale recommendations cleanup warning:', cleanupErr.message);
                }
            } else {
                console.warn('Supabase saveRecommendations error:', upsertErr.message);
            }
        }
    }

    const sqliteDb = getSqliteDb();
    if (sqliteDb) {
        try {
            if (recommendations.length === 0) {
                sqliteDb.prepare('DELETE FROM recommendations WHERE outing_id = ?').run(outingId);
            } else {
                const existingOuting = sqliteDb.prepare('SELECT id FROM outings WHERE id = ?').get(outingId);
                if (!existingOuting) {
                    sqliteDb.prepare(`
                        INSERT INTO outings (id, name, mode, center_lat, center_lng, radius_km, status)
                        VALUES (?, 'Weekend Hangout', 'representative', 10.7769, 106.7009, 3.0, 'active')
                    `).run(outingId);
                }

                const ensureVenueStmt = sqliteDb.prepare(`
                    INSERT OR IGNORE INTO venues (
                        id, name, category, type, is_alley, alley_note, address, place_id,
                        lat, lng, rating, reviews_count, price_per_person_vnd, avg_price,
                        tags, attributes, unknowns
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                const insertRecStmt = sqliteDb.prepare(`
                    INSERT INTO recommendations (
                        id, outing_id, venue_id, group_score, avg_score, lowest_score, ai_rationale, dist_from_center_km, member_breakdowns
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                const syncSnapshot = sqliteDb.transaction((recsList) => {
                    for (const r of recsList) {
                        const vId = r.id || r.venue_id || r.venueId;
                        if (vId) {
                            try {
                                ensureVenueStmt.run(
                                    vId,
                                    r.name || vId,
                                    r.category || 'Ăn uống',
                                    r.type || 'restaurant',
                                    r.isAlley ? 1 : 0,
                                    r.alleyNote || '',
                                    r.address || '',
                                    r.placeId || '',
                                    r.lat != null ? Number(r.lat) : 10.7769,
                                    r.lng != null ? Number(r.lng) : 106.7009,
                                    r.rating != null ? Number(r.rating) : 4.5,
                                    r.reviewsCount != null ? Number(r.reviewsCount) : 100,
                                    r.pricePerPersonVnd != null ? Number(r.pricePerPersonVnd) : 60000,
                                    r.avgPrice || '35k - 80k VND',
                                    JSON.stringify(r.tags || []),
                                    JSON.stringify(r.attributes || r.traits || {}),
                                    JSON.stringify(r.unknowns || [])
                                );
                            } catch (vErr) {
                                console.error('ensureVenueStmt failed:', vErr.message);
                            }
                        }
                    }

                    // Delete old recommendations for this outing to ensure exact snapshot
                    sqliteDb.prepare('DELETE FROM recommendations WHERE outing_id = ?').run(outingId);

                    // Insert new recommendation records
                    for (const r of recsList) {
                        const vId = r.id || r.venue_id || r.venueId;
                        const recId = `rec-${outingId}-${vId}`;
                        const distFromCenter = r.distFromCenterKm != null ? Number(r.distFromCenterKm) : (r.distanceKm != null ? Number(r.distanceKm) : null);
                        const breakdownsJson = Array.isArray(r.memberBreakdowns) && r.memberBreakdowns.length > 0
                            ? JSON.stringify(r.memberBreakdowns)
                            : null;
                        insertRecStmt.run(
                            recId,
                            outingId,
                            vId,
                            r.groupScore || 0,
                            r.avgScore || 0,
                            r.minScore || 0,
                            r.aiRationale || '',
                            distFromCenter,
                            breakdownsJson
                        );
                    }
                });

                syncSnapshot(recommendations);
            }
        } catch (e) {
            console.error('SQLite saveRecommendations error:', e.message);
        }
    }
}

/**
 * Record a vote with strict 1-vote-per-user enforcement:
 * - If user voted for the same venue again -> retract/toggle vote.
 * - If user voted for a different venue -> move their vote via atomic in-place UPDATE.
 * - If user hasn't voted yet -> register vote.
 * - voter_id is the canonical voter identity; voter_name is display metadata.
 * - Authoritative backend: Supabase when configured, SQLite when local. Zero dual-write split-brain.
 * - Outings metadata is NEVER written or mutated during voting.
 */
async function recordVote(outingId, venueId, voterName = 'Guest', voterId = null) {
    if (!outingId || !venueId) {
        throw new Error('outingId and venueId are required to record a vote');
    }

    const cleanVoterId = voterId ? String(voterId).trim() : null;
    const cleanVoterName = voterName ? String(voterName).trim() : 'Guest';
    let action = 'voted';
    let currentVotedVenue = null;

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        // Authoritative write target: Supabase Cloud Database
        // 1. Verify outing exists in Supabase (never mutate outing metadata during voting)
        const { data: remoteOuting, error: outingCheckErr } = await client
            .from('outings')
            .select('id')
            .eq('id', outingId)
            .maybeSingle();
        if (outingCheckErr) {
            throw new Error(`Supabase verify outing existence failed: ${outingCheckErr.message}`);
        }
        if (!remoteOuting) {
            throw new Error(`Outing ${outingId} does not exist in remote database`);
        }

        // 2. Ensure venue exists in Supabase to satisfy foreign key constraint
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

        // 3. Query existing vote for this voter in Supabase
        let query = client.from('votes').select('id, venue_id, voter_name, voter_id').eq('outing_id', outingId);
        if (cleanVoterId) {
            query = query.eq('voter_id', cleanVoterId);
        } else {
            query = query.eq('voter_name', cleanVoterName);
        }
        const { data: existingVotes, error: selectVoteErr } = await query;
        if (selectVoteErr) {
            throw new Error(`Supabase query existing vote failed: ${selectVoteErr.message}`);
        }
        const existingVote = existingVotes && existingVotes.length > 0 ? existingVotes[0] : null;

        if (existingVote) {
            if (existingVote.venue_id === venueId) {
                // Toggle off / retract vote
                const { error: delErr } = await client.from('votes').delete().eq('id', existingVote.id);
                if (delErr) throw new Error(`Supabase recordVote unvoted failed: ${delErr.message}`);
                action = 'unvoted';
                currentVotedVenue = null;
            } else {
                // Change vote: Atomic in-place UPDATE (never delete-then-insert)
                const updatePayload = {
                    venue_id: venueId,
                    voter_name: cleanVoterName,
                    created_at: new Date().toISOString()
                };
                if (cleanVoterId) {
                    updatePayload.voter_id = cleanVoterId;
                }
                let { error: updateErr } = await client.from('votes').update(updatePayload).eq('id', existingVote.id);
                if (updateErr && (updateErr.code === 'PGRST204' || (updateErr.message && updateErr.message.includes('voter_id')))) {
                    const { voter_id, ...legacyPayload } = updatePayload;
                    const res = await client.from('votes').update(legacyPayload).eq('id', existingVote.id);
                    updateErr = res.error;
                }
                if (updateErr) throw new Error(`Supabase recordVote changed update failed: ${updateErr.message}`);
                action = 'changed';
                currentVotedVenue = venueId;
            }
        } else {
            // New vote: INSERT
            const voteId = 'vote-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
            const insertRecord = {
                id: voteId,
                outing_id: outingId,
                venue_id: venueId,
                voter_name: cleanVoterName
            };
            if (cleanVoterId) {
                insertRecord.voter_id = cleanVoterId;
            }

            let { error: insErr } = await client.from('votes').insert([insertRecord]);
            if (insErr && (insErr.code === 'PGRST204' || (insErr.message && insErr.message.includes('voter_id')))) {
                const { voter_id, ...legacyRecord } = insertRecord;
                const fallback = await client.from('votes').insert([legacyRecord]);
                insErr = fallback.error;
            }
            if (insErr) throw new Error(`Supabase recordVote voted insert failed: ${insErr.message}`);
            action = 'voted';
            currentVotedVenue = venueId;
        }

        // Best-effort local mirror only after Supabase write succeeds
        const sqliteDb = getSqliteDb();
        if (sqliteDb) {
            try {
                if (action === 'unvoted') {
                    if (cleanVoterId) {
                        sqliteDb.prepare('DELETE FROM votes WHERE outing_id = ? AND voter_id = ?').run(outingId, cleanVoterId);
                    } else {
                        sqliteDb.prepare('DELETE FROM votes WHERE outing_id = ? AND voter_name = ? AND voter_id IS NULL').run(outingId, cleanVoterName);
                    }
                } else if (action === 'changed' && existingVote) {
                    sqliteDb.prepare(`
                        UPDATE votes SET venue_id = ?, voter_name = ?, voter_id = ?, created_at = CURRENT_TIMESTAMP
                        WHERE outing_id = ? AND (voter_id = ? OR (voter_name = ? AND voter_id IS NULL))
                    `).run(venueId, cleanVoterName, cleanVoterId || null, outingId, cleanVoterId || '', cleanVoterName);
                } else if (action === 'voted') {
                    const voteId = 'vote-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
                    sqliteDb.prepare(`
                        INSERT OR REPLACE INTO votes (id, outing_id, venue_id, voter_name, voter_id)
                        VALUES (?, ?, ?, ?, ?)
                    `).run(voteId, outingId, venueId, cleanVoterName, cleanVoterId || null);
                }
            } catch (_) {}
        }
    } else {
        // Authoritative write target: Local SQLite Database
        const sqliteDb = getSqliteDb();
        if (!sqliteDb) {
            throw new Error('No database available to record vote');
        }

        const existingOuting = sqliteDb.prepare('SELECT id FROM outings WHERE id = ?').get(outingId);
        if (!existingOuting) {
            throw new Error(`Outing ${outingId} does not exist in local database`);
        }

        let existingVote = null;
        if (cleanVoterId) {
            existingVote = sqliteDb.prepare(`
                SELECT id, venue_id, voter_name, voter_id FROM votes
                WHERE outing_id = ? AND voter_id = ?
            `).get(outingId, cleanVoterId);
        } else {
            existingVote = sqliteDb.prepare(`
                SELECT id, venue_id, voter_name, voter_id FROM votes
                WHERE outing_id = ? AND voter_name = ? AND voter_id IS NULL
            `).get(outingId, cleanVoterName);
        }

        if (existingVote) {
            if (existingVote.venue_id === venueId) {
                // Toggle off
                sqliteDb.prepare('DELETE FROM votes WHERE id = ?').run(existingVote.id);
                action = 'unvoted';
                currentVotedVenue = null;
            } else {
                // Atomic in-place vote change
                sqliteDb.prepare(`
                    UPDATE votes SET venue_id = ?, voter_name = ?, voter_id = ?, created_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                `).run(venueId, cleanVoterName, cleanVoterId || null, existingVote.id);
                action = 'changed';
                currentVotedVenue = venueId;
            }
        } else {
            // New vote
            const voteId = 'vote-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 8);
            sqliteDb.prepare(`
                INSERT INTO votes (id, outing_id, venue_id, voter_name, voter_id)
                VALUES (?, ?, ?, ?, ?)
            `).run(voteId, outingId, venueId, cleanVoterName, cleanVoterId || null);
            action = 'voted';
            currentVotedVenue = venueId;
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

async function setLegacyOutingShareToken(outingId, shareTokenHash) {
    if (!outingId || !shareTokenHash) throw new Error('outingId and shareTokenHash are required');
    let remoteAffected = 0;
    let localAffected = 0;
    let remoteExecuted = false;

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        remoteExecuted = true;
        const { data, error } = await client
            .from('outings')
            .update({ share_token_hash: shareTokenHash })
            .eq('id', outingId)
            .is('share_token_hash', null)
            .select('id');
        if (error && error.code !== 'PGRST204') {
            throw new Error(`Supabase setLegacyOutingShareToken failed: ${error.message}`);
        }
        remoteAffected = data ? data.length : 0;

        // Best-effort SQLite mirror if record exists locally
        const sqliteDb = getSqliteDb();
        if (sqliteDb) {
            try {
                const res = sqliteDb.prepare('UPDATE outings SET share_token_hash = ? WHERE id = ? AND share_token_hash IS NULL').run(shareTokenHash, outingId);
                localAffected = res.changes;
            } catch (_) {}
        }
    } else {
        const sqliteDb = getSqliteDb();
        if (sqliteDb) {
            const res = sqliteDb.prepare('UPDATE outings SET share_token_hash = ? WHERE id = ? AND share_token_hash IS NULL').run(shareTokenHash, outingId);
            localAffected = res.changes;
        }
    }

    const isSuccess = remoteExecuted ? (remoteAffected > 0) : (localAffected > 0);
    const totalModified = remoteExecuted ? remoteAffected : localAffected;

    return {
        success: isSuccess,
        modifiedCount: totalModified,
        remoteModifiedCount: remoteAffected,
        localModifiedCount: localAffected
    };
}

async function forceReissueOutingShareToken(outingId, shareTokenHash) {
    if (!outingId || !shareTokenHash) throw new Error('outingId and shareTokenHash are required');
    let remoteAffected = 0;
    let localAffected = 0;
    let remoteExecuted = false;

    const client = getSupabaseClient();
    if (dbClient.isSupabaseConfigured && client) {
        remoteExecuted = true;
        const { data, error } = await client
            .from('outings')
            .update({ share_token_hash: shareTokenHash })
            .eq('id', outingId)
            .select('id');
        if (error && error.code !== 'PGRST204') {
            throw new Error(`Supabase forceReissueOutingShareToken failed: ${error.message}`);
        }
        remoteAffected = data ? data.length : 0;

        // Best-effort SQLite mirror if record exists locally
        const sqliteDb = getSqliteDb();
        if (sqliteDb) {
            try {
                const res = sqliteDb.prepare('UPDATE outings SET share_token_hash = ? WHERE id = ?').run(shareTokenHash, outingId);
                localAffected = res.changes;
            } catch (_) {}
        }
    } else {
        const sqliteDb = getSqliteDb();
        if (sqliteDb) {
            const res = sqliteDb.prepare('UPDATE outings SET share_token_hash = ? WHERE id = ?').run(shareTokenHash, outingId);
            localAffected = res.changes;
        }
    }

    const isSuccess = remoteExecuted ? (remoteAffected > 0) : (localAffected > 0);
    const totalModified = remoteExecuted ? remoteAffected : localAffected;

    return {
        success: isSuccess,
        modifiedCount: totalModified,
        remoteModifiedCount: remoteAffected,
        localModifiedCount: localAffected
    };
}

async function updateOutingShareToken(outingId, shareTokenHash) {
    return await forceReissueOutingShareToken(outingId, shareTokenHash);
}

module.exports = {
    saveOuting,
    updateOutingSettings,
    updateOutingShareToken,
    setLegacyOutingShareToken,
    forceReissueOutingShareToken,
    getOuting,
    saveParticipants,
    getParticipants,
    saveRecommendations,
    getRecommendations,
    recordVote,
    getVotes,
    getRawVotesList
};
