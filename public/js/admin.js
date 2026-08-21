const _origFetch = window.fetch;

// Retry only safe/idempotent reads. Write operations are never retried
// automatically to avoid duplicate bookings, payments, uploads, or edits.
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
    const token = localStorage.getItem('avaia_staff');
    if (token) {
      options.headers = { ...(options.headers || {}), 'Authorization': 'Bearer ' + token };
    }
  }
  return fetchWithTransientRetry(url, options).then(res => {
    if (res.status === 401 && url.includes('/api/') && !url.includes('/api/auth/')) {
      localStorage.removeItem('avaia_staff');
      localStorage.removeItem('avaia_staff_user');
      toast('Session expired. Please sign in again.', 'err');
      setTimeout(() => { document.getElementById('adm').style.display='none'; document.getElementById('gate').style.display='flex'; }, 1200);
    }
    return res;
  });
};

async function downloadWithAuth(url, filename){
  try{
    const r = await fetch(url); 
    if(!r.ok){
      let msg = 'Export failed.';
      try{ msg = (await r.json()).error || msg; }catch(e){}
      toast(msg, 'err');
      return;
    }
    const blob = await r.blob();
    const a = document.createElement('a');
    const objUrl = URL.createObjectURL(blob);
    a.href = objUrl; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(objUrl);
  }catch(e){
    toast('Export failed.', 'err');
  }
}
function exportExcel(){ downloadWithAuth('/api/bookings/export-excel','avaia-bookings.xlsx'); }
function exportBookingsCSV(){ downloadWithAuth('/api/bookings/export-csv','avaia-bookings.csv'); }
function exportMembersExcel(){ downloadWithAuth('/api/members/export-excel','avaia-members.xlsx'); }

function gv(id){const e=document.getElementById(id);return e?e.value.trim():'';}
function sv(id,v){const e=document.getElementById(id);if(e)e.value=v;}
function st(id,v){const e=document.getElementById(id);if(e)e.textContent=v;}
function openMo(id){const e=document.getElementById(id);if(e)e.classList.add('open');}
function closeMo(id){const e=document.getElementById(id);if(e)e.classList.remove('open');}
function fmtRp(n){return'IDR '+Number(n||0).toLocaleString('en-US');}
document.addEventListener('click',e=>{if(e.target.classList.contains('mo'))e.target.classList.remove('open');});
let _tt;
function toast(msg,type=''){
  const t=document.getElementById('_toast');if(!t)return;
  t.textContent=msg;t.className='toast '+(type==='ok'?'t-ok':type==='err'?'t-err':'')+' show';
  clearTimeout(_tt);_tt=setTimeout(()=>t.classList.remove('show'),3200);
}

/* ── CURRENT STAFF USER ── */
let CURRENT_STAFF = null;
function loadCurrentStaff(){
  const s = localStorage.getItem('avaia_staff_user');
  CURRENT_STAFF = s ? JSON.parse(s) : null;
  return CURRENT_STAFF;
}
function isAdminRole(){ return CURRENT_STAFF && CURRENT_STAFF.role==='admin'; }
function isInstructorRole(){ return CURRENT_STAFF && CURRENT_STAFF.role==='instructor'; }

/* ── GATE (single login for Admin & Instructor) ── */
async function gateLogin(){
  const u=gv('g-user'),p=gv('g-pass');
  if(!u||!p){showErr('Please enter your username and password.');return;}

  // A staff login always starts from a completely clean client identity.
  localStorage.removeItem('avaia_member_token');
  localStorage.removeItem('avaia_u');
  localStorage.removeItem('avaia_staff');
  localStorage.removeItem('avaia_staff_user');
  sessionStorage.clear();
  CURRENT_STAFF = null;

  const btn = document.querySelector('#gate button[onclick="gateLogin()"]');
  if(btn) btn.disabled = true;
  showErr('');

  try{
    // Admin/instructor login MUST use the staff endpoint.
    // Do not route the staff gate through member authentication.
    const r=await _origFetch('/api/auth/staff-login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:u,password:p})
    });

    let d={};
    try{ d=await r.json(); }catch(e){}

    if(r.status===429){
      showErr(d.error||'Too many attempts for this account. Please wait 15 minutes.');
      return;
    }

    if(d.ok && d.token && d.user && (d.user.role==='admin' || d.user.role==='instructor')){
      localStorage.setItem('avaia_staff',d.token);
      localStorage.setItem('avaia_staff_user',JSON.stringify(d.user));
      showAdm();
    } else {
      showErr(d.error||'Incorrect username or password.');
    }
  }catch(e){
    console.error('staff login:',e);
    showErr('Could not connect to the server.');
  }finally{
    if(btn) btn.disabled = false;
  }
}
function showErr(m){const e=document.getElementById('gate-err');if(e){e.textContent=m;e.style.display='block';}}
function gateLogout(){
  // Fully switch identity: remove staff AND member client sessions.
  [
    'avaia_staff',
    'avaia_staff_user',
    'avaia_member_token',
    'avaia_u',
    'currentUser',
    'user',
    'CU',
    'authToken',
    'adminToken',
    'staffToken',
    'memberToken',
    'currentStaff',
    'currentStaffUser'
  ].forEach(key => localStorage.removeItem(key));
  try { sessionStorage.clear(); } catch(e) {}
  CURRENT_STAFF = null;
  window.location.replace('/');
}

/* ── STATE ── */
let AST={},ACls=[],ASch=[],ABk=[],AMb=[],AMsh=[],AFb=[],AStaff=[];

async function showAdm(){
  loadCurrentStaff();
  if(!CURRENT_STAFF){ document.getElementById('gate').style.display='flex'; return; }

  document.getElementById('gate').style.display='none';
  document.getElementById('adm').style.display='flex';

  buildSidebar();
  applyRoleVisibility();

  await loadAST();

  if(isAdminRole()){
    await Promise.all([loadABk(),loadAMb(),loadACls(),loadASch(),loadAMsh(),loadAFb(),loadAStaff()]);
  } else {
    await Promise.all([loadACls(),loadASch()]);
  }

  updateStats(); populateForms(); loadSysStatus();
  initAdminSocket();
  loadAdminNotifs();

  const who=document.getElementById('adm-whoami');
  if(who) who.textContent=CURRENT_STAFF.name+' · '+(CURRENT_STAFF.role==='admin'?'Administrator':'Instructor');

  if(!isAdminRole()){
    sw('schedule', document.querySelector('[data-section="schedule"]'));
  }
}

/* ── DYNAMIC SIDEBAR BASED ON ROLE ── */
function buildSidebar(){
  const side=document.getElementById('adm-sidebar');
  if(!side) return;

  if(isAdminRole()){
    side.innerHTML=`
      <div class="adm-side-sect">Overview</div>
      <button class="adm-link" data-section="dashboard" onclick="sw('dashboard',this)">Dashboard</button>
      <button class="adm-link" data-section="analytics" onclick="sw('analytics',this);loadAnalytics()">Analytics</button>
      <button class="adm-link" data-section="bookings" onclick="sw('bookings',this)">Bookings</button>
      <button class="adm-link" data-section="members" onclick="sw('members',this)">Members</button>
      <button class="adm-link" data-section="memberships" onclick="sw('memberships',this)">Membership Packages</button>
      <button class="adm-link" data-section="feedback" onclick="sw('feedback',this)">Feedback <span id="fb-badge" class="fb-count-badge" style="display:none">0</span></button>
      <button class="adm-link" data-section="reports" onclick="sw('reports',this);initReport()">Reports</button>
      <div class="adm-side-sect">Studio</div>
      <button class="adm-link" data-section="schedule" onclick="sw('schedule',this)">Schedule</button>
      <button class="adm-link" data-section="classes" onclick="sw('classes',this)">Classes</button>
      <div class="adm-side-sect">Team</div>
      <button class="adm-link" data-section="staff" onclick="sw('staff',this)">Manage Staff</button>
      <div class="adm-side-sect">Settings</div>
      <button class="adm-link" data-section="appearance" onclick="sw('appearance',this)">Appearance & Colors</button>
      <button class="adm-link" data-section="content" onclick="sw('content',this)">Content & Info</button>
      <button class="adm-link" data-section="email" onclick="sw('email',this);loadEmailStatus()">Email & Notifications</button>
      <button class="adm-link" data-section="payment" onclick="sw('payment',this)">Payment</button>
      <button class="adm-link" data-section="security" onclick="sw('security',this)">Security</button>
    `;
    document.querySelector('[data-section="dashboard"]').classList.add('active');
  } else {
    side.innerHTML=`
      <div class="adm-side-sect">Studio</div>
      <button class="adm-link" data-section="schedule" onclick="sw('schedule',this)">Schedule</button>
      <button class="adm-link" data-section="classes" onclick="sw('classes',this)">Classes</button>
      <div class="adm-side-sect">Account</div>
      <button class="adm-link" data-section="security" onclick="sw('security',this)">Change Password</button>
    `;
    document.querySelector('[data-section="schedule"]').classList.add('active');
  }
}

/* ── HIDE ELEMENTS INSTRUCTORS SHOULDN'T ACCESS ── */
function applyRoleVisibility(){
  const adminOnlyPanels=['dashboard','analytics','bookings','members','memberships','feedback','staff','appearance','content','payment'];
  if(!isAdminRole()){
    adminOnlyPanels.forEach(id=>{
      const el=document.getElementById('adm-'+id);
      if(el) el.remove();
    });
    const adminCredCard=document.getElementById('admin-cred-card');
    if(adminCredCard) adminCredCard.remove();
  } else {
    const staffPwCard=document.getElementById('staff-pw-card');
    if(staffPwCard) staffPwCard.remove();
  }
}

async function loadAST(){
  const r=await fetch('/api/settings'); AST=await r.json();
  const root=document.documentElement;
  if(AST.primaryColor) root.style.setProperty('--p',AST.primaryColor);
  if(AST.accentColor)  root.style.setProperty('--a',AST.accentColor);
  if(AST.bgColor)      root.style.setProperty('--bg',AST.bgColor);
  const n=AST.studioName||'Avaia Studio';
  document.title=n+' — Dashboard';
}

function populateForms(){
  if(!isAdminRole()) return;
  sv('sn-name',AST.studioName||''); sv('sn-tag',AST.tagline||'');
  sv('sa1',AST.about1||''); sv('sa2',AST.about2||''); sv('sa3',AST.about3||'');
  sv('si-addr',AST.address||''); sv('si-ph',AST.phone||''); sv('si-em',AST.email||''); sv('si-hr',AST.hours||''); sv('si-map',AST.mapEmbed||'');
  const pc=AST.primaryColor||'#5D3A24',ac=AST.accentColor||'#9C6B3D',bc=AST.bgColor||'#FDF8F6';
  sv('sc-p',pc);sv('sc-ph',pc);sv('sc-a',ac);sv('sc-ah',ac);sv('sc-bg',bc);sv('sc-bh',bc);
  syncC('sc-p','sc-ph');syncC('sc-a','sc-ah');syncC('sc-bg','sc-bh');
  [1,2,3].forEach(n=>{
    const key=n===1?'heroImage':'heroImage'+n;
    const hp=document.getElementById('hero-prev'+n);
    if(hp) hp.innerHTML=AST[key]?'<img src="'+AST[key]+'" style="width:100%;height:120px;object-fit:cover">':'<span style="color:var(--mt);font-size:12px">None yet</span>';
  });
  const ap=document.getElementById('about-prev');
  if(ap) ap.innerHTML=AST.aboutImage?'<img src="'+AST.aboutImage+'" style="width:100%;height:190px;object-fit:cover">':'<span style="color:var(--mt);font-size:13px">No photo yet</span>';
}
function syncC(pid,hid){
  const p=document.getElementById(pid),h=document.getElementById(hid); if(!p||!h) return;
  p.addEventListener('input',()=>{h.value=p.value;});
  h.addEventListener('input',()=>{ if(/^#[0-9A-Fa-f]{6}$/.test(h.value)) p.value=h.value; });
}

async function checkRes(r){
  if(r.ok) return true;
  let msg='Something went wrong ('+r.status+').';
  try{ const d=await r.json(); if(d.error) msg=d.error; }catch(e){}
  toast(msg,'err');
  return false;
}
async function patch(body){
  const r=await fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!(await checkRes(r))) return false;
  AST={...AST,...body};
  const el=document.documentElement;
  if(body.primaryColor) el.style.setProperty('--p',body.primaryColor);
  if(body.accentColor)  el.style.setProperty('--a',body.accentColor);
  if(body.bgColor)      el.style.setProperty('--bg',body.bgColor);
  return true;
}
async function saveName(){ if(await patch({studioName:gv('sn-name'),tagline:gv('sn-tag')})) toast('Name saved.','ok'); }
async function saveColors(){ if(await patch({primaryColor:gv('sc-ph')||gv('sc-p'),accentColor:gv('sc-ah')||gv('sc-a'),bgColor:gv('sc-bh')||gv('sc-bg')})) toast('Colors applied.','ok'); }
async function saveAbout(){ if(await patch({about1:gv('sa1'),about2:gv('sa2'),about3:gv('sa3')})) toast('Content saved.','ok'); }
async function saveContact(){ if(await patch({address:gv('si-addr'),phone:gv('si-ph'),email:gv('si-em'),hours:gv('si-hr')})) toast('Contact info saved.','ok'); }
async function saveMap(){ if(await patch({mapEmbed:gv('si-map')})) toast('Map updated.','ok'); }

async function uploadHeroN(input,n){
  const f=input.files[0]; if(!f) return;
  const key=n===1?'hero':'hero'+n;
  const form=new FormData(); form.append('hero',f);
  const r=await fetch('/api/settings/'+key+'-img',{method:'POST',body:form});
  if(!(await checkRes(r))){ input.value=''; return; }
  const d=await r.json();
  const dbKey=n===1?'heroImage':'heroImage'+n;
  AST[dbKey]=d.path;
  const hp=document.getElementById('hero-prev'+n);
  if(hp) hp.innerHTML='<img src="'+d.path+'" style="width:100%;height:120px;object-fit:cover">';
  toast('Photo '+n+' updated.','ok');
}
async function uploadAbout(input){
  const f=input.files[0]; if(!f) return;
  const form=new FormData(); form.append('aboutImg',f);
  const r=await fetch('/api/settings/about-img',{method:'POST',body:form});
  if(!(await checkRes(r))){ input.value=''; return; }
  const d=await r.json();
  AST.aboutImage=d.path;
  const ap=document.getElementById('about-prev');
  if(ap) ap.innerHTML='<img src="'+d.path+'" style="width:100%;height:190px;object-fit:cover">';
  toast('About Us photo updated.','ok');
}

/* ── CHANGE OWN PASSWORD (admin or instructor) ── */
async function saveStaffPassword(){
  const cp=gv('staff-cur'),np=gv('staff-new'),cf=gv('staff-confirm');
  if(!cp||!np){toast('Please enter your current and new password.','err');return;}
  if(np!==cf){toast('Password confirmation does not match.','err');return;}
  if(np.length<8){toast('New password must be at least 8 characters.','err');return;}
  const r=await fetch('/api/auth/staff-password',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cp,newPassword:np})});
  const d=await r.json();
  if(d.ok){ sv('staff-cur','');sv('staff-new','');sv('staff-confirm',''); toast('Password updated successfully.','ok'); }
  else toast(d.error||'Failed to update password.','err');
}

function updateStats(){
  if(!isAdminRole()) return;
  const confirmedBk=ABk.filter(b=>b.status==='confirmed');
  st('s-bk',confirmedBk.length); st('s-mb',AMb.length); st('s-cl',ACls.length);
  const totalRev=confirmedBk.reduce((sum,b)=>sum+(parseInt(b.amount)||0),0);
  st('s-rev',fmtRp(totalRev));
  const unread=AFb.filter(f=>f.status==='unread').length;
  const badge=document.getElementById('fb-badge');
  if(badge){ if(unread>0){badge.textContent=unread;badge.style.display='inline-block';}else badge.style.display='none'; }
}

/* ── BOOKINGS (admin only) ── */
function bkStatusBadge(b){
  if(b.status==='cancelled') return '<span class="badge" style="background:#fde8e8;color:#b52b2b">Cancelled</span>';
  if(b.status==='no-show')   return '<span class="badge" style="background:#fdf0e0;color:#9a6a1a">No Show</span>';
  return '<span class="badge b-ok">Confirmed</span>';
}
async function loadABk(){
  const r=await fetch('/api/bookings'); ABk=await r.json();
  const db=document.getElementById('dash-bk');
  if(db) db.innerHTML=ABk.slice(0,6).map(b=>'<tr><td>'+b.name+'</td><td>'+b.class+'</td><td>'+b.date+'</td><td>'+b.time+'</td><td>'+fmtRp(b.amount)+'</td><td>'+bkStatusBadge(b)+'</td></tr>').join('')||'<tr><td colspan="6" style="padding:16px;color:var(--mt)">None yet.</td></tr>';
  const ab=document.getElementById('all-bk-body');
  const _tok=localStorage.getItem('avaia_staff')||'';
  if(ab) ab.innerHTML=ABk.map(b=>{
    const noShowBtn = b.status==='confirmed' ? '<button class="btn bo bsm" onclick="markNoShow(\''+b.id+'\')">No Show</button>' : '';
    return '<tr><td>'+b.name+'</td><td>'+b.class+'</td><td>'+b.date+'</td><td>'+b.time+'</td><td>'+(b.phone||'—')+'</td><td>'+fmtRp(b.amount)+'</td><td style="font-size:12px;text-transform:capitalize">'+(b.payment_type||'—')+'</td><td>'+bkStatusBadge(b)+'</td><td><div style="display:flex;gap:6px;flex-wrap:wrap"><a class="btn bo bsm" href="/api/invoice/'+b.id+'?token='+encodeURIComponent(_tok)+'" target="_blank">Invoice</a>'+noShowBtn+'<button class="btn bd bsm" onclick="delBk(\''+b.id+'\')">Delete</button></div></td></tr>';
  }).join('')||'<tr><td colspan="9" style="padding:16px;color:var(--mt)">None yet.</td></tr>';
}
async function markNoShow(id){
  if(!confirm('Mark this booking as No Show? The class credit already used will NOT be refunded.'))return;
  const r=await fetch('/api/bookings/'+id+'/no-show',{method:'PUT'});
  const d=await r.json();
  if(d.ok){ await loadABk(); toast('Booking marked as No Show.','ok'); }
  else toast(d.error||'Failed to update.','err');
}
async function delBk(id){ if(!confirm('Delete this booking?'))return; const r=await fetch('/api/bookings/'+id,{method:'DELETE'}); if(!(await checkRes(r))) return; await loadABk(); updateStats(); toast('Booking deleted.'); }

async function importBookings(input){
  const f=input.files[0]; if(!f) return;
  const form=new FormData(); form.append('file',f);
  try{
    const r=await fetch('/api/bookings/import',{method:'POST',body:form});
    const d=await r.json();
    if(d.ok){ toast(d.imported+' bookings imported successfully.','ok'); await loadABk(); updateStats(); }
    else toast(d.error||'Import failed.','err');
  }catch(e){ toast('Failed to upload the file.','err'); }
  input.value='';
}

/* ── MEMBERS (admin only) ── */
let AMPkg=[];
async function loadAMb(){
  const [r,rp]=await Promise.all([fetch('/api/members'),fetch('/api/member-packages')]);
  AMb=await r.json(); AMPkg=await rp.json();
  const b=document.getElementById('mb-body'); if(!b) return;
  b.innerHTML=AMb.length?AMb.map(m=>{
    const j=m.joined?new Date(m.joined).toLocaleDateString('en-US',{day:'numeric',month:'short',year:'numeric'}):'—';
    const pkgs=AMPkg.filter(p=>(p.member_id&&p.member_id===m.id)||p.member_email===m.email);
    const active=pkgs.filter(p=>p.computed_status==='active').sort((a,b)=>new Date(a.expires_at)-new Date(b.expires_at))[0];
    const pkgCell=active
      ? active.package_name+' <span style="color:var(--mt)">('+Math.max(0,active.credits_total-active.credits_used)+' left, exp: '+new Date(active.expires_at).toLocaleDateString('en-US',{day:'numeric',month:'short'})+')</span>'
      : '<span style="color:var(--mt)">— drop-in —</span>';
    return '<tr><td>'+m.name+'</td><td>'+m.email+'</td><td>'+(m.phone||'—')+'</td><td style="text-transform:capitalize">'+(m.membership_type||'drop-in')+'</td><td style="font-size:12.5px">'+pkgCell+'</td><td>'+j+'</td><td><button class="btn bd bsm" onclick="delMb(\''+m.id+'\')">Delete</button></td></tr>';
  }).join(''):'<tr><td colspan="7" style="padding:16px;color:var(--mt)">No members yet.</td></tr>';
}
async function delMb(id){ if(!confirm('Delete this member?'))return; const r=await fetch('/api/members/'+id,{method:'DELETE'}); if(!(await checkRes(r))) return; await loadAMb(); updateStats(); toast('Member deleted.'); }

async function importMembers(input){
  const f=input.files[0]; if(!f) return;
  const form=new FormData(); form.append('file',f);
  try{
    const r=await fetch('/api/members/import',{method:'POST',body:form});
    const d=await r.json();
    if(d.ok){ toast(d.imported+' members imported successfully.','ok'); await loadAMb(); updateStats(); }
    else toast(d.error||'Import failed.','err');
  }catch(e){ toast('Failed to upload the file.','err'); }
  input.value='';
}

/* ── CLASSES (admin & instructor) ── */
async function loadACls(){
  const r=await fetch('/api/classes'); ACls=await r.json();
  const b=document.getElementById('cls-body'); if(!b) return;
  b.innerHTML=ACls.map(c=>'<tr><td>'+c.name+'</td><td>'+c.instructor+'</td><td>'+c.level+'</td><td>'+c.duration+'</td><td>'+fmtRp(c.price||85000)+'</td><td>'+c.capacity+'</td><td><div style="display:flex;gap:6px"><button class="btn bo bsm" onclick="openEditCls(\''+c.id+'\')">Edit</button><button class="btn bd bsm" onclick="delCls(\''+c.id+'\')">Delete</button></div></td></tr>').join('');
}
function openClsMo(){ st('cls-mo-t','Add Class'); sv('cls-eid','');sv('cls-name','');sv('cls-inst','');sv('cls-dur','');sv('cls-cap','');sv('cls-price',''); document.getElementById('cls-lv').value='All Levels'; openMo('cls-mo'); }
function openEditCls(id){ const c=ACls.find(x=>x.id===id); if(!c) return; st('cls-mo-t','Edit Class'); sv('cls-eid',c.id);sv('cls-name',c.name);sv('cls-inst',c.instructor);document.getElementById('cls-lv').value=c.level;sv('cls-dur',c.duration);sv('cls-cap',c.capacity);sv('cls-price',c.price||85000); openMo('cls-mo'); }
async function saveCls(){
  const id=gv('cls-eid'),body={name:gv('cls-name'),instructor:gv('cls-inst'),level:document.getElementById('cls-lv').value,duration:gv('cls-dur'),capacity:parseInt(gv('cls-cap'))||12,price:parseInt(gv('cls-price'))||85000};
  if(!body.name||!body.instructor){ toast('Name and instructor are required.','err'); return; }
  const r = id
    ? await fetch('/api/classes/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    : await fetch('/api/classes',    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!(await checkRes(r))) return;
  closeMo('cls-mo'); await loadACls(); updateStats(); toast('Class saved.','ok');
}
async function delCls(id){
  if(!confirm('Delete this class?'))return;
  const r=await fetch('/api/classes/'+id,{method:'DELETE'});
  if(!(await checkRes(r))) return;
  await loadACls(); updateStats(); toast('Class deleted.');
}

/* ── SCHEDULE (admin & instructor) ── */
const DAY_O=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const SCH_DOW=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
async function loadASch(){
  const r=await fetch('/api/schedule');
  ASch=await r.json();
  const c=document.getElementById('sch-list'); if(!c) return;
  const dated=ASch.filter(s=>s.session_date);
  const legacy=ASch.filter(s=>!s.session_date);
  const groups={};
  dated.forEach(s=>{ (groups[s.session_date] ||= []).push(s); });
  const keys=Object.keys(groups).sort();
  let html=keys.map(date=>{
    const rows=groups[date].sort((a,b)=>a.time.localeCompare(b.time));
    const label=new Date(date+'T00:00:00').toLocaleDateString('en-US',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
    return `<div style="margin-bottom:20px"><div class="day-lbl">${label}</div><div class="tw"><table class="tbl"><thead><tr><th>Time</th><th>Class</th><th>Instructor</th><th>Price</th><th>Left</th><th></th></tr></thead><tbody>${rows.map(s=>`<tr><td style="font-weight:600">${s.time}</td><td>${s.className||'—'}</td><td>${s.instructor||'—'}</td><td>${fmtRp(s.price)}</td><td>${s.slots}</td><td><div style="display:flex;gap:6px"><button class="btn bo bsm" onclick="openEditSch('${s.id}')">Edit</button><button class="btn bd bsm" onclick="delSch('${s.id}')">Delete</button></div></td></tr>`).join('')}</tbody></table></div></div>`;
  }).join('');
  if(legacy.length){
    html += `<div style="margin-top:28px;padding:14px;border:1px solid var(--ln);border-radius:12px"><strong>Legacy weekly sessions</strong><p class="sm" style="margin:6px 0 10px">These old entries have no exact date. Edit each one and assign a date. New sessions never repeat automatically.</p>${DAY_O.map(day=>{ const rows=legacy.filter(s=>s.day===day).sort((a,b)=>a.time.localeCompare(b.time)); if(!rows.length)return ''; return `<div style="margin-top:10px"><div class="day-lbl">${day}</div><div class="tw"><table class="tbl"><tbody>${rows.map(s=>`<tr><td>${s.time}</td><td>${s.className||'—'}</td><td>${s.instructor||'—'}</td><td>${fmtRp(s.price)}</td><td>${s.slots}</td><td><button class="btn bo bsm" onclick="openEditSch('${s.id}')">Edit & assign date</button></td></tr>`).join('')}</tbody></table></div></div>`; }).join('')}</div>`;
  }
  c.innerHTML=html||'<p style="color:var(--mt);padding:16px">No schedule yet.</p>';
}
function setTodayScheduleDate(){
  const d=new Date();
  sv('sch-date-picker', d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'));
  syncSchDayFromDate();
}
function updateSchDayHint(dayName){
  const h=document.getElementById('sch-day-hint');
  if(h) h.textContent = dayName ? `This session is scheduled only for ${dayName}. It will not repeat automatically.` : 'Choose the exact calendar date. Sessions do not repeat automatically.';
}
function syncSchDayFromDate(){
  const v=gv('sch-date-picker'); if(!v) return;
  const d=new Date(v+'T00:00:00');
  sv('sch-day', SCH_DOW[d.getDay()]);
  updateSchDayHint(SCH_DOW[d.getDay()]);
}
function openSchMo(){
  const sel=document.getElementById('sch-cls'); if(sel) sel.innerHTML=ACls.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  st('sch-mo-t','Add Session'); sv('sch-eid','');sv('sch-time','');sv('sch-slots','');
  setTodayScheduleDate();
  openMo('sch-mo');
}
function openEditSch(id){
  const s=ASch.find(x=>x.id===id); if(!s) return;
  const sel=document.getElementById('sch-cls'); if(sel) sel.innerHTML=ACls.map(c=>`<option value="${c.id}" ${((c.id===s.class_id||c.id===s.classId)?'selected':'')}>${c.name}</option>`).join('');
  st('sch-mo-t','Edit Session'); sv('sch-eid',s.id); sv('sch-time',s.time); sv('sch-slots',s.slots);
  sv('sch-date-picker', s.session_date || '');
  sv('sch-day', s.day || '');
  if(s.session_date) syncSchDayFromDate(); else updateSchDayHint(s.day || '');
  openMo('sch-mo');
}
async function saveSch(){
  const eid=gv('sch-eid');
  const session_date=gv('sch-date-picker');
  const body={session_date,day:gv('sch-day'),time:gv('sch-time'),class_id:document.getElementById('sch-cls').value,slots:parseInt(gv('sch-slots'))||12};
  if(!session_date){ toast('Please choose a session date.','err'); return; }
  if(!body.time){ toast('Please enter a time.','err'); return; }
  const r=eid
    ? await fetch('/api/schedule/'+eid,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    : await fetch('/api/schedule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!(await checkRes(r))) return;
  closeMo('sch-mo'); await loadASch(); updateStats(); toast('Session saved.','ok');
}
async function delSch(id){
  if(!confirm('Delete this session?'))return;
  const r=await fetch('/api/schedule/'+id,{method:'DELETE'});
  if(!(await checkRes(r))) return;
  await loadASch(); updateStats(); toast('Session deleted.');
}

/* ── MANUAL MEMBER MEMBERSHIP ── */
function openManualPkgMo(){
  const ms=document.getElementById('mp-member'), ps=document.getElementById('mp-package');
  if(ms) ms.innerHTML=AMb.map(m=>`<option value="${m.id}">${m.name} — ${m.email}</option>`).join('');
  if(ps) ps.innerHTML=AMsh.map(p=>`<option value="${p.id}">${p.name} — ${fmtRp(p.price)}</option>`).join('');
  const d=new Date();
  sv('mp-start',d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'));
  prefillManualPackage();
  openMo('manual-pkg-mo');
}
function prefillManualPackage(){
  const p=AMsh.find(x=>x.id===gv('mp-package')); if(!p)return;
  sv('mp-price',p.price||0); sv('mp-credits',p.credits||1); sv('mp-validity',p.validity_days||30);
  const h=document.getElementById('mp-hint');
  if(h) h.textContent=`Default: ${p.credits||1} credits · ${p.validity_days||30} days. You can override these for this manual sale.`;
}
async function saveManualPkg(){
  const body={member_id:gv('mp-member'),package_id:gv('mp-package'),start_date:gv('mp-start'),price_paid:gv('mp-price'),credits_total:gv('mp-credits'),validity_days:gv('mp-validity'),payment_type:gv('mp-payment')};
  if(!body.member_id||!body.package_id||!body.start_date){toast('Member, package and start date are required.','err');return;}
  try{
    const r=await fetch('/api/member-packages/manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(!r.ok||!d.ok){toast(d.error||'Could not activate membership.','err');return;}
    closeMo('manual-pkg-mo'); await loadAMb(); updateStats(); toast('Membership added to member successfully.','ok');
  }catch(e){toast('Could not activate membership.','err');}
}

/* ── MEMBERSHIP PACKAGES (admin only) ── */
async function loadAMsh(){
  const r=await fetch('/api/memberships'); AMsh=await r.json();
  const b=document.getElementById('msh-body'); if(!b) return;
  b.innerHTML=AMsh.length?AMsh.map(m=>{
    const feats=(m.features||[]).slice(0,2).join(', ')+(m.features&&m.features.length>2?'...':'');
    return '<tr><td>'+m.name+'</td><td>'+fmtRp(m.price)+'</td><td>'+(m.duration||'—')+'</td><td style="font-size:12px;color:var(--mt)">'+feats+'</td><td><div style="display:flex;gap:6px"><button class="btn bo bsm" onclick="openEditMsh(\''+m.id+'\')">Edit</button><button class="btn bd bsm" onclick="delMsh(\''+m.id+'\')">Delete</button></div></td></tr>';
  }).join(''):'<tr><td colspan="5" style="padding:16px;color:var(--mt)">No packages yet. Add a membership package.</td></tr>';
}
function openMshMo(){ st('msh-mo-t','Add Package'); sv('msh-eid','');sv('msh-name','');sv('msh-price','');sv('msh-duration','');sv('msh-credits','');sv('msh-validity','');sv('msh-feats',''); openMo('msh-mo'); }
function openEditMsh(id){
  const m=AMsh.find(x=>x.id===id); if(!m) return;
  st('msh-mo-t','Edit Package'); sv('msh-eid',m.id); sv('msh-name',m.name); sv('msh-price',m.price); sv('msh-duration',m.duration);
  sv('msh-credits',m.credits||1); sv('msh-validity',m.validity_days||30); sv('msh-feats',(m.features||[]).join('\n'));
  openMo('msh-mo');
}
async function saveMsh(){
  const id=gv('msh-eid');
  const body={name:gv('msh-name'),price:parseInt(gv('msh-price'))||0,duration:gv('msh-duration'),
    credits:parseInt(gv('msh-credits'))||1, validity_days:parseInt(gv('msh-validity'))||30,
    features:gv('msh-feats').split('\n').map(s=>s.trim()).filter(Boolean)};
  if(!body.name){ toast('Package name is required.','err'); return; }
  const r = id
    ? await fetch('/api/memberships/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    : await fetch('/api/memberships',    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!(await checkRes(r))) return;
  closeMo('msh-mo'); await loadAMsh(); toast('Package saved.','ok');
}
async function delMsh(id){
  if(!confirm('Delete this package?'))return;
  const r=await fetch('/api/memberships/'+id,{method:'DELETE'});
  if(!(await checkRes(r))) return;
  await loadAMsh(); toast('Package deleted.');
}

/* ── FEEDBACK (admin only) ── */
async function loadAFb(){
  const r=await fetch('/api/feedback'); AFb=await r.json();
  const c=document.getElementById('fb-list'); if(!c) return;
  if(!AFb.length){ c.innerHTML='<p style="color:var(--mt);padding:20px">No feedback yet.</p>'; return; }
  const typeColor={criticism:'#b52b2b',suggestion:'#9C6B3D',question:'#5D3A24',compliment:'#4a7a48'};
  c.innerHTML=AFb.map(f=>{
    const stars=f.rating?'★'.repeat(f.rating)+'☆'.repeat(5-f.rating):'';
    const date=f.created_at?new Date(f.created_at).toLocaleString('en-US',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'';
    const unreadStyle=f.status==='unread'?'border-left:3px solid var(--p)':'border-left:3px solid transparent';
    return '<div style="background:var(--wh);border:1px solid var(--ln);'+unreadStyle+';padding:20px;margin-bottom:12px">'+
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap;gap:8px">'+
      '<div>'+
        '<strong style="font-family:var(--fd);font-size:17px">'+f.name+'</strong> '+
        '<span style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:'+(typeColor[f.type]||'var(--mt)')+';border:1px solid '+(typeColor[f.type]||'var(--mt)')+';padding:2px 8px;margin-left:8px">'+f.type+'</span>'+
        (stars?'<span style="color:var(--a);margin-left:8px;font-size:14px">'+stars+'</span>':'')+
      '</div>'+
      '<span class="sm">'+date+'</span>'+
      '</div>'+
      (f.email?'<p class="sm" style="margin-bottom:8px">'+f.email+'</p>':'')+
      '<p style="font-size:14px;color:var(--mt);line-height:1.7;margin-bottom:12px">'+f.message+'</p>'+
      '<div style="display:flex;gap:8px">'+
        (f.status==='unread'?'<button class="btn bo bsm" onclick="markFbRead(\''+f.id+'\')">Mark as Read</button>':'')+
        '<button class="btn bd bsm" onclick="delFb(\''+f.id+'\')">Delete</button>'+
      '</div>'+
    '</div>';
  }).join('');
}
async function markFbRead(id){ await fetch('/api/feedback/'+id+'/read',{method:'PUT'}); await loadAFb(); updateStats(); }
async function delFb(id){ if(!confirm('Delete this feedback?'))return; const r=await fetch('/api/feedback/'+id,{method:'DELETE'}); if(!(await checkRes(r))) return; await loadAFb(); updateStats(); toast('Feedback deleted.'); }

/* ── MANAGE STAFF — Admin & Instructor (admin only) ── */
async function loadAStaff(){
  const r=await fetch('/api/staff'); AStaff=await r.json();
  const b=document.getElementById('staff-body'); if(!b) return;
  b.innerHTML=AStaff.length?AStaff.map(s=>{
    const roleLabel = s.role==='admin' ? 'Administrator' : 'Instructor';
    const roleBadge = s.role==='admin' ? 'b-ok' : 'b-pend';
    const statusLabel = s.status==='active' ? 'Active' : 'Inactive';
    return '<tr><td>'+s.name+'</td><td>'+s.username+'</td><td>'+(s.email||'—')+'</td>'+
      '<td><span class="badge '+roleBadge+'">'+roleLabel+'</span></td>'+
      '<td>'+(s.specialty||'—')+'</td>'+
      '<td>'+statusLabel+'</td>'+
      '<td><div style="display:flex;gap:6px">'+
        '<button class="btn bo bsm" onclick="openEditStaff(\''+s.id+'\')">Edit</button>'+
        '<button class="btn bd bsm" onclick="delStaff(\''+s.id+'\')">Delete</button>'+
      '</div></td></tr>';
  }).join(''):'<tr><td colspan="7" style="padding:16px;color:var(--mt)">No staff yet. Add an instructor account for your team.</td></tr>';
}
function openStaffMo(){
  st('staff-mo-t','Add Staff Account'); sv('staff-eid','');sv('staff-name','');sv('staff-username','');sv('staff-email','');sv('staff-pass','');sv('staff-specialty','');sv('staff-bio','');
  document.getElementById('staff-role').value='instructor';
  document.getElementById('staff-pass-hint').textContent='Password for the first login.';
  openMo('staff-mo');
}
function openEditStaff(id){
  const s=AStaff.find(x=>x.id===id); if(!s) return;
  st('staff-mo-t','Edit Staff Account'); sv('staff-eid',s.id); sv('staff-name',s.name); sv('staff-username',s.username);
  sv('staff-email',s.email||''); sv('staff-pass',''); sv('staff-specialty',s.specialty||''); sv('staff-bio',s.bio||'');
  document.getElementById('staff-role').value=s.role;
  document.getElementById('staff-pass-hint').textContent='Leave blank to keep the current password.';
  openMo('staff-mo');
}
async function saveStaff(){
  const id=gv('staff-eid');
  const body={
    name:gv('staff-name'), username:gv('staff-username'), email:gv('staff-email'),
    role:document.getElementById('staff-role').value,
    specialty:gv('staff-specialty'), bio:gv('staff-bio'),
  };
  const pw=gv('staff-pass');
  if(pw) body.password=pw;

  if(!body.name||!body.username){ toast('Name and username are required.','err'); return; }
  if(!id && !pw){ toast('Password is required for a new account.','err'); return; }

  if(id){
    const r=await fetch('/api/staff/'+id,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(!d.ok){ toast(d.error||'Failed to save.','err'); return; }
  } else {
    const r=await fetch('/api/staff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const d=await r.json();
    if(!d.ok){ toast(d.error||'Failed to save.','err'); return; }
  }
  closeMo('staff-mo'); await loadAStaff(); toast('Staff account saved.','ok');
}
async function delStaff(id){
  if(!confirm('Delete this staff account? It will no longer be able to sign in.'))return;
  const r=await fetch('/api/staff/'+id,{method:'DELETE'});
  if(!(await checkRes(r))) return;
  await loadAStaff(); toast('Staff account deleted.');
}

/* ── SYSTEM STATUS (admin only) ── */
async function loadSysStatus(){
  if(!isAdminRole()) return;
  try{
    const r=await fetch('/api/status'); const d=await r.json();
    const db=document.getElementById('adm-db'); if(db) db.textContent=d.supabase?'DB: Supabase':'DB: Local';
    const mt=document.getElementById('adm-mt'); if(mt) mt.textContent=d.midtrans?'Payment: Midtrans '+d.midtransEnv:'Payment: Simulation';

    const ss=document.getElementById('sys-stat');
    if(ss) ss.innerHTML='<div>Database: <strong>'+(d.supabase?'Supabase ☁':'Unavailable')+'</strong></div>'+
      '<div>Payment: <strong>'+(d.midtrans?'Midtrans '+d.midtransEnv:'Simulation Mode')+'</strong></div>'+
      '<div style="margin-top:10px;font-size:12px">'+(d.midtrans?'Real payments are active via Midtrans.':'Bookings are confirmed automatically without real payment. Configure .env for Midtrans.')+'</div>';

    const mts=document.getElementById('mt-status');
    if(mts) mts.innerHTML='<div>Status: <strong style="color:'+(d.midtrans?'var(--ok)':'var(--a)')+'">'+(d.midtrans?'✓ Connected':'✗ Not configured')+'</strong></div>'+
      '<div>Environment: <strong>'+(d.midtransEnv||'—')+'</strong></div>'+
      '<div style="margin-top:8px;font-size:12px">'+(d.midtrans?'Customer payments will be processed via Midtrans Snap.':'Bookings currently use simulation mode (confirmed instantly without real payment).')+'</div>';
  }catch(e){}
}

/* ── SECTION SWITCH ── */
/* ── MONTHLY REPORTS ── */
function initReport(){
  const now=new Date();
  const mEl=document.getElementById('rpt-month');
  const yEl=document.getElementById('rpt-year');
  if(mEl&&!mEl.dataset.init){mEl.value=now.getMonth()+1;mEl.dataset.init='1';}
  if(yEl&&!yEl.value) yEl.value=now.getFullYear();
}

async function loadReport(){
  const m=document.getElementById('rpt-month')?.value;
  const y=document.getElementById('rpt-year')?.value;
  if(!m||!y){toast('Please select a month and year.','err');return;}
  const r=await fetch(`/api/reports/monthly?month=${m}&year=${y}`);
  const d=await r.json();
  const hint=document.getElementById('rpt-hint');
  if(hint) hint.style.display='none';
  document.getElementById('rpt-result').style.display='block';
  st('rpt-total',d.summary.totalBookings);
  st('rpt-conf',d.summary.confirmed);
  st('rpt-canc',d.summary.cancelled);
  st('rpt-rev',fmtRp(d.summary.revenue));
  const clsB=document.getElementById('rpt-classes');
  if(clsB) clsB.innerHTML=d.topClasses.length
    ?d.topClasses.map(c=>`<tr><td>${c.name}</td><td style="font-weight:600">${c.count}</td></tr>`).join('')
    :'<tr><td colspan="2" style="padding:14px;color:var(--mt)">No data.</td></tr>';
  const dayB=document.getElementById('rpt-daily');
  if(dayB) dayB.innerHTML=d.dailyData.length
    ?d.dailyData.map(x=>{const dt=new Date(x.date);const lbl=dt.toLocaleDateString('en-US',{day:'numeric',month:'short'});return`<tr><td>${lbl}</td><td>${x.bookings}</td><td>${fmtRp(x.revenue)}</td></tr>`;}).join('')
    :'<tr><td colspan="3" style="padding:14px;color:var(--mt)">No data.</td></tr>';
}

function exportReport(){
  const m=document.getElementById('rpt-month')?.value;
  const y=document.getElementById('rpt-year')?.value;
  if(!m||!y){toast('Please select a month and year.','err');return;}
  downloadWithAuth(`/api/reports/monthly/excel?month=${m}&year=${y}`, `report-${m}-${y}.xlsx`);
}

/* ── EMAIL STATUS ── */
async function loadEmailStatus(){
  try{
    const r=await fetch('/api/status');const d=await r.json();
    const el=document.getElementById('email-status');
    if(el) el.innerHTML=d.email
      ?`<div>Status: <strong style="color:var(--ok)">✓ Active</strong></div><div>Account: <strong>${d.emailUser}</strong></div><div style="font-size:12px;margin-top:8px">Booking confirmation, reminder, and cancellation notification emails are active.</div>`
      :`<div>Status: <strong style="color:var(--a)">✗ Not configured</strong></div><div style="font-size:12px;margin-top:8px">Fill in EMAIL_HOST, EMAIL_USER, and EMAIL_PASS in .env to enable automatic email notifications.</div>`;
  }catch(e){}
}

/* ── REMINDERS ── */
async function sendReminders(){
  const btn=document.querySelector('[onclick="sendReminders()"]');
  if(btn){btn.textContent='Sending...';btn.disabled=true;}
  try{
    const r=await fetch('/api/reminders/send',{method:'POST'});
    const d=await r.json();
    const res=document.getElementById('reminder-result');
    if(d.ok){
      if(res) res.textContent=`Done: ${d.sent} emails sent${d.failed>0?', '+d.failed+' failed':''}.`;
      toast(`${d.sent} reminders sent.`,'ok');
    }else{
      if(res) res.textContent=d.reason||'Failed to send reminders.';
      toast(d.reason||'Failed.','err');
    }
  }catch(e){toast('Connection error.','err');}
  finally{if(btn){btn.textContent='Send Reminders Now';btn.disabled=false;}}
}

/* ── ANALYTICS (admin only) ── */
let _anLoaded=false;
async function loadAnalytics(){
  if(!isAdminRole()) return;
  try{
    const r=await fetch('/api/stats/admin'); const d=await r.json();
    if(d.error) return;
    _anLoaded=true;

    st('an-rev',fmtRp(d.summary.totalRevenue));
    const growEl=document.getElementById('an-rev-grow');
    if(growEl){
      const g=d.summary.revenueGrowthPct;
      growEl.className='stat-grow '+(g>=0?'up':'down');
      growEl.textContent=(g>=0?'▲ ':'▼ ')+Math.abs(g)+'%';
    }
    st('an-avg',fmtRp(d.summary.avgBookingValue));
    st('an-canc',d.summary.cancellationRate+'%');
    st('an-occ',d.summary.occupancyRate+'%');
    st('an-active-pkg',d.summary.activePackagesCount);

    // Monthly chart
    const maxMonthly=Math.max(1,...d.monthly12.map(m=>m.revenue));
    const mc=document.getElementById('an-monthly-chart');
    if(mc) mc.innerHTML=d.monthly12.map(m=>`
      <div class="bchart-col" title="${m.label}: ${fmtRp(m.revenue)}">
        <div class="bchart-bar" style="height:${Math.max(2,(m.revenue/maxMonthly)*100)}%"></div>
        <div class="bchart-label">${m.label}</div>
      </div>`).join('');

    // Top classes (horizontal bar)
    const maxCls=Math.max(1,...d.topClasses.map(c=>c.bookings));
    const tc=document.getElementById('an-top-classes');
    if(tc) tc.innerHTML=d.topClasses.length?d.topClasses.map(c=>`
      <div class="hbar-row">
        <div class="hbar-label">${c.name}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${(c.bookings/maxCls)*100}%"></div></div>
        <div class="hbar-val">${c.bookings}x</div>
      </div>`).join(''):'<p class="sm" style="padding:10px 0">No data yet.</p>';

    // Instructors
    const maxInst=Math.max(1,...d.instructorPerformance.map(i=>i.revenue));
    const ip=document.getElementById('an-instructors');
    if(ip) ip.innerHTML=d.instructorPerformance.length?d.instructorPerformance.map(i=>`
      <div class="hbar-row">
        <div class="hbar-label">${i.name}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${(i.revenue/maxInst)*100}%"></div></div>
        <div class="hbar-val">${fmtRp(i.revenue)}</div>
      </div>`).join(''):'<p class="sm" style="padding:10px 0">No data yet.</p>';

    // Bookings by day
    const maxDay=Math.max(1,...d.bookingsByDay.map(x=>x.count));
    const dc=document.getElementById('an-day-chart');
    if(dc) dc.innerHTML=d.bookingsByDay.map(x=>`
      <div class="bchart-col" title="${x.day}: ${x.count} bookings">
        <div class="bchart-bar alt" style="height:${Math.max(2,(x.count/maxDay)*100)}%"></div>
        <div class="bchart-label">${x.day.slice(0,3)}</div>
      </div>`).join('');

    // Busiest hours
    const maxHour=Math.max(1,...d.peakHours.map(h=>h.count));
    const hc=document.getElementById('an-hour-chart');
    if(hc) hc.innerHTML=d.peakHours.length?d.peakHours.map(h=>`
      <div class="bchart-col" title="${h.hour}: ${h.count} bookings">
        <div class="bchart-bar" style="height:${Math.max(2,(h.count/maxHour)*100)}%"></div>
        <div class="bchart-label">${h.hour}</div>
      </div>`).join(''):'<p class="sm" style="padding:10px 0">No data yet.</p>';

    // Member growth
    const maxMem=Math.max(1,...d.memberGrowth.map(m=>m.count));
    const mgc=document.getElementById('an-member-chart');
    if(mgc) mgc.innerHTML=d.memberGrowth.map(m=>`
      <div class="bchart-col" title="${m.label}: ${m.count} new members">
        <div class="bchart-bar alt" style="height:${Math.max(2,(m.count/maxMem)*100)}%"></div>
        <div class="bchart-label">${m.label}</div>
      </div>`).join('');

    // Membership distribution
    const distEntries=Object.entries(d.membershipDist);
    const maxDist=Math.max(1,...distEntries.map(([,v])=>v));
    const mdEl=document.getElementById('an-membership-dist');
    if(mdEl) mdEl.innerHTML=distEntries.length?distEntries.map(([type,count])=>`
      <div class="hbar-row">
        <div class="hbar-label" style="text-transform:capitalize">${type}</div>
        <div class="hbar-track"><div class="hbar-fill" style="width:${(count/maxDist)*100}%"></div></div>
        <div class="hbar-val">${count}</div>
      </div>`).join(''):'<p class="sm" style="padding:10px 0">No data yet.</p>';
  }catch(e){ console.error('Analytics error:',e); }
}

/* ── REALTIME (polling — no Socket.IO, safe on any budget hosting) ── */
let _adminPollTimer=null;
function initAdminSocket(){
  if(_adminPollTimer) clearInterval(_adminPollTimer);
  _adminPollTimer=setInterval(pollAdminUpdates, 20000);
}
async function pollAdminUpdates(){
  const before=new Set(_anotifs.map(n=>n.id));
  await loadAdminNotifs();
  const hasNew=_anotifs.some(n=>!before.has(n.id));
  if(hasNew){
    const newest=_anotifs.find(n=>!before.has(n.id));
    if(newest) toast(newest.title+': '+newest.message, newest.type==='warning'?'err':'ok');
    loadABk().then(()=>updateStats());
    // Refresh admin lists that can change without a full page reload.
    if(newest?.title?.toLowerCase().includes('member')) loadAMb();
    if(newest?.title?.toLowerCase().includes('membership')) loadAMb();
    if(newest?.message?.toLowerCase().includes('joined')) loadAMb();
    if(newest?.title?.toLowerCase().includes('feedback')) loadAFb();
    if(_anLoaded) loadAnalytics();
  }
  if(document.getElementById('adm-schedule')?.classList.contains('active')) loadASch();
}

/* ── ADMIN NOTIFICATIONS ── */
let _anotifs=[];
async function loadAdminNotifs(){
  try{
    const r=await fetch('/api/notifications/admin'); _anotifs=await r.json();
    renderAdminNotifPanel();
  }catch(e){}
}
function renderAdminNotifPanel(){
  const list=document.getElementById('notif-list');
  const dot=document.getElementById('notif-dot');
  const unread=_anotifs.filter(n=>!n.read).length;
  if(dot) dot.classList.toggle('show',unread>0);
  if(!list) return;
  if(!_anotifs.length){ list.innerHTML='<div class="notif-empty">No notifications yet.</div>'; return; }
  list.innerHTML=_anotifs.map(n=>`
    <a href="${n.link||'#'}" class="notif-item ${n.read?'':'unread'}" onclick="markAdminNotifRead('${n.id}')">
      <div class="notif-item-top">${n.read?'':'<span class="notif-item-dot"></span>'}<span class="notif-item-title">${n.title}</span></div>
      <div class="notif-item-msg">${n.message}</div>
      <div class="notif-item-time">${timeAgo(n.created_at)}</div>
    </a>`).join('');
}
function toggleNotifPanel(){
  const p=document.getElementById('notif-panel'); if(!p) return;
  const willOpen=!p.classList.contains('open');
  document.querySelectorAll('.notif-panel.open').forEach(el=>el.classList.remove('open'));
  if(willOpen){ p.classList.add('open'); loadAdminNotifs(); }
}
document.addEventListener('click',e=>{
  if(!e.target.closest('.notif-wrap')) document.querySelectorAll('.notif-panel.open').forEach(el=>el.classList.remove('open'));
});
async function markAdminNotifRead(id){
  const n=_anotifs.find(x=>x.id===id); if(n) n.read=true;
  renderAdminNotifPanel();
  try{ await fetch('/api/notifications/'+id+'/read',{method:'PUT'}); }catch(e){}
}
async function markAllNotifsRead(event){
  if(event) event.stopPropagation();
  _anotifs.forEach(n=>n.read=true); renderAdminNotifPanel();
  try{ await fetch('/api/notifications/read-all',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({audience:'admin'})}); }catch(e){}
}
function timeAgo(iso){
  if(!iso) return '';
  const s=Math.floor((Date.now()-new Date(iso).getTime())/1000);
  if(s<60) return 'Just now';
  if(s<3600) return Math.floor(s/60)+' min ago';
  if(s<86400) return Math.floor(s/3600)+' hr ago';
  return Math.floor(s/86400)+' day(s) ago';
}

function sw(id,btn){
  document.querySelectorAll('.adm-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.adm-link').forEach(b=>b.classList.remove('active'));
  document.getElementById('adm-'+id)?.classList.add('active');
  btn?.classList.add('active');
}

document.addEventListener('DOMContentLoaded', async ()=>{
  loadCurrentStaff();
  const token = localStorage.getItem('avaia_staff');

  if(!CURRENT_STAFF || !token){
    document.getElementById('gate').style.display='flex';
    return;
  }

  // Never trust stale localStorage alone. Validate the staff JWT before opening
  // the admin application.
  try{
    const r = await fetch('/api/me');
    if(r.ok){
      const d = await r.json();
      if(d?.user){
        CURRENT_STAFF = d.user;
        localStorage.setItem('avaia_staff_user', JSON.stringify(d.user));
        showAdm();
        return;
      }
    }
  }catch(e){}

  localStorage.removeItem('avaia_staff');
  localStorage.removeItem('avaia_staff_user');
  CURRENT_STAFF = null;
  document.getElementById('gate').style.display='flex';
});
