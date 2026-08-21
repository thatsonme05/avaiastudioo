try { require('dotenv').config(); } catch(e) {}

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const bcrypt   = require('bcryptjs');
const XLSX     = require('xlsx');
const jwt      = require('jsonwebtoken');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const nodemailer= require('nodemailer');
const { generateInvoicePDF } = require('./lib/invoice');
const { createNotifier } = require('./lib/notify');
const { buildAdminStats } = require('./lib/stats');

const JWT_SECRET     = process.env.JWT_SECRET     || 'avaia-dev-secret-CHANGE-IN-PRODUCTION';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const EMAIL_HOST = process.env.EMAIL_HOST || '';
const EMAIL_PORT = parseInt(process.env.EMAIL_PORT || '587');
const EMAIL_USER = process.env.EMAIL_USER || '';
const EMAIL_PASS = process.env.EMAIL_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || EMAIL_USER || 'noreply@avaiastudio.com';
const USE_EMAIL  = !!(EMAIL_HOST && EMAIL_USER && EMAIL_PASS);

let mailer = null;
if (USE_EMAIL) {
  mailer = nodemailer.createTransport({
    host: EMAIL_HOST, port: EMAIL_PORT,
    secure: EMAIL_PORT === 465,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
  mailer.verify()
    .then(() => console.log('✓ Email connected'))
    .catch(e => console.warn('⚠ Email error:', e.message));
} else {
  console.log('ℹ Email not configured — email notifications inactive');
}

async function sendMail({ to, subject, html, text, attachments }) {
  if (!USE_EMAIL || !mailer) return { ok: false, reason: 'not_configured' };
  try {
    await mailer.sendMail({ from: EMAIL_FROM, to, subject, html, text, attachments });
    return { ok: true };
  } catch(e) {
    console.error('Email send error:', e.message);
    return { ok: false, reason: e.message };
  }
}

// ── EMAIL TEMPLATES ───────────────────────────
function emailBookingConfirm(booking, studioName='Avaia Studio') {
  const subject = `Booking Confirmation — ${booking.class} | ${studioName}`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:Georgia,serif;background:#fdf8f6;margin:0;padding:20px}.wrap{max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd5ca}.hdr{background:#5D3A24;padding:32px 36px}.hdr h1{color:#fff;font-size:22px;margin:0;font-weight:400}.hdr p{color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px}.bdy{padding:36px}.ok{display:inline-block;background:#e6f0e6;color:#4a7a48;padding:8px 16px;font-size:13px;margin-bottom:20px}.box{background:#fdf8f6;border:1px solid #ddd5ca;padding:20px;margin:16px 0}.row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #ede5dc}.row:last-child{border-bottom:none}.dl{font-size:11px;color:#7a6e68;text-transform:uppercase;letter-spacing:.08em}.dv{font-size:14px;font-weight:600;color:#1c1410}.note{font-size:13px;color:#7a6e68;line-height:1.7;margin-top:16px}.ftr{padding:18px 36px;border-top:1px solid #ede5dc;font-size:12px;color:#7a6e68}</style>
</head><body><div class="wrap">
<div class="hdr"><h1>${studioName}</h1><p>Class Booking Confirmation</p></div>
<div class="bdy">
<div class="ok">✓ Payment Confirmed</div>
<p style="font-size:15px;color:#1c1410">Hi, <strong>${booking.name}</strong>!</p>
<p style="font-size:14px;color:#7a6e68;line-height:1.7">Your booking has been confirmed. See you at the studio!</p>
<div class="box">
<div class="row"><span class="dl">Class</span><span class="dv">${booking.class}</span></div>
<div class="row"><span class="dl">Date</span><span class="dv">${booking.date}</span></div>
<div class="row"><span class="dl">Time</span><span class="dv">${booking.time}</span></div>
<div class="row"><span class="dl">Total Paid</span><span class="dv">IDR ${Number(booking.amount||0).toLocaleString('en-US')}</span></div>
<div class="row"><span class="dl">Order ID</span><span class="dv" style="font-size:11px;font-weight:400">${booking.id}</span></div>
</div>
${booking.note?`<p class="note"><strong>Note:</strong> ${booking.note}</p>`:''}
<p class="note">Please arrive <strong>10 minutes early</strong>. Cancellations must be made at least 2 hours before class.</p>
</div>
<div class="ftr">This is an automated email from ${studioName}. Please do not reply.</div>
</div></body></html>`;
  const text = `Booking Confirmation — ${studioName}\n\nHi ${booking.name},\n\nClass: ${booking.class}\nDate: ${booking.date}\nTime: ${booking.time}\nTotal: IDR ${Number(booking.amount||0).toLocaleString('en-US')}\nOrder ID: ${booking.id}\n\nPlease arrive 10 minutes early.`;
  return { subject, html, text };
}

function emailBookingReminder(booking, studioName='Avaia Studio') {
  const subject = `Reminder: ${booking.class} tomorrow at ${booking.time} | ${studioName}`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:Georgia,serif;background:#fdf8f6;margin:0;padding:20px}.wrap{max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd5ca}.hdr{background:#9C6B3D;padding:32px 36px}.hdr h1{color:#fff;font-size:22px;margin:0;font-weight:400}.bdy{padding:36px}.box{background:#fdf8f6;border:1px solid #ddd5ca;padding:20px;margin:16px 0}.row{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid #ede5dc}.row:last-child{border-bottom:none}.dl{font-size:11px;color:#7a6e68;text-transform:uppercase}.dv{font-size:14px;font-weight:600;color:#1c1410}.ftr{padding:18px 36px;border-top:1px solid #ede5dc;font-size:12px;color:#7a6e68}</style>
</head><body><div class="wrap">
<div class="hdr"><h1>${studioName}</h1></div>
<div class="bdy">
<p style="font-size:15px;color:#1c1410">Hi, <strong>${booking.name}</strong>!</p>
<p style="font-size:14px;color:#7a6e68;line-height:1.7">Reminder: you have a <strong>${booking.class}</strong> class tomorrow. We look forward to seeing you!</p>
<div class="box">
<div class="row"><span class="dl">Class</span><span class="dv">${booking.class}</span></div>
<div class="row"><span class="dl">Date</span><span class="dv">${booking.date}</span></div>
<div class="row"><span class="dl">Time</span><span class="dv">${booking.time}</span></div>
</div>
<p style="font-size:14px;color:#7a6e68">Please arrive 10 minutes before class. See you there!</p>
</div>
<div class="ftr">This is an automated email from ${studioName}.</div>
</div></body></html>`;
  const text = `Class Reminder — ${studioName}\n\nHi ${booking.name},\nYour ${booking.class} class is tomorrow at ${booking.time}.\nPlease arrive 10 minutes early.\n\nSee you there!`;
  return { subject, html, text };
}

function emailCancellation(booking, studioName='Avaia Studio') {
  const subject = `Booking Cancellation — ${booking.class} | ${studioName}`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:Georgia,serif;background:#fdf8f6;margin:0;padding:20px}.wrap{max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd5ca}.hdr{background:#1c1410;padding:32px 36px}.hdr h1{color:#fff;font-size:22px;margin:0;font-weight:400}.bdy{padding:36px}.ftr{padding:18px 36px;border-top:1px solid #ede5dc;font-size:12px;color:#7a6e68}</style>
</head><body><div class="wrap">
<div class="hdr"><h1>${studioName}</h1></div>
<div class="bdy">
<p style="font-size:15px;color:#1c1410">Hi, <strong>${booking.name}</strong>,</p>
<p style="font-size:14px;color:#7a6e68;line-height:1.7">Your booking for <strong>${booking.class}</strong> on <strong>${booking.date} at ${booking.time}</strong> has been cancelled.</p>
<p style="font-size:14px;color:#7a6e68;line-height:1.7">For questions or refunds, please contact us directly.</p>
</div>
<div class="ftr">This is an automated email from ${studioName}.</div>
</div></body></html>`;
  const text = `Booking Cancellation — ${studioName}\n\nHi ${booking.name},\nYour booking for ${booking.class} on ${booking.date} at ${booking.time} has been cancelled.`;
  return { subject, html, text };
}

const app  = express();

// Hostinger (and most managed Node.js hosts) run the app behind a reverse proxy,
// which adds an X-Forwarded-For header with the visitor's real IP. Without this,
// express-rate-limit can't tell visitors apart and ends up sharing ONE rate-limit
// bucket across every visitor combined — meaning ONE person's normal browsing
// (or a couple of mistyped passwords) can lock out EVERY visitor from login,
// and page-load requests like /api/settings can start failing with 429 errors,
// which is why hero/about images and colors can vanish site-wide.
// "1" = trust exactly one hop (the hosting platform's own proxy) — safer than
// blanket-trusting the whole chain, which would let a client spoof its own IP.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ── SUPABASE ────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || '';
// Production uses Supabase as the ONLY database.
// Keep the secret key server-side only; never expose it to browser code.
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY || '';
const SUPABASE_AUTH_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || SUPABASE_KEY;
let supabase = null, USE_SB = false;

// IMPORTANT: the main Supabase client is a shared server-side database client.
// Never call signInWithPassword()/signUp() on that shared instance because
// Supabase JS stores the resulting auth session on the client object. After a
// member signs in, subsequent queries (including the staff table) can then be
// executed with the member JWT instead of the server key. That makes the next
// admin login appear to have a missing/invalid account.
//
// Each member authentication operation therefore gets its own short-lived
// client. The database client above remains session-free and keeps using the
// server key for API/database work.
function createAuthClient() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(SUPABASE_URL, SUPABASE_AUTH_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR_')) {
  console.error('❌ SUPABASE_URL is missing. Application will NOT start without Supabase.');
} else if (!SUPABASE_KEY) {
  console.error('❌ SUPABASE_SECRET_KEY (or SUPABASE_KEY) is missing. Application will NOT start without Supabase.');
} else {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    USE_SB = true;
  } catch(e) {
    console.error('❌ Supabase client initialization failed:', e.message);
  }
}

// ── MIDTRANS ────────────────────────────────
const MT_SERVER = process.env.MIDTRANS_SERVER_KEY || '';
const MT_CLIENT = process.env.MIDTRANS_CLIENT_KEY || '';
const MT_ENV    = process.env.MIDTRANS_ENV || 'sandbox';
let snap = null, USE_MT = false;

if (MT_SERVER && !MT_SERVER.includes('xxxx')) {
  try {
    const midtrans = require('midtrans-client');
    snap   = new midtrans.Snap({ isProduction: MT_ENV==='production', serverKey: MT_SERVER, clientKey: MT_CLIENT });
    USE_MT = true;
    console.log(`✓ Midtrans ${MT_ENV} connected`);
  } catch(e) { console.warn('Midtrans failed:', e.message); }
} else {
  console.log('ℹ Midtrans not configured — simulation mode active');
}

// ── SUPABASE-ONLY DATABASE ───────────────────
// There is intentionally no local database implementation in this build.
// Supabase is mandatory and startServer() aborts before accepting traffic when
// Supabase is unavailable. The two guards below exist only to make any legacy
// unreachable branch fail loudly instead of silently creating local data.
function unreachableLocalStoreRead() {
  throw new Error('Local database access is disabled. Supabase is required.');
}
function unreachableLocalStoreWrite() {
  throw new Error('Local database writes are disabled. Supabase is required.');
}

// ── NOTIFICATIONS ────────────────────────────
const notifier = createNotifier({ supabase, isSB: () => USE_SB });
const { push: pushNotif, broadcastScheduleUpdate } = notifier;

// ── MULTER ──────────────────────────────────
const upDir = path.join(__dirname,'public','uploads');
if (!fs.existsSync(upDir)) fs.mkdirSync(upDir,{recursive:true});
const upload     = multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024}});
const uploadXLSX = multer({dest:upDir,limits:{fileSize:10*1024*1024}});

app.use(cors({
  origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN.split(','),
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

// ── RATE LIMITERS ────────────────────────────
// Login attempts are isolated by BOTH client IP and the identity being tested.
// This is important for a shared network (e.g. studio Wi-Fi): a member
// mistyping a password must never lock the admin account out for 15 minutes.
function authIdentityKey(req) {
  const identity = String(
    req.body?.email ??
    req.body?.username ??
    ''
  ).trim().toLowerCase();
  return `${ipKeyGenerator(req.ip)}|${identity || '(empty)'}`;
}

const authLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 10,
  keyGenerator: authIdentityKey,
  message: { error: 'Too many attempts for this account. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 1*60*1000,
  max: 100,
  message: { error: 'Too many requests. Please try again shortly.' },
});

app.use('/api/', generalLimiter);

// Do NOT put one shared limiter on every /api/auth/* route.
// Login/register are rate-limited at the individual endpoint so that
// member activity cannot consume the admin login bucket.

function requireRole(allowedRoles) {
  return (req, res, next) => {
    // Accept the token via the Authorization header (used by fetch calls) or a
    // ?token= query param (used by plain <a href> / window.location downloads,
    // e.g. Excel/CSV exports, which can't attach custom headers).
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'Access denied. Please sign in.' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!allowedRoles.includes(decoded.role)) {
        return res.status(403).json({ error: 'You do not have permission for this action.' });
      }
      req.user = decoded; // { id, email, role, name }
      next();
    } catch(e) {
      return res.status(401).json({ error: 'Invalid session. Please sign in again.' });
    }
  };
}
const requireAdmin = requireRole(['admin']);
const requireStaff = requireRole(['admin','instructor']); // admin + instructor

// Like requireRole(['member']), but also confirms the member row still exists.
// A plain JWT check isn't enough here: the token stays cryptographically valid
// for 30 days even after an admin deletes the member, which used to leave the
// person "stuck" signed in on the client with no way to register again.
function requireMember(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (!token) return res.status(401).json({ error: 'Access denied. Please sign in.' });
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid session. Please sign in again.' });
  }
  if (decoded.role !== 'member') {
    return res.status(403).json({ error: 'You do not have permission for this action.' });
  }

  (async () => {
    try {
      let exists;
      if (USE_SB) {
        const { data } = await supabase.from('members').select('id').eq('id', decoded.id).maybeSingle();
        exists = !!data;
        if (!exists) {
          // The "members" profile row is missing. This can legitimately happen if
          // it failed to get created during registration (a since-fixed bug), so
          // recreate it — unless we get a clear, definitive signal that this
          // specific account was deliberately deleted by an admin. If the check
          // itself fails for any other reason (e.g. the Supabase key doesn't have
          // admin-level access), we deliberately fail OPEN and heal anyway —
          // a broken permission check should never be able to lock someone out.
          let authUserGone = false;
          try {
            const { data: authCheck, error: authErr } = await supabase.auth.admin.getUserById(decoded.id);
            if (authErr && /not.*found|does not exist/i.test(authErr.message || '')) authUserGone = true;
            else if (!authErr && !authCheck?.user) authUserGone = true;
          } catch (e) { /* couldn't verify — fail open, don't block */ }

          if (!authUserGone) {
            const { error: insertErr } = await supabase.from('members').insert({
              id: decoded.id,
              name: decoded.name || decoded.email,
              email: decoded.email,
              phone: '',
              joined: new Date().toISOString(),
              membership_type: 'drop-in',
              status: 'active',
            });
            exists = !insertErr;
            if (insertErr) console.error('Self-heal insert failed:', insertErr.message);
          }
        }
      } else {
        const db = unreachableLocalStoreRead();
        exists = (db.members || []).some(m => m.id === decoded.id || m.email === decoded.email);
      }
      if (!exists) {
        return res.status(401).json({ error: 'Your account no longer exists. Please sign in again.' });
      }
      req.user = decoded;
      next();
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  })();
}

// Soft auth: verifies a member token if present, but never rejects the request —
// used on endpoints where guests are still allowed (e.g. booking a class as a guest).
// Returns { id, email, name, role } if a valid member token was sent, otherwise null.
function getSoftMemberAuth(req){
  const token=req.headers.authorization?.replace('Bearer ','');
  if(!token) return null;
  try{
    const dec=jwt.verify(token,JWT_SECRET);
    return dec.role==='member' ? dec : null;
  }catch(e){ return null; }
}

// ════════════════════════════════════════════
//  STATUS
// ════════════════════════════════════════════
app.get('/api/status',(req,res)=>res.json({
  supabase:USE_SB, midtrans:USE_MT,
  midtransEnv:MT_ENV, midtransClientKey:MT_CLIENT||null,
  email:USE_EMAIL, emailUser:USE_EMAIL?EMAIL_USER:null
}));

// ════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════
const APP_BUILD_ID = 'supabase-auth-final-20260811-02';
const APP_STARTED_AT = new Date().toISOString();

async function fetchSettingsRow() {
  if(!USE_SB || !supabase){
    return { data:null, error:new Error('Supabase is not configured') };
  }

  // Use one helper for BOTH startup verification and HTTP requests.
  // This removes any possibility that the two paths query Supabase differently.
  const result = await supabase
    .from('settings')
    .select('*')
    .eq('id', 1)
    .limit(1);

  if(result.error) return { data:null, error:result.error };

  const rows = Array.isArray(result.data) ? result.data : [];
  return { data:rows[0] || null, error:null, rowCount:rows.length };
}

app.get('/api/settings', async (req, res) => {
  res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma','no-cache');
  res.set('Expires','0');

  if(!USE_SB || !supabase){
    return res.status(503).json({ error:'Supabase is not configured.' });
  }

  try {
    const { data, error } = await supabase
      .from('settings')
      .select('*')
      .eq('id',1)
      .maybeSingle();

    if(error){
      console.error('❌ /api/settings:', error.message);
      return res.status(500).json({ error:error.message });
    }

    if(!data){
      console.error('❌ /api/settings: row id=1 not found');
      return res.status(404).json({ error:'Settings row id=1 not found in Supabase.' });
    }

    return res.json(data);
  } catch(e) {
    console.error('❌ /api/settings exception:', e.message);
    return res.status(500).json({ error:e.message });
  }
});

app.put('/api/settings',requireAdmin,async(req,res)=>{
  // Image URLs are deliberately excluded. Images are changed only by the
  // dedicated /api/settings/*-img endpoints below, so a normal settings save
  // can never overwrite an existing image with null/undefined.
  const allowedFields = [
    'studioName','tagline','primaryColor','accentColor','bgColor',
    'address','phone','email','hours','mapEmbed',
    'about1','about2','about3'
  ];

  const safeBody = {};
  for(const key of allowedFields){
    if(Object.prototype.hasOwnProperty.call(req.body,key)){
      safeBody[key] = req.body[key];
    }
  }

  if(!Object.keys(safeBody).length){
    return res.status(400).json({error:'No valid settings fields provided.'});
  }

  if(USE_SB){
    const{data,error}=await supabase.from('settings').update(safeBody).eq('id',1).select().single();
    if(error) return res.status(500).json({error:error.message});
    return res.json({ok:true,settings:data});
  }

  const db=unreachableLocalStoreRead();
  db.settings={...db.settings,...safeBody};
  unreachableLocalStoreWrite(db);
  res.json({ok:true,settings:db.settings});
});

// Image uploads
['hero','hero2','hero3','about'].forEach(key=>{
  const field = key==='about'?'aboutImg':'hero';
  const dbKey = key==='about'?'aboutImage':key==='hero'?'heroImage':'heroImage'+(key.slice(-1));
  app.post(`/api/settings/${key}-img`,requireAdmin,
    upload.single(field),async(req,res)=>{
      if(!req.file) return res.status(400).json({error:'No file'});
      const filename = key+'-'+Date.now()+path.extname(req.file.originalname);

      if(USE_SB){
        const{error:upErr}=await supabase.storage.from('uploads')
          .upload(filename,req.file.buffer,{contentType:req.file.mimetype,upsert:true});
        if(upErr) return res.status(500).json({error:'Upload failed: '+upErr.message});
        const{data:pub}=supabase.storage.from('uploads').getPublicUrl(filename);
        const{data:updData,error:updErr}=await supabase.from('settings').update({[dbKey]:pub.publicUrl}).eq('id',1).select();
        if(updErr) return res.status(500).json({error:updErr.message});
        if(!updData||!updData.length) return res.status(500).json({error:'Settings row not found — the settings table may not be set up correctly.'});
        return res.json({ok:true,path:pub.publicUrl});
      }

      fs.writeFileSync(path.join(upDir,filename), req.file.buffer);
      const db=unreachableLocalStoreRead(); db.settings[dbKey]='/uploads/'+filename; unreachableLocalStoreWrite(db);
      res.json({ok:true,path:db.settings[dbKey]});
    });
});

// ════════════════════════════════════════════
//  AUTH STAFF (Admin & Instructor — single login gate)
// ════════════════════════════════════════════

// Check token & get current logged-in user info (for frontend UI decisions)
app.get('/api/me',requireStaff,(req,res)=>{
  res.json({ ok:true, user:req.user });
});

async function findStaffAccount(identity){
  const normalized = String(identity || '').trim().toLowerCase();
  if(!normalized || !USE_SB || !supabase) return null;

  // Query username and email separately. This avoids PostgREST .or() parsing
  // problems and makes the staff lookup deterministic.
  let q = await supabase.from('staff').select('*').eq('username', normalized).maybeSingle();
  if(q.error) throw q.error;
  if(q.data) return q.data;

  q = await supabase.from('staff').select('*').eq('email', normalized).maybeSingle();
  if(q.error) throw q.error;
  return q.data || null;
}

async function authenticateStaff(username, password){
  const identity = String(username || '').trim();
  const secret = String(password || '');
  if(!identity || !secret) return { ok:false, status:400, error:'Username/email and password are required.' };
  if(!USE_SB) return { ok:false, status:503, error:'Supabase is required for staff login.' };

  try {
    const staffUser = await findStaffAccount(identity);

    // Tell the caller whether an actual staff account exists. This is used by
    // the unified login endpoint so a staff email can never accidentally fall
    // through to a member account with the same email.
    if(!staffUser){
      return { ok:false, found:false, status:401, error:'Incorrect username/email or password.' };
    }

    if(staffUser.status === 'inactive'){
      return { ok:false, found:true, status:403, error:'Your account is currently inactive. Please contact an admin.' };
    }

    const match = await bcrypt.compare(secret, staffUser.password || '');
    if(!match){
      return { ok:false, found:true, status:401, error:'Incorrect username/email or password.' };
    }

    const token = jwt.sign(
      {
        id:staffUser.id,
        role:staffUser.role,
        name:staffUser.name,
        username:staffUser.username,
        email:staffUser.email || ''
      },
      JWT_SECRET,
      { expiresIn:'8h' }
    );

    const { password:_, ...safe } = staffUser;
    return { ok:true, found:true, status:200, token, user:safe };
  } catch(error) {
    console.error('staff-login database error:', error.message);
    return { ok:false, found:false, status:500, error:'Staff login database error: '+error.message };
  }
}

// AUTH STAFF (Admin & Instructor)
app.post('/api/auth/staff-login', authLimiter, async(req,res)=>{
  const result = await authenticateStaff(req.body?.username, req.body?.password);
  return res.status(result.status).json(result);
});

app.get('/api/auth/staff-login', (req,res)=>{
  return res.status(405).json({
    error: 'Method Not Allowed. Use POST with username and password.'
  });
});

// Change own password for the currently logged-in staff member (admin or instructor)
app.put('/api/auth/staff-password',requireStaff,async(req,res)=>{
  const {currentPassword,newPassword}=req.body;
  if(!newPassword || newPassword.length<8) return res.status(400).json({error:'New password must be at least 8 characters.'});

  if(USE_SB){
    const{data:staffUser}=await supabase.from('staff').select('*').eq('id',req.user.id).maybeSingle();
    if(!staffUser) return res.status(404).json({error:'Account not found.'});
    const match=await bcrypt.compare(currentPassword||'', staffUser.password);
    if(!match) return res.status(401).json({error:'Current password is incorrect.'});
    const hashed=await bcrypt.hash(newPassword,10);
    const{error}=await supabase.from('staff').update({password:hashed}).eq('id',req.user.id);
    if(error) return res.status(500).json({error:error.message});
    return res.json({ok:true});
  }

  const db=unreachableLocalStoreRead(); if(!db.staff) db.staff=[];

  if(req.user.id==='admin-default'){
    const match=await bcrypt.compare(currentPassword||'', db.admin.password);
    if(!match) return res.status(401).json({error:'Current password is incorrect.'});
    db.admin.password=await bcrypt.hash(newPassword,10);
    unreachableLocalStoreWrite(db); return res.json({ok:true});
  }

  const i=db.staff.findIndex(s=>s.id===req.user.id);
  if(i<0) return res.status(404).json({error:'Account not found.'});
  const match=await bcrypt.compare(currentPassword||'', db.staff[i].password);
  if(!match) return res.status(401).json({error:'Current password is incorrect.'});
  db.staff[i].password=await bcrypt.hash(newPassword,10);
  unreachableLocalStoreWrite(db); res.json({ok:true});
});

// ════════════════════════════════════════════
//  MANAGE STAFF (Admin & Instructor) — Admin only
// ════════════════════════════════════════════
app.get('/api/staff',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('staff').select('*').order('created_at',{ascending:false});
    if(error) return res.status(500).json({error:error.message});
    return res.json((data||[]).map(({password:_,...s})=>s));
  }
  const db=unreachableLocalStoreRead();
  res.json((db.staff||[]).map(({password:_,...s})=>s));
});

app.post('/api/staff',requireAdmin,async(req,res)=>{
  const {name,username,email,password,role,bio,specialty}=req.body;
  if(!name||!username||!password||!role) return res.status(400).json({error:'Name, username, password, and role are required.'});
  if(!['admin','instructor'].includes(role)) return res.status(400).json({error:'Invalid role.'});
  if(password.length<8) return res.status(400).json({error:'Password must be at least 8 characters.'});
  const hashedPw=await bcrypt.hash(password,10);

  if(USE_SB){
    const{data:existing}=await supabase.from('staff').select('id').eq('username',username).maybeSingle();
    if(existing) return res.status(400).json({error:'Username is already taken.'});
    const{data,error}=await supabase.from('staff').insert({
      name, username, email:email||'', password:hashedPw, role,
      bio:bio||'', specialty:specialty||'', status:'active'
    }).select().single();
    if(error) return res.status(500).json({error:error.message});
    const{password:_,...safe}=data;
    return res.json({ok:true, staff:safe});
  }

  const db=unreachableLocalStoreRead(); if(!db.staff) db.staff=[];
  if(db.staff.find(s=>s.username===username)) return res.status(400).json({error:'Username is already taken.'});

  const staff={
    id:uuidv4(), name, username, email:email||'', password:hashedPw, role,
    bio:bio||'', specialty:specialty||'', status:'active',
    created_at:new Date().toISOString()
  };
  db.staff.push(staff); unreachableLocalStoreWrite(db);
  const {password:_,...safe}=staff;
  res.json({ok:true, staff:safe});
});

app.put('/api/staff/:id',requireAdmin,async(req,res)=>{
  // Whitelist of fields allowed to change — don't let an arbitrary body overwrite id/created_at/etc.
  const allowed=['name','username','email','role','bio','specialty','status','password'];
  const body={};
  for(const k of allowed){ if(req.body[k]!==undefined) body[k]=req.body[k]; }

  if(body.role && !['admin','instructor'].includes(body.role)){
    return res.status(400).json({error:'Invalid role.'});
  }
  if(body.password){
    if(body.password.length<8) return res.status(400).json({error:'Password must be at least 8 characters.'});
    body.password=await bcrypt.hash(body.password,10);
  }
  else delete body.password;

  if(USE_SB){
    const{data:current}=await supabase.from('staff').select('*').eq('id',req.params.id).maybeSingle();
    if(!current) return res.status(404).json({error:'Account not found.'});

    if(body.username && body.username!==current.username){
      const{data:dupe}=await supabase.from('staff').select('id').eq('username',body.username).neq('id',req.params.id).maybeSingle();
      if(dupe) return res.status(400).json({error:'Username is already taken.'});
    }

    const targetWasAdmin = current.role==='admin' && current.status!=='inactive';
    const willStillBeAdmin = (body.role || current.role)==='admin' && (body.status || current.status)!=='inactive';
    if(targetWasAdmin && !willStillBeAdmin){
      const{count}=await supabase.from('staff').select('*',{count:'exact',head:true}).eq('role','admin').eq('status','active').neq('id',req.params.id);
      if(!count){
        return res.status(400).json({error:'Cannot change the role/status of the last admin. Make sure another active admin exists first.'});
      }
    }

    const{data,error}=await supabase.from('staff').update(body).eq('id',req.params.id).select().single();
    if(error) return res.status(500).json({error:error.message});
    const{password:_,...safe}=data;
    return res.json({ok:true, staff:safe});
  }

  const db=unreachableLocalStoreRead(); if(!db.staff) db.staff=[];
  const i=db.staff.findIndex(s=>s.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Account not found.'});

  if(body.username && body.username!==db.staff[i].username){
    if(db.staff.find(s=>s.username===body.username && s.id!==req.params.id)){
      return res.status(400).json({error:'Username is already taken.'});
    }
  }

  // Prevent the last admin from disabling/demoting themselves until no active admin remains
  const targetWasAdmin = db.staff[i].role==='admin' && db.staff[i].status!=='inactive';
  const willStillBeAdmin = (body.role || db.staff[i].role)==='admin' && (body.status || db.staff[i].status)!=='inactive';
  if(targetWasAdmin && !willStillBeAdmin){
    const otherActiveAdmins = db.staff.filter(s=>s.id!==req.params.id && s.role==='admin' && s.status!=='inactive').length;
    if(otherActiveAdmins===0){
      return res.status(400).json({error:'Cannot change the role/status of the last admin. Make sure another active admin exists first.'});
    }
  }

  db.staff[i]={...db.staff[i],...body}; unreachableLocalStoreWrite(db);
  const {password:_,...safe}=db.staff[i];
  res.json({ok:true, staff:safe});
});

app.delete('/api/staff/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data:target}=await supabase.from('staff').select('*').eq('id',req.params.id).maybeSingle();
    if(!target) return res.status(404).json({error:'Account not found.'});
    if(target.role==='admin' && target.status!=='inactive'){
      const{count}=await supabase.from('staff').select('*',{count:'exact',head:true}).eq('role','admin').eq('status','active').neq('id',req.params.id);
      if(!count){
        return res.status(400).json({error:'Cannot delete the last active admin. Create another admin first.'});
      }
    }
    const{error}=await supabase.from('staff').delete().eq('id',req.params.id);
    if(error) return res.status(500).json({error:error.message});
    return res.json({ok:true});
  }

  const db=unreachableLocalStoreRead(); if(!db.staff) db.staff=[];
  const target=db.staff.find(s=>s.id===req.params.id);
  if(!target) return res.status(404).json({error:'Account not found.'});

  // Prevent deleting the last active admin to avoid a total lockout
  if(target.role==='admin' && target.status!=='inactive'){
    const otherActiveAdmins = db.staff.filter(s=>s.id!==req.params.id && s.role==='admin' && s.status!=='inactive').length;
    if(otherActiveAdmins===0){
      return res.status(400).json({error:'Cannot delete the last active admin. Create another admin first.'});
    }
  }

  db.staff=db.staff.filter(s=>s.id!==req.params.id); unreachableLocalStoreWrite(db);
  res.json({ok:true});
});

// ════════════════════════════════════════════
//  AUTH MEMBER
// ════════════════════════════════════════════
app.post('/api/auth/register', authLimiter, async(req,res)=>{
  const {name,email,password,phone}=req.body;
  if(!name||!email||!password) return res.status(400).json({error:'Name, email, and password are required.'});

  if(USE_SB){
    try{
      // Use an isolated auth client. Do not mutate the shared DB client's
      // auth session; doing so breaks subsequent staff/admin logins.
      const authClient = createAuthClient();
      const {data,error}=await authClient.auth.signUp({email,password,options:{data:{name,phone}}});
      if(error) return res.status(400).json({error:error.message});
      const {error:profileErr}=await supabase.from('members').insert({
        id:data.user.id,name,email,phone:phone||'',
        joined:new Date().toISOString(),membership_type:'drop-in',status:'active'
      });
      if(profileErr){
        console.error('Failed to create member profile row:', profileErr.message);
        return res.status(500).json({error:'Registration partially failed. Please try signing in — if that fails too, contact the studio.'});
      }
      pushNotif({audience:'admin',type:'info',title:'New member registered',message:`${name} (${email}) just joined.`,link:'/admin#members'});
      const token=jwt.sign({id:data.user.id,email,name,role:'member'},JWT_SECRET,{expiresIn:'30d'});
      res.json({ok:true,token,user:{id:data.user.id,name,email,phone}});
    }catch(e){res.status(500).json({error:e.message});}
  } else {
    const db=unreachableLocalStoreRead();
    if(db.members.find(m=>m.email===email))
      return res.status(400).json({error:'Email is already registered.'});
    const hashedPw=await bcrypt.hash(password,10);
    const m={id:uuidv4(),name,email,phone:phone||'',password:hashedPw,
      joined:new Date().toISOString(),membership_type:'drop-in',status:'active'};
    db.members.push(m); unreachableLocalStoreWrite(db);
    pushNotif({audience:'admin',type:'info',title:'New member registered',message:`${name} (${email}) just joined.`,link:'/admin#members'});
    const {password:_,...safe}=m;
    const token=jwt.sign({id:m.id,email:m.email,name:m.name,role:'member'},JWT_SECRET,{expiresIn:'30d'});
    res.json({ok:true,token,user:safe});
  }
});

app.post('/api/auth/login', authLimiter, async (req,res)=>{
  const identity = String(req.body?.email || req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if(!identity || !password){
    return res.status(400).json({error:'Email/username and password are required.'});
  }

  if(!USE_SB || !supabase){
    return res.status(503).json({error:'Supabase is required for login.'});
  }

  try {
    // IMPORTANT: staff is checked FIRST. If a staff account exists for this
    // identity, its password/role decides the result. We never silently fall
    // through to a member account with the same email.
    const staff = await authenticateStaff(identity, password);
    if(staff.found){
      return res.status(staff.status).json(staff);
    }
    if(staff.status === 500){
      return res.status(500).json(staff);
    }

    // Non-email identities are staff-only.
    if(!identity.includes('@')){
      return res.status(401).json({error:'Incorrect username or password.'});
    }

    // Member authentication is handled by Supabase Auth.
    // CRITICAL: authenticate the member on a separate Supabase client.
    // The main `supabase` client is shared by every request on this Node
    // process. Calling signInWithPassword() on it changes its in-memory auth
    // session. The next request would then query `staff` as the member and RLS
    // can hide the admin row, producing the exact symptom: admin works once,
    // then member login/logout, then admin login says incorrect credentials.
    const authClient = createAuthClient();
    const {data,error} = await authClient.auth.signInWithPassword({
      email: identity.toLowerCase(),
      password
    });

    if(error || !data?.user){
      return res.status(401).json({
        error:'Incorrect email or password.'
      });
    }

    const {data:member,error:memberError} = await supabase
      .from('members')
      .select('*')
      .eq('id', data.user.id)
      .maybeSingle();

    if(memberError){
      console.error('member profile lookup error:', memberError.message);
      return res.status(500).json({error:'Unable to load your member profile.'});
    }

    const user = member || {
      id:data.user.id,
      email:data.user.email || identity
    };

    if(user.status === 'inactive'){
      return res.status(403).json({
        error:'Your account is currently inactive. Please contact the studio.'
      });
    }

    const token = jwt.sign(
      {
        id:user.id,
        email:user.email || data.user.email || identity,
        name:user.name || '',
        role:'member'
      },
      JWT_SECRET,
      {expiresIn:'30d'}
    );

    return res.json({
      ok:true,
      token,
      user
    });

  } catch(error) {
    console.error('login error:', error);
    return res.status(500).json({error:'Login failed. Please try again.'});
  }
});

app.get('/api/classes',async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('classes').select('*').order('name');
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  res.json(unreachableLocalStoreRead().classes);
});
app.post('/api/classes',requireStaff,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('classes').insert(req.body).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  const db=unreachableLocalStoreRead(); const c={id:'c'+uuidv4().slice(0,8),...req.body}; db.classes.push(c); unreachableLocalStoreWrite(db); res.json(c);
});
app.put('/api/classes/:id',requireStaff,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('classes').update(req.body).eq('id',req.params.id).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  const db=unreachableLocalStoreRead(); const i=db.classes.findIndex(c=>c.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Not found'});
  db.classes[i]={...db.classes[i],...req.body}; unreachableLocalStoreWrite(db); res.json(db.classes[i]);
});
app.delete('/api/classes/:id',requireStaff,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('classes').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Class not found — it may already have been deleted, or you may not have permission to delete it.'});
    return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead(); db.classes=db.classes.filter(c=>c.id!==req.params.id); unreachableLocalStoreWrite(db); res.json({ok:true});
});

// ════════════════════════════════════════════
//  SCHEDULE
// ════════════════════════════════════════════
app.get('/api/schedule',async(req,res)=>{
  if(USE_SB){
    const dateFilter = String(req.query?.date || '').trim();
    let q = supabase.from('schedule')
      .select('*,classes(name,instructor,level,duration,capacity,price)')
      .order('session_date',{ascending:true,nullsFirst:false})
      .order('time',{ascending:true});
    if(dateFilter) q = q.eq('session_date', dateFilter);
    const{data,error}=await q;
    if(error) return res.status(500).json({error:error.message});
    return res.json((data||[]).map(s=>({...s,
      day:s.day || (s.session_date ? new Date(s.session_date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long'}) : ''),
      className:s.classes?.name,instructor:s.classes?.instructor,
      level:s.classes?.level,duration:s.classes?.duration,capacity:s.classes?.capacity,price:s.classes?.price
    })));
  }
  const db=unreachableLocalStoreRead();
  res.json(db.schedule.map(s=>{
    const c=db.classes.find(x=>x.id===(s.classId||s.class_id))||{};
    return{...s,class_id:s.classId,className:c.name,instructor:c.instructor,
      level:c.level,duration:c.duration,capacity:c.capacity,price:c.price||85000};
  }));
});
app.post('/api/schedule',requireStaff,async(req,res)=>{
  if(USE_SB){
    const body={...req.body};
    if(!body.session_date) return res.status(400).json({error:'Session date is required.'});
    if(!body.class_id) return res.status(400).json({error:'Class is required.'});
    if(!body.time) return res.status(400).json({error:'Time is required.'});
    const d=new Date(String(body.session_date)+'T00:00:00');
    if(Number.isNaN(d.getTime())) return res.status(400).json({error:'Invalid session date.'});
    body.day = d.toLocaleDateString('en-US',{weekday:'long'});
    body.slots = Math.max(0, Number.parseInt(body.slots,10) || 0);

    const { data: duplicate } = await supabase
      .from('schedule').select('id').eq('session_date', body.session_date)
      .eq('class_id', body.class_id).eq('time', body.time).maybeSingle();
    if(duplicate) return res.status(409).json({error:'A session with this class, date and time already exists.'});

    const{data,error}=await supabase.from('schedule').insert(body).select().single();
    if(error) return res.status(500).json({error:error.message});
    broadcastScheduleUpdate(); return res.json(data);
  }
  const db=unreachableLocalStoreRead(); const e={id:'s'+uuidv4().slice(0,8),classId:req.body.class_id,...req.body}; db.schedule.push(e); unreachableLocalStoreWrite(db); broadcastScheduleUpdate(); res.json(e);
});
app.put('/api/schedule/:id',requireStaff,async(req,res)=>{
  if(USE_SB){
    const body={...req.body};
    if(!body.session_date) return res.status(400).json({error:'Session date is required.'});
    if(!body.class_id) return res.status(400).json({error:'Class is required.'});
    if(!body.time) return res.status(400).json({error:'Time is required.'});
    const d=new Date(String(body.session_date)+'T00:00:00');
    if(Number.isNaN(d.getTime())) return res.status(400).json({error:'Invalid session date.'});
    body.day = d.toLocaleDateString('en-US',{weekday:'long'});
    body.slots = Math.max(0, Number.parseInt(body.slots,10) || 0);

    const { data: duplicate } = await supabase
      .from('schedule').select('id').eq('session_date', body.session_date)
      .eq('class_id', body.class_id).eq('time', body.time).neq('id', req.params.id).maybeSingle();
    if(duplicate) return res.status(409).json({error:'A session with this class, date and time already exists.'});

    const{data,error}=await supabase.from('schedule').update(body).eq('id',req.params.id).select().single();
    if(error) return res.status(500).json({error:error.message});
    if(!data) return res.status(404).json({error:'Schedule session not found.'});
    broadcastScheduleUpdate(); return res.json(data);
  }
  const db=unreachableLocalStoreRead(); const i=db.schedule.findIndex(s=>s.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Not found'});
  if(req.body.class_id) req.body.classId=req.body.class_id;
  db.schedule[i]={...db.schedule[i],...req.body}; unreachableLocalStoreWrite(db); broadcastScheduleUpdate(); res.json(db.schedule[i]);
});
app.delete('/api/schedule/:id',requireStaff,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('schedule').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Session not found — it may already have been deleted, or you may not have permission to delete it.'});
    broadcastScheduleUpdate(); return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead(); db.schedule=db.schedule.filter(s=>s.id!==req.params.id); unreachableLocalStoreWrite(db); broadcastScheduleUpdate(); res.json({ok:true});
});

// ════════════════════════════════════════════
//  BOOKINGS
// ════════════════════════════════════════════
app.get('/api/bookings',requireAdmin,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('bookings').select('*').order('created_at',{ascending:false});
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  res.json(unreachableLocalStoreRead().bookings);
});

// Bookings belonging to the logged-in user only (for member dashboard)
app.get('/api/my-bookings',requireMember,async(req,res)=>{
  const email = req.user.email;
  const memberId = req.user.id;

  let all;
  if(USE_SB){
    const{data,error}=await supabase.from('bookings').select('*').order('created_at',{ascending:false});
    if(error) return res.status(500).json({error:error.message});
    all=data;
  } else all=unreachableLocalStoreRead().bookings;

  const mine = all.filter(b => (email && b.email===email) || (memberId && b.member_id===memberId));
  res.json(mine);
});

app.delete('/api/bookings/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('bookings').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Booking not found — it may already have been deleted, or you may not have permission to delete it.'});
    return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead(); db.bookings=db.bookings.filter(b=>b.id!==req.params.id); unreachableLocalStoreWrite(db); res.json({ok:true});
});

// Mark a booking as No Show. The class credit (if any was used) is NOT refunded —
// it was already spent at booking time, same as a late cancellation.
app.put('/api/bookings/:id/no-show',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{error}=await supabase.from('bookings').update({status:'no-show'}).eq('id',req.params.id);
    if(error) return res.status(500).json({error:error.message});
    return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead(); const i=db.bookings.findIndex(b=>b.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Booking not found.'});
  db.bookings[i].status='no-show'; unreachableLocalStoreWrite(db);
  res.json({ok:true});
});

// Export bookings to Excel
app.get('/api/bookings/export-excel',requireAdmin,async(req,res)=>{
  let data;
  if(USE_SB){const r=await supabase.from('bookings').select('*').order('created_at',{ascending:false}); data=r.data||[];}
  else data=unreachableLocalStoreRead().bookings;
  const rows=data.map(b=>({
    'Name':b.name,'Email':b.email,'Phone':b.phone||'','Class':b.class,
    'Date':b.date,'Time':b.time,'Note':b.note||'',
    'Status':b.status,'Payment':b.payment_type||'','Price':b.amount||'',
    'Created':b.created_at?new Date(b.created_at).toLocaleString('en-US'):'',
  }));
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.json_to_sheet(rows);
  ws['!cols']=[{wch:20},{wch:25},{wch:18},{wch:20},{wch:14},{wch:8},{wch:20},{wch:12},{wch:14},{wch:12},{wch:20}];
  XLSX.utils.book_append_sheet(wb,ws,'Bookings');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="avaia-bookings.xlsx"');
  res.send(buf);
});

// Export bookings to CSV
app.get('/api/bookings/export-csv',requireAdmin,async(req,res)=>{
  let data;
  if(USE_SB){const r=await supabase.from('bookings').select('*').order('created_at',{ascending:false}); data=r.data||[];}
  else data=unreachableLocalStoreRead().bookings;
  const header='Name,Email,Phone,Class,Date,Time,Status,Payment,Price,Created\n';
  const rows=data.map(b=>[b.name,b.email,b.phone,b.class,b.date,b.time,b.status,b.payment_type||'',b.amount||'',
    b.created_at?new Date(b.created_at).toLocaleString('en-US'):'']
    .map(v=>`"${String(v||'').replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type','text/csv;charset=utf-8');
  res.setHeader('Content-Disposition','attachment; filename="avaia-bookings.csv"');
  res.send('\uFEFF'+header+rows);
});

// Import bookings from Excel
app.post('/api/bookings/import',requireAdmin,uploadXLSX.single('file'),async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file uploaded'});
  try{
    const wb=XLSX.readFile(req.file.path);
    const ws=wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(ws);
    fs.unlinkSync(req.file.path);
    let imported=0;
    for(const row of rows){
      const b={
        id:'b'+uuidv4().slice(0,8),
        name:row['Name']||row['Nama']||row['name']||'',
        email:row['Email']||row['email']||'',
        phone:row['Phone']||row['Telepon']||row['phone']||'',
        class:row['Class']||row['Kelas']||row['class']||'',
        date:row['Date']||row['Tanggal']||row['date']||'',
        time:row['Time']||row['Waktu']||row['time']||'',
        note:row['Note']||row['Catatan']||row['note']||'',
        status:'confirmed',payment_type:'import',
        created_at:new Date().toISOString()
      };
      if(!b.name||!b.email) continue;
      if(USE_SB) await supabase.from('bookings').insert(b);
      else{ const db=unreachableLocalStoreRead(); db.bookings.unshift(b); unreachableLocalStoreWrite(db); }
      imported++;
    }
    res.json({ok:true,imported});
  }catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════
//  MEMBERS
// ════════════════════════════════════════════
app.get('/api/members',requireAdmin,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('members').select('*').order('joined',{ascending:false});
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  res.json(unreachableLocalStoreRead().members.map(({password:_,...m})=>m));
});
app.delete('/api/members/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('members').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Member not found — it may already have been deleted, or you may not have permission to delete it.'});
    // Also remove the underlying Supabase Auth identity — otherwise the person
    // could still sign in (their auth account survives) and the profile row
    // would just get silently recreated on their next request.
    await supabase.auth.admin.deleteUser(req.params.id).catch(()=>{});
    return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead(); db.members=db.members.filter(m=>m.id!==req.params.id); unreachableLocalStoreWrite(db); res.json({ok:true});
});

// Export members to Excel
app.get('/api/members/export-excel',requireAdmin,async(req,res)=>{
  let data;
  if(USE_SB){const r=await supabase.from('members').select('*').order('joined',{ascending:false}); data=r.data||[];}
  else data=unreachableLocalStoreRead().members.map(({password:_,...m})=>m);
  const rows=data.map(m=>({
    'Name':m.name,'Email':m.email,'Phone':m.phone||'',
    'Membership Type':m.membership_type||'drop-in','Status':m.status||'active',
    'Joined':m.joined?new Date(m.joined).toLocaleDateString('en-US'):'',
  }));
  const wb=XLSX.utils.book_new();
  const ws=XLSX.utils.json_to_sheet(rows);
  ws['!cols']=[{wch:22},{wch:28},{wch:18},{wch:18},{wch:12},{wch:16}];
  XLSX.utils.book_append_sheet(wb,ws,'Members');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition','attachment; filename="avaia-members.xlsx"');
  res.send(buf);
});

// Import members from Excel
app.post('/api/members/import',requireAdmin,uploadXLSX.single('file'),async(req,res)=>{
  if(!req.file) return res.status(400).json({error:'No file'});
  try{
    const wb=XLSX.readFile(req.file.path);
    const ws=wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(ws);
    fs.unlinkSync(req.file.path);
    let imported=0;
    for(const row of rows){
      const m={
        id:uuidv4(),
        name:row['Name']||row['Nama']||row['name']||'',
        email:row['Email']||row['email']||'',
        phone:row['Phone']||row['Telepon']||row['phone']||'',
        membership_type:row['Membership Type']||row['Tipe Membership']||'drop-in',
        status:row['Status']||'active',
        joined:new Date().toISOString()
      };
      if(!m.name||!m.email) continue;
      if(USE_SB) await supabase.from('members').insert(m);
      else{ const db=unreachableLocalStoreRead(); if(!db.members.find(x=>x.email===m.email)){db.members.push(m);unreachableLocalStoreWrite(db);} }
      imported++;
    }
    res.json({ok:true,imported});
  }catch(e){res.status(500).json({error:e.message});}
});

// ════════════════════════════════════════════
//  MEMBERSHIPS (packages)
// ════════════════════════════════════════════
app.get('/api/memberships',async(req,res)=>{
  if(USE_SB){const{data}=await supabase.from('memberships').select('*').order('created_at',{ascending:false}); return res.json(data||[]);}
  res.json(unreachableLocalStoreRead().memberships||[]);
});
app.post('/api/memberships',requireAdmin,async(req,res)=>{
  const m={...req.body,id:uuidv4(),created_at:new Date().toISOString(),status:'active'};
  if(USE_SB){const{data,error}=await supabase.from('memberships').insert(m).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  const db=unreachableLocalStoreRead(); if(!db.memberships)db.memberships=[]; db.memberships.unshift(m); unreachableLocalStoreWrite(db); res.json(m);
});
app.put('/api/memberships/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('memberships').update(req.body).eq('id',req.params.id).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  const db=unreachableLocalStoreRead(); const i=(db.memberships||[]).findIndex(m=>m.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Not found'});
  db.memberships[i]={...db.memberships[i],...req.body}; unreachableLocalStoreWrite(db); res.json(db.memberships[i]);
});
app.delete('/api/memberships/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('memberships').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Package not found — it may already have been deleted, or you may not have permission to delete it.'});
    return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead(); db.memberships=(db.memberships||[]).filter(m=>m.id!==req.params.id); unreachableLocalStoreWrite(db); res.json({ok:true});
});

// ════════════════════════════════════════════
//  FEEDBACK
// ════════════════════════════════════════════
app.get('/api/feedback',requireAdmin,async(req,res)=>{
  if(USE_SB){const{data}=await supabase.from('feedback').select('*').order('created_at',{ascending:false}); return res.json(data||[]);}
  res.json((unreachableLocalStoreRead().feedback||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)));
});
app.post('/api/feedback',async(req,res)=>{
  const {name,email,type,message,rating}=req.body;
  if(!message) return res.status(400).json({error:'Message cannot be empty.'});
  const fb={id:uuidv4(),name:name||'Anonymous',email:email||'',type:type||'suggestion',
    message,rating:rating||null,status:'unread',created_at:new Date().toISOString()};
  pushNotif({
    audience:'admin', type:'info',
    title:'New feedback: '+(type||'suggestion'),
    message:`${fb.name}: ${message.slice(0,80)}${message.length>80?'...':''}`,
    link:'/admin#feedback',
  });
  if(USE_SB){const{data,error}=await supabase.from('feedback').insert(fb).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json({ok:true,data});}
  const db=unreachableLocalStoreRead(); if(!db.feedback)db.feedback=[]; db.feedback.unshift(fb); unreachableLocalStoreWrite(db);
  res.json({ok:true,data:fb});
});
app.put('/api/feedback/:id/read',requireAdmin,async(req,res)=>{
  if(USE_SB){await supabase.from('feedback').update({status:'read'}).eq('id',req.params.id); return res.json({ok:true});}
  const db=unreachableLocalStoreRead(); const i=(db.feedback||[]).findIndex(f=>f.id===req.params.id);
  if(i>=0){db.feedback[i].status='read';unreachableLocalStoreWrite(db);} res.json({ok:true});
});
app.delete('/api/feedback/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('feedback').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Feedback not found — it may already have been deleted, or you may not have permission to delete it.'});
    return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead(); db.feedback=(db.feedback||[]).filter(f=>f.id!==req.params.id); unreachableLocalStoreWrite(db); res.json({ok:true});
});

// ════════════════════════════════════════════
//  PAYMENT — MIDTRANS
// ════════════════════════════════════════════
// ── PAYMENT SAFETY HELPERS ───────────────────
// Reserve/release schedule capacity atomically in Supabase. This prevents two
// simultaneous checkouts from consuming the same last slot.
async function reserveScheduleSlot(scheduleId){
  if(!scheduleId) return true;
  if(!USE_SB) return false;
  const {data,error}=await supabase.rpc('reserve_slot',{sched_id:scheduleId});
  if(error){
    console.error('reserve_slot:',error.message);
    throw new Error('Unable to reserve this class slot. Please try again.');
  }
  return data===true || data==='true';
}

async function releaseScheduleSlot(scheduleId){
  if(!scheduleId || !USE_SB) return false;
  const {data,error}=await supabase.rpc('release_slot',{sched_id:scheduleId});
  if(error){
    console.error('release_slot:',error.message);
    return false;
  }
  return data===true || data==='true';
}

async function redeemPackageCreditAtomic(memberPackageId){
  if(!USE_SB) return false;
  const {data,error}=await supabase.rpc('redeem_package_credit',{pkg_id:memberPackageId});
  if(error){
    console.error('redeem_package_credit:',error.message);
    throw new Error('Unable to redeem the membership credit. Please try again.');
  }
  return data===true || data==='true';
}

app.post('/api/payment/create',async(req,res)=>{
  const{bookingData,amount,className}=req.body;
  if(!bookingData||!amount) return res.status(400).json({error:'Incomplete data.'});

  // A schedule row represents ONE exact calendar date. Never allow a booking
  // to silently move to another week because the old recurring-weekday logic
  // still exists in a client or stale browser.
  if(USE_SB){
    if(!bookingData.schedule_id) return res.status(400).json({error:'Schedule session is required.'});
    const { data: scheduleRow, error: scheduleErr } = await supabase
      .from('schedule')
      .select('id,session_date,time,slots')
      .eq('id', bookingData.schedule_id)
      .maybeSingle();

    if(scheduleErr) return res.status(500).json({error:'Unable to verify the selected schedule.'});
    if(!scheduleRow) return res.status(404).json({error:'This schedule session no longer exists.'});
    if(!scheduleRow.session_date) return res.status(409).json({error:'This schedule session has no exact date yet. Please choose another session.'});

    const requestedDate = String(bookingData.date || '').trim();
    const iso = String(scheduleRow.session_date);
    const requestedIso = (()=>{
      const m = requestedDate.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
      if(!m) return '';
      const months = {January:0,February:1,March:2,April:3,May:4,June:5,July:6,August:7,September:8,October:9,November:10,December:11};
      const mon = months[m[2]];
      if(mon===undefined) return '';
      return `${m[3]}-${String(mon+1).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`;
    })();

    if(requestedIso && requestedIso !== iso){
      return res.status(409).json({error:'The selected booking date does not match this schedule session. Please refresh the schedule and try again.'});
    }

    if(Number(scheduleRow.slots) <= 0) return res.status(409).json({error:'This class is already full.'});
    bookingData.date = requestedIso === iso ? requestedDate : new Date(iso+'T00:00:00').toLocaleDateString('en-US',{day:'numeric',month:'long',year:'numeric'});
    bookingData.time = scheduleRow.time;
  }
  const orderId='AVAIA-'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();

  // If a valid member session is present, that identity is authoritative for credit
  // purposes — never trust a client-claimed member_id/email for spending someone
  // else's package credit. Guests (no token) simply have no credits to redeem.
  const verifiedMember = getSoftMemberAuth(req);
  if(verifiedMember){
    bookingData.member_id = verifiedMember.id;
    bookingData.email = verifiedMember.email;
  }

  // If the member has an active package with a credit available, the booking
  // is confirmed immediately and NO Midtrans payment is created.
  const activePkg = verifiedMember ? await getActivePackage(bookingData.member_id, bookingData.email) : null;

  // Reserve the exact schedule slot BEFORE creating the pending transaction.
  // This makes capacity safe under concurrent checkout attempts.
  let slotReserved=false;
  try {
    slotReserved = await reserveScheduleSlot(bookingData.schedule_id);
    if(!slotReserved) return res.status(409).json({error:'This class is already full. Please choose another session.'});
  } catch(e) {
    return res.status(503).json({error:e.message});
  }

  const pending={
    id:orderId,...bookingData,status:'pending',amount:activePkg?0:amount,
    slot_reserved:true,slot_released:false,created_at:new Date().toISOString()
  };

  if(USE_SB){
    const {error:pendingErr}=await supabase.from('pending_bookings').insert(pending);
    if(pendingErr){
      await releaseScheduleSlot(bookingData.schedule_id);
      return res.status(500).json({error:'Unable to create the payment transaction. Please try again.'});
    }
  } else {
    unreachableLocalStoreRead();
  }

  // Existing membership credit: finalize immediately without any payment gateway.
  if(activePkg){
    try{
      const confirmed=await confirmBooking(orderId,'package_credit',activePkg.id);
      const remaining=Math.max(0,(activePkg.credits_total||0)-(activePkg.credits_used||0)-1);
      return res.json({ok:true,orderId,redeemed:true,booking:confirmed,creditsLeft:remaining,packageName:activePkg.package_name});
    }catch(e){
      await cancelBooking(orderId,'package_credit_error');
      return res.status(500).json({error:e.message});
    }
  }

  if(!USE_MT) return res.json({ok:true,orderId,token:null,simulated:true});

  try{
    const param={
      transaction_details:{order_id:orderId,gross_amount:amount},
      item_details:[{id:bookingData.schedule_id||'class',price:amount,quantity:1,name:className||bookingData.class}],
      customer_details:{
        first_name:bookingData.name.split(' ')[0],
        last_name:bookingData.name.split(' ').slice(1).join(' '),
        email:bookingData.email,phone:bookingData.phone
      },
      callbacks:{
        finish:`${req.protocol}://${req.get('host')}/payment/finish`,
        error:`${req.protocol}://${req.get('host')}/payment/error`,
        pending:`${req.protocol}://${req.get('host')}/payment/pending`,
      }
    };
    const txn=await snap.createTransaction(param);
    res.json({ok:true,orderId,token:txn.token,redirectUrl:txn.redirect_url});
  }catch(e){
    console.error('Midtrans:',e.message);
    await cancelBooking(orderId,'payment_create_error');
    res.status(500).json({error:e.message});
  }
});

app.post('/api/payment/notification',async(req,res)=>{
  try{
    let n=req.body;
    if(USE_MT){
      const midtrans=require('midtrans-client');
      const core=new midtrans.CoreApi({isProduction:MT_ENV==='production',serverKey:MT_SERVER});
      n=await core.transaction.notification(req.body);
    }
    const{order_id,transaction_status,fraud_status,payment_type}=n;
    const ok=(transaction_status==='capture'&&fraud_status==='accept')||transaction_status==='settlement';
    const isPackage=order_id&&order_id.startsWith('AVAIA-PKG-');
    if(ok) await (isPackage?confirmPackagePurchase(order_id,payment_type||'midtrans'):confirmBooking(order_id,payment_type||'midtrans'));
    else if(['deny','cancel','expire'].includes(transaction_status)) await (isPackage?cancelPackagePurchase(order_id,transaction_status):cancelBooking(order_id,transaction_status));
    res.json({ok:true});
  }catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/payment/simulate',async(req,res)=>{
  const{orderId}=req.body;
  if(!orderId) return res.status(400).json({error:'orderId required'});
  try{const b=await confirmBooking(orderId,'simulated'); res.json({ok:true,booking:b});}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/payment/status/:orderId',async(req,res)=>{
  if(!USE_SB) return res.status(503).json({error:'Supabase is required.'});
  const orderId=req.params.orderId;
  const isPackage=orderId.startsWith('AVAIA-PKG-');

  if(isPackage){
    const {data:pkg}=await supabase.from('member_packages').select('*').eq('payment_order_id',orderId).maybeSingle();
    if(pkg) return res.json({status:'active',package:pkg});
    const {data:pendingPkg}=await supabase.from('pending_package_purchases').select('*').eq('id',orderId).maybeSingle();
    if(pendingPkg) return res.json({status:pendingPkg.status,package:pendingPkg});
    return res.status(404).json({error:'Membership payment not found'});
  }

  let {data:b}=await supabase.from('bookings').select('*').eq('id',orderId).maybeSingle();
  if(!b){ const pending=await supabase.from('pending_bookings').select('*').eq('id',orderId).maybeSingle(); b=pending.data; }
  if(!b) return res.status(404).json({error:'Booking payment not found'});
  res.json({status:b.status,booking:b});
});

// ════════════════════════════════════════════
//  MEMBERSHIP PACKAGE PURCHASE
// ════════════════════════════════════════════
app.post('/api/membership-purchase/create',requireMember,async(req,res)=>{
  const{memberPhone,packageId}=req.body;
  const memberId=req.user.id, memberEmail=req.user.email, memberName=req.user.name;
  if(!packageId) return res.status(400).json({error:'Incomplete data.'});

  let pkg;
  if(USE_SB){ const{data}=await supabase.from('memberships').select('*').eq('id',packageId).single(); pkg=data; }
  else pkg=(unreachableLocalStoreRead().memberships||[]).find(m=>m.id===packageId);
  if(!pkg) return res.status(404).json({error:'Package not found.'});

  const orderId='AVAIA-PKG-'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
  const pending={
    id:orderId, member_id:memberId||null, member_email:memberEmail, member_name:memberName||'',
    member_phone:memberPhone||'', package_id:pkg.id, package_name:pkg.name,
    price:pkg.price, credits_total:pkg.credits||1, validity_days:pkg.validity_days||30,
    status:'pending', created_at:new Date().toISOString(),
  };
  if(USE_SB){
    const {error:pendingErr}=await supabase.from('pending_package_purchases').insert(pending);
    if(pendingErr) return res.status(500).json({error:'Unable to create the membership payment transaction.'});
  } else {
    unreachableLocalStoreRead();
  }

  if(!USE_MT) return res.json({ok:true,orderId,token:null,simulated:true});

  try{
    const param={
      transaction_details:{order_id:orderId,gross_amount:pkg.price},
      item_details:[{id:pkg.id,price:pkg.price,quantity:1,name:pkg.name}],
      customer_details:{
        first_name:(memberName||'').split(' ')[0]||memberEmail,
        last_name:(memberName||'').split(' ').slice(1).join(' '),
        email:memberEmail,phone:memberPhone
      },
      callbacks:{
        finish:`${req.protocol}://${req.get('host')}/payment/finish`,
        error:`${req.protocol}://${req.get('host')}/payment/error`,
        pending:`${req.protocol}://${req.get('host')}/payment/pending`,
      }
    };
    const txn=await snap.createTransaction(param);
    res.json({ok:true,orderId,token:txn.token,redirectUrl:txn.redirect_url});
  }catch(e){
    console.error('Midtrans:',e.message);
    await cancelPackagePurchase(orderId,'payment_create_error');
    res.status(500).json({error:e.message});
  }
});

app.post('/api/membership-purchase/simulate',async(req,res)=>{
  const{orderId}=req.body;
  if(!orderId) return res.status(400).json({error:'orderId required'});
  try{const p=await confirmPackagePurchase(orderId,'simulated'); res.json({ok:true,package:p});}
  catch(e){res.status(500).json({error:e.message});}
});

// Packages belonging to the logged-in member (for dashboard + booking eligibility display)
app.get('/api/my-packages',requireMember,async(req,res)=>{
  const pkgs=await getMemberPackages(req.user.id,req.user.email);
  res.json(pkgs);
});

// All member packages, for admin overview (Members panel)
app.get('/api/member-packages',requireAdmin,async(req,res)=>{
  let all;
  if(USE_SB){ const{data}=await supabase.from('member_packages').select('*'); all=data||[]; }
  else all=unreachableLocalStoreRead().memberPackages||[];
  res.json(all.map(p=>({...p,computed_status:computePkgStatus(p)})));
});

// Admin manual membership assignment for offline / in-studio sales.
app.post('/api/member-packages/manual',requireAdmin,async(req,res)=>{
  if(!USE_SB) return res.status(503).json({error:'Supabase is required for manual membership assignment.'});
  try{
    const {member_id, package_id, start_date, price_paid, credits_total, validity_days, payment_type}=req.body||{};
    if(!member_id || !package_id) return res.status(400).json({error:'Member and membership package are required.'});

    const {data:member,error:memberErr}=await supabase
      .from('members').select('id,name,email,phone,status').eq('id',member_id).maybeSingle();
    if(memberErr) return res.status(500).json({error:memberErr.message});
    if(!member) return res.status(404).json({error:'Member not found.'});

    const {data:pkg,error:pkgErr}=await supabase
      .from('memberships').select('*').eq('id',package_id).maybeSingle();
    if(pkgErr) return res.status(500).json({error:pkgErr.message});
    if(!pkg) return res.status(404).json({error:'Membership package not found.'});

    const start=new Date(start_date ? `${start_date}T00:00:00` : new Date().toISOString());
    if(Number.isNaN(start.getTime())) return res.status(400).json({error:'Invalid start date.'});

    const credits=Math.max(1,parseInt(credits_total,10)||parseInt(pkg.credits,10)||1);
    const validity=Math.max(1,parseInt(validity_days,10)||parseInt(pkg.validity_days,10)||30);
    const expires=new Date(start.getTime()+validity*24*60*60*1000);
    const price=(price_paid===''||price_paid==null)?(parseInt(pkg.price,10)||0):Math.max(0,parseInt(price_paid,10)||0);
    const payment=String(payment_type||'manual').trim()||'manual';

    const record={
      id:uuidv4(),
      member_id:member.id,
      member_email:member.email,
      member_name:member.name,
      package_name:pkg.name,
      price_paid:price,
      credits_total:credits,
      credits_used:0,
      payment_type:payment,
      purchased_at:start.toISOString(),
      expires_at:expires.toISOString(),
      status:'active',
      package_id:pkg.id,
      source:'admin_manual'
    };

    const {data:inserted,error:insertErr}=await supabase.from('member_packages').insert(record).select('*').single();
    if(insertErr){
      // Postgres 42703 = undefined_column. This endpoint writes package_id/source,
      // which only exist after migrations/009_manual_membership_admin.sql has been
      // run in Supabase. Surface that directly instead of a generic DB message.
      if(insertErr.code==='42703' || /column .* does not exist/i.test(insertErr.message||'')){
        return res.status(500).json({error:'Database is missing required columns for this feature. In your Supabase project, open SQL Editor and run migrations/009_manual_membership_admin.sql, then try again.'});
      }
      return res.status(500).json({error:insertErr.message});
    }

    const {error:updateErr}=await supabase.from('members').update({membership_type:pkg.name}).eq('id',member.id);
    if(updateErr) console.error('Manual membership member update:',updateErr.message);

    try{
      await supabase.from('notifications').insert({
        id:uuidv4(), title:'Manual membership added',
        message:`${member.name} received ${pkg.name} manually.`,
        type:'membership', read:false, created_at:new Date().toISOString()
      });
    }catch(e){}

    res.json({ok:true,package:{...inserted,computed_status:computePkgStatus(inserted)}});
  }catch(e){
    console.error('Manual membership:',e);
    res.status(500).json({error:e.message});
  }
});

// ── MEMBERSHIP PACKAGE CREDITS — helpers ──────
function computePkgStatus(pkg){
  const now=new Date();
  const expired = pkg.expires_at && now > new Date(pkg.expires_at);
  const depleted = (pkg.credits_used||0) >= (pkg.credits_total||0);
  if(expired) return 'expired';
  if(depleted) return 'depleted';
  return 'active';
}

async function getMemberPackages(memberId, email){
  let all;
  if(USE_SB){
    let q=supabase.from('member_packages').select('*');
    if(memberId && email) q=q.or(`member_id.eq.${memberId},member_email.eq.${email}`);
    else if(memberId) q=q.eq('member_id',memberId);
    else if(email) q=q.eq('member_email',email);
    const{data,error}=await q;
    if(error){ console.error('getMemberPackages:',error.message); all=[]; }
    else all=data||[];
  } else {
    all=(unreachableLocalStoreRead().memberPackages||[]).filter(p=>(memberId&&p.member_id===memberId)||(email&&p.member_email===email));
  }
  return all
    .map(p=>({...p,computed_status:computePkgStatus(p)}))
    .sort((a,b)=>new Date(a.expires_at)-new Date(b.expires_at));
}

// Returns the active package that expires soonest (use-it-or-lose-it order), or null.
async function getActivePackage(memberId, email){
  if(!memberId && !email) return null;
  const pkgs = await getMemberPackages(memberId, email);
  return pkgs.find(p=>p.computed_status==='active') || null;
}

async function redeemPackageCredit(memberPackageId){
  if(!memberPackageId) return true;
  const ok=await redeemPackageCreditAtomic(memberPackageId);
  if(!ok) throw new Error('This membership has no remaining class credits or has expired.');
  return true;
}

async function refundPackageCredit(memberPackageId){
  if(!memberPackageId) return false;
  if(USE_SB){
    const {data,error}=await supabase.rpc('refund_package_credit',{pkg_id:memberPackageId});
    if(error){
      console.error('refund_package_credit:',error.message);
      return false;
    }
    return data===true || data==='true';
  }
  unreachableLocalStoreRead();
  return false;
}

async function sendConfirmEmailWithInvoice(confirmed, studioName, settings){
  if(!confirmed.email) return;
  try{
    const t=emailBookingConfirm(confirmed,studioName);
    const pdfBuf=await generateInvoicePDF(confirmed,settings);
    sendMail({to:confirmed.email,...t,attachments:[{filename:`invoice-${confirmed.id}.pdf`,content:pdfBuf}]})
      .catch(e=>console.error('Email:',e.message));
  }catch(e){ console.error('Invoice/email error:',e.message); }
}

async function confirmBooking(orderId,paymentType,memberPackageId=null){
  if(!USE_SB) throw new Error('Supabase is required for payment confirmation.');

  // Idempotency: Midtrans may send the same settlement notification more than once.
  // If the booking is already final, return it without decrementing slots again.
  const {data:existing,error:existingErr}=await supabase
    .from('bookings').select('*').eq('id',orderId).maybeSingle();
  if(existingErr) throw new Error(existingErr.message);
  if(existing){
    if(memberPackageId && !existing.package_credit_redeemed){
      await redeemPackageCredit(memberPackageId);
      await supabase.from('bookings').update({package_credit_redeemed:true}).eq('id',orderId);
      existing.package_credit_redeemed=true;
    }
    return existing;
  }

  const {data:pending,error:pendingErr}=await supabase
    .from('pending_bookings').select('*').eq('id',orderId).maybeSingle();
  if(pendingErr) throw new Error(pendingErr.message);
  if(!pending) throw new Error('Pending booking not found: '+orderId);

  const confirmed={
    ...pending,
    status:'confirmed',
    payment_type:paymentType,
    paid_at:new Date().toISOString(),
    package_credit_redeemed:false
  };
  delete confirmed.slot_reserved;
  delete confirmed.slot_released;

  if(memberPackageId) confirmed.member_package_id=memberPackageId;

  const {data:inserted,error:insertErr}=await supabase
    .from('bookings').insert(confirmed).select('*').single();

  if(insertErr){
    // Another webhook/process may have inserted the same order a moment ago.
    const {data:race}=await supabase.from('bookings').select('*').eq('id',orderId).maybeSingle();
    if(race){
      if(memberPackageId && !race.package_credit_redeemed){
        await redeemPackageCredit(memberPackageId);
        await supabase.from('bookings').update({package_credit_redeemed:true}).eq('id',orderId);
        race.package_credit_redeemed=true;
      }
      return race;
    }
    throw new Error('Unable to finalize booking: '+insertErr.message);
  }

  // New flow reserves the slot during checkout. Legacy pending rows may not have
  // a reservation, so reserve those here as a backward-compatible fallback.
  if(!pending.slot_reserved && pending.schedule_id){
    const ok=await reserveScheduleSlot(pending.schedule_id);
    if(!ok){
      await supabase.from('bookings').delete().eq('id',orderId);
      throw new Error('The selected class is full. Payment was not finalized as a booking.');
    }
  }

  if(memberPackageId){
    try{
      await redeemPackageCredit(memberPackageId);
      await supabase.from('bookings').update({package_credit_redeemed:true}).eq('id',orderId);
      inserted.package_credit_redeemed=true;
    }catch(e){
      // Remove the booking so a retriable failure cannot create a confirmed
      // booking without actually consuming the membership credit.
      await supabase.from('bookings').delete().eq('id',orderId);
      if(pending.schedule_id && pending.slot_reserved) await releaseScheduleSlot(pending.schedule_id);
      throw e;
    }
  }

  // Delete pending only AFTER the final row exists. If deletion fails, a retry
  // will see the final booking and remain idempotent.
  const {error:deleteErr}=await supabase.from('pending_bookings').delete().eq('id',orderId);
  if(deleteErr) console.error('pending booking cleanup:',deleteErr.message);

  const {data:settingsData}=await supabase.from('settings').select('*').eq('id',1).single();
  const settings=settingsData||{};
  sendConfirmEmailWithInvoice(inserted,settings.studioName||'Avaia Studio',settings);

  broadcastScheduleUpdate();
  pushNotif({
    audience:'admin', type:'booking',
    title:'New booking confirmed',
    message:`${inserted.name} booked ${inserted.class} on ${inserted.date} ${inserted.time}${memberPackageId?' (via package credit)':''}.`,
    link:'/admin#bookings',
  });
  if(inserted.member_id || inserted.email){
    pushNotif({
      audience:'member', memberId:inserted.member_id, memberEmail:inserted.email,
      type:'success', title:'Booking Confirmed',
      message: memberPackageId
        ? `${inserted.class} — ${inserted.date} at ${inserted.time}. 1 class credit used.`
        : `${inserted.class} — ${inserted.date} at ${inserted.time}. Your invoice is ready to download.`,
      link:'/dashboard',
    });
  }
  return inserted;
}

async function cancelBooking(orderId,reason){
  if(!USE_SB) throw new Error('Supabase is required for payment cancellation.');
  const {data:pending,error}=await supabase.from('pending_bookings').select('*').eq('id',orderId).maybeSingle();
  if(error) throw new Error(error.message);
  if(!pending) return;
  if(String(pending.status||'pending').startsWith('cancelled_')) return pending;

  let released = !!pending.slot_released;
  if(pending.slot_reserved && !released && pending.schedule_id){
    released = await releaseScheduleSlot(pending.schedule_id);
    if(!released) throw new Error('The class slot could not be released safely. Please retry the cancellation.');
  }
  const {data:updated,error:updateErr}=await supabase
    .from('pending_bookings')
    .update({status:'cancelled_'+reason,slot_released:released})
    .eq('id',orderId)
    .select('*').maybeSingle();
  if(updateErr) throw new Error(updateErr.message);
  return updated||pending;
}

// ── MEMBERSHIP PACKAGE PURCHASE — confirm/cancel ──
async function confirmPackagePurchase(orderId,paymentType){
  if(!USE_SB) throw new Error('Supabase is required for membership purchase confirmation.');

  // Idempotency: the same Midtrans settlement notification may arrive multiple times.
  const {data:existing,error:existingErr}=await supabase
    .from('member_packages').select('*').eq('payment_order_id',orderId).maybeSingle();
  if(existingErr) throw new Error(existingErr.message);
  if(existing){
    if(existing.member_id){
      await supabase.from('members').update({membership_type:existing.package_name}).eq('id',existing.member_id);
    }
    return existing;
  }

  const {data:pending,error:pendingErr}=await supabase
    .from('pending_package_purchases').select('*').eq('id',orderId).maybeSingle();
  if(pendingErr) throw new Error(pendingErr.message);
  if(!pending) throw new Error('Pending package purchase not found: '+orderId);

  const now=new Date();
  const expires=new Date(now.getTime()+(pending.validity_days||30)*24*60*60*1000);
  const purchased={
    id:uuidv4(),
    payment_order_id:orderId,
    member_id:pending.member_id,
    member_email:pending.member_email,
    member_name:pending.member_name,
    package_name:pending.package_name,
    price_paid:pending.price,
    credits_total:pending.credits_total,
    credits_used:0,
    payment_type:paymentType,
    purchased_at:now.toISOString(),
    expires_at:expires.toISOString(),
    status:'active',
  };

  const {data:inserted,error:insertErr}=await supabase
    .from('member_packages').insert(purchased).select('*').single();
  if(insertErr){
    const {data:race}=await supabase.from('member_packages').select('*').eq('payment_order_id',orderId).maybeSingle();
    if(race) return race;
    throw new Error('Unable to activate membership: '+insertErr.message);
  }

  if(inserted.member_id){
    const {error:memberErr}=await supabase.from('members')
      .update({membership_type:inserted.package_name}).eq('id',inserted.member_id);
    if(memberErr) console.error('membership_type update:',memberErr.message);
  }

  const {error:deleteErr}=await supabase.from('pending_package_purchases').delete().eq('id',orderId);
  if(deleteErr) console.error('pending package cleanup:',deleteErr.message);

  const {data:settingsData}=await supabase.from('settings').select('*').eq('id',1).single();
  const settings=settingsData||{};

  // Invoice + email are best-effort and NEVER determine whether the payment was recorded.
  try{
    const invoiceLike={
      id:inserted.id, order_id:orderId, name:inserted.member_name, email:inserted.member_email,
      class:inserted.package_name+' (Membership Package)',
      date:now.toLocaleDateString('en-US',{day:'numeric',month:'long',year:'numeric'}),
      time:'—', amount:inserted.price_paid, payment_type:inserted.payment_type, status:'confirmed',
      note:`${inserted.credits_total} class credits · valid until ${new Date(inserted.expires_at).toLocaleDateString('en-US',{day:'numeric',month:'long',year:'numeric'})}`,
      paid_at:inserted.purchased_at, created_at:inserted.purchased_at,
    };
    if(inserted.member_email){
      const t=emailBookingConfirm(invoiceLike,settings.studioName||'Avaia Studio');
      const pdfBuf=await generateInvoicePDF(invoiceLike,settings);
      sendMail({to:inserted.member_email,...t,attachments:[{filename:`invoice-${inserted.id}.pdf`,content:pdfBuf}]})
        .catch(e=>console.error('Email:',e.message));
    }
  }catch(e){ console.error('Package invoice/email error:',e.message); }

  pushNotif({
    audience:'admin', type:'booking',
    title:'New package purchased',
    message:`${inserted.member_name} purchased ${inserted.package_name} (${inserted.credits_total} classes).`,
    link:'/admin#members',
  });
  pushNotif({
    audience:'member', memberId:inserted.member_id, memberEmail:inserted.member_email,
    type:'success', title:'Package Purchased',
    message:`${inserted.package_name} is now active — ${inserted.credits_total} class credits, valid until ${new Date(inserted.expires_at).toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric'})}.`,
    link:'/dashboard',
  });
  return inserted;
}

async function cancelPackagePurchase(orderId,reason){
  if(!USE_SB) throw new Error('Supabase is required for membership payment cancellation.');
  const {data:pending,error}=await supabase.from('pending_package_purchases').select('*').eq('id',orderId).maybeSingle();
  if(error) throw new Error(error.message);
  if(!pending) return;
  if(String(pending.status||'pending').startsWith('cancelled_')) return pending;
  const {data:updated,error:updateErr}=await supabase
    .from('pending_package_purchases')
    .update({status:'cancelled_'+reason})
    .eq('id',orderId).select('*').maybeSingle();
  if(updateErr) throw new Error(updateErr.message);
  return updated||pending;
}


// ════════════════════════════════════════════
//  MEMBER CANCEL BOOKING (self-service)
// ════════════════════════════════════════════
app.delete('/api/my-bookings/:id',requireMember,async(req,res)=>{
  const email=req.user.email;
  let booking;
  if(USE_SB){
    const{data}=await supabase.from('bookings').select('*').eq('id',req.params.id).single();
    booking=data;
  } else { const db=unreachableLocalStoreRead(); booking=db.bookings.find(b=>b.id===req.params.id); }
  if(!booking) return res.status(404).json({error:'Booking not found.'});
  if(booking.email!==email) return res.status(403).json({error:'You cannot cancel someone else\'s booking.'});
  if(booking.status==='cancelled') return res.status(400).json({error:'This booking has already been cancelled.'});
  // Check at least 2 hours before class
  const MONTHS={'January':0,'February':1,'March':2,'April':3,'May':4,'June':5,'July':6,'August':7,'September':8,'October':9,'November':10,'December':11};
  try{
    const parts=booking.date.split(' ');
    const [h,m]=(booking.time||'00.00').split('.').map(Number);
    const classTime=new Date(parseInt(parts[2]),MONTHS[parts[1]],parseInt(parts[0]),h||0,m||0);
    if(new Date()>new Date(classTime.getTime()-2*60*60*1000))
      return res.status(400).json({error:'Cannot cancel less than 2 hours before class. Please contact the studio directly.'});
  }catch(e){}
  if(USE_SB){
    const {error:updateErr}=await supabase.from('bookings').update({status:'cancelled',cancelled_at:new Date().toISOString()}).eq('id',req.params.id);
    if(updateErr) return res.status(500).json({error:updateErr.message});
    if(booking.schedule_id){
      const {error:slotErr}=await supabase.rpc('release_slot',{sched_id:booking.schedule_id});
      if(slotErr) console.error('release_slot on cancellation:',slotErr.message);
    }
  } else {
    const db=unreachableLocalStoreRead();
    const bi=db.bookings.findIndex(b=>b.id===req.params.id);
    if(bi>=0){db.bookings[bi].status='cancelled';db.bookings[bi].cancelled_at=new Date().toISOString();}
    if(booking.schedule_id){const si=db.schedule.findIndex(s=>s.id===booking.schedule_id);if(si>=0)db.schedule[si].slots++;}
    unreachableLocalStoreWrite(db);
  }
  if(booking.payment_type==='package_credit' && booking.member_package_id){
    await refundPackageCredit(booking.member_package_id);
  }
  if(booking.email){
    let studioName='Avaia Studio';
    if(USE_SB){ const {data:settings}=await supabase.from('settings').select('studioName').eq('id',1).single(); studioName=settings?.studioName||studioName; }
    const t=emailCancellation(booking,studioName);
    sendMail({to:booking.email,...t}).catch(e=>console.error('Email:',e.message));
  }
  broadcastScheduleUpdate();
  pushNotif({
    audience:'admin', type:'warning',
    title:'Booking cancelled by member',
    message:`${booking.name} cancelled ${booking.class} on ${booking.date} ${booking.time}.`,
    link:'/admin#bookings',
  });
  res.json({ok:true,message:'Booking cancelled successfully.'});
});

// ════════════════════════════════════════════
//  REMINDER EMAIL (admin trigger or cron)
// ════════════════════════════════════════════
app.post('/api/reminders/send',requireAdmin,async(req,res)=>{
  if(!USE_EMAIL) return res.json({ok:false,reason:'Email is not configured in .env'});
  let bookings;
  if(USE_SB){
    const{data}=await supabase.from('bookings').select('*').eq('status','confirmed'); bookings=data||[];
  } else { const db=unreachableLocalStoreRead(); bookings=(db.bookings||[]).filter(b=>b.status==='confirmed'); }
  let studioName='Avaia Studio';
  if(USE_SB){ const {data:settings}=await supabase.from('settings').select('studioName').eq('id',1).single(); studioName=settings?.studioName||studioName; }
  let sent=0,failed=0;
  for(const b of bookings){
    if(!b.email||b.reminder_sent) continue;
    try{
      const t=emailBookingReminder(b,studioName);
      const r=await sendMail({to:b.email,...t});
      if(r.ok){
        if(!USE_SB){
          const ldb=unreachableLocalStoreRead(); const i=ldb.bookings.findIndex(x=>x.id===b.id);
          if(i>=0){ldb.bookings[i].reminder_sent=true;unreachableLocalStoreWrite(ldb);}
        }
        sent++;
      } else failed++;
    }catch(e){ failed++; }
  }
  res.json({ok:true,sent,failed});
});

// ════════════════════════════════════════════
//  MONTHLY REPORTS
// ════════════════════════════════════════════
app.get('/api/reports/monthly',requireAdmin,async(req,res)=>{
  const y=parseInt(req.query.year)||new Date().getFullYear();
  const m=parseInt(req.query.month)||new Date().getMonth()+1;
  let bookings;
  if(USE_SB){const{data}=await supabase.from('bookings').select('*'); bookings=data||[];}
  else bookings=unreachableLocalStoreRead().bookings||[];
  const filtered=bookings.filter(b=>{if(!b.created_at)return false;const d=new Date(b.created_at);return d.getFullYear()===y&&d.getMonth()+1===m;});
  const confirmed=filtered.filter(b=>b.status==='confirmed');
  const revenue=confirmed.reduce((s,b)=>s+(parseInt(b.amount)||0),0);
  const classCounts={};
  confirmed.forEach(b=>{classCounts[b.class]=(classCounts[b.class]||0)+1;});
  const topClasses=Object.entries(classCounts).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([name,count])=>({name,count}));
  const byDay={};
  confirmed.forEach(b=>{const d=b.created_at?new Date(b.created_at).toISOString().split('T')[0]:'';if(!d)return;if(!byDay[d])byDay[d]={date:d,bookings:0,revenue:0};byDay[d].bookings++;byDay[d].revenue+=(parseInt(b.amount)||0);});
  res.json({period:{year:y,month:m},summary:{totalBookings:filtered.length,confirmed:confirmed.length,cancelled:filtered.filter(b=>b.status==='cancelled').length,revenue},topClasses,dailyData:Object.values(byDay).sort((a,b)=>a.date.localeCompare(b.date))});
});

app.get('/api/reports/monthly/excel',requireAdmin,async(req,res)=>{
  const MONTH_NAMES=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const y=parseInt(req.query.year)||new Date().getFullYear();
  const m=parseInt(req.query.month)||new Date().getMonth()+1;
  let bookings;
  if(USE_SB){const{data}=await supabase.from('bookings').select('*'); bookings=data||[];}
  else bookings=unreachableLocalStoreRead().bookings||[];
  const filtered=bookings.filter(b=>{if(!b.created_at)return false;const d=new Date(b.created_at);return d.getFullYear()===y&&d.getMonth()+1===m;});
  const wb=XLSX.utils.book_new();
  const ws1=XLSX.utils.json_to_sheet(filtered.map(b=>({'Name':b.name,'Email':b.email,'Class':b.class,'Date':b.date,'Time':b.time,'Price':b.amount||0,'Status':b.status,'Created':b.created_at?new Date(b.created_at).toLocaleString('en-US'):''})));
  XLSX.utils.book_append_sheet(wb,ws1,'Booking Details');
  const confirmed=filtered.filter(b=>b.status==='confirmed');
  const ws2=XLSX.utils.json_to_sheet([{Metric:'Period',Value:`${MONTH_NAMES[m-1]} ${y}`},{Metric:'Total Bookings',Value:filtered.length},{Metric:'Confirmed',Value:confirmed.length},{Metric:'Cancelled',Value:filtered.filter(b=>b.status==='cancelled').length},{Metric:'Total Revenue',Value:`IDR ${confirmed.reduce((s,b)=>s+(parseInt(b.amount)||0),0).toLocaleString('en-US')}`}]);
  XLSX.utils.book_append_sheet(wb,ws2,'Summary');
  const buf=XLSX.write(wb,{type:'buffer',bookType:'xlsx'});
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="report-${MONTH_NAMES[m-1].toLowerCase()}-${y}.xlsx"`);
  res.send(buf);
});

// ════════════════════════════════════════════
//  ADMIN STATISTICS — FULL
// ════════════════════════════════════════════
app.get('/api/stats/admin',requireAdmin,async(req,res)=>{
  let bookings,members,classes,schedule,memberPackages;
  if(USE_SB){
    const [b,m,c,s,p]=await Promise.all([
      supabase.from('bookings').select('*'),
      supabase.from('members').select('*'),
      supabase.from('classes').select('*'),
      supabase.from('schedule').select('*'),
      supabase.from('member_packages').select('*'),
    ]);
    bookings=b.data||[]; members=m.data||[]; classes=c.data||[]; schedule=s.data||[]; memberPackages=p.data||[];
  } else {
    const db=unreachableLocalStoreRead();
    bookings=db.bookings||[]; members=db.members||[]; classes=db.classes||[]; schedule=db.schedule||[]; memberPackages=db.memberPackages||[];
  }
  try{
    res.json(buildAdminStats({bookings,members,classes,schedule,memberPackages}));
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ════════════════════════════════════════════
//  INVOICE PDF
// ════════════════════════════════════════════
app.get('/api/invoice/:id',async(req,res)=>{
  let booking, isPackage=false;
  if(USE_SB){
    const{data}=await supabase.from('bookings').select('*').eq('id',req.params.id).single();
    booking=data;
  } else { booking=(unreachableLocalStoreRead().bookings||[]).find(b=>b.id===req.params.id); }

  // Not a class booking? Check if it's a membership package purchase instead.
  if(!booking){
    let pkg;
    if(USE_SB){ const{data}=await supabase.from('member_packages').select('*').eq('id',req.params.id).single(); pkg=data; }
    else { pkg=(unreachableLocalStoreRead().memberPackages||[]).find(p=>p.id===req.params.id); }
    if(pkg){
      isPackage=true;
      booking={
        id:pkg.id, name:pkg.member_name, email:pkg.member_email,
        class:pkg.package_name+' (Membership Package)',
        date:new Date(pkg.purchased_at).toLocaleDateString('en-US',{day:'numeric',month:'long',year:'numeric'}),
        time:'—', amount:pkg.price_paid, payment_type:pkg.payment_type, status:'confirmed',
        note:`${pkg.credits_total} class credits · valid until ${new Date(pkg.expires_at).toLocaleDateString('en-US',{day:'numeric',month:'long',year:'numeric'})}`,
        paid_at:pkg.purchased_at, created_at:pkg.purchased_at,
      };
    }
  }
  if(!booking) return res.status(404).json({error:'Invoice not found.'});

  // Access requires a valid session token — either staff (any invoice) or the
  // owning member (only their own). Plain ?email= is no longer trusted on its own,
  // since anyone could type in someone else's email.
  let authorized=false;
  const authHdr=req.headers.authorization;
  const tokenFromQuery=req.query.token;
  const rawToken=authHdr?authHdr.replace('Bearer ',''):tokenFromQuery;
  if(rawToken){
    try{
      const dec=jwt.verify(rawToken,JWT_SECRET);
      if(['admin','instructor'].includes(dec.role)) authorized=true;
      else if(dec.role==='member' && dec.email===booking.email) authorized=true;
    }catch(e){}
  }
  if(!authorized) return res.status(403).json({error:'You are not allowed to access this invoice.'});

  try{
    const settings=USE_SB?(await supabase.from('settings').select('*').single()).data||{}:(unreachableLocalStoreRead().settings||{});
    const buf=await generateInvoicePDF(booking,settings);
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`inline; filename="invoice-${booking.id}.pdf"`);
    res.send(buf);
  }catch(e){ res.status(500).json({error:'Failed to generate invoice: '+e.message}); }
});

// ════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════
app.get('/api/notifications',requireMember,async(req,res)=>{
  let all;
  if(USE_SB){ const{data}=await supabase.from('notifications').select('*').order('created_at',{ascending:false}); all=data||[]; }
  else all=unreachableLocalStoreRead().notifications||[];
  const mine=all.filter(n=>n.audience==='member' && ((req.user.id&&n.memberId===req.user.id)||(req.user.email&&n.memberEmail===req.user.email)));
  res.json(mine.slice(0,50));
});

app.get('/api/notifications/admin',requireStaff,async(req,res)=>{
  let all;
  if(USE_SB){ const{data}=await supabase.from('notifications').select('*').order('created_at',{ascending:false}); all=data||[]; }
  else all=unreachableLocalStoreRead().notifications||[];
  res.json(all.filter(n=>n.audience==='admin').slice(0,50));
});

// Used by both member and staff UIs, so this checks whichever valid session
// token is present and only allows marking a notification the caller owns.
app.put('/api/notifications/:id/read',async(req,res)=>{
  const token=req.headers.authorization?.replace('Bearer ','');
  if(!token) return res.status(401).json({error:'Please sign in.'});
  let decoded;
  try{ decoded=jwt.verify(token,JWT_SECRET); }catch(e){ return res.status(401).json({error:'Invalid session.'}); }

  let notif;
  if(USE_SB){ const{data}=await supabase.from('notifications').select('*').eq('id',req.params.id).single(); notif=data; }
  else notif=(unreachableLocalStoreRead().notifications||[]).find(n=>n.id===req.params.id);
  if(!notif) return res.status(404).json({error:'Notification not found.'});

  const isStaff=['admin','instructor'].includes(decoded.role);
  const isOwner=decoded.role==='member' && (notif.memberId===decoded.id || notif.memberEmail===decoded.email);
  if(!((isStaff && notif.audience==='admin') || (isOwner && notif.audience==='member')))
    return res.status(403).json({error:'Not allowed.'});

  if(USE_SB){ await supabase.from('notifications').update({read:true}).eq('id',req.params.id); }
  else{ const db=unreachableLocalStoreRead(); const i=(db.notifications||[]).findIndex(n=>n.id===req.params.id); if(i>=0){db.notifications[i].read=true; unreachableLocalStoreWrite(db);} }
  res.json({ok:true});
});

app.put('/api/notifications/read-all',async(req,res)=>{
  const token=req.headers.authorization?.replace('Bearer ','');
  if(!token) return res.status(401).json({error:'Please sign in.'});
  let decoded;
  try{ decoded=jwt.verify(token,JWT_SECRET); }catch(e){ return res.status(401).json({error:'Invalid session.'}); }

  const isStaff=['admin','instructor'].includes(decoded.role);
  const isMember=decoded.role==='member';

  if(USE_SB){
    if(isStaff) await supabase.from('notifications').update({read:true}).eq('audience','admin');
    else if(isMember) await supabase.from('notifications').update({read:true}).eq('audience','member').or(`memberId.eq.${decoded.id},memberEmail.eq.${decoded.email}`);
    return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead();
  (db.notifications||[]).forEach(n=>{
    if(isStaff && n.audience==='admin') n.read=true;
    else if(isMember && n.audience==='member' && (n.memberId===decoded.id || n.memberEmail===decoded.email)) n.read=true;
  });
  unreachableLocalStoreWrite(db); res.json({ok:true});
});
const PG=path.join(__dirname,'public','pages');
app.get('/',         (req,res)=>res.sendFile('home.html', { root: PG }));
app.get('/schedule', (req,res)=>res.sendFile('schedule.html', { root: PG }));
app.get('/classes',  (req,res)=>res.sendFile('classes.html', { root: PG }));
app.get('/pricing',  (req,res)=>res.sendFile('pricing.html', { root: PG }));
app.get('/about',    (req,res)=>res.sendFile('about.html', { root: PG }));
app.get('/locate',   (req,res)=>res.sendFile('locate.html', { root: PG }));
app.get('/cancel-policy',     (req,res)=>res.sendFile('cancel-policy.html', { root: PG }));
app.get('/membership-policy', (req,res)=>res.sendFile('membership-policy.html', { root: PG }));
app.get('/booking-policy',    (req,res)=>res.sendFile('booking-policy.html', { root: PG }));
app.get('/house-rules',       (req,res)=>res.sendFile('house-rules.html', { root: PG }));
app.get('/terms',             (req,res)=>res.sendFile('terms.html', { root: PG }));
app.get('/dashboard',(req,res)=>res.sendFile('dashboard.html', { root: PG }));
app.get('/feedback', (req,res)=>res.sendFile('feedback.html', { root: PG }));
app.get('/admin',    (req,res)=>res.sendFile('admin.html', { root: PG }));
app.get('/payment/finish', (req,res)=>res.sendFile('payment-finish.html', { root: PG }));
app.get('/payment/error',  (req,res)=>res.sendFile('payment-error.html', { root: PG }));
app.get('/payment/pending',(req,res)=>res.sendFile('payment-pending.html', { root: PG }));

// 404
app.use((req,res)=>{
  if(req.path.startsWith('/api/')) return res.status(404).json({error:'Endpoint not found.'});
  res.status(404).sendFile('404.html', { root: PG });
});

async function startServer(){
  if(!USE_SB || !supabase){
    throw new Error('Supabase is required. Check SUPABASE_URL and SUPABASE_SECRET_KEY.');
  }

  // createClient() alone does not prove the database is reachable. Verify a real
  // query before accepting traffic so a bad project/key/RLS configuration is loud.
  const result = await fetchSettingsRow();
  if(result.error){
    throw new Error(`Supabase connection/query check failed: ${result.error.message}`);
  }
  if(!result.data){
    const probe = await supabase.from('settings').select('id').limit(5);
    throw new Error(
      `Supabase connection succeeded, but public.settings row id=1 was not found. ` +
      `Visible ids: ${Array.isArray(probe.data) ? probe.data.map(r=>r.id).join(',') || '(none)' : '(probe failed)'}`
    );
  }

  console.log(`✓ Supabase connected and settings verified | build=${APP_BUILD_ID} | pid=${process.pid} | host=${SUPABASE_URL.replace(/^https?:\/\//,'').split('/')[0]}`);

  app.listen(PORT,()=>{
    console.log(`\n🌿 Avaia Studio → http://localhost:${PORT}`);
    console.log(`   DB:       Supabase ☁`);
    console.log(`   Payment:  ${USE_MT?'Midtrans '+MT_ENV:'Simulation mode'}`);
    console.log(`   Email:    ${USE_EMAIL?EMAIL_USER:'Not configured'}`);
    console.log(`   Realtime: Polling (every few seconds)`);
    console.log(`   Admin:    http://localhost:${PORT}/admin\n`);
  });
}

startServer().catch(err=>{
  console.error('\n❌ Avaia Studio startup aborted:',err.message);
  console.error('   Supabase is required. No local database fallback is available.\n');
  process.exit(1);
});
