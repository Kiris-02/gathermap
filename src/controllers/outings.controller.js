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
        const outing = await outingService.getOutingById(req.params.id);
        if (!outing) {
            return res.status(404).json({ error: 'outing_not_found', message: 'Outing session not found' });
        }
        res.json({
            outing,
            votes: outing.votes || [],
            ...outing
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
        const { venue, friends, groupScore, outingCode } = req.body;
        const host = req.get('host') || 'gathermap.onrender.com';
        const protocol = req.protocol === 'https' || host.includes('render.com') ? 'https' : 'http';

        const result = outingService.generateShareText({
            venue,
            friends,
            groupScore,
            outingCode,
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
    castVote,
    getVotes,
    generateShareText
};
