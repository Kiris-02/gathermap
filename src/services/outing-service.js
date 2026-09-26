/**
 * Outing Service
 * Coordinates outing creation, participant tracking, deduplicated voting, and shareable invitation text.
 */

const crypto = require('crypto');
const outingRepository = require('../repositories/outing-repository');
const { calcDistanceKm } = require('../algorithms/geometric-median');
const { buildDirectionsUrl } = require('./places-service');
const { dbType } = require('../repositories/db-client');

const CODE_CHARSET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function generateShareToken() {
    const rawToken = crypto.randomBytes(24).toString('base64url');
    const tokenHash = hashShareToken(rawToken);
    return { rawToken, tokenHash };
}

function hashShareToken(token) {
    if (!token) return '';
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function verifyShareToken(providedToken, storedHash) {
    if (!providedToken || !storedHash) return false;
    const providedHash = hashShareToken(providedToken);
    try {
        const bufA = Buffer.from(providedHash, 'hex');
        const bufB = Buffer.from(storedHash, 'hex');
        if (bufA.length !== bufB.length) return false;
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (_) {
        return false;
    }
}

async function generateUniqueOutingId() {
    for (let attempt = 0; attempt < 5; attempt++) {
        const bytes = crypto.randomBytes(6);
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += CODE_CHARSET[bytes[i] % CODE_CHARSET.length];
        }
        const candidateId = `EAT-${code}`;
        const existing = await outingRepository.getOuting(candidateId);
        if (!existing) {
            return candidateId;
        }
    }
    return `EAT-${Date.now().toString(36).toUpperCase()}`;
}

async function createOuting({ name = 'Weekend Hangout', mode = 'representative', centerLat = 10.7769, centerLng = 106.7009, radiusKm = 3.0 }) {
    const outingId = await generateUniqueOutingId();
    const { rawToken, tokenHash } = generateShareToken();
    await outingRepository.saveOuting({
        id: outingId,
        name,
        mode,
        centerLat,
        centerLng,
        radiusKm,
        shareTokenHash: tokenHash
    });
    return {
        id: outingId,
        shareToken: rawToken,
        name,
        mode,
        status: 'active',
        database: dbType
    };
}

async function getOutingById(id) {
    return await outingRepository.getOuting(id);
}

async function castVote({ outingId, venueId, voterName = 'Guest', voterId = null }) {
    return await outingRepository.recordVote(outingId, venueId, voterName, voterId);
}

async function getVotesForOuting(outingId) {
    const votes = await outingRepository.getVotes(outingId);
    return {
        outingId,
        votes: votes || {}
    };
}

function generateShareText({ venue, friends = [], groupScore, outingCode = 'EAT-2026', shareToken = '', host = 'gathermap.onrender.com', protocol = 'https' }) {
    if (!venue) {
        throw new Error('Venue data required');
    }

    const friendTravels = friends.map(f => {
        const dKm = calcDistanceKm({ lat: f.lat, lng: f.lng }, { lat: venue.lat, lng: venue.lng });
        const estMin = Math.max(3, Math.round(dKm * 3.2));
        return '  👤 ' + f.name + ': ~' + dKm.toFixed(1) + ' km (~' + estMin + ' phút - ước tính)';
    }).join('\n');

    const signature = (venue.signatureDishes && venue.signatureDishes.length > 0)
        ? venue.signatureDishes.join(', ')
        : (venue.category || 'Món ngon bản địa');

    const mapsUrl = buildDirectionsUrl(venue);
    const tokenParam = shareToken ? `&token=${encodeURIComponent(shareToken)}` : '';
    const appUrl = `${protocol}://${host}/?outing=${encodeURIComponent(outingCode)}${tokenParam}`;

    const message = [
        '🎉 KÈO ĂN UỐNG ĐÃ CHỐT BẰNG GATHERMAP!',
        '──────────────────────',
        '📍 Quán: ' + venue.name,
        '🏠 Địa chỉ: ' + (venue.address || 'Trung tâm TP.HCM'),
        '⭐ Đánh giá: ' + (venue.rating || 4.5) + '★ | 💰 Giá: ' + (venue.avgPrice || venue.priceLevel || 'Bình dân'),
        '⚖️ Độ công bằng vị trí nhóm: ' + (venue.groupScore || groupScore || 90) + '/100',
        '',
        '🚗 Khoảng cách di chuyển của từng bạn (ước tính):',
        friendTravels,
        '',
        '🍜 Món ruột nên thử: ' + signature,
        (venue.socialCons ? '⚠️ Lưu ý: ' + venue.socialCons : ''),
        '',
        '🗺️ Bấm vào đây để chỉ đường Google Maps:',
        mapsUrl,
        '──────────────────────',
        '👉 Xem bản đồ & cùng bình chọn tại: ' + appUrl + ' (Mã kèo: #' + outingCode + ')'
    ].filter(line => line !== null && line !== undefined).join('\n');

    return {
        message,
        shareUrl: mapsUrl,
        venueName: venue.name,
        appUrl
    };
}

async function updateOutingSettings(outingId, updates) {
    return await outingRepository.updateOutingSettings(outingId, updates);
}

async function reissueLegacyOutingShareToken({ outingId, force = false }) {
    if (!outingId) throw new Error('outingId is required');
    const outing = await outingRepository.getOuting(outingId);
    if (!outing) {
        throw new Error(`Outing session "${outingId}" not found`);
    }

    if (outing.share_token_hash && !force) {
        return {
            success: false,
            outingId,
            reason: 'already_secured',
            message: `Outing ${outingId} already has a share token configured. Use --force if you intentionally want to rotate the token.`
        };
    }

    const { rawToken, tokenHash } = generateShareToken();
    let result;
    if (force) {
        result = await outingRepository.forceReissueOutingShareToken(outingId, tokenHash);
    } else {
        result = await outingRepository.setLegacyOutingShareToken(outingId, tokenHash);
    }

    if (!result.success) {
        return {
            success: false,
            outingId,
            reason: 'update_conflict',
            message: `Failed to update share token for outing ${outingId}. It may have been upgraded concurrently.`
        };
    }

    return {
        success: true,
        outingId,
        shareToken: rawToken,
        tokenHash,
        message: `Share token successfully issued for outing ${outingId}`
    };
}

module.exports = {
    generateUniqueOutingId,
    generateShareToken,
    hashShareToken,
    verifyShareToken,
    createOuting,
    getOutingById,
    updateOutingSettings,
    castVote,
    getVotesForOuting,
    generateShareText,
    reissueLegacyOutingShareToken
};
