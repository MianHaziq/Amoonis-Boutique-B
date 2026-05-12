/* eslint-disable */
/**
 * End-to-end verification of the security hardening changes (C3, C5, H7, M7, L8).
 * Hits a running server on PORT. Does NOT modify the source under test.
 *
 * Run:
 *   DATABASE_URL=... PORT=5099 JWT_SECRET=... node server.js   # in another terminal
 *   PORT=5099 node scripts/audit-verify.js
 */

const BASE_PORT = process.env.PORT || 5099;
const BASE = `http://localhost:${BASE_PORT}/api/v1`;
const ROOT = `http://localhost:${BASE_PORT}`;

let passed = 0;
let failed = 0;
const fails = [];

function ok(name, detail = '') {
  passed++;
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
}
function bad(name, detail) {
  failed++;
  fails.push(`${name}: ${detail}`);
  console.log(`  FAIL  ${name} — ${detail}`);
}
function group(label) {
  console.log(`\n=== ${label} ===`);
}

async function req(method, path, { body, token } = {}) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { status: res.status, json, raw: text };
}

function rand(prefix = 'audit') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  console.log(`Pointing at ${BASE}\n`);

  // ============================================================
  // L8 — Health endpoints
  // ============================================================
  group('L8: health endpoints');
  {
    const live = await fetch(`${ROOT}/health/live`);
    live.status === 200 ? ok('GET /health/live returns 200') : bad('GET /health/live', `status=${live.status}`);
    const liveJson = await live.json();
    typeof liveJson.uptime === 'number' ? ok('live payload has uptime') : bad('live payload', JSON.stringify(liveJson));

    const ready = await fetch(`${ROOT}/health/ready`);
    ready.status === 200 ? ok('GET /health/ready returns 200') : bad('GET /health/ready', `status=${ready.status}`);
    const readyJson = await ready.json();
    readyJson.db === 'up' ? ok('ready payload reports db up') : bad('ready payload', JSON.stringify(readyJson));
  }

  // ============================================================
  // BASELINE — existing API contracts still intact
  // ============================================================
  group('Baseline: pre-existing public endpoints unchanged');
  {
    const root = await fetch(`${ROOT}/`);
    root.status === 200 ? ok('GET / returns 200') : bad('GET /', `status=${root.status}`);
    const cats = await req('GET', '/categories');
    cats.status === 200 && cats.json?.success === true ? ok('GET /categories — same shape', `keys=${Object.keys(cats.json).join(',')}`) : bad('GET /categories', cats.status);
    const products = await req('GET', '/products');
    products.status === 200 && products.json?.success === true ? ok('GET /products — same shape') : bad('GET /products', products.status);
    const settings = await req('GET', '/settings/public');
    settings.status === 200 && settings.json?.success === true ? ok('GET /settings/public — same shape') : bad('GET /settings/public', settings.status);
    const banners = await req('GET', '/banners');
    banners.status === 200 && banners.json?.success === true ? ok('GET /banners — same shape') : bad('GET /banners', banners.status);
    const sections = await req('GET', '/sections');
    sections.status === 200 && sections.json?.success === true ? ok('GET /sections — same shape') : bad('GET /sections', sections.status);
  }

  // ============================================================
  // M7 — Signup returns refreshToken (additive) and existing fields intact
  // ============================================================
  group('M7 + Baseline: signup returns access + refresh tokens; existing fields intact');
  const email1 = `${rand('u1')}@example.com`;
  const user1Password = 'AuditPass123!';
  let user1AccessToken;
  let user1RefreshToken;
  let user1Id;
  {
    const r = await req('POST', '/auth/signup', {
      body: { fullName: 'Audit User One', email: email1, password: user1Password },
    });
    r.status === 201 ? ok('POST /auth/signup returns 201') : bad('signup status', `status=${r.status} body=${r.raw.slice(0,200)}`);
    const d = r.json?.data || {};
    d.user && d.user.id && d.user.email === email1 ? ok('signup data.user.* unchanged', `id=${d.user.id}`) : bad('signup data.user', JSON.stringify(d));
    typeof d.token === 'string' && d.token.split('.').length === 3 ? ok('signup data.token unchanged (JWT)') : bad('signup data.token', String(d.token).slice(0,40));
    typeof d.refreshToken === 'string' && d.refreshToken.length >= 64 ? ok('signup data.refreshToken added (additive)') : bad('signup data.refreshToken', String(d.refreshToken).slice(0,40));
    typeof d.refreshTokenExpiresAt === 'string' ? ok('signup data.refreshTokenExpiresAt added') : bad('signup data.refreshTokenExpiresAt', String(d.refreshTokenExpiresAt));
    user1AccessToken = d.token;
    user1RefreshToken = d.refreshToken;
    user1Id = d.user?.id;
  }

  // ============================================================
  // M7 — Signin returns refreshToken too
  // ============================================================
  group('M7: signin returns refresh token; existing keys intact');
  let user1SigninAccess;
  let user1SigninRefresh;
  {
    const r = await req('POST', '/auth/signin', { body: { email: email1, password: user1Password } });
    r.status === 200 ? ok('POST /auth/signin returns 200') : bad('signin status', r.status);
    const d = r.json?.data || {};
    d.user?.email === email1 ? ok('signin data.user.email unchanged') : bad('signin data.user.email', JSON.stringify(d.user));
    typeof d.token === 'string' ? ok('signin data.token unchanged') : bad('signin data.token', String(d.token));
    typeof d.refreshToken === 'string' && d.refreshToken !== user1RefreshToken ? ok('signin issues distinct refresh token') : bad('signin refresh token', `same as signup? ${d.refreshToken === user1RefreshToken}`);
    user1SigninAccess = d.token;
    user1SigninRefresh = d.refreshToken;
  }

  // Confirm signin's access token actually authenticates against an existing protected endpoint.
  group('Baseline: signin access token works on protected endpoint (cart)');
  {
    const r = await req('GET', '/cart', { token: user1SigninAccess });
    r.status === 200 && r.json?.success === true ? ok('GET /cart with signin token — 200') : bad('GET /cart', `status=${r.status} body=${r.raw.slice(0,200)}`);
  }

  // ============================================================
  // M7 — /auth/refresh rotates tokens, new access token works, old refresh rejected
  // ============================================================
  group('M7: /auth/refresh — rotation works, single-use enforced');
  let user1RotatedRefresh;
  let user1RotatedAccess;
  {
    const r = await req('POST', '/auth/refresh', { body: { refreshToken: user1SigninRefresh } });
    r.status === 200 ? ok('POST /auth/refresh returns 200') : bad('refresh status', `status=${r.status} body=${r.raw.slice(0,200)}`);
    const d = r.json?.data || {};
    typeof d.token === 'string' && typeof d.refreshToken === 'string' ? ok('refresh returns new {token, refreshToken}') : bad('refresh payload', JSON.stringify(d));
    d.refreshToken !== user1SigninRefresh ? ok('refresh token rotated (different value)') : bad('refresh token rotation', 'same value returned');
    user1RotatedAccess = d.token;
    user1RotatedRefresh = d.refreshToken;
  }
  {
    const r = await req('POST', '/auth/refresh', { body: { refreshToken: user1SigninRefresh } });
    r.status === 401 ? ok('replaying revoked refresh returns 401') : bad('revoked refresh', `status=${r.status} body=${r.raw.slice(0,200)}`);
  }
  {
    const r = await req('POST', '/auth/refresh', { body: { refreshToken: 'this-is-not-a-real-token' } });
    r.status === 401 ? ok('unknown refresh returns 401') : bad('unknown refresh', `status=${r.status}`);
  }
  {
    const r = await req('POST', '/auth/refresh', { body: {} });
    r.status === 400 ? ok('missing refresh body returns 400') : bad('missing refresh', `status=${r.status}`);
  }
  {
    const r = await req('GET', '/cart', { token: user1RotatedAccess });
    r.status === 200 ? ok('rotated access token works on /cart') : bad('rotated access token /cart', `status=${r.status}`);
  }

  // ============================================================
  // M7 — /auth/logout revokes refresh; subsequent refresh fails
  // ============================================================
  group('M7: /auth/logout revokes refresh token');
  {
    const r = await req('POST', '/auth/logout', { body: { refreshToken: user1RotatedRefresh } });
    r.status === 200 && r.json?.success === true ? ok('POST /auth/logout returns 200') : bad('logout', `status=${r.status}`);
  }
  {
    const r = await req('POST', '/auth/refresh', { body: { refreshToken: user1RotatedRefresh } });
    r.status === 401 ? ok('logged-out refresh token rejected (401)') : bad('logged-out refresh', `status=${r.status}`);
  }

  // ============================================================
  // C3 — verifyToken rejects deactivated user (set status via direct DB)
  // ============================================================
  group('C3: deactivated user gets 403 on protected endpoints');
  // Sign in fresh so we have an unrevoked access token, then deactivate via direct prisma.
  const email2 = `${rand('u2')}@example.com`;
  const u2Password = 'AnotherPass456!';
  let u2Access;
  let u2Id;
  {
    const signup = await req('POST', '/auth/signup', { body: { fullName: 'Audit Two', email: email2, password: u2Password } });
    u2Access = signup.json?.data?.token;
    u2Id = signup.json?.data?.user?.id;
  }
  // Pre-check: works before deactivation
  {
    const r = await req('GET', '/cart', { token: u2Access });
    r.status === 200 ? ok('pre-deactivation /cart works') : bad('pre-deactivation /cart', `status=${r.status}`);
  }
  // Deactivate directly via Prisma
  {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }), log: ['error'] });
    try {
      await prisma.user.update({ where: { id: u2Id }, data: { status: 'INACTIVE' } });
      ok('direct DB: status set to INACTIVE');
    } finally {
      await prisma.$disconnect();
    }
  }
  // The user cache has a 30s TTL; sleep ~32s to ensure invalidation, OR we can wait until cache expires.
  // To keep test runtime short, we'll restart the cache by hitting an unrelated public route, then wait the cache TTL.
  console.log('  ... waiting 31s for verifyToken cache to expire ...');
  await new Promise((res) => setTimeout(res, 31000));
  {
    const r = await req('GET', '/cart', { token: u2Access });
    r.status === 403 && /deactivated/i.test(r.json?.message || '') ? ok('post-deactivation /cart returns 403 with deactivated msg', `msg="${r.json?.message}"`) : bad('post-deactivation /cart', `status=${r.status} msg=${r.json?.message}`);
    r.json?.success === false ? ok('error envelope shape unchanged ({success:false,message})') : bad('error envelope', JSON.stringify(r.json));
  }

  // ============================================================
  // H7 — Address default uniqueness via DB-level partial unique index
  // ============================================================
  group('H7: only one default address per user (enforced at DB level)');
  // Use user1 (still active — we did not deactivate u1). Sign in again to get fresh tokens.
  let u1Access2;
  {
    const r = await req('POST', '/auth/signin', { body: { email: email1, password: user1Password } });
    u1Access2 = r.json?.data?.token;
  }
  let addr1Id;
  let addr2Id;
  {
    const r1 = await req('POST', '/user/addresses', {
      token: u1Access2,
      body: { label: 'Home', streetAddress: '123 First St', city: 'Cairo', country: 'Egypt' },
    });
    r1.status === 201 ? ok('create first address — 201') : bad('create addr1', `status=${r1.status}`);
    addr1Id = r1.json?.data?.id;
    r1.json?.data?.isDefault === true ? ok('first address is auto-default') : bad('addr1 isDefault', JSON.stringify(r1.json?.data));

    const r2 = await req('POST', '/user/addresses', {
      token: u1Access2,
      body: { label: 'Work', streetAddress: '456 Second St', city: 'Cairo', country: 'Egypt', isDefault: true },
    });
    r2.status === 201 ? ok('create second address as default — 201') : bad('create addr2', `status=${r2.status}`);
    addr2Id = r2.json?.data?.id;
    r2.json?.data?.isDefault === true ? ok('addr2 isDefault=true returned') : bad('addr2 isDefault', JSON.stringify(r2.json?.data));

    const list = await req('GET', '/user/addresses', { token: u1Access2 });
    const defaults = (list.json?.data || []).filter((a) => a.isDefault);
    defaults.length === 1 && defaults[0].id === addr2Id ? ok('exactly one default after second create') : bad('default count after addr2', `defaults=${JSON.stringify(defaults.map((d) => d.id))}`);
  }
  // Concurrent setDefault attempts on different addresses — both should resolve, only one default after dust settles.
  {
    const calls = [
      req('PATCH', `/user/addresses/${addr1Id}/default`, { token: u1Access2 }),
      req('PATCH', `/user/addresses/${addr2Id}/default`, { token: u1Access2 }),
      req('PATCH', `/user/addresses/${addr1Id}/default`, { token: u1Access2 }),
      req('PATCH', `/user/addresses/${addr2Id}/default`, { token: u1Access2 }),
    ];
    const results = await Promise.all(calls);
    const codes = results.map((r) => r.status);
    const allOk = codes.every((c) => c === 200);
    allOk ? ok('concurrent setDefault: all 4 returned 200', `codes=${codes.join(',')}`) : bad('concurrent setDefault', `codes=${codes.join(',')}`);

    const list = await req('GET', '/user/addresses', { token: u1Access2 });
    const defaults = (list.json?.data || []).filter((a) => a.isDefault);
    defaults.length === 1 ? ok('post-concurrent: exactly one default remains') : bad('post-concurrent default count', `count=${defaults.length}`);
  }
  // Verify DB-level guarantee directly
  {
    const { PrismaClient } = require('@prisma/client');
    const { PrismaPg } = require('@prisma/adapter-pg');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }), log: ['error'] });
    try {
      const dupes = await prisma.$queryRaw`SELECT "userId", COUNT(*) AS c FROM "Address" WHERE "isDefault" = true GROUP BY "userId" HAVING COUNT(*) > 1`;
      dupes.length === 0 ? ok('DB-level: no user has multiple defaults') : bad('DB-level duplicates', JSON.stringify(dupes));

      const stat = await prisma.$queryRaw`SELECT 1 FROM pg_indexes WHERE indexname = 'Address_userId_default_unique'`;
      stat.length === 1 ? ok('partial unique index Address_userId_default_unique exists') : bad('partial unique index', JSON.stringify(stat));
    } finally {
      await prisma.$disconnect();
    }
  }

  // ============================================================
  // M7 — Password change bumps tokenVersion + revokes refresh tokens
  // ============================================================
  group('M7: password change invalidates current access + refresh tokens');
  let preChangeAccess;
  let preChangeRefresh;
  {
    const r = await req('POST', '/auth/signin', { body: { email: email1, password: user1Password } });
    preChangeAccess = r.json?.data?.token;
    preChangeRefresh = r.json?.data?.refreshToken;
    r.status === 200 ? ok('fresh signin succeeded before password change') : bad('pre-change signin', r.status);
  }
  // Pre-check: works
  {
    const r = await req('GET', '/cart', { token: preChangeAccess });
    r.status === 200 ? ok('pre-change access token works') : bad('pre-change access', `status=${r.status}`);
  }
  // Change password
  const user1NewPassword = 'BrandNewPass789!';
  {
    const r = await req('PUT', `/auth/change-password/${user1Id}`, {
      token: preChangeAccess,
      body: { currentPassword: user1Password, newPassword: user1NewPassword },
    });
    r.status === 200 ? ok('PUT /auth/change-password/:userId returns 200') : bad('change-password', `status=${r.status} body=${r.raw.slice(0,200)}`);
  }
  // Old access token MUST now be rejected (tokenVersion mismatch)
  {
    const r = await req('GET', '/cart', { token: preChangeAccess });
    r.status === 401 ? ok('old access token rejected with 401 (tokenVersion bumped)', `msg="${r.json?.message}"`) : bad('old access not rejected', `status=${r.status}`);
  }
  // Old refresh token MUST be revoked
  {
    const r = await req('POST', '/auth/refresh', { body: { refreshToken: preChangeRefresh } });
    r.status === 401 ? ok('old refresh token rejected after password change') : bad('old refresh not rejected', `status=${r.status}`);
  }
  // Signin with NEW password works and yields fresh tokens
  {
    const r = await req('POST', '/auth/signin', { body: { email: email1, password: user1NewPassword } });
    r.status === 200 ? ok('signin with new password succeeds') : bad('signin new password', `status=${r.status}`);
  }

  // ============================================================
  // C5 — Apple email anti-impersonation
  // Without a real Apple identity token we cannot fully exercise this. We instead
  // check that the route still parses request payloads as before for the failure paths.
  // ============================================================
  group('C5: /auth/apple still rejects bad input with same error shapes');
  {
    const r = await req('POST', '/auth/apple', { body: {} });
    r.status === 400 ? ok('missing identityToken returns 400 (unchanged)') : bad('apple no token', `status=${r.status}`);
  }
  {
    const r = await req('POST', '/auth/apple', { body: { identityToken: 'not.a.real.jwt' } });
    // With APPLE_CLIENT_ID unset this returns 503 (unchanged behavior).
    // With it set but token invalid it returns 401.
    [401, 503].includes(r.status) ? ok('invalid identityToken returns 401/503 (unchanged)', `status=${r.status}`) : bad('apple invalid token', `status=${r.status} body=${r.raw.slice(0,200)}`);
  }

  // ============================================================
  // BASELINE — Existing flows that we did NOT touch
  // ============================================================
  group('Baseline: untouched flows still respond with same shape');
  {
    const r = await req('GET', '/promo-codes/available', { token: u1Access2 });
    r.status === 200 || r.status === 401 ? ok(`GET /promo-codes/available — ${r.status}`) : bad('promo available', `status=${r.status}`);
    // u1Access2 was issued before password change so it should now be 401, which is correct.
  }

  // Forgot password (just smoke check it accepts and returns the generic message)
  {
    const r = await req('POST', '/auth/forgot-password', { body: { email: email1 } });
    r.status === 200 && r.json?.success === true ? ok('POST /auth/forgot-password returns 200 with generic message') : bad('forgot-password', `status=${r.status} body=${r.raw.slice(0,200)}`);
  }

  // ============================================================
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of fails) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(2);
});
