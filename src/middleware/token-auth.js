/**
 * Share Token Authentication Middleware
 * Enforces cryptographic token verification for private outing operations.
 */
const outingRepository = require('../repositories/outing-repository');
const { verifyShareToken, generateShareToken } = require('../services/outing-service');

function extractProvidedToken(req) {
    return req.headers['x-share-token'] || 
           (req.headers['authorization']?.startsWith('Bearer ') ? req.headers['authorization'].slice(7) : null) ||
           req.query?.token || 
           req.body?.token || 
           null;
}

async function requireShareToken(req, res, next) {
    try {
        const rawId = req.params.id || req.body?.outingId || req.query?.outingId;
        const outingId = typeof rawId === 'string' ? rawId.trim() : rawId;
        if (!outingId) {
            return res.status(400).json({ error: 'missing_outing_id', message: 'Outing ID is required' });
        }

        const outing = await outingRepository.getOuting(outingId);
        if (!outing) {
            return res.status(404).json({ error: 'outing_not_found', message: 'Outing session not found' });
        }

        const providedToken = extractProvidedToken(req);

        // Handle Legacy Outings (created before share tokens without a hash)
        if (!outing.share_token_hash) {
            return res.status(401).json({
                error: 'unauthorized',
                code: 'legacy_outing_upgrade_required',
                message: 'Kèo này được tạo từ phiên bản cũ chưa có mã bảo vệ. Vui lòng liên hệ quản trị viên hoặc sử dụng công cụ nâng cấp bảo mật để cấp link mới.'
            });
        }

        // Standard token verification for secured outings
        if (!providedToken) {
            return res.status(401).json({
                error: 'unauthorized',
                code: 'token_required',
                message: 'A valid share token is required to access or interact with this outing'
            });
        }

        const isValid = verifyShareToken(providedToken, outing.share_token_hash);
        if (!isValid) {
            return res.status(403).json({
                error: 'forbidden',
                code: 'invalid_token',
                message: 'Invalid share token'
            });
        }

        req.outing = outing;
        next();
    } catch (err) {
        next(err);
    }
}

async function requireShareTokenIfOutingSpecified(req, res, next) {
    const rawId = req.params.id || req.body?.outingId || req.query?.outingId;
    const outingId = typeof rawId === 'string' ? rawId.trim() : rawId;
    if (!outingId) {
        // No outing specified: allowed to create new outing
        return next();
    }
    const outing = await outingRepository.getOuting(outingId);
    if (!outing) {
        // Outing does not exist yet: allowed to create new outing with specified ID
        return next();
    }
    // Existing outing specified: strictly verify share token before proceeding
    return requireShareToken(req, res, next);
}

module.exports = {
    requireShareToken,
    requireShareTokenIfOutingSpecified,
    extractProvidedToken
};
