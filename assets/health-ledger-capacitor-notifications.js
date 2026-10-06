/* Health Ledger notification adapter. Safe to load in an ordinary browser. */
(function (global) {
  'use strict';
  const CHANNEL_ID = 'pill-reminders';
  const PLUGIN_NAME = 'LocalNotifications';
  const MAX_ID = 2000000000;
  const DAY_MAP = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7 };
  function plugin() { return global.Capacitor?.Plugins?.[PLUGIN_NAME] || null; }
  function isNative() {
    const cap = global.Capacitor;
    if (!cap || !plugin()) return false;
    try { return typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : ['android', 'ios'].includes(cap.getPlatform?.()); }
    catch (_) { return false; }
  }
  function stableBase(pill) {
    let hash = 2166136261;
    for (const ch of String(pill.id || pill.name || 'pill')) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return (Math.abs(hash >>> 0) % 1000000) * 1000 + 100;
  }
  function normalizeNotificationColor(value) {
  const color = String(value || '').trim();

  return /^#[0-9a-fA-F]{6}$/.test(color)
    ? color.toUpperCase()
    : '#4B9B76';
}
  function reminderEntries(pill, includeInactive = false) {
    const times = Array.isArray(pill.times) ? pill.times : [];
    if ((!pill.active && !includeInactive) || pill.schedule === 'asNeeded' || !times.length) return [];
    const days = pill.schedule === 'weekdays' ? [1,2,3,4,5] : pill.schedule === 'custom' ? (pill.days || []).map(Number).filter(n => n >= 0 && n <= 6) : [null];
    const entries = [];
    times.forEach((time, timeIndex) => {
      const [hour, minute] = String(time).split(':').map(Number);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
      days.forEach((day, dayIndex) => {
        const id = stableBase(pill) + timeIndex * 8 + dayIndex;
        const scheduleOn = { hour, minute };
        if (day !== null) scheduleOn.weekday = DAY_MAP[day];
        const bodyDose = pill.dosage ? ` (${pill.dosage})` : '';
        const color = normalizeNotificationColor(pill.color);

entries.push({
  id: id % MAX_ID || 1,
  title: 'Pill reminder',
  body: `Time to take ${pill.name}${bodyDose}.`,
  channelId: CHANNEL_ID,
  color: color,
  schedule: {
    on: scheduleOn,
    repeats: true,
    allowWhileIdle: true
  },
  extra: {
    type: 'pill-dose',
    pillId: pill.id,
    pillColor: color,
    weekday: day === null ? null : DAY_MAP[day],
    time: time
  }
});
      });
    });
    return entries;
  }
  async function requestPermission() {
    if (!isNative()) return { granted: false, reason: 'browser' };
    try {
      let result = await plugin().checkPermissions();
      if (result.display !== 'granted') result = await plugin().requestPermissions();
      return { granted: result.display === 'granted', reason: result.display === 'granted' ? '' : (result.display || 'denied') };
    } catch (error) { return { granted: false, reason: error?.message || 'permission-error' }; }
  }
  async function createAndroidChannel() {
    if (!isNative() || global.Capacitor.getPlatform?.() !== 'android' || !plugin().createChannel) return { supported: false };
    try { await plugin().createChannel({ id: CHANNEL_ID, name: 'Pill reminders', description: 'Scheduled reminders to take medication', importance: 4, visibility: 1, sound: 'default', vibration: true }); return { supported: true }; }
    catch (error) { return { supported: true, error: error?.message || String(error) }; }
  }
  function notificationIdForPill(pill) { return stableBase(pill); }
  function notificationIdsForPill(pill) { return reminderEntries(pill, true).map(item => item.id); }
  async function cancelPill(pill) {
    if (!isNative()) return { supported: false, cancelled: 0 };
    try {
      const ids = notificationIdsForPill(pill);
      if (ids.length) await plugin().cancel({ notifications: ids.map(id => ({ id })) });
      return { supported: true, cancelled: ids.length };
    } catch (error) { return { supported: true, cancelled: 0, error: error?.message || String(error) }; }
  }
  async function checkExactAlarmPermission() {
    if (!isNative() || global.Capacitor.getPlatform?.() !== 'android') return { supported: false, granted: null, reason: 'not-android' };
    try {
      const p = plugin();
      if (typeof p.checkExactNotificationSetting === 'function') {
        const result = await p.checkExactNotificationSetting();
        const granted = result.exactAlarm === true || result.exactAlarm === 'granted' || result.granted === true || result.value === true;
        return { supported: true, granted, raw: result };
      }
      if (typeof p.checkExactAlarmPermission === 'function') {
        const result = await p.checkExactAlarmPermission();
        return { supported: true, granted: result.granted === true || result.value === true, raw: result };
      }
      return { supported: false, granted: null, reason: 'plugin-api-unavailable' };
    } catch (error) { return { supported: true, granted: false, reason: error?.message || String(error) }; }
  }
  async function openExactAlarmSettings() {
    if (!isNative()) return { opened: false, reason: 'browser' };
    try {
      const p = plugin();
      if (typeof p.changeExactNotificationSetting === 'function') { await p.changeExactNotificationSetting(); return { opened: true }; }
      if (typeof p.openExactAlarmSettings === 'function') { await p.openExactAlarmSettings(); return { opened: true }; }
      return { opened: false, reason: 'plugin-api-unavailable' };
    } catch (error) { return { opened: false, reason: error?.message || String(error) }; }
  }
  async function schedulePill(pill) {
    if (!isNative()) return { supported: false, scheduled: 0, exactAlarm: await checkExactAlarmPermission(), reason: 'browser' };
    const permission = await requestPermission();
    if (!permission.granted) return { supported: true, scheduled: 0, permission, exactAlarm: await checkExactAlarmPermission(), reason: 'permission-denied' };
    await createAndroidChannel();
    const entries = reminderEntries(pill);
    if (!entries.length) return { supported: true, scheduled: 0, permission, exactAlarm: await checkExactAlarmPermission(), reason: 'no-scheduled-times' };
    try { await plugin().schedule({ notifications: entries }); return { supported: true, scheduled: entries.length, permission, exactAlarm: await checkExactAlarmPermission() }; }
    catch (error) { return { supported: true, scheduled: 0, permission, exactAlarm: await checkExactAlarmPermission(), error: error?.message || String(error) }; }
  }
  async function syncPills(pills) {
    if (!isNative()) return { supported: false, scheduled: 0, cancelled: 0, exactAlarm: await checkExactAlarmPermission(), message: 'Native scheduled notifications are available after installing this app on Android.' };
    const permission = await requestPermission();
    if (!permission.granted) return { supported: true, permission, scheduled: 0, cancelled: 0, exactAlarm: await checkExactAlarmPermission(), message: 'Notification permission is not enabled.' };
    await createAndroidChannel();
    try { await plugin().cancelAll(); } catch (_) { /* first launch or plugin version may not expose this */ }
    let scheduled = 0;
    const errors = [];
    for (const pill of pills) {
      if (!pill.active || pill.schedule === 'asNeeded') continue;
      const entries = reminderEntries(pill);
      if (!entries.length) continue;
      try { await plugin().schedule({ notifications: entries }); scheduled += entries.length; }
      catch (error) { errors.push(`${pill.name}: ${error?.message || String(error)}`); }
    }
    return { supported: true, permission, scheduled, cancelled: 'all prior notifications', exactAlarm: await checkExactAlarmPermission(), errors, message: errors.length ? errors.join('; ') : `Reminder sync complete. ${scheduled} repeating notification(s) scheduled.` };
  }
  function registerActionListener(callback) {
    if (!isNative() || typeof callback !== 'function' || !plugin().addListener) return null;
    return plugin().addListener('localNotificationActionPerformed', event => callback(event?.notification || event));
  }
  global.HealthLedgerNotifications = { isNative, requestPermission, createAndroidChannel, notificationIdForPill, notificationIdsForPill, schedulePill, cancelPill, syncPills, registerActionListener, checkExactAlarmPermission, openExactAlarmSettings, plugin };
})(window);
