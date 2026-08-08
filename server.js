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
const rateLimit= require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
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

// Hostinger (and most managed hosts) sit the app behind a reverse proxy, which
// sets X-Forwarded-For with the visitor's real IP. Without telling Express to
// trust that first hop, express-rate-limit can't reliably identify individual
// visitors and throws on every request trying to figure out the rate-limit key.
// This matters a lot here since generalLimiter below covers every /api/ route.
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;

// ── SUPABASE ────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || '';
// The Node server must use a server-side key. Prefer the current Supabase
// secret key, while retaining compatibility with the legacy service-role key.
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY ||
  '';

let supabase = null, USE_SB = false;

if (SUPABASE_URL && !SUPABASE_URL.includes('YOUR_') && SUPABASE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    USE_SB = true;
    console.log('✓ Supabase connected (server key)');
  } catch(e) {
    console.warn('⚠ Supabase initialization failed:', e.message);
  }
} else if (SUPABASE_URL && !SUPABASE_URL.includes('YOUR_')) {
  console.warn('⚠ SUPABASE_URL is set but no server key was found. Using db.json locally.');
  console.warn('  Set SUPABASE_SECRET_KEY (recommended) or SUPABASE_SERVICE_ROLE_KEY.');
} else {
  console.log('ℹ Using db.json (local)');
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

// ── LOCAL DB ────────────────────────────────
const DB_FILE = path.join(__dirname, 'db.json');
function rDB() {
  if (!fs.existsSync(DB_FILE)) return defDB();
  try { return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch { return defDB(); }
}
function wDB(d) { fs.writeFileSync(DB_FILE, JSON.stringify(d,null,2)); }
function defDB() {
  return {
    settings: {
      studioName:'Avaia Studio', tagline:'Find peace in every movement',
      primaryColor:'#5D3A24', accentColor:'#9C6B3D', bgColor:'#FDF8F6',
      heroImage:null, heroImage2:null, heroImage3:null,
      aboutImage:null,
      address:'Jl. Prawirotaman No. 12, Yogyakarta',
      phone:'+62 274 123 456', email:'hello@avaia.id',
      hours:'Monday – Saturday, 6:00 AM – 8:00 PM',
      mapEmbed:'https://maps.google.com/maps?q=Yogyakarta,Indonesia&output=embed',
      about1:'Avaia Studio was born from the belief that yoga is a journey, not a destination.',
      about2:'Our instructors are RYT 200 and 500 certified by Yoga Alliance International.',
      about3:'Our studio is equipped with premium mats, air conditioning, changing rooms, and lockers in the heart of the city.',
      classPrices: { default:85000 },
    },
    classes:[
      {id:'c1',name:'Hatha Flow',instructor:'Sari Dewi',level:'All Levels',duration:'60 minutes',capacity:12,price:85000},
      {id:'c2',name:'Vinyasa Power',instructor:'Budi Santoso',level:'Intermediate',duration:'75 minutes',capacity:10,price:95000},
      {id:'c3',name:'Yin & Restore',instructor:'Maya Putri',level:'All Levels',duration:'75 minutes',capacity:14,price:90000},
      {id:'c4',name:'Foundations',instructor:'Rina Hapsari',level:'Beginner',duration:'60 minutes',capacity:8,price:75000},
      {id:'c5',name:'Ashtanga Primary',instructor:'Budi Santoso',level:'Intermediate',duration:'90 minutes',capacity:10,price:100000},
      {id:'c6',name:'Meditation & Pranayama',instructor:'Sari Dewi',level:'All Levels',duration:'45 minutes',capacity:20,price:70000},
    ],
    schedule:[
      {id:'s1',day:'Monday',classId:'c1',time:'07.00',slots:8},
      {id:'s2',day:'Monday',classId:'c4',time:'09.00',slots:5},
      {id:'s3',day:'Monday',classId:'c6',time:'19.00',slots:12},
      {id:'s4',day:'Tuesday',classId:'c5',time:'06.00',slots:3},
      {id:'s5',day:'Tuesday',classId:'c2',time:'08.30',slots:4},
      {id:'s6',day:'Tuesday',classId:'c6',time:'19.00',slots:15},
      {id:'s7',day:'Wednesday',classId:'c1',time:'07.00',slots:10},
      {id:'s8',day:'Wednesday',classId:'c3',time:'17.00',slots:7},
      {id:'s9',day:'Wednesday',classId:'c6',time:'19.00',slots:14},
      {id:'s10',day:'Thursday',classId:'c2',time:'08.30',slots:6},
      {id:'s11',day:'Thursday',classId:'c6',time:'19.00',slots:18},
      {id:'s12',day:'Friday',classId:'c5',time:'06.00',slots:2},
      {id:'s13',day:'Friday',classId:'c1',time:'07.00',slots:9},
      {id:'s14',day:'Friday',classId:'c6',time:'19.00',slots:16},
      {id:'s15',day:'Saturday',classId:'c4',time:'07.30',slots:4},
      {id:'s16',day:'Saturday',classId:'c3',time:'09.00',slots:11},
      {id:'s17',day:'Saturday',classId:'c6',time:'19.00',slots:20},
    ],
    bookings:[], pendingBookings:[],
    members:[],
    memberships:[
      {id:'m1',name:'Single Class',price:100000,duration:'per class',credits:1,validity_days:7,
        features:['1 class of your choice','Access to all facilities','Mat provided','Online booking'],status:'active'},
      {id:'m2',name:'First Timer',price:240000,duration:'3 classes · valid for 7 days',credits:3,validity_days:7,
        features:['3 classes to explore','Best for first-time visitors','Access to all facilities','Online booking'],status:'active'},
      {id:'m3',name:'5 Classes',price:400000,duration:'5 classes · valid for 1 month',credits:5,validity_days:30,
        features:['5 classes per month','Flexible scheduling','Access to all facilities','Online booking'],status:'active'},
      {id:'m4',name:'10 Classes',price:800000,duration:'10 classes · valid for 1 month',credits:10,validity_days:30,
        features:['10 classes per month','Best value per class','Priority booking','Access to all facilities'],status:'active'},
    ],
    memberPackages:[], pendingPackagePurchases:[],
    feedback:[],
    staff:[],
    notifications:[],
    admin:{username:'admin@gmail.com',password:bcrypt.hashSync('admin123',10)}
  };
}
if (!fs.existsSync(DB_FILE)) wDB(defDB());

// ── NOTIFICATIONS ────────────────────────────
const notifier = createNotifier({ rDB, wDB, supabase, isSB: () => USE_SB });
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

// Lightweight diagnostics for deployment checks. Never expose secrets.
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    database: USE_SB ? 'supabase' : 'local',
    payment: MT_SERVER ? 'midtrans' : 'simulation',
    email: USE_EMAIL ? 'configured' : 'not_configured',
    node: process.version,
    time: new Date().toISOString()
  });
});

// ── RATE LIMITERS ────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15*60*1000,
  max: 10,
  // Do not let one person exhaust the login limit for everyone sharing
  // the same office/Wi-Fi IP. Scope the bucket to IP + account identifier.
  keyGenerator: (req) => {
    const identity = String(req.body?.username || '').trim().toLowerCase() || 'unknown';
    return `${ipKeyGenerator(req)}:${identity}`;
  },
  message: { error: 'Too many attempts for this account. Please try again in 15 minutes.', code: 'AUTH_RATE_LIMIT' },
  standardHeaders: true,
  legacyHeaders: false,
});
const generalLimiter = rateLimit({
  windowMs: 1*60*1000,  // 1 minute
  max: 100,              // 100 requests per minute per IP
  message: { error: 'Too many requests. Please try again shortly.' },
});
app.use('/api/', generalLimiter);
app.use('/api/auth/', authLimiter);

function requireRole(allowedRoles) {
  return (req, res, next) => {
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
        const db = rDB();
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
app.get('/api/settings',async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('settings').select('*').eq('id',1).maybeSingle();
    if(error) return res.status(500).json({error:error.message});
    return res.json(data||rDB().settings);
  }
  res.json(rDB().settings);
});
app.put('/api/settings',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('settings').update(req.body).eq('id',1).select().single();
    if(error) return res.status(500).json({error:error.message});
    return res.json({ok:true,settings:data});
  }
  const db=rDB(); db.settings={...db.settings,...req.body}; wDB(db); res.json({ok:true});
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
      const db=rDB(); db.settings[dbKey]='/uploads/'+filename; wDB(db);
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

app.post('/api/auth/staff-login',async(req,res)=>{
  const rawUsername = typeof req.body?.username === 'string' ? req.body.username : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const username = rawUsername.trim();

  if(!username || !password) {
    return res.status(400).json({error:'Please enter your username/email and password.', code:'MISSING_CREDENTIALS'});
  }

  try {
    if(USE_SB){
      // Username/email matching is normalized so admin@gmail.com and
      // ADMIN@GMAIL.COM behave consistently across browsers/devices.
      const normalized = username.toLowerCase();
      let staffUser = null;
      let lookupError = null;

      ({data:staffUser,error:lookupError} =
        await supabase.from('staff').select('*')
          .or(`username.ilike.${normalized},email.ilike.${normalized}`)
          .maybeSingle());

      if(lookupError) {
        console.error('Staff lookup failed:', lookupError.message);
        return res.status(503).json({
          error:'Database login is not available. Check the Supabase staff table and server key.',
          code:'STAFF_DB_ERROR'
        });
      }

      if(!staffUser) {
        return res.status(401).json({error:'Incorrect username/email or password.', code:'INVALID_CREDENTIALS'});
      }

      const match = await bcrypt.compare(password, staffUser.password || '');
      if(!match) return res.status(401).json({error:'Incorrect username/email or password.', code:'INVALID_CREDENTIALS'});
      if(staffUser.status==='inactive') return res.status(403).json({error:'Your account is currently inactive. Please contact an admin.', code:'ACCOUNT_INACTIVE'});

      const token = jwt.sign(
        { id:staffUser.id, role:staffUser.role, name:staffUser.name, username:staffUser.username },
        JWT_SECRET, { expiresIn:'8h' }
      );
      const {password:_,...safe}=staffUser;
      return res.json({ok:true, token, user:safe});
    }

    const db=rDB();
    if(!db.staff) db.staff=[];

    const normalized = username.toLowerCase();
    const staffUser = db.staff.find(s =>
      String(s.username||'').toLowerCase()===normalized ||
      String(s.email||'').toLowerCase()===normalized
    );

    if(staffUser){
      const match = await bcrypt.compare(password, staffUser.password || '');
      if(!match) return res.status(401).json({error:'Incorrect username/email or password.', code:'INVALID_CREDENTIALS'});
      if(staffUser.status==='inactive') return res.status(403).json({error:'Your account is currently inactive. Please contact an admin.', code:'ACCOUNT_INACTIVE'});
      const token = jwt.sign(
        { id:staffUser.id, role:staffUser.role, name:staffUser.name, username:staffUser.username },
        JWT_SECRET, { expiresIn:'8h' }
      );
      const {password:_,...safe}=staffUser;
      return res.json({ok:true, token, user:safe});
    }

    // Local development fallback. In Supabase mode this fallback is intentionally
    // disabled so a broken cloud database can never silently authenticate locally.
    if(String(db.admin?.username||'').toLowerCase()===normalized){
      const match = await bcrypt.compare(password||'', db.admin.password);
      if(match){
        const token = jwt.sign(
          { id:'admin-default', role:'admin', name:'Administrator', username:db.admin.username },
          JWT_SECRET, { expiresIn:'8h' }
        );
        return res.json({
          ok:true, token,
          user:{ id:'admin-default', role:'admin', name:'Administrator', username:db.admin.username }
        });
      }
    }

    return res.status(401).json({error:'Incorrect username/email or password.', code:'INVALID_CREDENTIALS'});
  } catch(e) {
    console.error('Staff login error:', e);
    return res.status(500).json({error:'Login service error. Please try again.', code:'LOGIN_SERVER_ERROR'});
  }
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

  const db=rDB(); if(!db.staff) db.staff=[];

  if(req.user.id==='admin-default'){
    const match=await bcrypt.compare(currentPassword||'', db.admin.password);
    if(!match) return res.status(401).json({error:'Current password is incorrect.'});
    db.admin.password=await bcrypt.hash(newPassword,10);
    wDB(db); return res.json({ok:true});
  }

  const i=db.staff.findIndex(s=>s.id===req.user.id);
  if(i<0) return res.status(404).json({error:'Account not found.'});
  const match=await bcrypt.compare(currentPassword||'', db.staff[i].password);
  if(!match) return res.status(401).json({error:'Current password is incorrect.'});
  db.staff[i].password=await bcrypt.hash(newPassword,10);
  wDB(db); res.json({ok:true});
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
  const db=rDB();
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

  const db=rDB(); if(!db.staff) db.staff=[];
  if(db.staff.find(s=>s.username===username)) return res.status(400).json({error:'Username is already taken.'});

  const staff={
    id:uuidv4(), name, username, email:email||'', password:hashedPw, role,
    bio:bio||'', specialty:specialty||'', status:'active',
    created_at:new Date().toISOString()
  };
  db.staff.push(staff); wDB(db);
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

  const db=rDB(); if(!db.staff) db.staff=[];
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

  db.staff[i]={...db.staff[i],...body}; wDB(db);
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

  const db=rDB(); if(!db.staff) db.staff=[];
  const target=db.staff.find(s=>s.id===req.params.id);
  if(!target) return res.status(404).json({error:'Account not found.'});

  // Prevent deleting the last active admin to avoid a total lockout
  if(target.role==='admin' && target.status!=='inactive'){
    const otherActiveAdmins = db.staff.filter(s=>s.id!==req.params.id && s.role==='admin' && s.status!=='inactive').length;
    if(otherActiveAdmins===0){
      return res.status(400).json({error:'Cannot delete the last active admin. Create another admin first.'});
    }
  }

  db.staff=db.staff.filter(s=>s.id!==req.params.id); wDB(db);
  res.json({ok:true});
});

// ════════════════════════════════════════════
//  AUTH MEMBER
// ════════════════════════════════════════════
app.post('/api/auth/register',async(req,res)=>{
  const {name,email,password,phone}=req.body;
  if(!name||!email||!password) return res.status(400).json({error:'Name, email, and password are required.'});

  if(USE_SB){
    try{
      const {data,error}=await supabase.auth.signUp({email,password,options:{data:{name,phone}}});
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
    const db=rDB();
    if(db.members.find(m=>m.email===email))
      return res.status(400).json({error:'Email is already registered.'});
    const hashedPw=await bcrypt.hash(password,10);
    const m={id:uuidv4(),name,email,phone:phone||'',password:hashedPw,
      joined:new Date().toISOString(),membership_type:'drop-in',status:'active'};
    db.members.push(m); wDB(db);
    pushNotif({audience:'admin',type:'info',title:'New member registered',message:`${name} (${email}) just joined.`,link:'/admin#members'});
    const {password:_,...safe}=m;
    const token=jwt.sign({id:m.id,email:m.email,name:m.name,role:'member'},JWT_SECRET,{expiresIn:'30d'});
    res.json({ok:true,token,user:safe});
  }
});

app.post('/api/auth/login',async(req,res)=>{
  const {email,password}=req.body;
  if(USE_SB){
    try{
      const {data,error}=await supabase.auth.signInWithPassword({email,password});
      if(error) return res.status(401).json({error:'Incorrect email or password.'});
      const {data:member}=await supabase.from('members').select('*').eq('id',data.user.id).maybeSingle();
      const user=member||{id:data.user.id,email};
      const token=jwt.sign({id:user.id,email:user.email||email,name:user.name||'',role:'member'},JWT_SECRET,{expiresIn:'30d'});
      res.json({ok:true,user,token});
    }catch(e){res.status(500).json({error:e.message});}
  } else {
    const db=rDB();
    const m=db.members.find(m=>m.email===email);
    if(!m) return res.status(401).json({error:'Incorrect email or password.'});
    const match=await bcrypt.compare(password,m.password);
    if(!match) return res.status(401).json({error:'Incorrect email or password.'});
    const {password:_,...safe}=m;
    const token=jwt.sign({id:m.id,email:m.email,name:m.name,role:'member'},JWT_SECRET,{expiresIn:'30d'});
    res.json({ok:true,user:safe,token});
  }
});

// ════════════════════════════════════════════
//  CLASSES
// ════════════════════════════════════════════
app.get('/api/classes',async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('classes').select('*').order('name');
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  res.json(rDB().classes);
});
app.post('/api/classes',requireStaff,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('classes').insert(req.body).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  const db=rDB(); const c={id:'c'+uuidv4().slice(0,8),...req.body}; db.classes.push(c); wDB(db); res.json(c);
});
app.put('/api/classes/:id',requireStaff,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('classes').update(req.body).eq('id',req.params.id).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  const db=rDB(); const i=db.classes.findIndex(c=>c.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Not found'});
  db.classes[i]={...db.classes[i],...req.body}; wDB(db); res.json(db.classes[i]);
});
app.delete('/api/classes/:id',requireStaff,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('classes').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Class not found — it may already have been deleted, or you may not have permission to delete it.'});
    return res.json({ok:true});
  }
  const db=rDB(); db.classes=db.classes.filter(c=>c.id!==req.params.id); wDB(db); res.json({ok:true});
});

// ════════════════════════════════════════════
//  SCHEDULE
// ════════════════════════════════════════════
app.get('/api/schedule',async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('schedule').select('*,classes(name,instructor,level,duration,capacity,price)').order('time');
    if(error) return res.status(500).json({error:error.message});
    return res.json(data.map(s=>({...s,className:s.classes?.name,instructor:s.classes?.instructor,
      level:s.classes?.level,duration:s.classes?.duration,capacity:s.classes?.capacity,price:s.classes?.price})));
  }
  const db=rDB();
  res.json(db.schedule.map(s=>{
    const c=db.classes.find(x=>x.id===(s.classId||s.class_id))||{};
    return{...s,class_id:s.classId,className:c.name,instructor:c.instructor,
      level:c.level,duration:c.duration,capacity:c.capacity,price:c.price||85000};
  }));
});
app.post('/api/schedule',requireStaff,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('schedule').insert(req.body).select().single();
    if(error) return res.status(500).json({error:error.message}); broadcastScheduleUpdate(); return res.json(data);}
  const db=rDB(); const e={id:'s'+uuidv4().slice(0,8),classId:req.body.class_id,...req.body}; db.schedule.push(e); wDB(db); broadcastScheduleUpdate(); res.json(e);
});
app.put('/api/schedule/:id',requireStaff,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('schedule').update(req.body).eq('id',req.params.id).select().single();
    if(error) return res.status(500).json({error:error.message}); broadcastScheduleUpdate(); return res.json(data);}
  const db=rDB(); const i=db.schedule.findIndex(s=>s.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Not found'});
  if(req.body.class_id) req.body.classId=req.body.class_id;
  db.schedule[i]={...db.schedule[i],...req.body}; wDB(db); broadcastScheduleUpdate(); res.json(db.schedule[i]);
});
app.delete('/api/schedule/:id',requireStaff,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('schedule').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Session not found — it may already have been deleted, or you may not have permission to delete it.'});
    broadcastScheduleUpdate(); return res.json({ok:true});
  }
  const db=rDB(); db.schedule=db.schedule.filter(s=>s.id!==req.params.id); wDB(db); broadcastScheduleUpdate(); res.json({ok:true});
});

// ════════════════════════════════════════════
//  BOOKINGS
// ════════════════════════════════════════════
app.get('/api/bookings',requireAdmin,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('bookings').select('*').order('created_at',{ascending:false});
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  res.json(rDB().bookings);
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
  } else all=rDB().bookings;

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
  const db=rDB(); db.bookings=db.bookings.filter(b=>b.id!==req.params.id); wDB(db); res.json({ok:true});
});

// Mark a booking as No Show. The class credit (if any was used) is NOT refunded —
// it was already spent at booking time, same as a late cancellation.
app.put('/api/bookings/:id/no-show',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{error}=await supabase.from('bookings').update({status:'no-show'}).eq('id',req.params.id);
    if(error) return res.status(500).json({error:error.message});
    return res.json({ok:true});
  }
  const db=rDB(); const i=db.bookings.findIndex(b=>b.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Booking not found.'});
  db.bookings[i].status='no-show'; wDB(db);
  res.json({ok:true});
});

// Export bookings to Excel
app.get('/api/bookings/export-excel',requireAdmin,async(req,res)=>{
  let data;
  if(USE_SB){const r=await supabase.from('bookings').select('*').order('created_at',{ascending:false}); data=r.data||[];}
  else data=rDB().bookings;
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
  else data=rDB().bookings;
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
      else{ const db=rDB(); db.bookings.unshift(b); wDB(db); }
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
  res.json(rDB().members.map(({password:_,...m})=>m));
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
  const db=rDB(); db.members=db.members.filter(m=>m.id!==req.params.id); wDB(db); res.json({ok:true});
});

// Export members to Excel
app.get('/api/members/export-excel',requireAdmin,async(req,res)=>{
  let data;
  if(USE_SB){const r=await supabase.from('members').select('*').order('joined',{ascending:false}); data=r.data||[];}
  else data=rDB().members.map(({password:_,...m})=>m);
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
      else{ const db=rDB(); if(!db.members.find(x=>x.email===m.email)){db.members.push(m);wDB(db);} }
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
  res.json(rDB().memberships||[]);
});
app.post('/api/memberships',requireAdmin,async(req,res)=>{
  const m={...req.body,id:uuidv4(),created_at:new Date().toISOString(),status:'active'};
  if(USE_SB){const{data,error}=await supabase.from('memberships').insert(m).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  const db=rDB(); if(!db.memberships)db.memberships=[]; db.memberships.unshift(m); wDB(db); res.json(m);
});
app.put('/api/memberships/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){const{data,error}=await supabase.from('memberships').update(req.body).eq('id',req.params.id).select().single();
    if(error) return res.status(500).json({error:error.message}); return res.json(data);}
  const db=rDB(); const i=(db.memberships||[]).findIndex(m=>m.id===req.params.id);
  if(i<0) return res.status(404).json({error:'Not found'});
  db.memberships[i]={...db.memberships[i],...req.body}; wDB(db); res.json(db.memberships[i]);
});
app.delete('/api/memberships/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('memberships').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Package not found — it may already have been deleted, or you may not have permission to delete it.'});
    return res.json({ok:true});
  }
  const db=rDB(); db.memberships=(db.memberships||[]).filter(m=>m.id!==req.params.id); wDB(db); res.json({ok:true});
});

// ════════════════════════════════════════════
//  FEEDBACK
// ════════════════════════════════════════════
app.get('/api/feedback',requireAdmin,async(req,res)=>{
  if(USE_SB){const{data}=await supabase.from('feedback').select('*').order('created_at',{ascending:false}); return res.json(data||[]);}
  res.json((rDB().feedback||[]).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)));
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
  const db=rDB(); if(!db.feedback)db.feedback=[]; db.feedback.unshift(fb); wDB(db);
  res.json({ok:true,data:fb});
});
app.put('/api/feedback/:id/read',requireAdmin,async(req,res)=>{
  if(USE_SB){await supabase.from('feedback').update({status:'read'}).eq('id',req.params.id); return res.json({ok:true});}
  const db=rDB(); const i=(db.feedback||[]).findIndex(f=>f.id===req.params.id);
  if(i>=0){db.feedback[i].status='read';wDB(db);} res.json({ok:true});
});
app.delete('/api/feedback/:id',requireAdmin,async(req,res)=>{
  if(USE_SB){
    const{data,error}=await supabase.from('feedback').delete().eq('id',req.params.id).select();
    if(error) return res.status(500).json({error:error.message});
    if(!data||!data.length) return res.status(404).json({error:'Feedback not found — it may already have been deleted, or you may not have permission to delete it.'});
    return res.json({ok:true});
  }
  const db=rDB(); db.feedback=(db.feedback||[]).filter(f=>f.id!==req.params.id); wDB(db); res.json({ok:true});
});

// ════════════════════════════════════════════
//  PAYMENT — MIDTRANS
// ════════════════════════════════════════════
app.post('/api/payment/create',async(req,res)=>{
  const{bookingData,amount,className}=req.body;
  if(!bookingData||!amount) return res.status(400).json({error:'Incomplete data.'});
  const orderId='AVAIA-'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();

  // If a valid member session is present, that identity is authoritative for credit
  // purposes — never trust a client-claimed member_id/email for spending someone
  // else's package credit. Guests (no token) simply have no credits to redeem.
  const verifiedMember = getSoftMemberAuth(req);
  if(verifiedMember){
    bookingData.member_id = verifiedMember.id;
    bookingData.email = verifiedMember.email;
  }

  // If the member has an active package with a credit available, redeem it instead of charging.
  const activePkg = verifiedMember ? await getActivePackage(bookingData.member_id, bookingData.email) : null;
  if(activePkg){
    const pending={id:orderId,...bookingData,status:'pending',amount:0,created_at:new Date().toISOString()};
    if(USE_SB) await supabase.from('pending_bookings').insert(pending);
    else{const db=rDB();if(!db.pendingBookings)db.pendingBookings=[];db.pendingBookings.push(pending);wDB(db);}
    try{
      const confirmed=await confirmBooking(orderId,'package_credit',activePkg.id);
      const remaining=Math.max(0,(activePkg.credits_total||0)-(activePkg.credits_used||0)-1);
      return res.json({ok:true,orderId,redeemed:true,booking:confirmed,creditsLeft:remaining,packageName:activePkg.package_name});
    }catch(e){ return res.status(500).json({error:e.message}); }
  }

  // Save pending booking (normal paid flow)
  const pending={id:orderId,...bookingData,status:'pending',amount,created_at:new Date().toISOString()};
  if(USE_SB) await supabase.from('pending_bookings').insert(pending);
  else{const db=rDB();if(!db.pendingBookings)db.pendingBookings=[];db.pendingBookings.push(pending);wDB(db);}

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
  }catch(e){console.error('Midtrans:',e.message);res.status(500).json({error:e.message});}
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
  const db=rDB();
  const b=[...(db.bookings||[]),...(db.pendingBookings||[])].find(x=>x.id===req.params.orderId);
  if(!b) return res.status(404).json({error:'Not found'});
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
  else pkg=(rDB().memberships||[]).find(m=>m.id===packageId);
  if(!pkg) return res.status(404).json({error:'Package not found.'});

  const orderId='AVAIA-PKG-'+Date.now()+'-'+Math.random().toString(36).slice(2,6).toUpperCase();
  const pending={
    id:orderId, member_id:memberId||null, member_email:memberEmail, member_name:memberName||'',
    member_phone:memberPhone||'', package_id:pkg.id, package_name:pkg.name,
    price:pkg.price, credits_total:pkg.credits||1, validity_days:pkg.validity_days||30,
    status:'pending', created_at:new Date().toISOString(),
  };
  if(USE_SB) await supabase.from('pending_package_purchases').insert(pending);
  else{const db=rDB();if(!db.pendingPackagePurchases)db.pendingPackagePurchases=[];db.pendingPackagePurchases.push(pending);wDB(db);}

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
  }catch(e){console.error('Midtrans:',e.message);res.status(500).json({error:e.message});}
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
  else all=rDB().memberPackages||[];
  res.json(all.map(p=>({...p,computed_status:computePkgStatus(p)})));
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
    all=(rDB().memberPackages||[]).filter(p=>(memberId&&p.member_id===memberId)||(email&&p.member_email===email));
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
  if(USE_SB){
    const{data}=await supabase.from('member_packages').select('credits_used').eq('id',memberPackageId).single();
    await supabase.from('member_packages').update({credits_used:(data?.credits_used||0)+1}).eq('id',memberPackageId);
  } else {
    const db=rDB(); const i=(db.memberPackages||[]).findIndex(p=>p.id===memberPackageId);
    if(i>=0){ db.memberPackages[i].credits_used=(db.memberPackages[i].credits_used||0)+1; wDB(db); }
  }
}

async function refundPackageCredit(memberPackageId){
  if(!memberPackageId) return;
  if(USE_SB){
    const{data}=await supabase.from('member_packages').select('credits_used').eq('id',memberPackageId).single();
    if(data) await supabase.from('member_packages').update({credits_used:Math.max(0,(data.credits_used||0)-1)}).eq('id',memberPackageId);
  } else {
    const db=rDB(); const i=(db.memberPackages||[]).findIndex(p=>p.id===memberPackageId);
    if(i>=0){ db.memberPackages[i].credits_used=Math.max(0,(db.memberPackages[i].credits_used||0)-1); wDB(db); }
  }
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
  let pending, confirmed, settings;
  if(USE_SB){
    const{data}=await supabase.from('pending_bookings').select('*').eq('id',orderId).single();
    pending=data;
    if(!pending) throw new Error('Pending booking not found: '+orderId);
    await supabase.from('pending_bookings').delete().eq('id',orderId);
    confirmed={...pending,status:'confirmed',payment_type:paymentType,paid_at:new Date().toISOString()};
    if(memberPackageId) confirmed.member_package_id=memberPackageId;
    await supabase.from('bookings').insert(confirmed);
    if(pending.schedule_id) await supabase.rpc('decrement_slots',{sched_id:pending.schedule_id});
    settings=rDB().settings;
    sendConfirmEmailWithInvoice(confirmed,settings.studioName||'Avaia Studio',settings);
  } else {
    const db=rDB();
    if(!db.pendingBookings) db.pendingBookings=[];
    const idx=db.pendingBookings.findIndex(b=>b.id===orderId);
    if(idx<0) throw new Error('Pending booking not found: '+orderId);
    pending=db.pendingBookings.splice(idx,1)[0];
    confirmed={...pending,status:'confirmed',payment_type:paymentType,paid_at:new Date().toISOString()};
    if(memberPackageId) confirmed.member_package_id=memberPackageId;
    if(!db.bookings) db.bookings=[];
    db.bookings.unshift(confirmed);
    if(pending.schedule_id){const si=db.schedule.findIndex(s=>s.id===pending.schedule_id);if(si>=0&&db.schedule[si].slots>0)db.schedule[si].slots--;}
    wDB(db);
    settings=db.settings||{};
    sendConfirmEmailWithInvoice(confirmed,settings.studioName||'Avaia Studio',settings);
  }

  if(memberPackageId) await redeemPackageCredit(memberPackageId);

  broadcastScheduleUpdate();
  pushNotif({
    audience:'admin', type:'booking',
    title:'New booking confirmed',
    message:`${confirmed.name} booked ${confirmed.class} on ${confirmed.date} ${confirmed.time}${memberPackageId?' (via package credit)':''}.`,
    link:'/admin#bookings',
  });
  if(confirmed.member_id || confirmed.email){
    pushNotif({
      audience:'member', memberId:confirmed.member_id, memberEmail:confirmed.email,
      type:'success', title:'Booking Confirmed',
      message: memberPackageId
        ? `${confirmed.class} — ${confirmed.date} at ${confirmed.time}. 1 class credit used.`
        : `${confirmed.class} — ${confirmed.date} at ${confirmed.time}. Your invoice is ready to download.`,
      link:'/dashboard',
    });
  }
  return confirmed;
}

async function cancelBooking(orderId,reason){
  if(USE_SB){await supabase.from('pending_bookings').update({status:'cancelled_'+reason}).eq('id',orderId); return;}
  const db=rDB(); if(!db.pendingBookings) return;
  const i=db.pendingBookings.findIndex(b=>b.id===orderId);
  if(i>=0){db.pendingBookings[i].status='cancelled_'+reason;wDB(db);}
}

// ── MEMBERSHIP PACKAGE PURCHASE — confirm/cancel ──
async function confirmPackagePurchase(orderId,paymentType){
  let pending, purchased, settings;
  const now=new Date();

  if(USE_SB){
    const{data}=await supabase.from('pending_package_purchases').select('*').eq('id',orderId).single();
    pending=data;
    if(!pending) throw new Error('Pending package purchase not found: '+orderId);
    await supabase.from('pending_package_purchases').delete().eq('id',orderId);
    const expires=new Date(now.getTime()+(pending.validity_days||30)*24*60*60*1000);
    purchased={
      id:uuidv4(), member_id:pending.member_id, member_email:pending.member_email, member_name:pending.member_name,
      package_name:pending.package_name, price_paid:pending.price, credits_total:pending.credits_total, credits_used:0,
      payment_type:paymentType, purchased_at:now.toISOString(), expires_at:expires.toISOString(), status:'active',
    };
    await supabase.from('member_packages').insert(purchased);
    if(pending.member_id) await supabase.from('members').update({membership_type:pending.package_name}).eq('id',pending.member_id);
    settings=rDB().settings;
  } else {
    const db=rDB();
    if(!db.pendingPackagePurchases) db.pendingPackagePurchases=[];
    const idx=db.pendingPackagePurchases.findIndex(p=>p.id===orderId);
    if(idx<0) throw new Error('Pending package purchase not found: '+orderId);
    pending=db.pendingPackagePurchases.splice(idx,1)[0];
    const expires=new Date(now.getTime()+(pending.validity_days||30)*24*60*60*1000);
    purchased={
      id:uuidv4(), member_id:pending.member_id, member_email:pending.member_email, member_name:pending.member_name,
      package_name:pending.package_name, price_paid:pending.price, credits_total:pending.credits_total, credits_used:0,
      payment_type:paymentType, purchased_at:now.toISOString(), expires_at:expires.toISOString(), status:'active',
    };
    if(!db.memberPackages) db.memberPackages=[];
    db.memberPackages.unshift(purchased);
    const mi=db.members.findIndex(m=>m.id===pending.member_id || m.email===pending.member_email);
    if(mi>=0) db.members[mi].membership_type=pending.package_name;
    wDB(db);
    settings=db.settings||{};
  }

  // Invoice + email (reuses the same invoice generator/template as a class booking)
  try{
    const invoiceLike={
      id:purchased.id, name:purchased.member_name, email:purchased.member_email,
      class:purchased.package_name+' (Membership Package)',
      date:now.toLocaleDateString('en-US',{day:'numeric',month:'long',year:'numeric'}),
      time:'—', amount:purchased.price_paid, payment_type:purchased.payment_type, status:'confirmed',
      note:`${purchased.credits_total} class credits · valid until ${new Date(purchased.expires_at).toLocaleDateString('en-US',{day:'numeric',month:'long',year:'numeric'})}`,
      paid_at:purchased.purchased_at, created_at:purchased.purchased_at,
    };
    if(purchased.member_email){
      const t=emailBookingConfirm(invoiceLike,settings.studioName||'Avaia Studio');
      const pdfBuf=await generateInvoicePDF(invoiceLike,settings);
      sendMail({to:purchased.member_email,...t,attachments:[{filename:`invoice-${purchased.id}.pdf`,content:pdfBuf}]})
        .catch(e=>console.error('Email:',e.message));
    }
  }catch(e){ console.error('Package invoice/email error:',e.message); }

  pushNotif({
    audience:'admin', type:'booking',
    title:'New package purchased',
    message:`${purchased.member_name} purchased ${purchased.package_name} (${purchased.credits_total} classes).`,
    link:'/admin#members',
  });
  pushNotif({
    audience:'member', memberId:purchased.member_id, memberEmail:purchased.member_email,
    type:'success', title:'Package Purchased',
    message:`${purchased.package_name} is now active — ${purchased.credits_total} class credits, valid until ${new Date(purchased.expires_at).toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric'})}.`,
    link:'/dashboard',
  });
  return purchased;
}

async function cancelPackagePurchase(orderId,reason){
  if(USE_SB){await supabase.from('pending_package_purchases').update({status:'cancelled_'+reason}).eq('id',orderId); return;}
  const db=rDB(); if(!db.pendingPackagePurchases) return;
  const i=db.pendingPackagePurchases.findIndex(p=>p.id===orderId);
  if(i>=0){db.pendingPackagePurchases[i].status='cancelled_'+reason;wDB(db);}
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
  } else { const db=rDB(); booking=db.bookings.find(b=>b.id===req.params.id); }
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
    await supabase.from('bookings').update({status:'cancelled',cancelled_at:new Date().toISOString()}).eq('id',req.params.id);
    if(booking.schedule_id) await supabase.rpc('increment_slots',{sched_id:booking.schedule_id});
  } else {
    const db=rDB();
    const bi=db.bookings.findIndex(b=>b.id===req.params.id);
    if(bi>=0){db.bookings[bi].status='cancelled';db.bookings[bi].cancelled_at=new Date().toISOString();}
    if(booking.schedule_id){const si=db.schedule.findIndex(s=>s.id===booking.schedule_id);if(si>=0)db.schedule[si].slots++;}
    wDB(db);
  }
  if(booking.payment_type==='package_credit' && booking.member_package_id){
    await refundPackageCredit(booking.member_package_id);
  }
  if(booking.email){
    const db=rDB();
    const t=emailCancellation(booking,db.settings?.studioName||'Avaia Studio');
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
  } else { const db=rDB(); bookings=(db.bookings||[]).filter(b=>b.status==='confirmed'); }
  const db=rDB(); const studioName=db.settings?.studioName||'Avaia Studio';
  let sent=0,failed=0;
  for(const b of bookings){
    if(!b.email||b.reminder_sent) continue;
    try{
      const t=emailBookingReminder(b,studioName);
      const r=await sendMail({to:b.email,...t});
      if(r.ok){
        if(!USE_SB){
          const ldb=rDB(); const i=ldb.bookings.findIndex(x=>x.id===b.id);
          if(i>=0){ldb.bookings[i].reminder_sent=true;wDB(ldb);}
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
  else bookings=rDB().bookings||[];
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
  else bookings=rDB().bookings||[];
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
    const db=rDB();
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
  } else { booking=(rDB().bookings||[]).find(b=>b.id===req.params.id); }

  // Not a class booking? Check if it's a membership package purchase instead.
  if(!booking){
    let pkg;
    if(USE_SB){ const{data}=await supabase.from('member_packages').select('*').eq('id',req.params.id).single(); pkg=data; }
    else { pkg=(rDB().memberPackages||[]).find(p=>p.id===req.params.id); }
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
    const settings=USE_SB?(await supabase.from('settings').select('*').single()).data||{}:(rDB().settings||{});
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
  else all=rDB().notifications||[];
  const mine=all.filter(n=>n.audience==='member' && ((req.user.id&&n.memberId===req.user.id)||(req.user.email&&n.memberEmail===req.user.email)));
  res.json(mine.slice(0,50));
});

app.get('/api/notifications/admin',requireStaff,async(req,res)=>{
  let all;
  if(USE_SB){ const{data}=await supabase.from('notifications').select('*').order('created_at',{ascending:false}); all=data||[]; }
  else all=rDB().notifications||[];
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
  else notif=(rDB().notifications||[]).find(n=>n.id===req.params.id);
  if(!notif) return res.status(404).json({error:'Notification not found.'});

  const isStaff=['admin','instructor'].includes(decoded.role);
  const isOwner=decoded.role==='member' && (notif.memberId===decoded.id || notif.memberEmail===decoded.email);
  if(!((isStaff && notif.audience==='admin') || (isOwner && notif.audience==='member')))
    return res.status(403).json({error:'Not allowed.'});

  if(USE_SB){ await supabase.from('notifications').update({read:true}).eq('id',req.params.id); }
  else{ const db=rDB(); const i=(db.notifications||[]).findIndex(n=>n.id===req.params.id); if(i>=0){db.notifications[i].read=true; wDB(db);} }
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
  const db=rDB();
  (db.notifications||[]).forEach(n=>{
    if(isStaff && n.audience==='admin') n.read=true;
    else if(isMember && n.audience==='member' && (n.memberId===decoded.id || n.memberEmail===decoded.email)) n.read=true;
  });
  wDB(db); res.json({ok:true});
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

app.listen(PORT,()=>{
  console.log(`\n🌿 Avaia Studio → http://localhost:${PORT}`);
  console.log(`   DB:       ${USE_SB?'Supabase ☁':'db.json (local)'}`);
  console.log(`   Payment:  ${USE_MT?'Midtrans '+MT_ENV:'Simulation mode'}`);
  console.log(`   Email:    ${USE_EMAIL?EMAIL_USER:'Not configured'}`);
  console.log(`   Realtime: Polling (every few seconds)`);
  console.log(`   Admin:    http://localhost:${PORT}/admin\n`);
});
