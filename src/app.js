/**
 * Express Application Setup
 * Configures middleware, static asset caching headers, routing pipelines, and centralized error handling.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const apiRoutes = require('./routes');
const { errorHandler } = require('./middleware/error-handler');

const app = express();

app.use(cors());
app.use(express.json());

// Guard against malformed JSON client payloads
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        console.warn('⚠️ Rejected malformed JSON request:', err.message);
        return res.status(400).json({ error: 'Malformed JSON payload', message: err.message });
    }
    next(err);
});

// Static assets with strong no-cache headers for HTML files
app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: 0,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// Mount all API routes under /api
app.use('/api', apiRoutes);

// Centralized error handling middleware
app.use(errorHandler);

module.exports = app;
