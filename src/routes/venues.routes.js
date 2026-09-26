const express = require('express');
const router = express.Router();
const venuesController = require('../controllers/venues.controller');
const { validateSearchAndRank, validateReview } = require('../middleware/validation');
const { requireShareTokenIfOutingSpecified } = require('../middleware/token-auth');

router.get(['/venues', '/venues/all'], venuesController.getVenues);
router.post('/venues/search-and-rank', validateSearchAndRank, requireShareTokenIfOutingSpecified, venuesController.handleSearchAndRank);
router.post('/places/nearby', venuesController.nearbyPlaces);
router.post('/preferences/parse', venuesController.handleParsePreferences);

router.get('/venues/:id/map-link', venuesController.getVenueMapLink);
router.get('/venues/:id/reviews', venuesController.getVenueReviews);
router.get('/venues/:id/reviewers', venuesController.getVenueReviewers);
router.post('/venues/:id/reviews', validateReview, venuesController.addVenueReview);

module.exports = router;
