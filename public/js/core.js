/* ═══════════════════════════════════════
   AVAIA STUDIO — core.js v6 FINAL (English)
   Boot: settings → nav → footer → modals → pageInit
═══════════════════════════════════════ */
const API='';
let ST={}, CU=null, _payStatus={configured:false,env:'sandbox',clientKey:''};

const MON =['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY =['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const DAYS=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/* ── FETCH INTERCEPTOR ──
   Automatically attaches the member session token to every request to /api/,
   so it doesn't need to be repeated manually in every fetch() call. ── */
const _origFetch = window.fetch;

// Retry only transient/idempotent requests so failed GETs can recover from
// short network blips, gateway errors, or rate-limit responses. Mutating
// requests (POST/PATCH/PUT/DELETE) are deliberately not retried automatically
// to avoid duplicate bookings, payments, registrations, etc.
const RETRY_STATUS = new Set([408, 429, 502, 503, 504]);
const RETRY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const RETRY_MAX = 3;
const RETRY_BASE_MS = 350;

function sleep(ms){ return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchWithTransientRetry(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  if (!RETRY_METHODS.has(method)) return _origFetch(url, options);

  let attempt = 0;
  while (true) {
    try {
      const res = await _origFetch(url, options);
      if (!RETRY_STATUS.has(res.status) || attempt >= RETRY_MAX) return res;

      const retryAfter = Number(res.headers.get('Retry-After'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 8000)
        : Math.min(RETRY_BASE_MS * (2 ** attempt), 4000);
      const jitter = Math.floor(Math.random() * 150);
      await sleep(backoff + jitter);
      attempt += 1;
    } catch (err) {
      if (attempt >= RETRY_MAX) throw err;
      await sleep(Math.min(RETRY_BASE_MS * (2 ** attempt), 4000) + Math.floor(Math.random() * 150));
      attempt += 1;
    }
  }
}

window.fetch = function(url, options = {}) {
  if (typeof url === 'string' && url.startsWith('/api/')) {
    const token = localStorage.getItem('avaia_member_token');
    if (token) {
      options.headers = { ...(options.headers || {}), 'Authorization': 'Bearer ' + token };
    }
  }
  return fetchWithTransientRetry(url, options).then(res => {
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
      // Session expired, invalid, or the member account no longer exists (e.g. an
      // admin deleted it) — fully sign the person out on this device instead of just
      // dropping the token, otherwise the cached profile keeps them "logged in" with
      // no way to register again.
      const wasSignedIn = !!CU;
      clearUser();
      if (wasSignedIn) {
        renderNav();
        if (window.location.pathname === '/dashboard') {
          toast('Your session has ended. Please sign in again.', 'err');
          setTimeout(() => { window.location.href = '/'; }, 1200);
        }
      }
    }
    return res;
  });
};

/* ── BOOT ── */
document.addEventListener('DOMContentLoaded', async () => {
  injectNav();
  injectModals();
  applyI18n();

  // Restore the local session before any page initialization.
  restoreUser();
  renderNav();

  // Settings are public and must be loaded independently of auth state.
  await Promise.all([loadST(), loadPayStatus()]);

  renderFooter();
  initSocket();

  if (CU) loadMemberNotifs();
  if (typeof pageInit === 'function') pageInit();

  applyI18n();
});

/* ── SETTINGS ── */
async function loadST(){
  try{
    // Settings are public. Do not send a member token and do not reuse a cached response.
    const r=await _origFetch(API+'/api/settings', {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache' }
    });
    if(!r.ok){
      console.error('settings fetch failed:',r.status);
      return; // keep whatever ST already had rather than overwriting it with an error body
    }
    const data=await r.json();
    if(data && !data.error){ ST=data; applyTheme(); }
  }
  catch(e){ console.error('settings',e); }
}
function applyTheme(){
  const r=document.documentElement;
  if(ST.primaryColor) r.style.setProperty('--p',ST.primaryColor);
  if(ST.accentColor)  r.style.setProperty('--a',ST.accentColor);
  if(ST.bgColor)      r.style.setProperty('--bg',ST.bgColor);
  const n=ST.studioName||'Avaia Studio';
  document.querySelectorAll('[data-brand]').forEach(e=>e.textContent=n);
  document.title=(window.PAGE_TITLE?window.PAGE_TITLE+' — ':'')+n;
}

/* ── PAYMENT STATUS ── */
async function loadPayStatus(){
  try{ const r=await fetch(API+'/api/status'); const d=await r.json();
    _payStatus={configured:d.midtrans,env:d.midtransEnv||'sandbox',clientKey:d.midtransClientKey||''}; }
  catch(e){}
}

/* ── NAV (for non-home pages: burger bar) ── */
function injectNav(){
  const nav=document.getElementById('main-nav');
  if(!nav) return;
  nav.innerHTML=`
    <button class="burger" id="burger" onclick="toggleDrawer()" aria-label="Menu">
      <span></span><span></span><span></span>
    </button>
    <a href="/" class="nav-logo"><img src="/img/logo.svg" class="brand-icon" alt="Avaia Studio"></a>
    <div class="nav-right" id="nav-right"></div>`;
}

function langToggleHTML(size){
  return `<button class="btn bol ${size||'bsm'}" onclick="toggleLang()" title="${getLang()==='en'?'Ganti ke Bahasa Indonesia':'Switch to English'}">${getLang()==='en'?'ID':'EN'}</button>`;
}

function renderNav(){
  const name=ST.studioName||'Avaia Studio';
  document.querySelectorAll('[data-brand]').forEach(e=>e.textContent=name);
  const r=document.getElementById('nav-right');
  if(r){
    r.innerHTML=(CU
      ?`<div class="notif-wrap">
          <button class="notif-bell" id="notif-bell" onclick="toggleNotifPanel()" aria-label="Notifications">
            <svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            <span class="notif-dot" id="notif-dot"></span>
          </button>
          <div class="notif-panel" id="notif-panel">
            <div class="notif-panel-head"><strong>${t('notif.title')}</strong><button class="notif-mark-all" onclick="markAllNotifsRead(event)">${t('notif.markallread')}</button></div>
            <div class="notif-list" id="notif-list"><div class="notif-empty">${t('notif.loading')}</div></div>
          </div>
        </div>
        <a href="/dashboard" class="btn bol bsm">${(CU.name||CU.email).split(' ')[0]}</a>`
      :`<button class="btn bol bsm" onclick="openMo('login-mo')">${t('nav.signin')}</button>`)
      +langToggleHTML();
  }
  const pg=window.PAGE_ID||'';
  const links=[
    {href:'/',id:'home',label:t('nav.home')},
    {href:'/schedule',id:'schedule',label:t('nav.schedule')},
    {href:'/classes',id:'classes',label:t('nav.classes')},
    {href:'/pricing',id:'pricing',label:t('nav.membership')},
    {href:'/about',id:'about',label:t('nav.about')},
    {href:'/locate',id:'locate',label:t('nav.locate')},
    {href:'/feedback',id:'feedback',label:t('nav.feedback')},
  ];
  const dn=document.querySelector('.drawer-nav');
  if(dn) dn.innerHTML=links.map(l=>`<a href="${l.href}" class="drawer-link ${l.id===pg?'active':''}">${l.label}</a>`).join('');
  const df=document.querySelector('.drawer-foot');
  if(df) df.innerHTML=(CU
    ?`<a href="/dashboard" class="btn bo bsm" style="width:100%;justify-content:center;text-align:center">${t('nav.dashboard')}</a>
      <button class="btn bsm" style="background:var(--sd);color:var(--mt);border:none;width:100%" onclick="doLogout()">${t('nav.signout')}</button>`
    :`<button class="btn bp bsm" style="width:100%" onclick="closeDrawer();openMo('login-mo')">${t('nav.signin')}</button>
      <button class="btn bo bsm" style="width:100%" onclick="closeDrawer();openMo('reg-mo')">${t('modal.register.submit')}</button>`)
    +`<div style="margin-top:10px;text-align:center">${langToggleHTML()}</div>`;
}

/* ── DRAWER ── */
function toggleDrawer(){
  const b=document.getElementById('burger'),d=document.querySelector('.nav-drawer'),o=document.getElementById('nav-overlay');
  const op=d&&!d.classList.contains('open');
  b?.classList.toggle('open',op); d?.classList.toggle('open',op); o?.classList.toggle('open',op);
  document.body.style.overflow=op?'hidden':'';
}
function closeDrawer(){
  document.getElementById('burger')?.classList.remove('open');
  document.querySelector('.nav-drawer')?.classList.remove('open');
  document.getElementById('nav-overlay')?.classList.remove('open');
  document.body.style.overflow='';
}

/* ── FOOTER ── */
function renderFooter(){
  const f=document.getElementById('main-footer'); if(!f) return;
  const n=ST.studioName||'Avaia Studio';
  f.className='footer';
  f.innerHTML=`
    <div class="footer-g">
      <div>
        <div class="f-brand"><img src="/img/logo.svg" class="brand-icon" alt="Avaia Studio"></div>
        <p class="f-desc">${t('footer.desc')}</p>
      </div>
      <div>
        <p class="f-col-t">${t('footer.pages')}</p>
        <ul class="f-links">
          <li><a href="/">${t('nav.home')}</a></li><li><a href="/schedule">${t('nav.schedule')}</a></li>
          <li><a href="/classes">${t('nav.classes')}</a></li><li><a href="/pricing">${t('nav.membership')}</a></li>
          <li><a href="/about">${t('nav.about')}</a></li><li><a href="/locate">${t('nav.locate')}</a></li>
          <li><a href="/feedback">${t('nav.feedback')}</a></li>
        </ul>
      </div>
      <div>
        <p class="f-col-t">${t('footer.contact')}</p>
        <ul class="f-links" id="f-contact"></ul>
      </div>
    </div>
    <div class="f-btm">
      <span>© ${new Date().getFullYear()} ${n}</span>
      <ul class="f-btm-links">
        <li><a href="/booking-policy">${t('footer.bookingpolicy')}</a></li>
        <li><a href="/cancel-policy">${t('footer.cancelpolicy')}</a></li>
        <li><a href="/membership-policy">${t('footer.membershippolicy')}</a></li>
        <li><a href="/house-rules">${t('footer.houserules')}</a></li>
        <li><a href="/terms">${t('footer.terms')}</a></li>
      </ul>
      <span>${t('footer.location')}</span>
    </div>`;
  const fc=document.getElementById('f-contact');
  if(fc) fc.innerHTML=[ST.address,ST.phone,ST.email,ST.hours].filter(Boolean).map(v=>`<li>${v}</li>`).join('');
}

/* ── SESSION ── */
function restoreUser(){
  try {
    const s = localStorage.getItem('avaia_u');
    CU = s ? JSON.parse(s) : null;
  } catch(e) {
    CU = null;
    localStorage.removeItem('avaia_u');
    localStorage.removeItem('avaia_member_token');
  }
}

function saveUser(u){
  CU = u;
  localStorage.setItem('avaia_u', JSON.stringify(u));
}

function clearAllSessions(){
  // One source of truth for client-side identity state.
  // Never leave a member token and a staff token in the browser at the same time.
  CU = null;

  const sessionKeys = [
    'avaia_u',
    'avaia_member_token',
    'avaia_staff',
    'avaia_staff_user'
  ];

  sessionKeys.forEach(key => {
    try { localStorage.removeItem(key); } catch(e) {}
  });

  // Also remove any legacy session keys from older builds if they still exist.
  [
    'currentUser',
    'user',
    'CU',
    'authToken',
    'adminToken',
    'staffToken',
    'memberToken',
    'currentStaff',
    'currentStaffUser'
  ].forEach(key => {
    try {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    } catch(e) {}
  });

  try { sessionStorage.clear(); } catch(e) {}
}

function clearUser(){
  clearAllSessions();
}

/* ── AUTH ── */
async function doLogin(){
  const identity=gv('li-email'),pass=gv('li-pass');
  if(!identity||!pass){toast(t('msg.enteremailpass'),'err');return;}

  // Clear every previous local identity before starting a new login.
  clearAllSessions();

  try{
    // Send every login through the unified endpoint. The server first checks
    // staff accounts, then member accounts by email or registered name.
    const loginEndpoint = '/api/auth/login';
    const loginBody = {identity, email: identity, username: identity, password: pass};

    const r=await _origFetch(API+loginEndpoint,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(loginBody)
    });
    const d=await r.json();

    if(d.ok){
      if(d.user?.role==='admin' || d.user?.role==='instructor'){
        localStorage.removeItem('avaia_member_token');
        localStorage.removeItem('avaia_u');
        localStorage.setItem('avaia_staff',d.token);
        localStorage.setItem('avaia_staff_user',JSON.stringify(d.user));
        closeMo('login-mo');
        toast(t('msg.welcomeback')+' '+(d.user.name||d.user.username||'')+'!','ok');
        setTimeout(()=>window.location.href='/admin',500);
      }else{
        localStorage.removeItem('avaia_staff');
        localStorage.removeItem('avaia_staff_user');
        localStorage.setItem('avaia_member_token',d.token);
        saveUser(d.user);closeMo('login-mo');renderNav();
        toast(t('msg.welcomeback')+' '+(d.user.name||d.user.email).split(' ')[0]+'!','ok');
        loadMemberNotifs();
        if(typeof onAfterLogin==='function') onAfterLogin(d.user);
      }
      return;
    }

    toast(d.error||t('msg.wrongcreds'),'err');
  }catch(e){
    console.error('login',e);
    toast(t('msg.connerror'),'err');
  }
}

async function doRegister(){
  const fn=gv('rg-fn'),ln=gv('rg-ln'),email=gv('rg-email'),phone=gv('rg-ph'),pass=gv('rg-pw'),conf=gv('rg-cf');
  if(!fn||!email||!pass){toast(t('msg.nameemailpassrequired'),'err');return;}
  if(pass!==conf){toast(t('msg.passwordsnomatch'),'err');return;}
  if(pass.length<8){toast(t('msg.password8'),'err');return;}
  try{
    const r=await fetch(API+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:fn+' '+ln,email,phone,password:pass})});
    const d=await r.json();
    if(d.ok && d.needsEmailConfirmation){
      // Account created, but Supabase requires email confirmation before
      // it can sign in — do NOT store a token or treat this as logged in.
      qs('#rg-form').style.display='none';
      qs('#rg-ok-msg').textContent=d.message||t('msg.checkemailconfirm');
      qs('#rg-ok').classList.add('show');
      return;
    }
    if(d.ok){
      localStorage.removeItem('avaia_staff');
      localStorage.removeItem('avaia_staff_user');

      localStorage.setItem('avaia_member_token',d.token);
      saveUser(d.user);renderNav();
      qs('#rg-form').style.display='none';
      qs('#rg-ok-msg').textContent=t('msg.welcome')+' '+fn+t('msg.registeredwith');
      qs('#rg-ok').classList.add('show');
      if(typeof onAfterLogin==='function') onAfterLogin(d.user);
    }else toast(d.error||t('msg.registrationfailed'),'err');
  }catch(e){toast(t('msg.connerror'),'err');}
}

async function doForgotPassword(){
  const email = gv('fp-email');
  if(!email){ toast(t('msg.enteremail'),'err'); return; }
  try{
    const r = await fetch(API+'/api/auth/forgot-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email})});
    const d = await r.json();
    if(d.ok){
      qs('#fp-form').style.display='none';
      qs('#fp-ok').classList.add('show');
    }else{
      toast(d.error||t('msg.connerror'),'err');
    }
  }catch(e){
    toast(t('msg.connerror'),'err');
  }
}

async function doLogout(){
  // Clear browser identity FIRST so a second account can never inherit the
  // previous member/staff session.
  clearAllSessions();
  closeDrawer();
  renderNav();

  // JWT sessions are stateless on the server, so there is nothing to revoke
  // server-side. The important part is removing every local identity token.
  toast(t('msg.signedout'));
  setTimeout(() => {
    window.location.replace('/');
  }, 250);
}

/* ── MODALS ── */
function injectModals(){
  if(document.getElementById('login-mo')) return;
  const div=document.createElement('div');
  div.innerHTML=`
  <div class="mo" id="login-mo">
    <div class="mbox" style="max-width:420px">
      <button class="mc" onclick="closeMo('login-mo')">&#215;</button>
      <p class="m-eye">Avaia Studio</p>
      <h2 class="m-title" style="margin-bottom:22px">${t('modal.login.title')}</h2>
      <div class="fg"><label class="fl">Email or Username</label><input type="text" class="fi" id="li-email" placeholder="email@example.com or your registered name" onkeydown="if(event.key==='Enter')doLogin()"></div>
      <div class="fg"><label class="fl">${t('modal.login.password')}</label><input type="password" class="fi" id="li-pass" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()"></div>
      <p style="text-align:right;margin:-8px 0 16px"><a href="#" onclick="closeMo('login-mo');openMo('forgot-mo');return false" style="font-size:12.5px;color:var(--mt)">${t('modal.login.forgotpw')}</a></p>
      <button class="btn bp" style="width:100%" onclick="doLogin()">${t('modal.login.submit')}</button>
      <p style="text-align:center;margin-top:14px;font-size:13px;color:var(--mt)">${t('modal.login.noaccount')} <a href="#" onclick="closeMo('login-mo');openMo('reg-mo')" style="color:var(--p)">${t('modal.login.signup')}</a></p>
    </div>
  </div>
  <div class="mo" id="forgot-mo">
    <div class="mbox" style="max-width:400px">
      <button class="mc" onclick="closeMo('forgot-mo')">&#215;</button>
      <p class="m-eye">Avaia Studio</p>
      <h2 class="m-title" style="margin-bottom:10px">${t('modal.forgotpw.title')}</h2>
      <div id="fp-form">
        <p class="m-sub" style="margin-bottom:18px">${t('modal.forgotpw.subtitle')}</p>
        <div class="fg"><label class="fl">${t('modal.login.email')}</label><input type="email" class="fi" id="fp-email" placeholder="email@example.com" onkeydown="if(event.key==='Enter')doForgotPassword()"></div>
        <button class="btn bp" style="width:100%" onclick="doForgotPassword()">${t('modal.forgotpw.submit')}</button>
      </div>
      <div class="ok-wrap" id="fp-ok">
        <div class="ok-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h3 style="font-family:var(--fd);font-size:22px;font-weight:600;margin-bottom:8px">${t('modal.forgotpw.sent.title')}</h3>
        <p style="font-size:14px;color:var(--mt)">${t('modal.forgotpw.sent.msg')}</p>
      </div>
      <p style="text-align:center;margin-top:16px;font-size:13px;color:var(--mt)"><a href="#" onclick="closeMo('forgot-mo');openMo('login-mo')" style="color:var(--p)">${t('modal.forgotpw.backtologin')}</a></p>
    </div>
  </div>
  <div class="mo" id="reg-mo">
    <div class="mbox" style="max-width:460px">
      <button class="mc" onclick="closeMo('reg-mo')">&#215;</button>
      <p class="m-eye">${t('modal.register.eyebrow')}</p>
      <h2 class="m-title" style="margin-bottom:4px">${t('modal.register.title')}</h2>
      <p class="m-sub">${t('modal.register.subtitle')}</p>
      <div id="rg-form">
        <div class="fr"><div class="fg"><label class="fl">${t('modal.register.firstname')}</label><input type="text" class="fi" id="rg-fn" placeholder="${t('modal.register.firstname')}"></div>
        <div class="fg"><label class="fl">${t('modal.register.lastname')}</label><input type="text" class="fi" id="rg-ln" placeholder="${t('modal.register.lastname')}"></div></div>
        <div class="fg"><label class="fl">${t('modal.register.email')}</label><input type="email" class="fi" id="rg-email" placeholder="email@example.com"></div>
        <div class="fg"><label class="fl">${t('modal.register.whatsapp')}</label><input type="tel" class="fi" id="rg-ph" placeholder="+62 812 3456 7890"></div>
        <div class="fg"><label class="fl">${t('modal.register.password')}</label><input type="password" class="fi" id="rg-pw" placeholder="${t('msg.password8')}"></div>
        <div class="fg"><label class="fl">${t('modal.register.confirmpassword')}</label><input type="password" class="fi" id="rg-cf" placeholder="••••••••"></div>
        <button class="btn bp" style="width:100%" onclick="doRegister()">${t('modal.register.submit')}</button>
        <p style="text-align:center;margin-top:14px;font-size:13px;color:var(--mt)">${t('modal.register.hasaccount')} <a href="#" onclick="closeMo('reg-mo');openMo('login-mo')" style="color:var(--p)">${t('modal.register.signin')}</a></p>
      </div>
      <div class="ok-wrap" id="rg-ok">
        <div class="ok-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h3 style="font-family:var(--fd);font-size:24px;font-weight:600;margin-bottom:8px">${t('modal.register.created')}</h3>
        <p id="rg-ok-msg" style="font-size:14px;color:var(--mt)"></p>
        <button class="btn bp" style="margin-top:18px" onclick="closeMo('reg-mo')">${t('modal.register.startbooking')}</button>
      </div>
    </div>
  </div>
  <div class="mo" id="bk-mo">
    <div class="mbox">
      <button class="mc" onclick="closeMo('bk-mo')">&#215;</button>
      <p class="m-eye">${t('modal.booking.eyebrow')}</p>
      <h2 class="m-title" id="bk-title">—</h2>
      <p class="m-sub" id="bk-meta">—</p>
      <div class="bk-bar">
        <div class="bk-bi bk-bi-date">
          <select id="bk-date-select" class="bk-date-select" onchange="onBookingDateChange()"></select>
          <span class="lbl">${t('modal.booking.date')}</span>
        </div>
        <div class="bk-bi"><strong id="bk-time">—</strong><span class="lbl">${t('modal.booking.time')}</span></div>
        <div class="bk-bi"><strong id="bk-price">—</strong><span class="lbl">${t('modal.booking.price')}</span></div>
      </div>
      <div id="bk-form">
        <div class="fr">
          <div class="fg"><label class="fl">${t('modal.booking.firstname')}</label><input type="text" class="fi" id="bk-fn"></div>
          <div class="fg"><label class="fl">${t('modal.booking.lastname')}</label><input type="text" class="fi" id="bk-ln"></div>
        </div>
        <div class="fg"><label class="fl">${t('modal.booking.email')}</label><input type="email" class="fi" id="bk-email"></div>
        <div class="fg"><label class="fl">${t('modal.booking.whatsapp')}</label><input type="tel" class="fi" id="bk-phone"></div>
        <div class="fg"><label class="fl">${t('modal.booking.note')}</label><input type="text" class="fi" id="bk-note" placeholder="${t('modal.booking.noteph')}"></div>
        <div style="background:var(--bg);border:1px solid var(--ln);padding:14px;margin-bottom:16px;font-size:13px;color:var(--mt)" id="bk-pay-info">
          ${t('modal.booking.payinfo')}
        </div>
        <button class="btn bp" style="width:100%" id="bk-submit-btn" onclick="submitBookingWithPayment()">${t('modal.booking.continue')}</button>
      </div>
      <div class="ok-wrap" id="bk-ok">
        <div class="ok-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h3 style="font-family:var(--fd);font-size:24px;font-weight:600;margin-bottom:8px">${t('modal.booking.confirmed')}</h3>
        <p id="bk-ok-msg" style="font-size:14px;color:var(--mt)"></p>
        <button class="btn bo" style="margin-top:18px" onclick="closeMo('bk-mo')">${t('modal.booking.close')}</button>
      </div>
    </div>
  </div>
  <div class="mo" id="pkg-mo">
    <div class="mbox">
      <button class="mc" onclick="closeMo('pkg-mo')">&#215;</button>
      <p class="m-eye">${t('modal.package.eyebrow')}</p>
      <h2 class="m-title" id="pkg-title">—</h2>
      <p class="m-sub" id="pkg-meta">—</p>
      <div class="bk-bar">
        <div class="bk-bi" style="grid-column:span 3"><strong id="pkg-price">—</strong><span class="lbl">${t('modal.package.price')}</span></div>
      </div>
      <div id="pkg-form">
        <div style="background:var(--bg);border:1px solid var(--ln);padding:14px;margin-bottom:16px;font-size:13px;color:var(--mt)" id="pkg-pay-info">
          ${t('modal.booking.payinfo')}
        </div>
        <button class="btn bp" style="width:100%" id="pkg-submit-btn" onclick="submitPackagePurchase()">${t('modal.package.paynow')}</button>
      </div>
      <div class="ok-wrap" id="pkg-ok">
        <div class="ok-icon"><svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg></div>
        <h3 style="font-family:var(--fd);font-size:24px;font-weight:600;margin-bottom:8px">${t('modal.package.purchased')}</h3>
        <p id="pkg-ok-msg" style="font-size:14px;color:var(--mt)"></p>
        <button class="btn bo" style="margin-top:18px" onclick="closeMo('pkg-mo');window.location.href='/dashboard'">${t('modal.package.godashboard')}</button>
      </div>
    </div>
  </div>
  <div id="_toast" class="toast"></div>`;
  document.body.appendChild(div);
  document.querySelectorAll('.mo').forEach(el=>{
    el.addEventListener('click',function(e){if(e.target===this){this.classList.remove('open');document.body.style.overflow='';}});
  });
}

function openMo(id){const el=document.getElementById(id);if(el){el.classList.add('open');document.body.style.overflow='hidden';}}
function closeMo(id){const el=document.getElementById(id);if(el){el.classList.remove('open');document.body.style.overflow='';}}

/* ── BOOKING + PAYMENT ── */
let _BK=null;

// Booking sessions are tied to ONE exact calendar date. The booking modal
// therefore never generates a recurring weekly list; it uses the date of the
// schedule row that the member actually clicked.
function openBooking(schedId,name,dayName,preferredDateStr,time,instructor,slots,price){
  const dateStr = preferredDateStr || '';
  _BK={schedId,name,dayName,dateStr,time,instructor,slots,price:price||85000};
  qs('#bk-title').textContent=name;
  qs('#bk-meta').textContent='Instructor: '+instructor+' · '+slots+' spots left';
  const dsel=document.getElementById('bk-date-select');
  if(dsel){
    dsel.innerHTML = `<option value="0">${esc(dateStr)}</option>`;
    dsel.value='0';
    dsel.disabled=true;
  }
  qs('#bk-time').textContent=time;
  qs('#bk-price').textContent='IDR '+Number(_BK.price).toLocaleString('en-US');
  if(CU){
    const p=(CU.name||'').split(' ');
    sv('bk-fn',p[0]||'');sv('bk-ln',p.slice(1).join(' ')||'');
    sv('bk-email',CU.email||'');sv('bk-phone',CU.phone||'');
  }else['bk-fn','bk-ln','bk-email','bk-phone'].forEach(id=>sv(id,''));
  sv('bk-note','');
  qs('#bk-form').style.display='block';
  qs('#bk-ok').classList.remove('show');
  const btn=document.getElementById('bk-submit-btn');
  if(btn){btn.textContent='Continue to Payment';btn.disabled=false;}
  const info=document.getElementById('bk-pay-info');
  if(info) info.innerHTML=_payStatus.configured
    ?'Payment via Midtrans: QRIS, GoPay, OVO, Bank Transfer, Credit Card, Indomaret, etc.'
    :'<span style="color:var(--a)">⚠ Simulation mode active.</span> Configure Midtrans in .env for real payments.';
  openMo('bk-mo');
}

function onBookingDateChange(){
  if(!_BK) return;
  // Kept for compatibility with existing markup. Date is fixed by the exact
  // schedule session and cannot be changed to another week.
  _BK.dateStr = _BK.dateStr;
}

async function ensureSnapLoaded(){
  if(window.snap) return;
  const s=document.createElement('script');
  s.src=_payStatus.env==='production'?'https://app.midtrans.com/snap/snap.js':'https://app.sandbox.midtrans.com/snap/snap.js';
  s.setAttribute('data-client-key',_payStatus.clientKey);
  document.head.appendChild(s);
  await new Promise(res=>s.onload=res);
}

async function submitBookingWithPayment(){
  const fn=gv('bk-fn'),ln=gv('bk-ln'),email=gv('bk-email'),phone=gv('bk-phone'),note=gv('bk-note');
  if(!fn||!email||!phone){toast(t('msg.fillbookingfields'),'err');return;}
  const btn=document.getElementById('bk-submit-btn');
  if(btn){btn.textContent=t('msg.processing');btn.disabled=true;}
  const bookingData={
    name:fn+' '+ln,class:_BK.name,date:_BK.dateStr,time:_BK.time,
    phone,email,note,schedule_id:_BK.schedId,member_id:CU?CU.id:null
  };
  try{
    const r=await fetch(API+'/api/payment/create',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({bookingData,amount:_BK.price,className:_BK.name})});
    const txn=await r.json();
    if(!txn.ok){toast(txn.error||t('msg.failedtransaction'),'err');if(btn){btn.textContent=t('modal.booking.continue');btn.disabled=false;}return;}

    if(txn.redeemed){
      // Paid instantly using an active package credit — no payment gateway needed
      qs('#bk-form').style.display='none';
      qs('#bk-ok-msg').innerHTML=fn+', '+t('msg.bookingfor')+' <strong>'+_BK.name+'</strong> '+t('msg.on')+' '+_BK.dateStr+' '+t('msg.at')+' '+_BK.time+' '+t('msg.confirmedusingcredit')+' <strong>'+esc(txn.packageName||'')+'</strong> '+t('msg.package')+'<br><small style="color:var(--mt);margin-top:4px;display:block">'+txn.creditsLeft+' '+t('msg.creditsleft')+'</small>';
      qs('#bk-ok').classList.add('show');
      updateSlotEl(_BK.schedId);
    } else if(txn.simulated){
      // Simulation mode — confirm immediately
      const r2=await fetch(API+'/api/payment/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:txn.orderId})});
      const sim=await r2.json();
      if(sim.ok){
        qs('#bk-form').style.display='none';
        qs('#bk-ok-msg').innerHTML=fn+', '+t('msg.bookingfor')+' <strong>'+_BK.name+'</strong> '+t('msg.on')+' '+_BK.dateStr+' '+t('msg.at')+' '+_BK.time+' '+t('msg.confirmedsaved')+'<br><small style="color:var(--a);margin-top:4px;display:block">'+t('msg.simmodenote')+'</small>';
        qs('#bk-ok').classList.add('show');
        updateSlotEl(_BK.schedId);
      }else toast(sim.error||t('msg.somethingwrong'),'err');
    }else{
      // Midtrans Snap
      await ensureSnapLoaded();
      closeMo('bk-mo');
      window.snap.pay(txn.token,{
        onSuccess:(res)=>window.location.href='/payment/finish?order_id='+res.order_id,
        onPending:(res)=>window.location.href='/payment/pending?order_id='+res.order_id,
        onError:(res)=>window.location.href='/payment/error?order_id='+res.order_id,
        onClose:()=>{toast(t('msg.paymentcancelled'),'err');if(btn){btn.textContent=t('modal.booking.continue');btn.disabled=false;}}
      });
    }
  }catch(e){toast(t('msg.connectionerror'),'err');if(btn){btn.textContent=t('modal.booking.continue');btn.disabled=false;}}
}

/* ── MEMBERSHIP PACKAGE PURCHASE (shared modal, used from the Pricing page) ── */
let _PKG=null;

function openPackagePurchase(pkg){
  if(!CU){ toast(t('msg.signinfirst'),'err'); openMo('login-mo'); return; }
  _PKG=pkg;
  qs('#pkg-title').textContent=pkg.name;
  qs('#pkg-meta').textContent=(pkg.credits||1)+' '+t('unit.creditvalid')+' '+(pkg.validity_days||30)+' '+t('unit.daysfrompurchase');
  qs('#pkg-price').textContent='IDR '+Number(pkg.price).toLocaleString('en-US');
  qs('#pkg-form').style.display='block';
  qs('#pkg-ok').classList.remove('show');
  const btn=document.getElementById('pkg-submit-btn');
  if(btn){btn.textContent=t('modal.package.paynow');btn.disabled=false;}
  const info=document.getElementById('pkg-pay-info');
  if(info) info.innerHTML=_payStatus.configured
    ?t('msg.paymentvia')
    :'<span style="color:var(--a)">⚠ '+t('msg.simnote2')+'</span> '+t('msg.simnote3');
  openMo('pkg-mo');
}

async function submitPackagePurchase(){
  if(!_PKG||!CU) return;
  const btn=document.getElementById('pkg-submit-btn');
  if(btn){btn.textContent=t('msg.processing');btn.disabled=true;}
  try{
    const r=await fetch(API+'/api/membership-purchase/create',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({memberPhone:CU.phone,packageId:_PKG.id})});
    const txn=await r.json();
    if(!txn.ok){toast(txn.error||t('msg.failedtransaction'),'err');if(btn){btn.textContent=t('modal.package.paynow');btn.disabled=false;}return;}

    if(txn.simulated){
      const r2=await fetch(API+'/api/membership-purchase/simulate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderId:txn.orderId})});
      const sim=await r2.json();
      if(sim.ok){
        qs('#pkg-form').style.display='none';
        qs('#pkg-ok-msg').innerHTML='<strong>'+esc(_PKG.name)+'</strong> '+t('msg.packagenowactive')+' '+(_PKG.credits||1)+' '+t('msg.creditsvalidfor')+' '+(_PKG.validity_days||30)+' '+t('msg.days')+'<br><small style="color:var(--a);margin-top:4px;display:block">'+t('msg.simmodenote')+'</small>';
        qs('#pkg-ok').classList.add('show');
      }else toast(sim.error||t('msg.somethingwrong'),'err');
    }else{
      await ensureSnapLoaded();
      closeMo('pkg-mo');
      window.snap.pay(txn.token,{
        onSuccess:(res)=>window.location.href='/payment/finish?order_id='+res.order_id,
        onPending:(res)=>window.location.href='/payment/pending?order_id='+res.order_id,
        onError:(res)=>window.location.href='/payment/error?order_id='+res.order_id,
        onClose:()=>{toast(t('msg.paymentcancelled'),'err');if(btn){btn.textContent=t('modal.package.paynow');btn.disabled=false;}}
      });
    }
  }catch(e){toast(t('msg.connectionerror'),'err');if(btn){btn.textContent=t('modal.package.paynow');btn.disabled=false;}}
}

function updateSlotEl(schedId){
  if(!schedId) return;
  const el=document.querySelector(`[data-sid="${schedId}"]`);
  if(el){const n=Math.max(0,parseInt(el.dataset.n||0)-1);el.dataset.n=n;el.textContent=n>0?n+' spots':'Full';if(n<=3&&n>0)el.style.color='var(--a)';}
}

/* ── TOAST ── */
let _tt;
function toast(msg,type=''){
  const t=document.getElementById('_toast');if(!t)return;
  t.textContent=msg;t.className='toast '+(type==='ok'?'t-ok':type==='err'?'t-err':'')+' show';
  clearTimeout(_tt);_tt=setTimeout(()=>t.classList.remove('show'),3200);
}

/* ── UTILS ── */
function gv(id){const e=document.getElementById(id);return e?e.value.trim():'';}
function sv(id,v){const e=document.getElementById(id);if(e)e.value=v;}
function qs(sel){return document.querySelector(sel);}
function esc(s){return String(s||'').replace(/'/g,"\\'").replace(/"/g,'&quot;');}
function fmtRp(n){return'IDR '+Number(n||0).toLocaleString('en-US');}

/* ── REALTIME (polling — no Socket.IO, safe on any budget hosting) ── */
let _notifPollTimer = null;
function initSocket(){
  // Poll for member notifications every 15 seconds while logged in
  if (_notifPollTimer) clearInterval(_notifPollTimer);
  _notifPollTimer = setInterval(()=>{ if (CU) loadMemberNotifs(); }, 15000);
}

/* ── MEMBER NOTIFICATIONS ── */
let _notifs=[];
async function loadMemberNotifs(){
  if(!CU) return;
  try{
    const r=await fetch(API+'/api/notifications');
    const fresh=await r.json();
    const oldIds=new Set(_notifs.map(n=>n.id));
    const isNew=_notifs.length>0; // avoid a flood of toasts on first load
    fresh.forEach(n=>{
      if(isNew && !oldIds.has(n.id)) toast(n.title+': '+n.message, n.type==='warning'?'err':'ok');
    });
    _notifs=fresh;
    renderNotifPanel();
  }catch(e){}
}
function renderNotifPanel(){
  const list=document.getElementById('notif-list');
  const dot=document.getElementById('notif-dot');
  const unread=_notifs.filter(n=>!n.read).length;
  if(dot) dot.classList.toggle('show',unread>0);
  if(!list) return;
  if(!_notifs.length){ list.innerHTML='<div class="notif-empty">'+t('notif.empty')+'</div>'; return; }
  list.innerHTML=_notifs.map(n=>`
    <a href="${n.link||'#'}" class="notif-item ${n.read?'':'unread'}" onclick="markNotifRead('${n.id}')">
      <div class="notif-item-top">${n.read?'':'<span class="notif-item-dot"></span>'}<span class="notif-item-title">${n.title}</span></div>
      <div class="notif-item-msg">${n.message}</div>
      <div class="notif-item-time">${timeAgo(n.created_at)}</div>
    </a>`).join('');
}
function toggleNotifPanel(){
  const p=document.getElementById('notif-panel');
  if(!p) return;
  const willOpen=!p.classList.contains('open');
  document.querySelectorAll('.notif-panel.open').forEach(el=>el.classList.remove('open'));
  if(willOpen){ p.classList.add('open'); loadMemberNotifs(); }
}
document.addEventListener('click',e=>{
  if(!e.target.closest('.notif-wrap')) document.querySelectorAll('.notif-panel.open').forEach(el=>el.classList.remove('open'));
});
async function markNotifRead(id){
  const n=_notifs.find(x=>x.id===id); if(n) n.read=true;
  renderNotifPanel();
  try{ await fetch(API+'/api/notifications/'+id+'/read',{method:'PUT'}); }catch(e){}
}
async function markAllNotifsRead(event){
  if(event) event.stopPropagation();
  _notifs.forEach(n=>n.read=true); renderNotifPanel();
  try{ await fetch(API+'/api/notifications/read-all',{method:'PUT'}); }catch(e){}
}
function timeAgo(iso){
  if(!iso) return '';
  const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(s<60) return t('time.justnow');
  if(s<3600) return Math.floor(s/60)+' '+t('time.minago');
  if(s<86400) return Math.floor(s/3600)+' '+t('time.hrago');
  return Math.floor(s/86400)+' '+t('time.dayago');
}
