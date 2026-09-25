/* ═══════════════════════════════════════════════
   ADMIN STATS — full statistics calculation
═══════════════════════════════════════════════ */
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function buildAdminStats({ bookings = [], members = [], classes = [], schedule = [], memberPackages = [] }) {
  const confirmed = bookings.filter(b => b.status === 'confirmed');
  const cancelled = bookings.filter(b => b.status === 'cancelled');
  const noShow = bookings.filter(b => b.status === 'no-show');
  const classRevenue = confirmed.reduce((s, b) => s + (parseInt(b.amount) || 0), 0);
  const packageRevenue = memberPackages.reduce((s, p) => s + (parseInt(p.price_paid) || 0), 0);
  const totalRevenue = classRevenue + packageRevenue;
  const avgBookingValue = confirmed.length ? Math.round(classRevenue / confirmed.length) : 0;
  const cancellationRate = (confirmed.length + cancelled.length) > 0
    ? +((cancelled.length / (confirmed.length + cancelled.length)) * 100).toFixed(1) : 0;

  // ── Revenue over the last 30 days ──
  const today = new Date();
  const dailyMap = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const key = d.toISOString().split('T')[0];
    dailyMap[key] = { date: key, revenue: 0, bookings: 0 };
  }
  confirmed.forEach(b => {
    if (!b.created_at) return;
    const key = new Date(b.created_at).toISOString().split('T')[0];
    if (dailyMap[key]) { dailyMap[key].revenue += (parseInt(b.amount) || 0); dailyMap[key].bookings++; }
  });
  memberPackages.forEach(p => {
    if (!p.purchased_at) return;
    const key = new Date(p.purchased_at).toISOString().split('T')[0];
    if (dailyMap[key]) dailyMap[key].revenue += (parseInt(p.price_paid) || 0);
  });
  const daily30 = Object.values(dailyMap);

  // ── Revenue over the last 12 months ──
  const monthlyMap = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    monthlyMap[key] = { key, label: MONTH_NAMES[d.getMonth()] + " '" + String(d.getFullYear()).slice(2), revenue: 0, bookings: 0 };
  }
  confirmed.forEach(b => {
    if (!b.created_at) return;
    const d = new Date(b.created_at);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (monthlyMap[key]) { monthlyMap[key].revenue += (parseInt(b.amount) || 0); monthlyMap[key].bookings++; }
  });
  memberPackages.forEach(p => {
    if (!p.purchased_at) return;
    const d = new Date(p.purchased_at);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (monthlyMap[key]) monthlyMap[key].revenue += (parseInt(p.price_paid) || 0);
  });
  const monthly12 = Object.values(monthlyMap);

  // ── Revenue over the last 12 weeks (Mon–Sun), confirmed payments only ──
  function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay(); // 0=Sun..6=Sat
    const diff = (day === 0 ? -6 : 1) - day; // shift back to Monday
    x.setDate(x.getDate() + diff);
    return x;
  }
  const weeklyMap = {};
  const weekOrder = [];
  const thisWeekStart = startOfWeek(today);
  for (let i = 11; i >= 0; i--) {
    const ws = new Date(thisWeekStart); ws.setDate(thisWeekStart.getDate() - i * 7);
    const we = new Date(ws); we.setDate(ws.getDate() + 6);
    const key = ws.toISOString().split('T')[0];
    const label = `${String(ws.getDate()).padStart(2, '0')}/${String(ws.getMonth() + 1).padStart(2, '0')}`;
    weeklyMap[key] = { key, label, weekStart: key, weekEnd: we.toISOString().split('T')[0], revenue: 0, bookings: 0 };
    weekOrder.push(key);
  }
  function weekKeyFor(dateVal) {
    const ws = startOfWeek(new Date(dateVal));
    return ws.toISOString().split('T')[0];
  }
  confirmed.forEach(b => {
    if (!b.created_at) return;
    const key = weekKeyFor(b.created_at);
    if (weeklyMap[key]) { weeklyMap[key].revenue += (parseInt(b.amount) || 0); weeklyMap[key].bookings++; }
  });
  memberPackages.forEach(p => {
    if (!p.purchased_at) return;
    const key = weekKeyFor(p.purchased_at);
    if (weeklyMap[key]) weeklyMap[key].revenue += (parseInt(p.price_paid) || 0);
  });
  const weekly12 = weekOrder.map(k => weeklyMap[k]);

  // Growth this week vs last week
  const thisWeekData = weekly12[weekly12.length - 1];
  const lastWeekData = weekly12[weekly12.length - 2] || { revenue: 0, bookings: 0 };
  const weeklyRevenueGrowthPct = lastWeekData.revenue > 0
    ? +(((thisWeekData.revenue - lastWeekData.revenue) / lastWeekData.revenue) * 100).toFixed(1)
    : (thisWeekData.revenue > 0 ? 100 : 0);

  // Growth this month vs last month
  const thisMonthKey = monthly12[monthly12.length - 1];
  const lastMonthKey = monthly12[monthly12.length - 2] || { revenue: 0, bookings: 0 };
  const revenueGrowthPct = lastMonthKey.revenue > 0
    ? +(((thisMonthKey.revenue - lastMonthKey.revenue) / lastMonthKey.revenue) * 100).toFixed(1)
    : (thisMonthKey.revenue > 0 ? 100 : 0);

  // ── Top classes (all-time) ──
  const classCounts = {};
  confirmed.forEach(b => {
    if (!classCounts[b.class]) classCounts[b.class] = { name: b.class, bookings: 0, revenue: 0 };
    classCounts[b.class].bookings++;
    classCounts[b.class].revenue += (parseInt(b.amount) || 0);
  });
  const topClasses = Object.values(classCounts).sort((a, b) => b.bookings - a.bookings).slice(0, 8);

  // ── Instructor performance ──
  const classToInstructor = {};
  classes.forEach(c => { classToInstructor[c.name] = c.instructor; });
  const instrMap = {};
  confirmed.forEach(b => {
    const inst = classToInstructor[b.class] || 'Unknown';
    if (!instrMap[inst]) instrMap[inst] = { name: inst, bookings: 0, revenue: 0 };
    instrMap[inst].bookings++;
    instrMap[inst].revenue += (parseInt(b.amount) || 0);
  });
  const instructorPerformance = Object.values(instrMap).sort((a, b) => b.revenue - a.revenue);

  // ── Peak hours ──
  const hourMap = {};
  confirmed.forEach(b => {
    const hour = (b.time || '00.00').split('.')[0].padStart(2, '0') + ':00';
    hourMap[hour] = (hourMap[hour] || 0) + 1;
  });
  const peakHours = Object.entries(hourMap)
    .map(([hour, count]) => ({ hour, count }))
    .sort((a, b) => a.hour.localeCompare(b.hour));

  // ── Bookings by day of the week ──
  const DAY_ORDER = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const dayCount = {}; DAY_ORDER.forEach(d => dayCount[d] = 0);
  const schedById = {}; schedule.forEach(s => { schedById[s.id] = s; });
  confirmed.forEach(b => {
    const sc = schedById[b.schedule_id];
    if (sc && sc.day) dayCount[sc.day] = (dayCount[sc.day] || 0) + 1;
  });
  const bookingsByDay = DAY_ORDER.map(d => ({ day: d, count: dayCount[d] || 0 }));

  // ── Member growth (last 6 months) ──
  const memberMonthMap = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    memberMonthMap[key] = { key, label: MONTH_NAMES[d.getMonth()] + " '" + String(d.getFullYear()).slice(2), count: 0 };
  }
  members.forEach(m => {
    if (!m.joined) return;
    const d = new Date(m.joined);
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    if (memberMonthMap[key]) memberMonthMap[key].count++;
  });
  const memberGrowth = Object.values(memberMonthMap);

  // ── Membership type distribution ──
  const membershipDist = {};
  members.forEach(m => {
    const t = m.membership_type || 'drop-in';
    membershipDist[t] = (membershipDist[t] || 0) + 1;
  });

  // ── Current class occupancy rate ──
  const totalCapacitySlots = schedule.reduce((s, sc) => {
    const cls = classes.find(c => c.id === (sc.classId || sc.class_id));
    return s + (cls?.capacity || 0);
  }, 0);
  const totalFilledSlots = schedule.reduce((s, sc) => {
    const cls = classes.find(c => c.id === (sc.classId || sc.class_id));
    const cap = cls?.capacity || 0;
    return s + Math.max(0, cap - (sc.slots || 0));
  }, 0);
  const occupancyRate = totalCapacitySlots > 0 ? +((totalFilledSlots / totalCapacitySlots) * 100).toFixed(1) : 0;

  return {
    summary: {
      totalRevenue, classRevenue, packageRevenue,
      totalBookings: bookings.length, confirmedCount: confirmed.length,
      cancelledCount: cancelled.length, noShowCount: noShow.length, cancellationRate, avgBookingValue,
      totalMembers: members.length, revenueGrowthPct,
      thisMonthRevenue: thisMonthKey.revenue, lastMonthRevenue: lastMonthKey.revenue,
      weeklyRevenueGrowthPct, thisWeekRevenue: thisWeekData.revenue, lastWeekRevenue: lastWeekData.revenue,
      occupancyRate, activePackagesCount: memberPackages.filter(p=>{
        const expired = p.expires_at && new Date() > new Date(p.expires_at);
        const depleted = (p.credits_used||0) >= (p.credits_total||0);
        return !expired && !depleted;
      }).length,
    },
    daily30, monthly12, weekly12, topClasses, instructorPerformance,
    peakHours, bookingsByDay, memberGrowth, membershipDist,
  };
}

module.exports = { buildAdminStats };
