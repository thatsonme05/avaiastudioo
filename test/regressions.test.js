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
