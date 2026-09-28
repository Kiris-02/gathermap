/**
 * GatherMap Server Entry Point
 * Mounts the modular application from src/app.js and launches the HTTP listener.
 */

const app = require('./src/app');
const { dbType } = require('./src/repositories/db-client');
const { preloadAllReviews } = require('./src/repositories/review-repository');

const PORT = process.env.PORT || 3000;

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`🚀 GATHERMAP backend running at http://localhost:${PORT}`);
        console.log(`🤖 AI Engine: ${process.env.GEMINI_API_KEY ? 'Connected (Gemini Multi-Model Fallback)' : 'Rule-Based Fallback'}`);
        console.log(`💾 Database: ${dbType}`);
        preloadAllReviews().then(() => {
            console.log('⚡ All venue reviews preloaded into memory cache');
        }).catch((err) => {
            console.warn('Review preload warning:', err.message);
        });

        // Self-ping every 9 minutes to prevent Render Free Tier from idling
        const RENDER_APP_URL = process.env.RENDER_EXTERNAL_URL || 'https://gathermap.onrender.com';
        if (process.env.NODE_ENV === 'production' || process.env.RENDER) {
            console.log(`⏱️ Keep-Alive ping active targeting: ${RENDER_APP_URL}/api/health`);
            setInterval(async () => {
                try {
                    await fetch(`${RENDER_APP_URL}/api/health`);
                    console.log(`💓 Keep-alive ping sent to ${RENDER_APP_URL}`);
                } catch (err) {
                    // silent fallback
                }
            }, 9 * 60 * 1000);
        }
    });
}

module.exports = app;
