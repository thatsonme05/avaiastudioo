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
├── db.json                    ← Local database (auto-created)
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
server restart**, whether you're using local `db.json` or Supabase cloud.

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

4. **Never commit `.env` or `db.json` to Git**
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


## Production login / deployment checklist

The server-side Supabase connection must use a **secret/service-role key**, not the publishable/anon key.

Required environment variables:
- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (recommended) or `SUPABASE_SERVICE_ROLE_KEY`
- `JWT_SECRET`
- `ALLOWED_ORIGIN`

After deployment, open:
- `/api/health` — should return `"database":"supabase"`
- `/admin` — staff login

Default staff account created by migration:
- Email/username: `admin@gmail.com`
- Password: `admin123`

Change the password immediately after the first successful login.

### If login still fails

1. Run `migrations/001_create_staff_table.sql` in Supabase SQL Editor.
2. Confirm the `staff` table contains an active row for `admin@gmail.com`.
3. Confirm the server has `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`.
4. Open `/api/health`. If it says `"database":"local"`, the server is **not connected to Supabase**.
5. Restart the Node application after changing environment variables.

### Important

The improved version now:
- validates the admin session before rendering the dashboard;
- accepts email/username case-insensitively;
- prevents one shared Wi-Fi IP from consuming another account's login limit;
- reports database login failures clearly;
- provides `/api/health` for deployment diagnostics;
- does not silently fall back to local authentication when Supabase is configured.
