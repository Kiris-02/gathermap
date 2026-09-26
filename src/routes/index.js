const express = require('express');
const router = express.Router();

const configRoutes = require('./config.routes');
const geocodingRoutes = require('./geocoding.routes');
const venuesRoutes = require('./venues.routes');
const outingsRoutes = require('./outings.routes');
const presetsRoutes = require('./presets.routes');

router.use('/', configRoutes);
router.use('/', geocodingRoutes);
router.use('/', venuesRoutes);
router.use('/', outingsRoutes);
router.use('/', presetsRoutes);

// Health check endpoint for monitoring & keep-alive
router.get('/health', (req, res) => {
    const { dbType } = require('../repositories/db-client');
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(process.uptime()),
        database: dbType
    });
});

module.exports = router;
