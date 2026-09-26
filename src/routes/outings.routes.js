const express = require('express');
const router = express.Router();
const outingsController = require('../controllers/outings.controller');
const { validateVote } = require('../middleware/validation');

router.post('/outings/create', outingsController.createOuting);
router.get('/outings/:id', outingsController.getOuting);
router.post('/outings/:id/vote', validateVote, outingsController.castVote);
router.get('/outings/:id/votes', outingsController.getVotes);
router.post('/outings/generate-share-text', outingsController.generateShareText);

module.exports = router;
