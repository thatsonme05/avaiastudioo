# Root cause of the recurring "price becomes Rp85,000" bug + Member/Membership editing

## Part 1 — Why the Rp85,000 charge kept coming back

The earlier fix (`README_PRICE_FIX.md`) made the server always charge exactly
whatever is stored in `classes.price` for the booked class — that part was
already airtight and unchanged here. But that same fix meant: **whatever
number sits in `classes.price` in the database is now, permanently, the
exact amount that gets charged.** The remaining bug was in how that number
gets *written* from the admin panel.

In `public/js/admin.js`, the Class edit form had two silent `85000` fallbacks:

```js
// Pre-filling the Edit form:
sv('cls-price', c.price || 85000);
// Saving the form:
price: parseInt(gv('cls-price')) || 85000
```

If a class ever had no price set (e.g. created before pricing was decided,
or via an import that didn't include a price), opening **Edit Class** would
show "85000" in the price box — not because that was the real saved value,
but as a silent placeholder. If an admin didn't specifically notice and
retype it, clicking **Save** would write `85000` into that class's price
for real, permanently — and every future booking would then correctly (per
the earlier fix) charge exactly that Rp85,000, no matter what price was
advertised elsewhere (e.g. on the Pricing page, which is a separate,
unrelated set of numbers).

This explains the pattern precisely: the studio believed the price was
Rp100,000 (from Pricing page copy), but the actual `classes.price` column
had silently been set to Rp85,000 the last time someone opened and saved
that class in the admin panel.

### Fix
- `openEditCls()` now leaves the price field **blank** when no price is set,
  instead of pre-filling 85000 — so a genuinely unset price is visibly empty,
  not indistinguishable from a real saved value.
- `saveCls()` now **requires** a valid price greater than 0 and rejects the
  save with a clear message otherwise — it will never silently substitute
  85000 (or any other number) again.
- The Classes list in admin now shows **"⚠ Not set"** in red for any class
  still missing a price, so existing bad data is easy to spot and fix.
- Removed the matching `||85000` fallbacks on the customer-facing side
  (`core.js`, `home.html`, `schedule.html`): a class with no price now shows
  an **"Unavailable"**, disabled Book button instead of quietly using 85000
  for display. (The server already refuses to create a Midtrans payment for
  a class with no valid price — this just makes that visible up front
  instead of the customer only discovering it after trying to book.)

### What to do after deploying this
Open **Admin → Classes** and check every class for the red "⚠ Not set"
label. For any class that currently shows a price you didn't intend
(including one that shows exactly Rp85,000), open **Edit**, retype the
correct price, and save — this is a one-time data cleanup; the code can no
longer re-introduce this specific bug.

---

## Part 2 — Member & Membership editing

Previously:
- A member's own info (name/email/phone/membership type) had **no edit
  option at all** — only Delete.
- An already-assigned membership (`member_packages`) could only be adjusted
  ±1 credit at a time — there was no way to fix a wrong expiry date, price,
  package name, or payment method, and manually granting one was
  create-only (no way to correct a mistake afterward except deleting the
  member entirely).

### Fix
**Backend (`server.js`):**
- `PUT /api/members/:id` — edits name, email, phone, membership type
  (checks the new email isn't already used by another member).
- `PUT /api/member-packages/:id` — edits package name, price paid, credits
  total/used, expiry date, and payment method on an existing membership,
  whether it came from a real Midtrans purchase or a manual grant.
- `DELETE /api/member-packages/:id` — removes a membership assignment
  entirely (for a mistaken manual grant), separate from deleting the member.

**Frontend (`public/pages/admin.html`, `public/js/admin.js`):**
- Members table: added an **Edit** button next to Delete, opening a modal
  for name/email/phone/membership type.
- Active Package cell: added a **✎** button next to the existing －/＋
  credit buttons, opening a full **Edit Membership** modal (package name,
  price, payment method, credits total/used, expiry date) with a
  **Remove** option.

## Deployment
No database migration needed — both new endpoints use existing
`member_packages` / `members` columns.

1. Replace `server.js`, `public/pages/admin.html`, `public/js/admin.js`,
   `public/js/core.js`, `public/pages/home.html`, `public/pages/schedule.html`.
2. Restart/redeploy.
3. Check Admin → Classes for any "⚠ Not set" prices and fix them.
4. Test: edit a member's phone number, and edit an existing membership's
   expiry date — both should save and reflect immediately.
