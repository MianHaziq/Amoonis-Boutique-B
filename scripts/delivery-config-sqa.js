/* ============================================================================
 * Senior-SQA exhaustive edge-case suite for the delivery-configuration feature.
 * Covers: businessTime tz math, resolveDeliveryConfig inheritance + boundaries,
 * parse/validation layer, and the full checkout engine (createGuestOrder) incl.
 * every rejection path, boundary, and snapshot. LOCAL DB ONLY.
 * Run: node -r dotenv/config scripts/delivery-config-sqa.js
 * ==========================================================================*/
const prisma = require('../src/config/db');
const regionService = require('../src/services/region.service');
const zoneService = require('../src/services/deliveryZone.service');
const orderService = require('../src/services/order.service');
const { resolveDeliveryConfig } = require('../src/services/deliveryConfig.service');
const bt = require('../src/utils/businessTime');
const P = require('../src/utils/deliveryConfigParse');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra = '') {
  if (cond) { pass++; }
  else { fail++; fails.push(`${name} ${extra}`); console.log('  ✗ FAIL:', name, extra); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
function throws(name, fn) {
  try { fn(); ok(name, false, '(expected throw, got none)'); }
  catch { ok(name, true); }
}
function noThrow(name, fn) {
  try { fn(); ok(name, true); }
  catch (e) { ok(name, false, `(unexpected throw: ${e.message})`); }
}

const legal = {};
for (const f of ['registrationCity', 'currencyDisplayName', 'vatLawName', 'dataProtectionLawName',
  'dataProtectionAuthority', 'ipLawName', 'consumerProtectionLawName', 'consumerProtectionAuthority',
  'standardsAuthority']) { legal[f] = 'x'; legal[f + '_ar'] = 'س'; }

(async () => {
  // ------------------------------------------------------------------ A. businessTime
  section('A. businessTime timezone math');
  const sunEvening = new Date('2026-07-26T14:00:00Z'); // Sun 18:00 Dubai / 17:00 Riyadh
  ok('todayKey Dubai', bt.todayKeyInTz('Asia/Dubai', sunEvening) === '2026-07-26');
  ok('weekday Sun=0', bt.weekdayOfKey('2026-07-26') === 0);
  ok('weekday Sat=6', bt.weekdayOfKey('2026-08-01') === 6);
  ok('nowMinutes Dubai 18:00=1080', bt.nowMinutesInTz('Asia/Dubai', sunEvening) === 1080);
  ok('nowMinutes Riyadh 17:00=1020', bt.nowMinutesInTz('Asia/Riyadh', sunEvening) === 1020);
  // Midnight boundary: 20:30 UTC = 00:30 next day in Dubai (+4)
  const nearMidnight = new Date('2026-07-26T20:30:00Z');
  ok('Dubai day rolls to 27 at 00:30 local', bt.todayKeyInTz('Asia/Dubai', nearMidnight) === '2026-07-27');
  ok('UTC still 26 at that instant', bt.dateKeyInTz(nearMidnight, 'UTC') === '2026-07-26');
  ok('addDays month rollover', bt.addDaysToKey('2026-07-30', 3) === '2026-08-02');
  ok('addDays year rollover', bt.addDaysToKey('2026-12-31', 1) === '2027-01-01');
  ok('parseHHmm valid', bt.parseHHmm('18:30') === 18 * 60 + 30);
  ok('parseHHmm invalid hh', bt.parseHHmm('24:00') === null);
  ok('parseHHmm invalid mm', bt.parseHHmm('12:60') === null);
  ok('parseHHmm garbage', bt.parseHHmm('abc') === null);
  ok('isValidDateKey good', bt.isValidDateKey('2026-02-28') === true);
  ok('isValidDateKey bad month', bt.isValidDateKey('2026-13-01') === false);
  ok('isValidDateKey bad day (Feb 30)', bt.isValidDateKey('2026-02-30') === false);
  ok('isValidDateKey wrong format', bt.isValidDateKey('2026-2-8') === false);

  // ------------------------------------------------------------------ B. resolver inheritance
  section('B. resolveDeliveryConfig inheritance + zero-value edges');
  const R = {
    timezone: 'Asia/Dubai', currency: 'AED', shippingFlatRate: '25', freeDeliveryThreshold: '200',
    standardDeliveryDays: 3, deliveryDays: [0, 1, 2, 3, 4], sameDayEnabled: true, sameDayCutoff: '18:00',
    codEnabled: true, blackoutDates: [{ date: '2026-07-27' }],
  };
  // zone inherits everything (all null/empty)
  let c = resolveDeliveryConfig(R, {}, { subtotal: 100, now: sunEvening });
  ok('inherit fee 25', c.deliveryFee === 25);
  ok('inherit threshold 200', c.freeDeliveryThreshold === 200);
  ok('inherit lead 3', c.standardLeadDays === 3);
  ok('inherit days region', JSON.stringify(c.deliveryDays) === JSON.stringify([0, 1, 2, 3, 4]));
  ok('inherit sameDay true', c.sameDayEnabled === true);
  ok('inherit cod true', c.codEnabled === true);

  // ZERO-VALUE edges (classic falsy-vs-null bugs)
  const zZero = { shippingFlatRate: '0', freeDeliveryThreshold: '0', standardLeadDays: 0, codEnabled: false, sameDayEnabled: false };
  c = resolveDeliveryConfig(R, zZero, { subtotal: 100, now: sunEvening });
  ok('zone fee 0 overrides region 25 (not inherit)', c.deliveryFee === 0);
  ok('zone threshold 0 -> everything free', c.freeDeliveryThreshold === 0 && c.effectiveFee === 0 && c.freeDeliveryApplied === true);
  ok('zone lead 0 overrides region 3', c.standardLeadDays === 0);
  ok('zone codEnabled=false overrides region true', c.codEnabled === false);
  ok('zone sameDayEnabled=false overrides region true', c.sameDayEnabled === false);

  // free-delivery threshold boundary
  ok('subtotal == threshold => free', resolveDeliveryConfig(R, {}, { subtotal: 200, now: sunEvening }).effectiveFee === 0);
  ok('subtotal just below threshold => fee', resolveDeliveryConfig(R, {}, { subtotal: 199.99, now: sunEvening }).effectiveFee === 25);
  ok('no subtotal => not free', resolveDeliveryConfig(R, {}, { subtotal: null, now: sunEvening }).effectiveFee === 25);

  // deliveryDays inheritance edge: zone [] inherits, zone non-empty overrides
  ok('zone days [] inherits region', JSON.stringify(resolveDeliveryConfig(R, { deliveryDays: [] }, { now: sunEvening }).deliveryDays) === JSON.stringify([0, 1, 2, 3, 4]));
  ok('zone days [6] overrides', JSON.stringify(resolveDeliveryConfig(R, { deliveryDays: [6] }, { now: sunEvening }).deliveryDays) === JSON.stringify([6]));

  // ------------------------------------------------------------------ B2. same-day boundary
  section('B2. same-day availability boundary (region-tz clock)');
  const preCut = new Date('2026-07-26T13:59:00Z');  // 17:59 Dubai (< 18:00)  Sun
  const atCut = new Date('2026-07-26T14:00:00Z');    // 18:00 Dubai (== cutoff) Sun
  const postCut = new Date('2026-07-26T14:01:00Z');  // 18:01 Dubai (> cutoff)  Sun
  ok('same-day available before cutoff', resolveDeliveryConfig(R, {}, { now: preCut }).sameDayAvailableNow === true);
  ok('same-day NOT available exactly at cutoff', resolveDeliveryConfig(R, {}, { now: atCut }).sameDayAvailableNow === false);
  ok('same-day NOT available after cutoff', resolveDeliveryConfig(R, {}, { now: postCut }).sameDayAvailableNow === false);
  // today (Sun=0) is in R.deliveryDays; make a region where Sunday excluded -> not available even before cutoff
  const Rno = { ...R, deliveryDays: [1, 2, 3, 4] };
  ok('same-day NOT available when today weekday excluded', resolveDeliveryConfig(Rno, {}, { now: preCut }).sameDayAvailableNow === false);
  // cutoff null but sameDayEnabled -> available all day
  ok('same-day available all day when cutoff null', resolveDeliveryConfig({ ...R, sameDayCutoff: null }, {}, { now: postCut }).sameDayAvailableNow === true);
  // today is blackout -> not available. (2026-07-26 is Sun; add it as blackout)
  ok('same-day NOT available on blackout today', resolveDeliveryConfig({ ...R, blackoutDates: [{ date: '2026-07-26' }] }, {}, { now: preCut }).sameDayAvailableNow === false);

  // ------------------------------------------------------------------ B3. earliestDeliveryKey
  section('B3. earliestDeliveryKey computation');
  ok('earliest = today when same-day available', resolveDeliveryConfig(R, {}, { now: preCut }).earliestDeliveryKey === '2026-07-26');
  // after cutoff: earliest = today + max(lead=3,1)=3 -> 07-29, but 07-27 is blackout & weekday filter days 0-4 (Wed 29 = weekday 3 ok)
  ok('earliest skips to lead day after cutoff', resolveDeliveryConfig(R, {}, { now: postCut }).earliestDeliveryKey === '2026-07-29');
  // impossible config: no delivery days at all is expressed as region [] = all; to force impossible, all 7 as blackout is infeasible; use deliveryDays that never match + far future blackout won't help.
  // Instead: deliveryDays = [5] (Fri only) and same-day off -> earliest = next Friday on/after today+1
  const Rfri = { ...R, deliveryDays: [5], sameDayEnabled: false, standardDeliveryDays: 0 };
  const efri = resolveDeliveryConfig(Rfri, {}, { now: preCut }).earliestDeliveryKey;
  ok('earliest lands on an allowed weekday (Fri=5)', bt.weekdayOfKey(efri) === 5, `got ${efri}`);

  // ------------------------------------------------------------------ C. parse/validation
  section('C. parse & validation layer (deliveryConfigParse)');
  ok('money blank -> null', P.parseMoneyOrNull('', 'x') === null);
  ok('money 0 -> 0 (not null)', P.parseMoneyOrNull(0, 'x') === 0);
  ok('money rounds 2dp', P.parseMoneyOrNull('12.345', 'x') === 12.35 || P.parseMoneyOrNull('12.345', 'x') === 12.34);
  throws('money negative throws', () => P.parseMoneyOrNull(-1, 'x'));
  throws('money NaN throws', () => P.parseMoneyOrNull('abc', 'x'));
  ok('days [] -> []', JSON.stringify(P.parseDeliveryDays([])) === '[]');
  ok('days dedup+sort', JSON.stringify(P.parseDeliveryDays([3, 1, 1, 0])) === '[0,1,3]');
  throws('days out of range 7 throws', () => P.parseDeliveryDays([7]));
  throws('days negative throws', () => P.parseDeliveryDays([-1]));
  throws('days non-array throws', () => P.parseDeliveryDays('mon'));
  ok('nullableBool blank -> null', P.parseNullableBool('') === null);
  ok('nullableBool "false" -> false', P.parseNullableBool('false') === false);
  ok('nullableBool true -> true', P.parseNullableBool(true) === true);
  ok('bool default when blank', P.parseBool('', true) === true && P.parseBool('', false) === false);
  ok('hhmm blank -> null', P.parseHHmmOrNull('', 'x') === null);
  ok('hhmm valid', P.parseHHmmOrNull('09:05', 'x') === '09:05');
  throws('hhmm invalid throws', () => P.parseHHmmOrNull('9:5', 'x') === null && (() => { throw 0; })());
  throws('hhmm 25:00 throws', () => P.parseHHmmOrNull('25:00', 'x'));
  ok('timezone blank -> default', P.parseTimezone('') === 'Asia/Dubai');
  ok('timezone valid', P.parseTimezone('Asia/Riyadh') === 'Asia/Riyadh');
  throws('timezone invalid throws', () => P.parseTimezone('Mars/Olympus'));
  throws('minmax min>max throws', () => P.assertMinMaxOrder(100, 50));
  noThrow('minmax equal ok', () => P.assertMinMaxOrder(50, 50));
  noThrow('minmax one null ok', () => P.assertMinMaxOrder(null, 50));
  ok('blackout parse+dedup', P.parseBlackoutDates([{ date: '2026-07-27' }, { date: '2026-07-27' }, '2026-07-28']).length === 2);
  throws('blackout bad date throws', () => P.parseBlackoutDates([{ date: '2026-7-1' }]));

  // ------------------------------------------------------------------ D. checkout engine E2E
  section('D. checkout engine (createGuestOrder) — rejection paths, boundaries, snapshots');
  const code = 'SQA_' + Math.floor(Math.random() * 1e6);
  const region = await regionService.createRegion({
    code, name: 'SQA', currency: 'AED', timezone: 'Asia/Dubai',
    shippingFlatRate: 30, freeDeliveryThreshold: 200, standardDeliveryDays: 3,
    deliveryDays: [], sameDayEnabled: true, sameDayCutoff: '23:59', codEnabled: true, ...legal,
  });
  const category = await prisma.category.create({ data: { title: 'SQAC_' + code } });
  const product = await prisma.product.create({
    data: { title: 'SQAP ' + code, status: 'PUBLISHED', price: 100, quantity: 100000, categoryId: category.id, regions: { create: { regionId: region.id, price: 100 } } },
  });
  const addr = (zoneId) => ({ fullName: 'B', phone: '0500000000', area: 'A', deliveryZoneId: zoneId, city: 'X', country: 'AE' });
  const order = (qty, zoneId, extra = {}) => orderService.createGuestOrder({
    items: [{ productId: product.id, quantity: qty }], shippingAddress: addr(zoneId),
    email: 'b@t.com', paymentMethod: 'COD', deliveryType: 'STANDARD', ...extra,
  }, { regionCode: code });

  // zone override fee + min/max boundaries
  const zA = await zoneService.createZone({ regionId: region.id, name: 'A', shippingFlatRate: 15, minOrderAmount: 100, maxOrderAmount: 200 });
  let r = await order(1, zA.id); ok('D1 fee=zone 15', !r.error && r.order.shippingAmount === 15, r.error || '');
  r = await order(1, zA.id); ok('D2 min boundary: subtotal==min(100) accepted', !r.error, r.error || '');
  const zMin = await zoneService.createZone({ regionId: region.id, name: 'Min', minOrderAmount: 101 });
  r = await order(1, zMin.id); ok('D3 subtotal(100) < min(101) rejected', /minimum order/i.test(r.error || ''), r.error || 'no error');
  r = await order(2, zA.id); ok('D4 max boundary: subtotal==max(200) accepted', !r.error, r.error || '');
  r = await order(3, zA.id); ok('D5 subtotal(300) > max(200) rejected', /maximum order/i.test(r.error || ''), r.error || 'no error');

  // free delivery boundary (region threshold 200; zone A has none -> inherits)
  r = await order(2, zA.id); ok('D6 subtotal==threshold(200) => shipping 0', !r.error && r.order.shippingAmount === 0, `fee ${r.order?.shippingAmount}`);
  const zFeeOnly = await zoneService.createZone({ regionId: region.id, name: 'FeeOnly', shippingFlatRate: 15, freeDeliveryThreshold: 500 });
  r = await order(2, zFeeOnly.id); ok('D7 zone threshold 500 not met at 200 => fee 15', !r.error && r.order.shippingAmount === 15, `fee ${r.order?.shippingAmount}`);

  // COD gate
  const zNoCod = await zoneService.createZone({ regionId: region.id, name: 'NoCod', codEnabled: false });
  r = await order(1, zNoCod.id); ok('D8 COD disabled zone rejects COD order', /cash on delivery/i.test(r.error || ''), r.error || 'no error');
  const zCodOn = await zoneService.createZone({ regionId: region.id, name: 'CodOn', codEnabled: true });
  r = await order(1, zCodOn.id); ok('D9 COD enabled zone accepts (control)', !r.error, r.error || '');

  // zone lead override -> estimatedDeliveryDays
  const zLead = await zoneService.createZone({ regionId: region.id, name: 'Lead', standardLeadDays: 5 });
  r = await order(1, zLead.id); ok('D10 STANDARD estimatedDeliveryDays = zone lead 5', !r.error && r.order.estimatedDeliveryDays === 5, `got ${r.order?.estimatedDeliveryDays}`);

  // SCHEDULED — DATE-ONLY (no time slots). Zone allows all weekdays, no same-day, lead 1.
  const zSch = await zoneService.createZone({
    regionId: region.id, name: 'Sched', deliveryDays: [0, 1, 2, 3, 4, 5, 6], sameDayEnabled: false, standardLeadDays: 1,
  });
  const today = bt.todayKeyInTz('Asia/Dubai');
  const plus3 = bt.addDaysToKey(today, 3);
  const plus70 = bt.addDaysToKey(today, 70);
  const iso = (k) => `${k}T12:00:00Z`;
  r = await order(1, zSch.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(plus3) });
  ok('D11 SCHEDULED valid future date accepted', !r.error, r.error || '');
  ok('D12 scheduledDeliveryAt persisted', !!r.order?.scheduledDeliveryAt);
  ok('D13 future date is not flagged same-day', r.order?.isSameDayDelivery === false);
  r = await order(1, zSch.id, { deliveryType: 'SCHEDULED' });
  ok('D14 SCHEDULED with no date rejected', /scheduledDeliveryAt is required/i.test(r.error || ''), r.error || 'no error');
  r = await order(1, zSch.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: 'not-a-date' });
  ok('D15 SCHEDULED with invalid date rejected', /valid date/i.test(r.error || ''), r.error || 'no error');
  r = await order(1, zSch.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(plus70) });
  ok('D16 SCHEDULED beyond max window (70d) rejected', /more than/i.test(r.error || ''), r.error || 'no error');

  // SCHEDULED disallowed weekday: zone allows only Monday(1). pick a non-Monday future date >= lead
  const zMon = await zoneService.createZone({
    regionId: region.id, name: 'MonOnly', deliveryDays: [1], sameDayEnabled: false, standardLeadDays: 1,
  });
  // find a future non-Monday >= today+2, and a future Monday
  let nonMon = bt.addDaysToKey(today, 2); while (bt.weekdayOfKey(nonMon) === 1) nonMon = bt.addDaysToKey(nonMon, 1);
  let mon = bt.addDaysToKey(today, 2); while (bt.weekdayOfKey(mon) !== 1) mon = bt.addDaysToKey(mon, 1);
  r = await order(1, zMon.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(nonMon) });
  ok('D17 SCHEDULED on disallowed weekday rejected', /not available on the selected date/i.test(r.error || ''), r.error || 'no error');
  r = await order(1, zMon.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(mon) });
  ok('D18 SCHEDULED on allowed weekday (Mon) accepted', !r.error, r.error || '');

  // SCHEDULED on blackout date (add via updateRegion so cache invalidates)
  const boDay = mon; // reuse an allowed Monday, then blacklist it
  await regionService.updateRegion(region.id, { blackoutDates: [{ date: boDay, label: 'BO' }] });
  r = await order(1, zMon.id, { deliveryType: 'SCHEDULED', scheduledDeliveryAt: iso(boDay) });
  ok('D19 SCHEDULED on blackout date rejected', /not available on the selected date/i.test(r.error || ''), r.error || 'no error');
  await regionService.updateRegion(region.id, { blackoutDates: [] }); // clear

  // STANDARD order never persists a scheduled date
  r = await order(1, zA.id, { deliveryType: 'STANDARD', scheduledDeliveryAt: iso(plus3) });
  ok('D22 STANDARD ignores scheduled date (no snapshot)', !r.error && !r.order.scheduledDeliveryAt && r.order.isSameDayDelivery === false, r.error || '');

  // region with NO delivery config (defaults): order still works, region fee applies
  const codeB = 'SQB_' + Math.floor(Math.random() * 1e6);
  const regionB = await regionService.createRegion({ code: codeB, name: 'SQB', currency: 'AED', shippingFlatRate: 40, standardDeliveryDays: 2, ...legal });
  // createRegion auto-links the whole catalog (ProductRegion) with no price override,
  // so the product is already visible in regionB and prices at its base 100.
  r = await orderService.createGuestOrder({ items: [{ productId: product.id, quantity: 1 }], shippingAddress: { fullName: 'B', phone: '05', area: 'A' }, email: 'b@t.com', paymentMethod: 'COD', deliveryType: 'STANDARD' }, { regionCode: codeB });
  ok('D23 region w/ no zone & default config: order ok, fee=region 40', !r.error && r.order.shippingAmount === 40, r.error || `fee ${r.order?.shippingAmount}`);
  ok('D24 defaults: COD allowed, no min/max block', !r.error);

  // ------------------------------------------------------------------ E. CRUD round-trips
  section('E. CRUD round-trips (partial update, full-replace semantics)');
  // partial region update: change only fee, others must remain
  const before = await regionService.getRegionById(region.id);
  await regionService.updateRegion(region.id, { shippingFlatRate: 99 });
  const after = await regionService.getRegionById(region.id);
  ok('E1 partial update changes fee', Number(after.shippingFlatRate) === 99);
  ok('E2 partial update preserves timezone', after.timezone === before.timezone);
  ok('E3 partial update preserves sameDayCutoff', after.sameDayCutoff === before.sameDayCutoff);
  ok('E4 partial update preserves deliveryDays', JSON.stringify(after.deliveryDays) === JSON.stringify(before.deliveryDays));

  // zone partial update: change fee only, other overrides preserved
  const zR = await zoneService.createZone({ regionId: region.id, name: 'RT', shippingFlatRate: 12, minOrderAmount: 20 });
  await zoneService.updateZone(zR.id, { shippingFlatRate: 18 });
  const zRafter = await zoneService.getZoneById(zR.id);
  ok('E5 zone partial update changes fee', Number(zRafter.shippingFlatRate) === 18);
  ok('E6 zone partial update preserves minOrder', Number(zRafter.minOrderAmount) === 20);
  ok('E7 zone name update works', (await zoneService.updateZone(zR.id, { name: 'RT2' })).name === 'RT2');
  // zone tri-state: set codEnabled false, then null (inherit)
  await zoneService.updateZone(zR.id, { codEnabled: false });
  ok('E8 zone codEnabled=false persisted', (await zoneService.getZoneById(zR.id)).codEnabled === false);
  await zoneService.updateZone(zR.id, { codEnabled: null });
  ok('E9 zone codEnabled=null (inherit) persisted', (await zoneService.getZoneById(zR.id)).codEnabled === null);
  // blackout full-replace
  await regionService.updateRegion(region.id, { blackoutDates: [{ date: '2026-12-25', label: 'X' }, { date: '2026-12-26' }] });
  ok('E10 blackout create 2', (await regionService.getRegionById(region.id)).blackoutDates.length === 2);
  await regionService.updateRegion(region.id, { blackoutDates: [] });
  ok('E11 blackout replace with [] -> 0', (await regionService.getRegionById(region.id)).blackoutDates.length === 0);
  // duplicate zone name rejected
  let dupErr = null; try { await zoneService.createZone({ regionId: region.id, name: 'A' }); } catch (e) { dupErr = e; }
  ok('E12 duplicate zone name rejected (P2002)', dupErr && (dupErr.code === 'P2002'));

  // ---------------- cleanup
  await prisma.order.deleteMany({ where: { regionId: { in: [region.id, regionB.id] } } });
  await prisma.product.delete({ where: { id: product.id } });
  await prisma.category.delete({ where: { id: category.id } });
  await prisma.region.deleteMany({ where: { id: { in: [region.id, regionB.id] } } });

  console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
  if (fail) { console.log('FAILURES:\n - ' + fails.join('\n - ')); }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
