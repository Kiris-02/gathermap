const express = require('express');
const router = express.Router();
const configController = require('../controllers/config.controller');

router.get('/config', configController.getConfig);
router.post('/config/maps-key', configController.updateMapsKey);

module.exports = router;
