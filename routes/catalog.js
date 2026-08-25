const express = require('express');
const syncAuth = require('../middleware/syncAuth');
const CatalogStockService = require('../services/sage/catalogStockService');

const router = express.Router();

router.get('/stock', syncAuth, async (req, res, next) => {
  try {
    const service = new CatalogStockService();
    const products = await service.fetchStock({
      location: req.query.location || req.headers['x-store-number'] || '',
      prefix: req.query.prefix || '',
    });

    return res.json({
      success: true,
      count: products.length,
      products,
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
