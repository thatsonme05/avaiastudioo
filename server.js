try { require('dotenv').config(); } catch(e) {}

const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const crypto   = require('crypto');
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
// Studio-side inbox for "someone booked / bought a membership" alerts.
// Comma-separated list is fine — nodemailer accepts "a@x.com, b@x.com" as-is.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim();

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
if (USE_EMAIL && !ADMIN_EMAIL) {
  console.log('ℹ ADMIN_EMAIL not set — admin will only get in-app notifications, no email, for new bookings/memberships.');
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

// Small, plain internal-alert template — this is for the studio's own inbox,
// not the customer, so it skips the branded invoice styling and just states
// the facts plus a link into the admin panel.
function emailAdminAlert({ title, rows, link, studioName='Avaia Studio' }){
  const rowsHtml = rows.map(([label,val])=>
    `<tr><td style="padding:6px 16px 6px 0;color:#7a6e68;font-size:13px;white-space:nowrap">${label}</td><td style="padding:6px 0;color:#1c1410;font-size:14px;font-weight:600">${val}</td></tr>`
  ).join('');
  const rowsText = rows.map(([label,val])=>`${label}: ${val}`).join('\n');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"></head>
<body style="font-family:Georgia,serif;background:#fdf8f6;margin:0;padding:20px">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #ddd5ca">
<div style="background:#5D3A24;padding:24px 32px"><h1 style="color:#fff;font-size:18px;margin:0;font-weight:400">${studioName} — ${title}</h1></div>
<div style="padding:28px 32px"><table style="border-collapse:collapse">${rowsHtml}</table>
${link?`<p style="margin-top:20px"><a href="${link}" style="color:#5D3A24">Open in admin panel →</a></p>`:''}
</div></div></body></html>`;
  return { subject:`${studioName} — ${title}`, html, text:`${title}\n\n${rowsText}` };
}

function notifyAdminEmail(title, rows, link){
  if(!ADMIN_EMAIL) return;
  const { subject, html, text } = emailAdminAlert({ title, rows, link });
  sendMail({ to: ADMIN_EMAIL, subject, html, text })
    .then(r => { if(!r.ok) console.error('Admin alert email failed:', r.reason); })
    .catch(e => console.error('Admin alert email error:', e.message));
}

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
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_KEY || '';
const SUPABASE_AUTH_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || SUPABASE_KEY;
let supabase = null, USE_SB = false;
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

const MT_SERVER = process.env.MIDTRANS_SERVER_KEY || '';
const MT_CLIENT = process.env.MIDTRANS_CLIENT_KEY || '';
const MT_ENV    = process.env.MIDTRANS_ENV || 'sandbox';
let snap = null, core = null, USE_MT = false;

if (MT_SERVER && !MT_SERVER.includes('xxxx')) {
  try {
    const midtrans = require('midtrans-client');
    snap   = new midtrans.Snap({ isProduction: MT_ENV==='production', serverKey: MT_SERVER, clientKey: MT_CLIENT });
    core   = new midtrans.CoreApi({ isProduction: MT_ENV==='production', serverKey: MT_SERVER, clientKey: MT_CLIENT });
    USE_MT = true;
    console.log(`✓ Midtrans ${MT_ENV} connected`);
  } catch(e) { console.warn('Midtrans failed:', e.message); }
} else {
  console.log('ℹ Midtrans not configured — simulation mode active');
}
function unreachableLocalStoreRead() {
  throw new Error('Local database access is disabled. Supabase is required.');
}
function unreachableLocalStoreWrite() {
  throw new Error('Local database writes are disabled. Supabase is required.');
}
const notifier = createNotifier({ supabase, isSB: () => USE_SB });
const { push: pushNotif, broadcastScheduleUpdate } = notifier;

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
  max: 30,
  keyGenerator: authIdentityKey,
  skipSuccessfulRequests: true,
  message: { error: 'Too many attempts for this account. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Login (member + staff) gets its own, more forgiving limiter:
// - higher ceiling, since a confused-but-legitimate user retrying a
//   correct password (e.g. while their email was still unconfirmed)
//   shouldn't get locked out before they even find the real problem.
// - skipSuccessfulRequests, so a successful login doesn't burn down the
//   same budget as failed ones. Only genuine failed attempts count,
//   which is what brute-force protection actually cares about.
const loginLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 50,
  keyGenerator: authIdentityKey,
  skipSuccessfulRequests: true,
  message: { error: 'Too many failed login attempts for this account. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = rateLimit({
  windowMs: 1*60*1000,
  max: 200,
  message: { error: 'Too many requests. Please try again shortly.' },
});

app.use('/api/', generalLimiter);

function requireRole(allowedRoles) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    if (!token) return res.status(401).json({ error: 'Access denied. Please sign in.' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (!allowedRoles.includes(decoded.role)) {
        return res.status(403).json({ error: 'You do not have permission for this action.' });
      }
      req.user = decoded; 
      next();
    } catch(e) {
      return res.status(401).json({ error: 'Invalid session. Please sign in again.' });
    }
  };
}
const requireAdmin = requireRole(['admin']);
const requireStaff = requireRole(['admin','instructor']);
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
          let authUserGone = false;
          try {
            const { data: authCheck, error: authErr } = await supabase.auth.admin.getUserById(decoded.id);
            if (authErr && /not.*found|does not exist/i.test(authErr.message || '')) authUserGone = true;
            else if (!authErr && !authCheck?.user) authUserGone = true;
          } catch (e) {  }

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
function getSoftMemberAuth(req){
  const token=req.headers.authorization?.replace('Bearer ','');
  if(!token) return null;
  try{
    const dec=jwt.verify(token,JWT_SECRET);
    return dec.role==='member' ? dec : null;
  }catch(e){ return null; }
}
app.get('/api/status',(req,res)=>res.json({
  supabase:USE_SB, midtrans:USE_MT,
  midtransEnv:MT_ENV, midtransClientKey:MT_CLIENT||null,
  email:USE_EMAIL, emailUser:USE_EMAIL?EMAIL_USER:null
}));
const APP_BUILD_ID = 'member-login-deterministic-20260824-01';
const APP_STARTED_AT = new Date().toISOString();

async function fetchSettingsRow() {
  if(!USE_SB || !supabase){
    return { data:null, error:new Error('Supabase is not configured') };
  }
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
app.get('/api/me',requireStaff,(req,res)=>{
  res.json({ ok:true, user:req.user });
});

async function findStaffAccount(identity){
  const normalized = String(identity || '').trim().toLowerCase();
  if(!normalized || !USE_SB || !supabase) return null;
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
app.post('/api/auth/staff-login', loginLimiter, async(req,res)=>{
  const result = await authenticateStaff(req.body?.username, req.body?.password);
  return res.status(result.status).json(result);
});

app.get('/api/auth/staff-login', (req,res)=>{
  return res.status(405).json({
    error: 'Method Not Allowed. Use POST with username and password.'
  });
});
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
  if(target.role==='admin' && target.status!=='inactive'){
    const otherActiveAdmins = db.staff.filter(s=>s.id!==req.params.id && s.role==='admin' && s.status!=='inactive').length;
    if(otherActiveAdmins===0){
      return res.status(400).json({error:'Cannot delete the last active admin. Create another admin first.'});
    }
  }

  db.staff=db.staff.filter(s=>s.id!==req.params.id); unreachableLocalStoreWrite(db);
  res.json({ok:true});
});
// Maps low-level Postgres/PostgREST errors from the `members` table into a
// message that actually tells the person (or admin) what to do, instead of a
// raw DB error. Returns null when the error isn't one of these known cases,
// so the caller can fall back to the original message.
function mapMemberAuthDbError(err){
  if(!err) return null;
  const msg = String(err.message||'');
  // 42703 = undefined_column. Check the specific column name mentioned first
  // so each missing migration gets its own precise pointer; only fall back to
  // a generic message if the code says undefined_column but we can't tell
  // which column from the message text.
  if(/column .*password_hash.* does not exist/i.test(msg)){
    return 'Database is missing the password_hash column on members. In your Supabase project, open SQL Editor and run migrations/010_member_password_hash.sql, then try again.';
  }
  // Same undefined_column case, but for the reset-token columns added by
  // migrations/014_password_reset.sql (forgot/reset password feature).
  if(/column .*reset_token.* does not exist/i.test(msg)){
    return 'Database is missing the reset_token columns on members. In your Supabase project, open SQL Editor and run migrations/014_password_reset.sql, then try again.';
  }
  if(err.code==='42703'){
    return 'Database is missing a column this feature needs. Check that every file in migrations/ has been run in your Supabase project, in order.';
  }
  // 42501 = insufficient_privilege. Hit when the app is configured with the
  // Supabase ANON key instead of the SECRET/service_role key, so RLS blocks
  // the write even though the endpoint itself is working correctly.
  if(err.code==='42501' || /permission denied|row-level security/i.test(msg)){
    return 'Database rejected this request for permission reasons. Check that SUPABASE_SECRET_KEY (service role key), not the anon key, is set in your server environment.';
  }
  // 23503 = foreign_key_violation. Hit when members.id still has the legacy
  // "members_id_fkey" constraint requiring it to exist in auth.users — but
  // registration now generates its own standalone id (see migration 010's
  // rewrite), so every new signup violates it until migration 011 is run.
  if(err.code==='23503' || /members_id_fkey/i.test(msg)){
    return 'Database is still requiring member accounts to match a Supabase Auth user (an old constraint). In your Supabase project, open SQL Editor and run migrations/011_drop_members_auth_fk.sql, then try again.';
  }
  return null;
}

app.post('/api/auth/register', authLimiter, async(req,res)=>{
  const name = String(req.body?.name || '').trim().replace(/\s+/g,' ');
  const email = String(req.body?.email || '').trim().toLowerCase();
  const phone = String(req.body?.phone || '').trim();
  const password = String(req.body?.password || '');

  if(!name || !email || !password)
    return res.status(400).json({error:'Name, email, and password are required.'});
  if(!/^\S+@\S+\.\S+$/.test(email))
    return res.status(400).json({error:'Please enter a valid email address.'});
  if(password.length < 8)
    return res.status(400).json({error:'Password must be at least 8 characters.'});
  if(!USE_SB || !supabase)
    return res.status(503).json({error:'Supabase is required for registration.'});

  try {
    // IMPORTANT: Member accounts are application accounts. They do not rely on
    // Supabase Auth email confirmation, so a freshly registered account can
    // always be logged in immediately with the same email/password.
    const {data:existing,error:findErr} = await supabase
      .from('members')
      .select('id,email,status,password_hash')
      .ilike('email', email)
      .limit(2);
    if(findErr){
      console.error('register member lookup error:', findErr.message);
      return res.status(500).json({error:mapMemberAuthDbError(findErr) || ('Cannot access the member account table: '+findErr.message)});
    }
    if((existing||[]).length > 1)
      return res.status(409).json({error:'This email exists more than once in the member table. Please contact the studio.'});

    const passwordHash = await bcrypt.hash(password, 12);
    let member;

    if(existing?.[0]){
      member = existing[0];
      if(member.status === 'inactive')
        return res.status(403).json({error:'This email belongs to an inactive account. Please contact the studio.'});

      const {data:updated,error:updateErr}=await supabase
        .from('members')
        .update({name,email,phone,password_hash:passwordHash})
        .eq('id',member.id)
        .select('id,name,email,phone,status')
        .maybeSingle();
      if(updateErr){
        console.error('register member update error:', updateErr.message);
        return res.status(500).json({error:mapMemberAuthDbError(updateErr) || ('Could not save the account password: '+updateErr.message)});
      }
      member = updated || {...member,name,email,phone};
    }else{
      const id = uuidv4();
      const {data:created,error:createErr}=await supabase
        .from('members')
        .insert({
          id,name,email,phone,password_hash:passwordHash,
          joined:new Date().toISOString(),membership_type:'drop-in',status:'active'
        })
        .select('id,name,email,phone,status')
        .single();
      if(createErr){
        console.error('register member insert error:', createErr.message);
        return res.status(500).json({error:mapMemberAuthDbError(createErr) || ('Could not create the member account: '+createErr.message)});
      }
      member = created;
    }

    try{
      pushNotif({audience:'admin',type:'info',title:'New member registered',message:`${name} (${email}) just joined.`,link:'/admin#members'});
    }catch(notifErr){
      console.warn('registration notification failed:', notifErr.message);
    }

    const token=jwt.sign({
      id:member.id,email:member.email,name:member.name,role:'member'
    },JWT_SECRET,{expiresIn:'30d'});

    return res.json({ok:true,token,user:member});
  }catch(e){
    console.error('register error:', e);
    return res.status(500).json({error:'Registration failed. Please try again.'});
  }
});

app.post('/api/auth/login', loginLimiter, async (req,res)=>{
  const identity = String(req.body?.identity ?? req.body?.email ?? req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');

  if(!identity || !password)
    return res.status(400).json({error:'Email/username and password are required.'});
  if(!USE_SB || !supabase)
    return res.status(503).json({error:'Supabase is required for login.'});

  try {
    const normalized = identity.toLowerCase();

    // 1) MEMBER LOGIN — email is the canonical identifier.
    // Try email first; only use a name when the input is not an email.
    let member = null;
    let memberLookupError = null;

    if(identity.includes('@')){
      const q = await supabase
        .from('members')
        .select('id,name,email,phone,status,password_hash')
        .ilike('email', normalized)
        .limit(2);
      memberLookupError = q.error;
      if(!q.error && q.data?.length === 1) member = q.data[0];
      if(!q.error && q.data?.length > 1)
        return res.status(409).json({error:'This email is duplicated in the member table. Please contact the studio.',reason:'duplicate_member_email'});
    }else{
      const q = await supabase
        .from('members')
        .select('id,name,email,phone,status,password_hash')
        .ilike('name', identity)
        .limit(2);
      memberLookupError = q.error;
      if(!q.error && q.data?.length === 1) member = q.data[0];
      if(!q.error && q.data?.length > 1)
        return res.status(409).json({error:'More than one member has that name. Please log in using your email address.',reason:'duplicate_member_name'});
    }

    if(memberLookupError){
      console.error('member login lookup error:', memberLookupError.message);
      return res.status(500).json({error:mapMemberAuthDbError(memberLookupError) || ('Member lookup failed: '+memberLookupError.message)});
    }

    if(member){
      if(member.status === 'inactive')
        return res.status(403).json({error:'Your account is currently inactive. Please contact the studio.'});

      let validPassword = false;
      let legacyBlockedReason = null;
      if(member.password_hash){
        validPassword = await bcrypt.compare(password, member.password_hash);
      }else{
        // Legacy compatibility only: members created by the older Supabase Auth
        // flow can still sign in once; after a successful check, save a bcrypt
        // hash so future logins no longer depend on Supabase Auth.
        try{
          const authClient = createAuthClient();
          const authResult = await authClient.auth.signInWithPassword({
            email:String(member.email).trim().toLowerCase(),
            password
          });
          if(!authResult.error && authResult.data?.user){
            validPassword = true;
            const hash = await bcrypt.hash(password, 12);
            const {error:hashErr}=await supabase.from('members').update({password_hash:hash}).eq('id',member.id);
            if(hashErr) console.warn('legacy password hash upgrade failed:', hashErr.message);
          }else if(authResult.error){
            // Don't silently collapse this into "wrong password" — the two
            // most common cases here are Supabase's own signup-email
            // confirmation requirement and Supabase's own rate limiting,
            // neither of which mean the password was wrong.
            console.warn('legacy member auth failed:', authResult.error.code || authResult.error.status, authResult.error.message);
            const msg = authResult.error.message || '';
            if(authResult.error.code === 'email_not_confirmed' || /confirm/i.test(msg)){
              legacyBlockedReason = 'This account was created before we switched login systems and its email was never confirmed. The fastest fix: just register again with the same email — that sets a fresh password immediately, with no confirmation step needed.';
            }else if(authResult.error.code === 'over_email_send_rate_limit' || authResult.error.status === 429 || /rate limit/i.test(msg)){
              legacyBlockedReason = 'This account still depends on our old login system, which is temporarily rate-limited. Please register again with the same email — that switches this account to the new system immediately and avoids the limit entirely.';
            }
          }
        }catch(legacyErr){
          console.warn('legacy member auth error:', legacyErr.message);
        }
      }

      if(!validPassword)
        return res.status(401).json({error:legacyBlockedReason || 'Incorrect email/name or password.',reason:legacyBlockedReason?'legacy_account_needs_reregistration':'invalid_member_password'});

      const user={
        id:member.id,
        name:member.name || '',
        email:member.email || '',
        phone:member.phone || '',
        status:member.status || 'active',
        role:'member'
      };
      const token=jwt.sign({id:user.id,email:user.email,name:user.name,role:'member'},JWT_SECRET,{expiresIn:'30d'});
      return res.json({ok:true,token,user,authType:'member'});
    }

    // 2) STAFF LOGIN — only reached when no member matched.
    const staff = await authenticateStaff(identity,password);
    if(staff.ok) return res.json({...staff,authType:'staff'});
    if(staff.status && staff.status !== 401 && staff.status !== 400)
      return res.status(staff.status).json(staff);

    return res.status(401).json({error:'Incorrect email/username or password.',reason:'account_not_found_or_invalid_password'});
  }catch(error){
    console.error('login error:', error);
    return res.status(500).json({error:'Login failed. Please try again.'});
  }
});

function hashResetToken(token){
  return crypto.createHash('sha256').update(token).digest('hex');
}

app.post('/api/auth/forgot-password', authLimiter, async(req,res)=>{
  const email = String(req.body?.email || '').trim().toLowerCase();
  // Always the same response whether or not the email exists — this endpoint
  // must never reveal which emails are registered.
  const genericReply = {ok:true, message:"If an account exists for that email, we've sent a password reset link."};

  if(!email || !/^\S+@\S+\.\S+$/.test(email))
    return res.status(400).json({error:'Please enter a valid email address.'});
  if(!USE_SB || !supabase)
    return res.status(503).json({error:'Supabase is required for password reset.'});

  try{
    const {data:matches,error:findErr} = await supabase
      .from('members')
      .select('id,name,email,status')
      .ilike('email', email)
      .limit(2);
    if(findErr){
      console.error('forgot-password lookup error:', findErr.message);
      // Still don't leak anything specific to the client, but don't pretend
      // this worked either — a broken DB connection is worth a real 500 so
      // the admin notices, rather than a silent no-op "email sent".
      return res.status(500).json({error:mapMemberAuthDbError(findErr) || ('Cannot access the member account table: '+findErr.message)});
    }

    // Zero matches, more than one match (ambiguous), or an inactive account:
    // in every case, respond exactly like a normal request and do nothing
    // else. This is what keeps the endpoint from being usable to check which
    // emails are registered.
    const member = (matches||[]).length===1 ? matches[0] : null;
    if(!member || member.status==='inactive') return res.json(genericReply);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const {error:updateErr} = await supabase
      .from('members')
      .update({
        reset_token_hash: hashResetToken(rawToken),
        reset_token_expires: new Date(Date.now() + 30*60*1000).toISOString(),
      })
      .eq('id', member.id);
    if(updateErr){
      console.error('forgot-password token save error:', updateErr.message);
      return res.status(500).json({error:mapMemberAuthDbError(updateErr) || ('Could not start password reset: '+updateErr.message)});
    }

    const resetUrl = `${req.protocol}://${req.get('host')}/reset-password?token=${rawToken}`;
    const {data:settingsData} = await supabase.from('settings').select('*').eq('id',1).single();
    const studioName = settingsData?.studioName || 'Avaia Studio';

    const mailResult = await sendMail({ to: member.email, ...emailPasswordReset(member, resetUrl, studioName) });
    if(!mailResult.ok){
      // The token is saved either way, so the link still works if the admin
      // hands it to the member manually — but flag this loudly, because a
      // silent "email sent" when email isn't configured leaves the member
      // stuck with no way to actually get the link.
      console.warn(`forgot-password: could not email ${member.email} (${mailResult.reason}). Reset link: ${resetUrl}`);
    }

    return res.json(genericReply);
  }catch(e){
    console.error('forgot-password error:', e);
    return res.status(500).json({error:'Could not process the password reset request. Please try again.'});
  }
});

app.post('/api/auth/reset-password', authLimiter, async(req,res)=>{
  const token = String(req.body?.token || '').trim();
  const password = String(req.body?.password || '');

  if(!token) return res.status(400).json({error:'This password reset link is invalid. Please request a new one.'});
  if(!password || password.length < 8)
    return res.status(400).json({error:'Password must be at least 8 characters.'});
  if(!USE_SB || !supabase)
    return res.status(503).json({error:'Supabase is required for password reset.'});

  try{
    const tokenHash = hashResetToken(token);
    const {data:member,error:findErr} = await supabase
      .from('members')
      .select('id,name,email,status,reset_token_expires')
      .eq('reset_token_hash', tokenHash)
      .maybeSingle();
    if(findErr){
      console.error('reset-password lookup error:', findErr.message);
      return res.status(500).json({error:mapMemberAuthDbError(findErr) || ('Cannot access the member account table: '+findErr.message)});
    }
    if(!member || !member.reset_token_expires || new Date(member.reset_token_expires) < new Date())
      return res.status(400).json({error:'This password reset link is invalid or has expired. Please request a new one.'});
    if(member.status==='inactive')
      return res.status(403).json({error:'This account is currently inactive. Please contact the studio.'});

    const passwordHash = await bcrypt.hash(password, 12);
    // Match on the token hash again here, not just the id — if this same
    // link were somehow submitted twice at once, only the first request
    // finds a row still holding this exact hash, and the second gets 0 rows
    // back instead of resetting the password twice.
    const {data:updated,error:updateErr} = await supabase
      .from('members')
      .update({ password_hash: passwordHash, reset_token_hash: null, reset_token_expires: null })
      .eq('id', member.id)
      .eq('reset_token_hash', tokenHash)
      .select('id,name,email,phone,status')
      .maybeSingle();
    if(updateErr){
      console.error('reset-password update error:', updateErr.message);
      return res.status(500).json({error:mapMemberAuthDbError(updateErr) || ('Could not save the new password: '+updateErr.message)});
    }
    if(!updated)
      return res.status(400).json({error:'This password reset link has already been used. Please request a new one.'});

    const user = { id:updated.id, name:updated.name||'', email:updated.email||'', phone:updated.phone||'', status:updated.status||'active', role:'member' };
    const jwtToken = jwt.sign({id:user.id,email:user.email,name:user.name,role:'member'}, JWT_SECRET, {expiresIn:'30d'});
    return res.json({ok:true, token:jwtToken, user});
  }catch(e){
    console.error('reset-password error:', e);
    return res.status(500).json({error:'Could not reset the password. Please try again.'});
  }
});

app.get('/api/auth/diagnostic', async(req,res)=>{
  const result={
    ok:false,
    build:APP_BUILD_ID,
    supabase:USE_SB,
    serverStartedAt:APP_STARTED_AT,
    membersPasswordColumn:false,
    memberCount:null
  };
  if(!USE_SB || !supabase) return res.status(503).json(result);
  try{
    const col=await supabase.from('members').select('id,password_hash').limit(1);
    result.membersPasswordColumn=!col.error;
    if(col.error) result.passwordColumnError=col.error.message;
    const count=await supabase.from('members').select('id',{count:'exact',head:true});
    result.memberCount=count.count ?? null;
    result.ok=!col.error;
    return res.status(result.ok?200:500).json(result);
  }catch(e){
    result.error=e.message;
    return res.status(500).json(result);
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
app.get('/api/bookings',requireAdmin,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('bookings').select('*').order('created_at',{ascending:false});
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  res.json(unreachableLocalStoreRead().bookings);
});
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

    await supabase.auth.admin.deleteUser(req.params.id).catch(()=>{});
    return res.json({ok:true});
  }
  const db=unreachableLocalStoreRead(); db.members=db.members.filter(m=>m.id!==req.params.id); unreachableLocalStoreWrite(db); res.json({ok:true});
});
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
  const{bookingData,className}=req.body;
  let{amount}=req.body;
  if(!bookingData||!amount) return res.status(400).json({error:'Incomplete data.'});

  if(USE_SB){
    if(!bookingData.schedule_id) return res.status(400).json({error:'Schedule session is required.'});
    const { data: scheduleRow, error: scheduleErr } = await supabase
      .from('schedule')
      .select('id,session_date,time,slots,classes(price)')
      .eq('id', bookingData.schedule_id)
      .maybeSingle();

    if(scheduleErr) return res.status(500).json({error:'Unable to verify the selected schedule.'});
    if(!scheduleRow) return res.status(404).json({error:'This schedule session no longer exists.'});
    if(!scheduleRow.session_date) return res.status(409).json({error:'This schedule session has no exact date yet. Please choose another session.'});

    // SECURITY / INTEGRITY: never trust the price sent by the browser.
    // Always charge the price configured for the class in the database,
    // the same way /api/membership-purchase/create re-reads pkg.price
    // instead of trusting the client. This is what fixes the bug where the
    // page showed one price but Midtrans charged a different (stale or
    // tampered) amount for guests / non-member checkouts.
    const verifiedPrice = Number(scheduleRow.classes?.price);
    if(!Number.isFinite(verifiedPrice) || verifiedPrice <= 0){
      return res.status(409).json({error:'This class does not have a valid price configured. Please contact the studio.'});
    }
    amount = verifiedPrice;

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
  // Booking order IDs are UUIDs so they remain valid even if a production database
  // still has a legacy UUID primary key on bookings.id or pending_bookings.id.
  // Midtrans accepts UUID order IDs, and booking/package flows already distinguish
  // packages using the AVAIA-PKG- prefix, so bookings do not need a readable prefix.
  const orderId=uuidv4();

  const verifiedMember = getSoftMemberAuth(req);
  if(verifiedMember){
    bookingData.member_id = verifiedMember.id;
    bookingData.email = verifiedMember.email;
  }

  const activePkg = verifiedMember ? await getActivePackage(bookingData.member_id, bookingData.email) : null;

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

// Asks Midtrans directly what a transaction's real status is right now, and
// if it's actually paid, finalizes it immediately via the same idempotent
// confirm functions the webhook uses — instead of waiting for that webhook
// to arrive on its own. Returns null if Midtrans isn't configured, the check
// itself fails (network hiccup, etc.), or the transaction is still genuinely
// unpaid — in all of those cases the caller should just report the
// last-known local status rather than treat this as a hard error.
async function activelyConfirmWithMidtrans(orderId, isPackage){
  if(!USE_MT || !core) return null;
  let mtStatus;
  try{
    mtStatus = await core.transaction.status(orderId);
  }catch(e){
    console.warn('Midtrans status check failed for', orderId, ':', e.message);
    return null;
  }
  const ok = (mtStatus.transaction_status==='capture' && mtStatus.fraud_status==='accept') || mtStatus.transaction_status==='settlement';
  if(ok){
    const confirmed = isPackage
      ? await confirmPackagePurchase(orderId, mtStatus.payment_type||'midtrans')
      : await confirmBooking(orderId, mtStatus.payment_type||'midtrans');
    return { confirmed:true, record:confirmed };
  }
  if(['deny','cancel','expire'].includes(mtStatus.transaction_status)){
    const cancelled = isPackage
      ? await cancelPackagePurchase(orderId, mtStatus.transaction_status)
      : await cancelBooking(orderId, mtStatus.transaction_status);
    return { confirmed:false, cancelled:true, record:cancelled };
  }
  return { confirmed:false, cancelled:false, record:null };
}

app.get('/api/payment/status/:orderId',async(req,res)=>{
  if(!USE_SB) return res.status(503).json({error:'Supabase is required.'});
  const orderId=req.params.orderId;
  const isPackage=orderId.startsWith('AVAIA-PKG-');

  if(isPackage){
    const {data:pkg,error:pkgErr}=await supabase.from('member_packages').select('*').eq('payment_order_id',orderId).maybeSingle();
    if(pkgErr) return res.status(500).json({error:'Unable to check membership payment: '+pkgErr.message});
    if(pkg) return res.json({status:'active',package:pkg});

    const {data:pendingPkg,error:pendingErr}=await supabase.from('pending_package_purchases').select('*').eq('id',orderId).maybeSingle();
    if(pendingErr) return res.status(500).json({error:'Unable to check membership payment: '+pendingErr.message});
    if(!pendingPkg) return res.status(404).json({error:'Membership payment not found'});

    if(!String(pendingPkg.status||'').startsWith('cancelled_')){
      try{
        const result=await activelyConfirmWithMidtrans(orderId, true);
        if(result?.confirmed) return res.json({status:'active',package:result.record});
        if(result?.cancelled) return res.json({status:result.record?.status||'cancelled',package:result.record||pendingPkg});
      }catch(e){
        console.error('Active confirm (package) failed for', orderId, ':', e.message);
      }
    }
    return res.json({status:pendingPkg.status,package:pendingPkg});
  }

  let {data:b,error:bErr}=await supabase.from('bookings').select('*').eq('id',orderId).maybeSingle();
  if(bErr) return res.status(500).json({error:'Unable to check booking payment: '+bErr.message});
  if(b) return res.json({status:b.status,booking:b});

  const {data:pendingBooking,error:pbErr}=await supabase.from('pending_bookings').select('*').eq('id',orderId).maybeSingle();
  if(pbErr) return res.status(500).json({error:'Unable to check booking payment: '+pbErr.message});
  if(!pendingBooking) return res.status(404).json({error:'Booking payment not found'});

  if(!String(pendingBooking.status||'').startsWith('cancelled_')){
    try{
      const result=await activelyConfirmWithMidtrans(orderId, false);
      if(result?.confirmed) return res.json({status:result.record.status,booking:result.record});
      if(result?.cancelled) return res.json({status:result.record?.status||'cancelled',booking:result.record||pendingBooking});
    }catch(e){
      console.error('Active confirm (booking) failed for', orderId, ':', e.message);
    }
  }
  res.json({status:pendingBooking.status,booking:pendingBooking});
});

// Sweeps every still-pending payment (bookings + membership packages) and
// asks Midtrans directly what really happened to it — for payments made
// while the webhook/confirmation flow had bugs (now fixed), the money may
// have been captured by Midtrans even though our side never finished the
// job. Reuses the exact same verified-confirm path as the live payment
// flow, so a record can only be completed here if Midtrans itself reports
// it as paid — this cannot be used to grant an unpaid booking/membership.
app.post('/api/admin/reconcile-pending',requireAdmin,async(req,res)=>{
  if(!USE_SB) return res.status(503).json({error:'Supabase is required.'});
  if(!USE_MT || !core) return res.status(503).json({error:'Midtrans is not configured, so pending payments cannot be verified.'});

  const results=[];
  let confirmed=0, cancelled=0, stillPending=0, failed=0;

  const {data:pendingPkgs,error:pkgErr}=await supabase
    .from('pending_package_purchases').select('id,member_name,package_name,created_at,status')
    .not('status','ilike','cancelled_%');
  if(pkgErr) return res.status(500).json({error:'Unable to list pending memberships: '+pkgErr.message});

  const {data:pendingBks,error:bkErr}=await supabase
    .from('pending_bookings').select('id,name,class,created_at,status')
    .not('status','ilike','cancelled_%');
  if(bkErr) return res.status(500).json({error:'Unable to list pending bookings: '+bkErr.message});

  for(const p of (pendingPkgs||[])){
    try{
      const r=await activelyConfirmWithMidtrans(p.id,true);
      if(r?.confirmed){ confirmed++; results.push({id:p.id,type:'membership',who:p.member_name,what:p.package_name,outcome:'confirmed'}); }
      else if(r?.cancelled){ cancelled++; results.push({id:p.id,type:'membership',who:p.member_name,what:p.package_name,outcome:'cancelled'}); }
      else { stillPending++; results.push({id:p.id,type:'membership',who:p.member_name,what:p.package_name,outcome:'still_pending'}); }
    }catch(e){
      failed++; results.push({id:p.id,type:'membership',who:p.member_name,what:p.package_name,outcome:'check_failed',error:e.message});
    }
  }

  for(const b of (pendingBks||[])){
    try{
      const r=await activelyConfirmWithMidtrans(b.id,false);
      if(r?.confirmed){ confirmed++; results.push({id:b.id,type:'booking',who:b.name,what:b.class,outcome:'confirmed'}); }
      else if(r?.cancelled){ cancelled++; results.push({id:b.id,type:'booking',who:b.name,what:b.class,outcome:'cancelled'}); }
      else { stillPending++; results.push({id:b.id,type:'booking',who:b.name,what:b.class,outcome:'still_pending'}); }
    }catch(e){
      failed++; results.push({id:b.id,type:'booking',who:b.name,what:b.class,outcome:'check_failed',error:e.message});
    }
  }

  res.json({
    ok:true,
    scanned:(pendingPkgs||[]).length+(pendingBks||[]).length,
    confirmed, cancelled, stillPending, failed,
    results,
  });
});

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

app.get('/api/my-packages',requireMember,async(req,res)=>{
  const pkgs=await getMemberPackages(req.user.id,req.user.email);
  res.json(pkgs);
});

app.get('/api/member-packages',requireAdmin,async(req,res)=>{
  let all;
  if(USE_SB){ const{data}=await supabase.from('member_packages').select('*'); all=data||[]; }
  else all=unreachableLocalStoreRead().memberPackages||[];
  res.json(all.map(p=>({...p,computed_status:computePkgStatus(p)})));
});

app.post('/api/member-packages/manual',requireAdmin,async(req,res)=>{
  if(!USE_SB) return res.status(503).json({error:'Supabase is required for manual membership assignment.'});
  try{
    const {member_id, package_id, start_date, price_paid, credits_total, credits_used, validity_days, payment_type}=req.body||{};
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
    const usedRaw=parseInt(credits_used,10);
    const used=Number.isFinite(usedRaw)?Math.max(0,usedRaw):0;
    if(used>credits) return res.status(400).json({error:'Credits already used cannot exceed total credits.'});
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
      credits_used:used,
      payment_type:payment,
      purchased_at:start.toISOString(),
      expires_at:expires.toISOString(),
      status:'active',
      package_id:pkg.id,
      source:'admin_manual'
    };

    const {data:inserted,error:insertErr}=await supabase.from('member_packages').insert(record).select('*').single();
    if(insertErr){
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

function emailPasswordReset(member, resetUrl, studioName='Avaia Studio'){
  const subject = `Reset your password | ${studioName}`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<style>body{font-family:Georgia,serif;background:#fdf8f6;margin:0;padding:20px}.wrap{max-width:560px;margin:0 auto;background:#fff;border:1px solid #ddd5ca}.hdr{background:#5D3A24;padding:32px 36px}.hdr h1{color:#fff;font-size:22px;margin:0;font-weight:400}.hdr p{color:rgba(255,255,255,.6);margin:4px 0 0;font-size:13px}.bdy{padding:36px}.btn{display:inline-block;background:#5D3A24;color:#fff !important;text-decoration:none;padding:13px 28px;font-family:Arial,sans-serif;font-size:14px;margin:20px 0}.note{font-size:13px;color:#7a6e68;line-height:1.7;margin-top:16px}.link{font-size:12px;color:#9C6B3D;word-break:break-all}.ftr{padding:18px 36px;border-top:1px solid #ede5dc;font-size:12px;color:#7a6e68}</style>
</head><body><div class="wrap">
<div class="hdr"><h1>${studioName}</h1><p>Password Reset Request</p></div>
<div class="bdy">
<p style="font-size:15px;color:#1c1410">Hi, <strong>${member.name||''}</strong>,</p>
<p style="font-size:14px;color:#7a6e68;line-height:1.7">We received a request to reset the password for your account. Click the button below to choose a new password. This link expires in 30 minutes.</p>
<a href="${resetUrl}" class="btn">Reset My Password</a>
<p class="note">If the button doesn't work, copy and paste this link into your browser:</p>
<p class="link">${resetUrl}</p>
<p class="note">If you didn't request this, you can safely ignore this email — your password will not be changed.</p>
</div>
<div class="ftr">This is an automated email from ${studioName}. Please do not reply.</div>
</div></body></html>`;
  const text = `Password Reset — ${studioName}\n\nHi ${member.name||''},\n\nWe received a request to reset your password. Open this link to choose a new one (expires in 30 minutes):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`;
  return { subject, html, text };
}

async function confirmBooking(orderId,paymentType,memberPackageId=null){
  if(!USE_SB) throw new Error('Supabase is required for payment confirmation.');
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
      await supabase.from('bookings').delete().eq('id',orderId);
      if(pending.schedule_id && pending.slot_reserved) await releaseScheduleSlot(pending.schedule_id);
      throw e;
    }
  }
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
  notifyAdminEmail('New Booking Confirmed', [
    ['Name', inserted.name],
    ['Class', inserted.class],
    ['Date', `${inserted.date} at ${inserted.time}`],
    ['Payment', memberPackageId ? 'Package credit' : (inserted.payment_type||paymentType||'—')],
    ['Email', inserted.email||'—'],
  ], '/admin#bookings');
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
async function confirmPackagePurchase(orderId,paymentType){
  if(!USE_SB) throw new Error('Supabase is required for membership purchase confirmation.');

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
  notifyAdminEmail('New Membership Purchased', [
    ['Member', inserted.member_name||'—'],
    ['Package', inserted.package_name],
    ['Credits', String(inserted.credits_total)],
    ['Paid', `${(inserted.price_paid||0).toLocaleString('id-ID')} (${inserted.payment_type||paymentType||'—'})`],
    ['Valid until', new Date(inserted.expires_at).toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric'})],
    ['Email', inserted.member_email||'—'],
  ], '/admin#members');
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
    const stats=buildAdminStats({bookings,members,classes,schedule,memberPackages});

    // ── Optional date-range filter for the "Total Revenue" card ──
    // Supports ?year=2026, ?year=2026&month=9, or ?from=2026-09-01&to=2026-09-30.
    // Always counts confirmed bookings + purchased packages only (payment succeeded).
    const {year,month,day,from,to}=req.query;
    let rangeStart=null, rangeEnd=null;
    if(from||to){
      rangeStart = from ? new Date(from+'T00:00:00') : null;
      rangeEnd   = to   ? new Date(to+'T23:59:59.999') : null;
    } else if(year){
      const y=parseInt(year);
      if(day && month){
        const m=parseInt(month)-1;
        rangeStart=new Date(y,m,parseInt(day),0,0,0);
        rangeEnd=new Date(y,m,parseInt(day),23,59,59,999);
      } else if(month){
        const m=parseInt(month)-1;
        rangeStart=new Date(y,m,1,0,0,0);
        rangeEnd=new Date(y,m+1,0,23,59,59,999);
      } else {
        rangeStart=new Date(y,0,1,0,0,0);
        rangeEnd=new Date(y,11,31,23,59,59,999);
      }
    }
    if(rangeStart||rangeEnd){
      const inRange=(dateVal)=>{
        if(!dateVal) return false;
        const d=new Date(dateVal);
        if(rangeStart && d<rangeStart) return false;
        if(rangeEnd && d>rangeEnd) return false;
        return true;
      };
      const confirmedInRange=(bookings||[]).filter(b=>b.status==='confirmed' && inRange(b.created_at));
      const packagesInRange=(memberPackages||[]).filter(p=>inRange(p.purchased_at));
      const classRevenueRange=confirmedInRange.reduce((s,b)=>s+(parseInt(b.amount)||0),0);
      const packageRevenueRange=packagesInRange.reduce((s,p)=>s+(parseInt(p.price_paid)||0),0);
      stats.summary.filteredRevenue = classRevenueRange + packageRevenueRange;
      stats.summary.filteredBookingsCount = confirmedInRange.length;
      stats.summary.filteredRange = {
        year: year?parseInt(year):null,
        month: month?parseInt(month):null,
        day: day?parseInt(day):null,
        from: from||null, to: to||null,
      };
    }

    res.json(stats);
  }catch(e){ res.status(500).json({error:e.message}); }
});
app.get('/api/invoice/:id',async(req,res)=>{
  let booking, isPackage=false;
  if(USE_SB){
    const{data}=await supabase.from('bookings').select('*').eq('id',req.params.id).single();
    booking=data;
  } else { booking=(unreachableLocalStoreRead().bookings||[]).find(b=>b.id===req.params.id); }

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
app.get('/reset-password', (req,res)=>res.sendFile('reset-password.html', { root: PG }));
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
  console.error('\n Avaia Studio startup aborted:',err.message);
  console.error('   Supabase is required. No local database fallback is available.\n');
  process.exit(1);
});
