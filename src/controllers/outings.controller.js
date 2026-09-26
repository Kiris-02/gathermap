/**
 * Outings Controller
 */

const outingService = require('../services/outing-service');

async function createOuting(req, res, next) {
    try {
        const { name = 'Weekend Hangout', mode = 'representative', centerLat, centerLng, radiusKm } = req.body || {};
        const outing = await outingService.createOuting({ name, mode, centerLat, centerLng, radiusKm });
        res.status(201).json(outing);
    } catch (err) {
        next(err);
    }
}

async function getOuting(req, res, next) {
    try {
        const outing = req.outing || (await outingService.getOutingById(req.params.id));
        if (!outing) {
            return res.status(404).json({ error: 'outing_not_found', message: 'Outing session not found' });
        }
        // Protect secret hash: Never expose share_token_hash to clients
        const { share_token_hash, ...safeOuting } = outing;
        res.json({
            outing: safeOuting,
            votes: safeOuting.votes || [],
            ...safeOuting
        });
    } catch (err) {
        next(err);
    }
}

async function updateOuting(req, res, next) {
    try {
        const { name, mode, centerLat, centerLng, radiusKm, status } = req.body || {};
        const updated = await outingService.updateOutingSettings(req.params.id, {
            name,
            mode,
            centerLat,
            centerLng,
            radiusKm,
            status
        });
        const { share_token_hash, ...safeOuting } = updated;
        res.json({
            outing: safeOuting,
            ...safeOuting
        });
    } catch (err) {
        next(err);
    }
}

async function castVote(req, res, next) {
    try {
        const { venueId, voterName = 'Guest', voterId = null } = req.body;
        const result = await outingService.castVote({
            outingId: req.params.id,
            venueId,
            voterName,
            voterId
        });
        res.json(result);
    } catch (err) {
        next(err);
    }
}

async function getVotes(req, res, next) {
    try {
        const result = await outingService.getVotesForOuting(req.params.id);
        res.json(result);
    } catch (err) {
        next(err);
    }
}

function generateShareText(req, res, next) {
    try {
        const { venue, friends, groupScore, outingCode, shareToken } = req.body;
        const host = req.get('host') || 'gathermap.onrender.com';
        const protocol = req.protocol === 'https' || host.includes('render.com') ? 'https' : 'http';

        const token = shareToken || req.headers['x-share-token'] || req.query.token;

        const result = outingService.generateShareText({
            venue,
            friends,
            groupScore,
            outingCode,
            shareToken: token,
            host,
            protocol
        });
        res.json(result);
    } catch (err) {
        next(err);
    }
}

module.exports = {
    createOuting,
    getOuting,
    updateOuting,
    castVote,
    getVotes,
    generateShareText
};
