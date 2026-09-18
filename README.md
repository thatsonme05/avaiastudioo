# Avaia Studio — Yoga Booking Platform

A professional yoga studio website with a booking system, online payments (Midtrans),
memberships, role-based access (Admin & Instructor), Excel import/export, and feedback.

---

## Getting Started

```bash
cd avaia-studio
npm install
node server.js
```

Open your browser: **http://localhost:3000**

Staff login (Admin/Instructor): go to `/admin` → username `admin` / password `admin123`

---

## Single-Door Login System

There's no separate "Member Login" vs "Admin Login" screen. Everyone —
members, instructors, and admins — logs in through **the same form** in the navbar
corner. The system automatically detects the account type:

- If it matches a **member** account → goes to `/dashboard`
- If it matches a **staff** account (admin/instructor) → redirected to `/admin`

### Roles & Permissions

| Role | Can Access |
|---|---|
| **Administrator** | All menus: Dashboard, Bookings, Members, Membership Packages, Feedback, Schedule, Classes, Manage Staff, Appearance, Content, Payment, Security |
| **Instructor** | Only **Schedule** and **Classes** (add/edit/delete), and changing their own password |

Instructor accounts are **created by an admin** via Admin → Manage Staff. There is no
public self-registration for instructors — this is intentional, to keep control over
who can manage the schedule and classes.

---

## Full Feature List

### Visitor-Facing Website
| Page | Features |
|---|---|
| `/` | Hero slideshow (3 photos), class preview |
| `/schedule` | Real-time daily schedule, per-class pricing, book + pay |
| `/classes` | All classes with level filter |
| `/pricing` | Membership packages (managed dynamically by admin) + FAQ |
| `/about` | Studio story + editable photo |
| `/locate` | Map + contact info + transportation info |
| `/feedback` | Feedback form (rating + feedback type) |
| `/dashboard` | Member area: booking history, profile, membership type |

### Booking & Payment System
- User picks a class → fills in the form → **pays via Midtrans** (QRIS, GoPay, OVO, bank transfer, credit card, Indomaret)
- Booking is **automatically confirmed** after successful payment (via webhook)
- If Midtrans isn't configured → **simulation mode** is active (booking is confirmed instantly, for testing)
- Slots automatically decrease with every successful booking

### Admin Panel (`/admin`)
- **Dashboard** — booking, member, and class stats, total revenue
- **Bookings** — view all bookings, **Excel import**, **Excel/CSV export**
- **Members** — view all registered members, **Excel import**, Excel export
- **Membership Packages** — add/edit/delete packages (automatically shown on /pricing)
- **Feedback** — view all feedback with an unread-notification badge
- **Schedule** — manage sessions per day, price per class
- **Classes** — manage class types + pricing
- **Appearance & Colors** — change name, colors, 3 slideshow photos, About Us photo
- **Content & Info** — edit About Us text, contact info, Google Maps
- **Payment** — Midtrans connection status
- **Security** — change admin username/password

---

## Configuration (Optional)

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

### Supabase (Cloud Database)
1. Sign up at https://supabase.com, create a new project
2. SQL Editor → run the contents of `supabase-schema.sql`
3. Settings → API → copy the **Project URL** and your API key
4. Fill in `.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SECRET_KEY=sb_secret_xxxx
   ```
   (Older Supabase projects may instead show a single `service_role`/anon key —
   in that case set it as `SUPABASE_KEY` instead. The app accepts either naming.)

### Midtrans (Payment Gateway)
1. Sign up at https://dashboard.midtrans.com
2. Settings → Access Keys → copy the **Server Key** and **Client Key**
3. Fill in `.env`:
   ```
   MIDTRANS_SERVER_KEY=SB-Mid-server-xxxx
   MIDTRANS_CLIENT_KEY=SB-Mid-client-xxxx
   MIDTRANS_ENV=sandbox
   ```
4. Restart the server: `node server.js`

> Without Midtrans configured, booking still works in **simulation mode** — automatically confirmed without real payment. Good for testing.

---

## Excel Import — File Format

### Import Bookings
Columns read: `Name`, `Email`, `Phone`, `Class`, `Date`, `Time`, `Note`

### Import Members
Columns read: `Name`, `Email`, `Phone`, `Membership Type`, `Status`

Files can be `.xlsx`, `.xls`, or `.csv`. Upload via Admin → Bookings/Members → **Import Excel** button.

---

## Project Structure

```
avaia-studio/
├── server.js                  ← Express backend (booking, payment, Excel, feedback)
├── Supabase                   ← Required cloud database
├── .env.example                ← Configuration template
├── supabase-schema.sql         ← Cloud database schema
└── public/
    ├── css/
    │   ├── global.css          ← Navbar, footer, modal, shared styles
    │   ├── home.css / schedule.css / classes.css
    │   ├── pricing.css / about.css / locate.css
    │   ├── dashboard.css / feedback.css / admin.css
    ├── js/
    │   ├── core.js             ← Auth, booking, payment, nav (all public pages)
    │   └── admin.js             ← Logic specific to /admin
    ├── pages/
    │   ├── home.html / schedule.html / classes.html
    │   ├── pricing.html / about.html / locate.html
    │   ├── dashboard.html / feedback.html / admin.html
    │   └── payment-finish.html / payment-error.html / payment-pending.html
    └── uploads/                ← Photos uploaded by admin
```

---

## Data Persistence

All data (bookings, members, classes, schedule, membership packages, feedback,
settings, photos) is stored permanently — **it doesn't disappear on refresh or
server restart**, using the Supabase cloud database.

---

## Security — REQUIRED before going to production

Before deploying to a public server (Hostinger, VPS, etc.), make sure to:

1. **Change the default admin password**
   Log in to `/admin` with `admin` / `admin123`, then immediately change it under
   Admin → Security → Change My Password.

2. **Set `JWT_SECRET` in `.env` to a random string**
   Don't use the default value from `.env.example`. Generate one with:
   ```bash
   openssl rand -hex 32
   ```

3. **Set `ALLOWED_ORIGIN` to your real domain**
   In production, don't leave `ALLOWED_ORIGIN=*`. Change it to your domain:
   ```
   ALLOWED_ORIGIN=https://avaiastudioo.com
   ```

4. **Never commit `.env`  to Git**
   A `.gitignore` file is already provided and excludes both automatically.
   Since `.env` isn't pushed to Git, remember to set these same environment
   variables directly in your hosting provider's dashboard (e.g. Hostinger's
   Node.js app → Environment Variables) after every deploy.

5. **Use HTTPS in production**
   Hostinger Managed Node.js and VPS with Certbot both offer free SSL.
   Without HTTPS, passwords and payment data can be intercepted in transit.

### What's already protected by default
- Every admin endpoint (managing classes, schedule, members, bookings, settings)
  requires a JWT token obtained only through a valid admin login
- Member and admin passwords are hashed with bcrypt — never stored as plain text
- Rate limiting on the login endpoint (max 10 attempts / 15 minutes) prevents brute-forcing
- A member's own booking endpoint (`/api/my-bookings`) only returns that member's
  data, never exposing all bookings publicly


## 2026-08-18 Supabase / Schedule hardening
- Schedule sessions are date-specific and do not repeat automatically.
- Booking UI uses the exact selected schedule date; it no longer generates future weekly dates.
- Server validates that a booking's date matches its schedule session.
- Schedule create/update rejects duplicates for the same class/date/time.
- Today's home schedule uses `session_date` when available.
- Admin member list refreshes when a new-member notification arrives.
- Login rate limiting uses `ipKeyGenerator()` for IPv6-safe keys.
- Run `migrations/006_schedule_per_date.sql` once if not already applied, then `007_schedule_per_date_hardening.sql` once.

## Payment flow hardening (v0.8)
Run `migrations/008_payment_flow_hardening.sql` once in Supabase.
This migration adds idempotent payment finalization, atomic schedule-slot reservation/release, and atomic membership-credit redemption/refunds.
Membership members with an active package and available credits can book without creating a Midtrans transaction; the booking is confirmed immediately and one credit is consumed.

## Manual member membership assignment (v0.9)
Run `migrations/009_manual_membership_admin.sql` once in Supabase — **required** before using
Admin → Members → **+ Add Member Membership**.
This migration adds `package_id` and `source` columns to `member_packages`, which the manual
assignment endpoint (`POST /api/member-packages/manual`) writes on every save. Without this
migration, saving a manual membership fails with a database column error.
