/* ═══════════════════════════════════════════════
   NOTIFICATIONS — create & store (db.json / Supabase)
   Realtime is handled via client-side POLLING (no server push),
   so no Socket.IO / persistent connection is needed.
═══════════════════════════════════════════════ */
const { v4: uuidv4 } = require('uuid');

/**
 * Creates notification functions connected to server.js's DB.
 * @param {object} opts { rDB, wDB, supabase, isSB }
 */
function createNotifier({ rDB, wDB, supabase, isSB }) {

  async function push({ audience, memberId = null, memberEmail = null, type = 'info', title, message, link = null }) {
    const notif = {
      id: uuidv4(), audience, memberId, memberEmail,
      type, title, message, link,
      read: false, created_at: new Date().toISOString(),
    };
    try {
      if (isSB()) {
        await supabase.from('notifications').insert(notif);
      } else {
        const db = rDB();
        if (!db.notifications) db.notifications = [];
        db.notifications.unshift(notif);
        // Cap stored notifications at 500 so db.json doesn't grow unbounded
        if (db.notifications.length > 500) db.notifications = db.notifications.slice(0, 500);
        wDB(db);
      }
    } catch (e) { console.error('Notif save error:', e.message); }
    return notif;
  }

  // No-op: kept so every caller in server.js doesn't need to change.
  // The client (schedule.html) already polls /api/schedule on its own.
  function broadcastScheduleUpdate() {}

  return { push, broadcastScheduleUpdate };
}

module.exports = { createNotifier };
