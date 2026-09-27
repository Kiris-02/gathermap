/**
 * Config Controller
 * Provides safe system capabilities introspection without leaking API secrets.
 */

const { isSupabaseConfigured, dbType } = require('../repositories/db-client');

function getConfig(req, res) {
    const hasGoogleKey = Boolean(process.env.GOOGLE_MAPS_API_KEY);
    const hasAIKey = Boolean(process.env.GEMINI_API_KEY);

    res.json({
        mapsConfigured: hasGoogleKey,
        aiConfigured: hasAIKey,
        hasGoogleKey, // legacy alias for backward compatibility
        hasAIKey,     // legacy alias for backward compatibility
        aiModel: hasAIKey ? 'Gemini Flash Multi-Model' : 'Rule-Based Fallback',
        databaseType: dbType,
        isSupabaseConfigured,
        version: '2.5.0-clean-architecture',
        product: 'Group Eatery Recommendation Engine'
    });
}

module.exports = {
    getConfig
};
