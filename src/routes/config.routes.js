const express = require('express');
const router = express.Router();
const configController = require('../controllers/config.controller');

router.get('/config', configController.getConfig);

module.exports = router;
