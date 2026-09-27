/* Avaia Studio notifications — Supabase only. */
const { v4: uuidv4 } = require('uuid');

function createNotifier({ supabase, isSB }) {
  async function push({ audience, memberId = null, memberEmail = null, type = 'info', title, message, link = null }) {
    const notif = {
      id: uuidv4(), audience, memberId, memberEmail,
      type, title, message, link, read: false,
      created_at: new Date().toISOString(),
    };
    if (!isSB() || !supabase) {
      console.error('Notification write skipped: Supabase is required.');
      return notif;
    }
    try {
      const { error } = await supabase.from('notifications').insert(notif);
      if (error) console.error('Notif save error:', error.message);
    } catch (e) {
      console.error('Notif save error:', e.message);
    }
    return notif;
  }

  function broadcastScheduleUpdate() {}
  return { push, broadcastScheduleUpdate };
}

module.exports = { createNotifier };
