const express = require('express');
const router = express.Router();
const presetsController = require('../controllers/presets.controller');

router.get('/presets', presetsController.getPresets);

module.exports = router;
