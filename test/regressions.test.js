const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('all server and browser JavaScript assets parse', () => {
  for (const file of ['server.js', 'public/js/core.js', 'public/js/admin.js']) {
    assert.doesNotThrow(() => new vm.Script(read(file), { filename: file }));
  }
  for (const file of [
    'public/pages/home.html',
    'public/pages/schedule.html',
    'public/pages/admin.html',
    'public/pages/payment-finish.html',
    'public/pages/payment-pending.html',
  ]) {
    const scripts = [...read(file).matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
    for (const [index, match] of scripts.entries()) {
      assert.doesNotThrow(
        () => new vm.Script(match[1], { filename: `${file}#script${index + 1}` }),
      );
    }
  }
});

test('guest booking price is verified from the database, not the browser amount', () => {
  const server = read('server.js');
  assert.equal(server.includes("if(!bookingData||!amount)"), false);
  assert.match(server, /const bookingData=\{\s*name:String\(rawBookingData\.name/);
  assert.doesNotMatch(server, /const bookingData=\{\.\.\.rawBookingData\}/);
  assert.match(server, /select\('id,session_date,time,slots,classes\(name,price\)'\)/);
  assert.match(server, /bookingData\.class=verifiedClassName/);
  assert.match(server, /const verifiedPrice = parsePositiveInteger\(scheduleRow\.classes\?\.price\);/);
  assert.match(server, /amount = verifiedPrice;/);
  assert.ok(server.indexOf('amount = verifiedPrice;') < server.indexOf('transaction_details:{order_id:orderId,gross_amount:amount}'));
});

test('invalid booking prices never render as IDR 0 or submit', () => {
  const core = read('public/js/core.js');
  assert.equal(core.includes('price:price||0'), false);
  assert.match(core, /hasValidPrice\?'IDR '\+numericPrice\.toLocaleString\('en-US'\):'Unavailable'/);
  assert.match(core, /!_BK \|\| !Number\.isFinite\(_BK\.price\)/);
});

test('payment flows have finite failure paths', () => {
  const core = read('public/js/core.js');
  assert.match(core, /s\.onerror=/);
  assert.match(core, /Payment gateway timed out/);
  for (const file of ['public/pages/payment-finish.html', 'public/pages/payment-pending.html']) {
    assert.match(read(file), /controller\.abort\(\)/);
  }
});

test('credit edits are behind the member Edit action', () => {
  const admin = read('public/js/admin.js');
  const html = read('public/pages/admin.html');
  assert.equal(admin.includes('openEditMbPkg('), false);
  assert.equal(html.includes('id="empk-mo"'), false);
  assert.match(html, /id="emb-pkg-used"/);
  assert.match(admin, /fetch\('\/api\/member-packages\/'\+packageId/);
});

test('membership edits preserve lifecycle status unless explicitly changed', () => {
  const server = read('server.js');
  assert.match(server, /keep the current lifecycle state/);
  assert.match(server, /before\.status\)\?before\.status:'active'/);
  assert.match(server, /if\(String\(pkg\.status\|\|'active'\)!=='active'\)/);
});

test('manual membership retries have a database idempotency key', () => {
  const server = read('server.js');
  const migration = read('migrations/016_manual_membership_idempotency.sql');
  assert.match(server, /record\.manual_fingerprint=crypto\.createHash\('sha256'\)/);
  assert.match(server, /eq\('manual_fingerprint',record\.manual_fingerprint\)/);
  assert.match(migration, /create unique index if not exists member_packages_manual_fingerprint_uidx/);
});

test('membership packages cannot reintroduce zero-price purchases', () => {
  const server = read('server.js');
  const admin = read('public/js/admin.js');
  const pricing = read('public/pages/pricing.html');
  assert.match(server, /Package name, price, credits and validity must all be valid positive values/);
  assert.match(server, /const packagePrice=parsePositiveInteger\(pkg\.price\)/);
  assert.match(admin, /Package name, price, credits and validity must all be valid positive values/);
  assert.match(pricing, /const validPrice = Number\.isFinite\(Number\(p\.price\)\)/);
});

test('payment simulation and fake webhooks are disabled unless explicitly enabled for local demos', () => {
  const server = read('server.js');
  assert.match(server, /ALLOW_PAYMENT_SIMULATION/);
  assert.match(server, /Payment simulation is disabled/);
  assert.match(server, /Payment notifications are disabled/);
  assert.match(server, /JWT_SECRET must be set in production/);
  assert.match(server, /ALLOWED_ORIGIN must be restricted in production/);
});

test('public guest payment endpoints are rate-limited and do not expose server identity or PII', () => {
  const server = read('server.js');
  const statusRoute = server.slice(
    server.indexOf("app.get('/api/payment/status/:orderId'"),
    server.indexOf('// Sweeps every still-pending payment'),
  );
  assert.match(server, /const paymentCreateLimiter = rateLimit\(/);
  assert.match(server, /app\.post\('\/api\/payment\/create',paymentCreateLimiter/);
  assert.match(server, /const paymentStatusLimiter = rateLimit\(/);
  assert.match(server, /app\.get\('\/api\/payment\/status\/:orderId',paymentStatusLimiter/);
  assert.match(server, /publicBookingPayment\(row\)/);
  assert.match(server, /publicPackagePayment\(row\)/);
  assert.match(server, /function escapeHtml\(value\)/);
  assert.doesNotMatch(server, /emailUser:USE_EMAIL\?EMAIL_USER/);
  assert.doesNotMatch(statusRoute, /select\('\*'\)/);
});

test('booking imports cannot create zero or null price non-package rows', () => {
  const server = read('server.js');
  assert.match(server, /parseMoneyInteger/);
  assert.match(server, /A positive Amount\/Price is required for non-package bookings/);
  assert.match(server, /skipped\.push/);
});

test('database integrity migration blocks duplicate checkouts and invalid money', () => {
  const migration = read('migrations/017_integrity_hardening.sql');
  assert.match(migration, /pending_bookings_identity_schedule_uidx/);
  assert.match(migration, /pending_package_request_fingerprint_uidx/);
  assert.match(migration, /bookings_identity_schedule_uidx/);
  assert.match(migration, /bookings_amount_integrity_chk/);
  assert.match(migration, /classes_name_normalized_uidx/);
  assert.match(migration, /not like 'cancelled%'/i);
  assert.doesNotMatch(migration, /not like 'cancelled_%'/i);
  assert.match(migration, /revoke execute on function public\.rls_auto_enable/i);
  assert.match(migration, /drop policy if exists "Bookings insert"/i);
});

test('password reset links last 60 minutes and expired vs invalid are distinct errors', () => {
  const server = read('server.js');
  const i18nEn = read('public/js/i18n.js');
  // The window itself, and every place that tells a human how long it is,
  // must agree — a mismatch here is exactly what made a real member's link
  // feel like it expired "too fast" even though the code and the stored
  // expires_at were internally consistent.
  assert.match(server, /Date\.now\(\) \+ 60\*60\*1000/);
  assert.doesNotMatch(server, /Date\.now\(\) \+ 30\*60\*1000/);
  assert.match(server, /expires in 60 minutes/);
  assert.doesNotMatch(server, /expires in 30 minutes/);
  assert.match(i18nEn, /expires in 60 minutes/);
  assert.doesNotMatch(i18nEn, /expires in 30 minutes/);
  // A token that plain doesn't exist (already used, or superseded by a
  // newer request) and a token that exists but is past its expires_at are
  // different situations with different fixes for the member to try next —
  // collapsing them into one "invalid or has expired" string hid which one
  // actually happened.
  assert.doesNotMatch(server, /This password reset link is invalid or has expired\./);
  assert.match(server, /This password reset link is invalid\. It may have already been used/);
  assert.match(server, /This password reset link has expired \(links are valid for 60 minutes\)\./);
});

test('admin Bookings and Members panels both have a working name search', () => {
  const html = read('public/pages/admin.html');
  const js = read('public/js/admin.js');
  assert.match(html, /id="bk-f-name"/);
  assert.match(html, /id="mb-f-name"/);
  // Both must actually re-render on every keystroke (oninput), not just on
  // blur/change — a search box that only filters after you click away from
  // it reads as broken.
  assert.match(html, /id="bk-f-name"[^>]*oninput="renderABkTable\(\)"/);
  assert.match(html, /id="mb-f-name"[^>]*oninput="renderAMbTable\(\)"/);
  // The match itself must be case-insensitive and substring, not exact —
  // an admin typing a first name should find "Ani Wijaya" and "Citra Ani"
  // alike, not need the full, exactly-cased name.
  assert.match(js, /fName=gv\('bk-f-name'\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(js, /String\(b\.name\|\|''\)\.toLowerCase\(\)\.includes\(fName\)/);
  assert.match(js, /fName=gv\('mb-f-name'\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(js, /String\(m\.name\|\|''\)\.toLowerCase\(\)\.includes\(fName\)/);
  // Clearing the booking filters must reset the name field too, or a
  // forgotten search term silently keeps hiding rows after "Clear" is
  // clicked.
  assert.match(js, /function clearBkFilters\(\)\{\s*sv\('bk-f-name',''\);/);
  // loadAMb must delegate to a separately-callable render function, or a
  // keystroke in the search box would have to needlessly re-fetch from the
  // server just to re-filter data already in memory.
  assert.match(js, /async function loadAMb\(\)\{[\s\S]*?renderAMbTable\(\);\s*\}/);
  assert.match(js, /function renderAMbTable\(\)\{/);
});

test('booking and membership purchase reject malformed email/phone before touching Midtrans', () => {
  const server = read('server.js');
  assert.match(server, /function isValidEmailFormat\(email\)\{/);
  assert.match(server, /function isValidPhoneFormat\(phone\)\{/);
  // Real production data this was found from: "name@gmail." (no TLD after
  // the final dot) and "name91yahoo.com" (missing "@" entirely) both slipped
  // through to Midtrans, which rejected the transaction with no clear reason
  // shown to the guest — who then just kept retrying the same typo.
  assert.doesNotMatch(isValidEmailFormatSrc(server), /^$/); // sanity: extraction below actually found something
  assert.match(server, /isValidEmailFormat\(bookingData\.email\)/);
  assert.match(server, /isValidPhoneFormat\(bookingData\.phone\)/);
  assert.match(server, /isValidPhoneFormat\(memberPhone\)/);
  // The two checks must run before reserveScheduleSlot / any pending row
  // insert — otherwise a rejected attempt still burns a slot reservation.
  const createHandlerStart = server.indexOf("app.post('/api/payment/create'");
  const emailCheckPos = server.indexOf('isValidEmailFormat(bookingData.email)', createHandlerStart);
  const reservePos = server.indexOf('reserveScheduleSlot(', createHandlerStart);
  assert.ok(createHandlerStart > -1 && emailCheckPos > -1 && reservePos > -1 && emailCheckPos < reservePos);
});

test('a pending payment Midtrans has no record of expires much sooner than one Midtrans confirms as pending', () => {
  const server = read('server.js');
  assert.match(server, /PENDING_PAYMENT_UNKNOWN_MAX_AGE_MS = 30\*60\*1000/);
  assert.match(server, /PENDING_PAYMENT_MAX_AGE_MS = 24\*60\*60\*1000/);
  // The old version bailed out on a null result (Midtrans status check
  // failed / order unknown to Midtrans) before the age check ever ran, so a
  // booking whose Midtrans transaction was never created — because the
  // guest closed the tab before the payment widget loaded — could never be
  // auto-expired at all, not even after weeks. It sat there forever,
  // permanently blocking that same person from re-booking the same class
  // session (the unique index on identity+schedule+not-cancelled).
  assert.doesNotMatch(server, /if\(!result \|\| result\.confirmed \|\| result\.cancelled \|\| !createdAt\) return result;/);
  assert.match(server, /if\(result\?\.confirmed \|\| result\?\.cancelled \|\| !createdAt\) return result;/);
  assert.match(server, /const threshold = result \? PENDING_PAYMENT_MAX_AGE_MS : PENDING_PAYMENT_UNKNOWN_MAX_AGE_MS;/);
});

function isValidEmailFormatSrc(server){
  const start = server.indexOf('function isValidEmailFormat(email){');
  return server.slice(start, start+120);
}
