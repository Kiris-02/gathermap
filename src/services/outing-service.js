/**
 * Outing Service
 * Coordinates outing creation, participant tracking, deduplicated voting, and shareable invitation text.
 */

const outingRepository = require('../repositories/outing-repository');
const { calcDistanceKm } = require('../algorithms/geometric-median');
const { buildDirectionsUrl } = require('./places-service');
const { dbType } = require('../repositories/db-client');

async function createOuting({ name = 'Weekend Hangout', mode = 'representative', centerLat = 10.7769, centerLng = 106.7009, radiusKm = 3.0 }) {
    const outingId = 'EAT-' + Math.floor(1000 + Math.random() * 9000);
    await outingRepository.saveOuting({
        id: outingId,
        name,
        mode,
        centerLat,
        centerLng,
        radiusKm
    });
    return {
        id: outingId,
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

function generateShareText({ venue, friends = [], groupScore, outingCode = 'EAT-2026', host = 'gathermap.onrender.com', protocol = 'https' }) {
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
    const appUrl = `${protocol}://${host}/?outing=${outingCode}`;

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

module.exports = {
    createOuting,
    getOutingById,
    castVote,
    getVotesForOuting,
    generateShareText
};
