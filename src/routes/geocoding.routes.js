const express = require('express');
const router = express.Router();
const geocodingController = require('../controllers/geocoding.controller');
const { validateGeometricMedian } = require('../middleware/validation');

router.get('/geocode', geocodingController.geocode);
router.post('/center/geometric-median', validateGeometricMedian, geocodingController.computeGeometricMedian);

module.exports = router;
