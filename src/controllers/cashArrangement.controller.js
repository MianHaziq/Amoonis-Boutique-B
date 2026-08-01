const { success, error } = require('../utils/response');
const prisma = require('../config/db');
const cashArrangementService = require('../services/cashArrangement.service');
const deliveryZoneService = require('../services/deliveryZone.service');

// ============================================
// GET /api/cash-arrangement  (admin) — every region + its enablement config
// ============================================
const listConfigs = async (req, res, next) => {
  try {
    const configs = await cashArrangementService.listConfigs();
    return success(res, configs, 'Cash arrangement configs fetched successfully', 200, { total: configs.length });
  } catch (err) {
    next(err);
  }
};

// ============================================
// GET /api/cash-arrangement/public — safe view for the storefront, resolved to the CURRENT
// region (req.regionId set by the `resolveRegion` middleware). Enablement only — no cart
// awareness, no fee schedule (that needs a specific product/category, see /resolve below).
// ============================================
const getPublicCashArrangementConfig = async (req, res, next) => {
  try {
    const config = await cashArrangementService.getPublicConfig(req.regionId);
    return success(res, config, 'Public cash arrangement config fetched successfully');
  } catch (err) {
    next(err);
  }
};

// ============================================
// GET /api/cash-arrangement/:regionId  (admin) — full config for ONE region, incl. scoped
// product/category ids
// ============================================
const getCashArrangementConfig = async (req, res, next) => {
  try {
    const config = await cashArrangementService.getConfig(req.params.regionId);
    return success(res, config, 'Cash arrangement config fetched successfully');
  } catch (err) {
    if (err.code === 'CASH_ARRANGEMENT_REGION_NOT_FOUND') return error(res, err.message, 404);
    next(err);
  }
};

// ============================================
// PUT /api/cash-arrangement/:regionId  (admin) — update enabled/appliesTo/scope/quick-pick
// amounts/denominations AND the region-wide FLAT fee schedule (feeStepAmount/feeMarginPercent)
// for ONE region. Finer product/category/zone fee overrides are edited elsewhere (product &
// category admin CRUD; zone flat fee via the delivery-zone PUT).
// ============================================
const updateCashArrangementConfig = async (req, res, next) => {
  try {
    const { enabled, appliesTo, productIds, categoryIds, quickPickAmounts, denominations, feeStepAmount, feeMarginPercent } = req.body;
    const config = await cashArrangementService.updateConfig(req.params.regionId, {
      enabled,
      appliesTo,
      productIds,
      categoryIds,
      quickPickAmounts,
      denominations,
      feeStepAmount,
      feeMarginPercent,
    });
    return success(res, config, 'Cash arrangement config updated successfully');
  } catch (err) {
    if (err.code === 'CASH_ARRANGEMENT_REGION_NOT_FOUND') return error(res, err.message, 404);
    if (err.code === 'VALIDATION') return error(res, err.message, 400);
    if (err && err.status === 400) {
      return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
  }
};

// ============================================
// POST /api/cash-arrangement/resolve — cart/zone-aware resolve. Body: { zoneId?, cartLines?:
// [{productId}] }. When cartLines is omitted, falls back to the signed-in user's stored cart
// (mirrors POST /promo-codes/validate). Returns eligibility + the fee schedule that would
// govern this cart, plus the region's quick-pick amounts/denominations. This is what checkout
// calls live as the customer builds their cash-arrangement request; the backend re-resolves
// authoritatively (with a tx-fresh read) again at order-creation time regardless.
// ============================================
const resolveCashArrangement = async (req, res, next) => {
  try {
    const { zoneId, cartLines: bodyCartLines } = req.body;

    let productIds = Array.isArray(bodyCartLines)
      ? [...new Set(bodyCartLines.map((l) => l?.productId).filter((id) => typeof id === 'string'))]
      : null;

    if (productIds == null) {
      // No cart lines to preview against. Guests (no userId) have no server cart, so they
      // must send cartLines in the body (mirrors promoCodeController.validatePromoCode).
      if (!req.userId) {
        return error(res, 'Send the cart lines to resolve cash arrangement', 400);
      }
      const cart = await prisma.cart.findUnique({
        where: { userId: req.userId },
        include: { items: { select: { productId: true } } },
      });
      productIds = [...new Set((cart?.items || []).map((ci) => ci.productId))];
    }

    if (productIds.length === 0) {
      return success(res, {
        eligible: false,
        feeStepAmount: null,
        feeMarginPercent: null,
        quickPickAmounts: [],
        denominations: [],
      });
    }

    // Hydrate categoryId for each cart line (resolveForOrder needs it for the enablement
    // scope check and the category tier of the fee chain).
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, categoryId: true },
    });
    const categoryById = new Map(products.map((p) => [p.id, p.categoryId ?? null]));
    const cartLines = productIds.map((productId) => ({
      productId,
      categoryId: categoryById.get(productId) ?? null,
    }));

    // Validate the zone actually belongs to (and is active in) the resolved region —
    // mirrors order.service.js's own zone validation before it ever reaches the fee
    // resolver. Unlike checkout, this is a PREVIEW endpoint: a stale/mismatched zoneId
    // degrades gracefully to "no zone" (falls back to the region/product/category tiers)
    // rather than erroring, so a client-side glitch never breaks the whole preview —
    // the authoritative order-creation path re-validates for real regardless.
    let validatedZoneId = null;
    if (zoneId) {
      try {
        const zone = await deliveryZoneService.assertValidZone(zoneId, req.regionId);
        validatedZoneId = zone.id;
      } catch (err) {
        if (!['ZONE_NOT_FOUND', 'ZONE_INACTIVE', 'ZONE_WRONG_REGION'].includes(err.code)) throw err;
      }
    }

    // Per-line resolution: the storefront needs each product's OWN fee schedule (cash is now
    // per line). Also derive the aggregate (first eligible line) for backward compatibility.
    const perLine = await cashArrangementService.resolveForLines({
      regionId: req.regionId,
      zoneId: validatedZoneId,
      cartLines,
    });
    const firstEligible = perLine.lines.find((l) => l.eligible) || null;

    return success(res, {
      // Aggregate (first eligible line) — kept for single-product callers (the PDP).
      eligible: Boolean(firstEligible),
      feeStepAmount: firstEligible ? firstEligible.feeStepAmount : null,
      feeMarginPercent: firstEligible ? firstEligible.feeMarginPercent : null,
      quickPickAmounts: perLine.quickPickAmounts,
      denominations: perLine.denominations,
      // Per-line: aligned with the deduped productIds sent, so checkout can price each line.
      lines: productIds.map((productId, i) => ({
        productId,
        eligible: Boolean(perLine.lines[i] && perLine.lines[i].eligible),
        feeStepAmount: perLine.lines[i] ? perLine.lines[i].feeStepAmount : null,
        feeMarginPercent: perLine.lines[i] ? perLine.lines[i].feeMarginPercent : null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listConfigs,
  getPublicCashArrangementConfig,
  getCashArrangementConfig,
  updateCashArrangementConfig,
  resolveCashArrangement,
};
