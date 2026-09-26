const express = require('express');
const router = express.Router();
const outingsController = require('../controllers/outings.controller');
const { validateVote } = require('../middleware/validation');
const { requireShareToken } = require('../middleware/token-auth');

router.post('/outings/create', outingsController.createOuting);
router.get('/outings/:id', requireShareToken, outingsController.getOuting);
router.put('/outings/:id', requireShareToken, outingsController.updateOuting);
router.post('/outings/:id/vote', requireShareToken, validateVote, outingsController.castVote);
router.get('/outings/:id/votes', requireShareToken, outingsController.getVotes);
router.post('/outings/generate-share-text', outingsController.generateShareText);

module.exports = router;
