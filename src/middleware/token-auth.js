/**
 * Share Token Authentication Middleware
 * Enforces cryptographic token verification for private outing operations.
 */
const outingRepository = require('../repositories/outing-repository');
const { verifyShareToken } = require('../services/outing-service');

async function requireShareToken(req, res, next) {
    try {
        const outingId = req.params.id || req.body?.outingId || req.query?.outingId;
        if (!outingId) {
            return res.status(400).json({ error: 'missing_outing_id', message: 'Outing ID is required' });
        }

        const providedToken = req.headers['x-share-token'] || 
                              req.query?.token || 
                              req.body?.token ||
                              (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null);

        if (!providedToken) {
            return res.status(401).json({
                error: 'unauthorized',
                message: 'A valid share token is required to access or interact with this outing'
            });
        }

        const outing = await outingRepository.getOuting(outingId);
        if (!outing) {
            return res.status(404).json({ error: 'outing_not_found', message: 'Outing session not found' });
        }

        if (!outing.share_token_hash) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Invalid share token'
            });
        }

        const isValid = verifyShareToken(providedToken, outing.share_token_hash);
        if (!isValid) {
            return res.status(403).json({
                error: 'forbidden',
                message: 'Invalid share token'
            });
        }

        req.outing = outing;
        next();
    } catch (err) {
        next(err);
    }
}

module.exports = {
    requireShareToken
};
