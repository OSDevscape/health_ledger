/* Health Ledger notification adapter. Safe to load in an ordinary browser. */
(function (global) {
  'use strict';

  const CHANNEL_ID = 'pill-reminders';
  const APPOINTMENT_CHANNEL_ID = 'appointment-reminders';
  const ACTION_TYPE_ID = 'PILL_DOSE_ACTIONS';
  const APPOINTMENT_ACTION_TYPE_ID = 'APPOINTMENT_ACTIONS';
  const PLUGIN_NAME = 'LocalNotifications';
  const MAX_ID = 2000000000;

  // ID layout (all must stay below 2^31 - 1):
  //   Pill reminders      < 1,100,000,000  (per-pill block of 1000: +100.. repeating, +800..999 snoozes)
  //   Appointment reminders 1,100,000,000 .. 1,110,000,000
  //   Missed-dose follow-ups 1,110,000,000 .. 1,120,000,000
  //   Test reminder        1,999,999,000
  const APPOINTMENT_ID_MIN = 1100000000;
  const APPOINTMENT_ID_MAX = 1110000000;
  const MISSED_ID_MIN = 1110000000;
  const MISSED_ID_MAX = 1120000000;
  const TEST_ID = 1999999000;
  const SNOOZE_OFFSET = 700;

  const APPOINTMENT_OFFSETS = [1440, 120, 60, 15];
  const OFFSET_LABELS = { 1440: 'in 1 day', 120: 'in 2 hours', 60: 'in 1 hour', 15: 'in 15 minutes' };
  const FINISHED_STATUSES = ['completed', 'missed', 'canceled'];
  const DAY_MAP = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7 };

  const APPOINTMENT_ACTIONS = [
    { id: 'completed', title: 'Completed' },
    { id: 'missed', title: 'Missed' },
  ];
  const DOSE_ACTIONS = [
    { id: 'taken', title: 'Mark taken' },
    { id: 'skip', title: 'Skip' },
    { id: 'snooze', title: 'Snooze' },
  ];

  function plugin() { return global.Capacitor?.Plugins?.[PLUGIN_NAME] || null; }

  function isNative() {
    const cap = global.Capacitor;
    if (!cap || !plugin()) return false;
    try { return typeof cap.isNativePlatform === 'function' ? cap.isNativePlatform() : ['android', 'ios'].includes(cap.getPlatform?.()); }
    catch (_) { return false; }
  }

  function isAndroid() {
    try { return isNative() && global.Capacitor.getPlatform?.() === 'android'; }
    catch (_) { return false; }
  }

  function hashString(value) {
    let hash = 2166136261;
    for (const ch of String(value)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return hash >>> 0;
  }

  function stableBase(pill) {
    return (hashString(pill.id || pill.name || 'pill') % 1000000) * 1000 + 100;
  }

  function appointmentBase(appointment) {
    return APPOINTMENT_ID_MIN + (hashString(appointment.id) % 1000000) * 10;
  }

  function normalizeNotificationColor(value) {
    const color = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toUpperCase() : '#4B9B76';
  }

  function errorMessage(error) { return error?.message || String(error); }

  /* ---------- Pill reminders ---------- */

  function reminderEntries(pill, includeInactive = false) {
    const times = Array.isArray(pill.times) ? pill.times : [];
    if ((!pill.active && !includeInactive) || pill.schedule === 'asNeeded' || !times.length) return [];
    const days = pill.schedule === 'weekdays' ? [1, 2, 3, 4, 5] : pill.schedule === 'custom' ? (pill.days || []).map(Number).filter(n => n >= 0 && n <= 6) : [null];
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
          actionTypeId: ACTION_TYPE_ID,
          schedule: { on: scheduleOn, repeats: true, allowWhileIdle: true },
          extra: {
            type: 'pill-dose',
            pillId: pill.id,
            pillColor: color,
            weekday: day === null ? null : DAY_MAP[day],
            time: time,
          },
        });
      });
    });
    return entries;
  }

  function snoozeIdFor(pill, time) {
    const index = Math.max(0, (Array.isArray(pill.times) ? pill.times : []).indexOf(time));
    return (stableBase(pill) + SNOOZE_OFFSET + (index % 200)) % MAX_ID || 1;
  }

  function notificationIdForPill(pill) { return stableBase(pill); }

  function notificationIdsForPill(pill) {
    const ids = reminderEntries(pill, true).map(item => item.id);
    const times = Array.isArray(pill.times) ? pill.times : [];
    times.forEach(time => ids.push(snoozeIdFor(pill, time)));
    return [...new Set(ids)];
  }

  function expectedPillReminderCount(pills) {
    return (pills || []).reduce((sum, pill) => sum + reminderEntries(pill).length, 0);
  }

  /* ---------- Appointment reminders ---------- */

  function parseAppointmentTime(value) {
    const text = String(value || '');
    return new Date(text.length === 16 ? `${text}:00` : text);
  }

  function appointmentIdsFor(appointment) {
    const base = appointmentBase(appointment);
    return APPOINTMENT_OFFSETS.map((_, index) => base + index);
  }

  function appointmentWhenText(date) {
    try {
      return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
    } catch (_) { return date.toLocaleString(); }
  }

  function appointmentReminderEntries(appointment, nowMs = Date.now()) {
    if (!appointment || !appointment.id || FINISHED_STATUSES.includes(appointment.status)) return [];
    const start = parseAppointmentTime(appointment.at);
    if (!Number.isFinite(start.getTime())) return [];
    const selected = Array.isArray(appointment.reminders) ? appointment.reminders.map(Number) : [];
    const entries = [];
    APPOINTMENT_OFFSETS.forEach((minutes, index) => {
      if (!selected.includes(minutes)) return;
      const fireAt = new Date(start.getTime() - minutes * 60000);
      if (fireAt.getTime() <= nowMs + 5000) return;
      const lines = [`${appointment.title} · ${appointmentWhenText(start)}`];
      if (appointment.location) lines.push(appointment.location);
      entries.push({
        id: appointmentBase(appointment) + index,
        title: `Appointment ${OFFSET_LABELS[minutes]}`,
        body: lines.join('\n'),
        channelId: APPOINTMENT_CHANNEL_ID,
        schedule: { at: fireAt, allowWhileIdle: true },
        extra: { type: 'appointment', appointmentId: appointment.id, minutes },
      });
    });
    return entries;
  }

  function requestedAppointmentReminders(appointment) {
    const selected = Array.isArray(appointment?.reminders) ? appointment.reminders.map(Number) : [];
    return APPOINTMENT_OFFSETS.filter(minutes => selected.includes(minutes)).length;
  }

  function expectedAppointmentReminderCount(appointments) {
    return (appointments || []).reduce((sum, item) => sum + appointmentReminderEntries(item).length, 0);
  }

  /* ---------- Setup, permissions, channels ---------- */

  async function requestPermission() {
    if (!isNative()) return { granted: false, reason: 'browser' };
    try {
      let result = await plugin().checkPermissions();
      if (result.display !== 'granted') result = await plugin().requestPermissions();
      return { granted: result.display === 'granted', reason: result.display === 'granted' ? '' : (result.display || 'denied') };
    } catch (error) { return { granted: false, reason: errorMessage(error) || 'permission-error' }; }
  }

  async function checkPermissionQuietly() {
    if (!isNative()) return { granted: false, reason: 'browser' };
    try {
      const result = await plugin().checkPermissions();
      return { granted: result.display === 'granted', reason: result.display || '' };
    } catch (error) { return { granted: false, reason: errorMessage(error) }; }
  }

  async function createAndroidChannel() {
    if (!isAndroid() || !plugin().createChannel) return { supported: false };
    const errors = [];
    const channels = [
      { id: CHANNEL_ID, name: 'Pill reminders', description: 'Scheduled reminders to take medication' },
      { id: APPOINTMENT_CHANNEL_ID, name: 'Appointment reminders', description: 'Reminders for upcoming appointments' },
    ];
    for (const channel of channels) {
      try { await plugin().createChannel({ ...channel, importance: 4, visibility: 1, sound: 'default', vibration: true }); }
      catch (error) { errors.push(errorMessage(error)); }
    }
    return errors.length ? { supported: true, error: errors.join('; ') } : { supported: true };
  }

  async function registerActionTypes() {
    if (!isNative() || typeof plugin().registerActionTypes !== 'function') return { supported: false };
    try {
      await plugin().registerActionTypes({ types: [{ id: ACTION_TYPE_ID, actions: DOSE_ACTIONS }, { id: APPOINTMENT_ACTION_TYPE_ID, actions: APPOINTMENT_ACTIONS }] });
      return { supported: true };
    } catch (error) { return { supported: true, error: errorMessage(error) }; }
  }

  // Registers notification channels and the Mark taken / Skip / Snooze buttons.
  // Never prompts for permission, so it is safe to call at launch.
  async function init() {
    if (!isNative()) return { supported: false };
    const channel = await createAndroidChannel();
    const actions = await registerActionTypes();
    return { supported: true, channel, actions };
  }

  async function listChannels() {
    if (!isAndroid() || typeof plugin().listChannels !== 'function') return { supported: false, channels: [] };
    try {
      const result = await plugin().listChannels();
      return { supported: true, channels: result.channels || [] };
    } catch (error) { return { supported: true, channels: [], error: errorMessage(error) }; }
  }

  async function checkExactAlarmPermission() {
    if (!isAndroid()) return { supported: false, granted: null, reason: 'not-android' };
    try {
      const p = plugin();
      if (typeof p.checkExactNotificationSetting === 'function') {
        const result = await p.checkExactNotificationSetting();
        const granted = result.exact_alarm === 'granted' || result.exactAlarm === true || result.exactAlarm === 'granted' || result.granted === true || result.value === true;
        return { supported: true, granted, raw: result };
      }
      if (typeof p.checkExactAlarmPermission === 'function') {
        const result = await p.checkExactAlarmPermission();
        return { supported: true, granted: result.granted === true || result.value === true, raw: result };
      }
      return { supported: false, granted: null, reason: 'plugin-api-unavailable' };
    } catch (error) { return { supported: true, granted: false, reason: errorMessage(error) }; }
  }

  async function openExactAlarmSettings() {
    if (!isNative()) return { opened: false, reason: 'browser' };
    try {
      const p = plugin();
      if (typeof p.changeExactNotificationSetting === 'function') { await p.changeExactNotificationSetting(); return { opened: true }; }
      if (typeof p.openExactAlarmSettings === 'function') { await p.openExactAlarmSettings(); return { opened: true }; }
      return { opened: false, reason: 'plugin-api-unavailable' };
    } catch (error) { return { opened: false, reason: errorMessage(error) }; }
  }

  async function getPendingSummary() {
    if (!isNative()) return { supported: false };
    const pending = await plugin().getPending();
    const list = pending.notifications || [];
    const summary = { supported: true, pill: 0, snooze: 0, appointment: 0, missed: 0, appointmentMissed: 0, test: 0, other: 0, total: list.length };
    for (const item of list) {
      const type = item.extra?.type;
      if (type === 'appointment-missed') summary.appointmentMissed += 1;
      else if (type === 'pill-dose') summary.pill += 1;
      else if (type === 'pill-snooze') summary.snooze += 1;
      else if (type === 'appointment') summary.appointment += 1;
      else if (type === 'pill-missed' || (item.id >= MISSED_ID_MIN && item.id < MISSED_ID_MAX)) summary.missed += 1;
      else if (type === 'test' || item.id === TEST_ID) summary.test += 1;
      else if (item.id >= APPOINTMENT_ID_MIN && item.id < APPOINTMENT_ID_MAX) summary.appointment += 1;
      else if (item.id < APPOINTMENT_ID_MIN) { if (item.id % 1000 >= 800) summary.snooze += 1; else summary.pill += 1; }
      else summary.other += 1;
    }
    return summary;
  }

  /* ---------- Pill scheduling ---------- */

  async function cancelPill(pill) {
    if (!isNative()) return { supported: false, cancelled: 0 };
    try {
      const ids = notificationIdsForPill(pill);
      if (ids.length) await plugin().cancel({ notifications: ids.map(id => ({ id })) });
      return { supported: true, cancelled: ids.length };
    } catch (error) { return { supported: true, cancelled: 0, error: errorMessage(error) }; }
  }

  async function schedulePill(pill) {
    if (!isNative()) return { supported: false, scheduled: 0, exactAlarm: await checkExactAlarmPermission(), reason: 'browser' };
    const permission = await requestPermission();
    if (!permission.granted) return { supported: true, scheduled: 0, permission, exactAlarm: await checkExactAlarmPermission(), reason: 'permission-denied' };
    await init();
    const entries = reminderEntries(pill);
    if (!entries.length) return { supported: true, scheduled: 0, permission, exactAlarm: await checkExactAlarmPermission(), reason: 'no-scheduled-times' };
    try { await plugin().schedule({ notifications: entries }); return { supported: true, scheduled: entries.length, permission, exactAlarm: await checkExactAlarmPermission() }; }
    catch (error) { return { supported: true, scheduled: 0, permission, exactAlarm: await checkExactAlarmPermission(), error: errorMessage(error) }; }
  }

  async function syncPills(pills) {
    if (!isNative()) return { supported: false, scheduled: 0, cancelled: 0, exactAlarm: await checkExactAlarmPermission(), message: 'Native scheduled notifications are available after installing this app on Android.' };
    const permission = await requestPermission();
    if (!permission.granted) return { supported: true, permission, scheduled: 0, cancelled: 0, exactAlarm: await checkExactAlarmPermission(), message: 'Notification permission is not enabled.' };
    await init();
    let cancelled = 0;

    try {
      const pending = await plugin().getPending();

      // Repeating pill reminders only. Pending snoozes, appointment reminders
      // and the test reminder are left alone.
      const medicationNotifications = (pending.notifications || []).filter(notification => {
        if (notification.extra?.type === 'pill-dose') return true;
        if (notification.extra?.type) return false;
        return notification.id < APPOINTMENT_ID_MIN && notification.id % 1000 < 800;
      });

      if (medicationNotifications.length) {
        await plugin().cancel({ notifications: medicationNotifications.map(notification => ({ id: notification.id })) });
        cancelled = medicationNotifications.length;
      }
    } catch (error) {
      return {
        supported: true, permission, scheduled: 0, cancelled,
        exactAlarm: await checkExactAlarmPermission(),
        errors: [errorMessage(error)],
        message: 'Could not refresh medication reminders. Existing schedules were left in place where possible.',
      };
    }

    let scheduled = 0;
    const errors = [];
    for (const pill of pills) {
      if (!pill.active || pill.schedule === 'asNeeded') continue;
      const entries = reminderEntries(pill);
      if (!entries.length) continue;
      try { await plugin().schedule({ notifications: entries }); scheduled += entries.length; }
      catch (error) { errors.push(`${pill.name}: ${errorMessage(error)}`); }
    }
    return { supported: true, permission, scheduled, cancelled, exactAlarm: await checkExactAlarmPermission(), errors, message: errors.length ? errors.join('; ') : `Reminder sync complete. ${scheduled} repeating notification(s) scheduled.` };
  }

  /* ---------- Snooze ---------- */

  async function snoozeDose(pill, time, doseId, minutes = 10) {
    if (!isNative()) return { supported: false, scheduled: false, reason: 'browser' };
    const permission = await requestPermission();
    if (!permission.granted) return { supported: true, scheduled: false, reason: 'permission-denied' };
    await init();
    const safeMinutes = Math.min(120, Math.max(1, Math.round(Number(minutes)) || 10));
    const at = new Date(Date.now() + safeMinutes * 60000);
    const color = normalizeNotificationColor(pill.color);
    const bodyDose = pill.dosage ? ` (${pill.dosage})` : '';
    try {
      await plugin().schedule({
        notifications: [{
          id: snoozeIdFor(pill, time),
          title: 'Pill reminder (snoozed)',
          body: `Time to take ${pill.name}${bodyDose}.`,
          channelId: CHANNEL_ID,
          color,
          actionTypeId: ACTION_TYPE_ID,
          schedule: { at, allowWhileIdle: true },
          extra: { type: 'pill-snooze', pillId: pill.id, pillColor: color, weekday: null, time, doseId },
        }],
      });
      return { supported: true, scheduled: true, at, minutes: safeMinutes };
    } catch (error) { return { supported: true, scheduled: false, error: errorMessage(error) }; }
  }

  async function cancelSnooze(pill, time) {
    if (!isNative()) return { supported: false };
    try { await plugin().cancel({ notifications: [{ id: snoozeIdFor(pill, time) }] }); return { supported: true }; }
    catch (error) { return { supported: true, error: errorMessage(error) }; }
  }


  /* ---------- Missed-dose follow-ups ---------- */

  function missedIdFor(pillId, key, time) { return MISSED_ID_MIN + (hashString(`${pillId}|${key}|${time}`) % (MISSED_ID_MAX - MISSED_ID_MIN - 1)); }

  // entries: [{ pill, dateKey, time, at: Date }]. Replaces every earlier follow-up.
  async function syncMissedFollowups(entries, minutes) {
    if (!isNative()) return { supported: false, scheduled: 0 };
    try {
      const pending = await plugin().getPending();
      const old = (pending.notifications || []).filter(n => n.extra?.type === 'pill-missed' || (n.id >= MISSED_ID_MIN && n.id < MISSED_ID_MAX));
      if (old.length) await plugin().cancel({ notifications: old.map(n => ({ id: n.id })) });
      if (!entries || !entries.length || !minutes) return { supported: true, scheduled: 0, cancelled: old.length };
      const permission = await checkPermissionQuietly();
      if (!permission.granted) return { supported: true, scheduled: 0, reason: 'permission-denied' };
      await init();
      const seen = new Set();
      const notifications = [];
      for (const { pill, dateKey, time, timeLabel, at } of entries) {
        const id = missedIdFor(pill.id, dateKey, time);
        if (seen.has(id)) continue;
        seen.add(id);
        const color = normalizeNotificationColor(pill.color);
        notifications.push({
          id,
          title: 'Missed dose?',
          body: `${pill.name}${pill.dosage ? ` (${pill.dosage})` : ''} was due at ${timeLabel || time}. Tap to record it.`,
          channelId: CHANNEL_ID,
          color,
          actionTypeId: ACTION_TYPE_ID,
          schedule: { at, allowWhileIdle: true },
          extra: { type: 'pill-missed', pillId: pill.id, pillColor: color, weekday: null, time, dateKey },
        });
      }
      if (notifications.length) await plugin().schedule({ notifications });
      return { supported: true, scheduled: notifications.length, cancelled: old.length };
    } catch (error) { return { supported: true, scheduled: 0, error: errorMessage(error) }; }
  }


  /* ---------- Missed-appointment follow-ups ---------- */

  // entries: [{ appointment, at: Date }]. Replaces every earlier follow-up.
  async function syncMissedAppointments(entries) {
    if (!isNative()) return { supported: false, scheduled: 0 };
    try {
      const pending = await plugin().getPending();
      const old = (pending.notifications || []).filter(n => n.extra?.type === 'appointment-missed');
      if (old.length) await plugin().cancel({ notifications: old.map(n => ({ id: n.id })) });
      if (!entries || !entries.length) return { supported: true, scheduled: 0, cancelled: old.length };
      const permission = await checkPermissionQuietly();
      if (!permission.granted) return { supported: true, scheduled: 0, reason: 'permission-denied' };
      await init();
      const notifications = entries.map(({ appointment, at }) => ({
        id: appointmentBase(appointment) + 4,
        title: 'Appointment finished?',
        body: `How did "${appointment.title}" go? Mark it completed or missed.`,
        channelId: APPOINTMENT_CHANNEL_ID,
        actionTypeId: APPOINTMENT_ACTION_TYPE_ID,
        schedule: { at, allowWhileIdle: true },
        extra: { type: 'appointment-missed', appointmentId: appointment.id },
      }));
      await plugin().schedule({ notifications });
      return { supported: true, scheduled: notifications.length, cancelled: old.length };
    } catch (error) { return { supported: true, scheduled: 0, error: errorMessage(error) }; }
  }

  /* ---------- Test reminder ---------- */

  async function sendTestReminder(delaySeconds = 5) {
    if (!isNative()) return { supported: false, sent: false, reason: 'browser' };
    const permission = await requestPermission();
    if (!permission.granted) return { supported: true, sent: false, permission, reason: 'permission-denied' };
    await init();
    const at = new Date(Date.now() + Math.max(2, delaySeconds) * 1000);
    try {
      await plugin().schedule({
        notifications: [{
          id: TEST_ID,
          title: 'Test reminder',
          body: 'Health Ledger reminders are working. Try the buttons below.',
          channelId: CHANNEL_ID,
          actionTypeId: ACTION_TYPE_ID,
          schedule: { at, allowWhileIdle: true },
          extra: { type: 'test', sentAt: new Date().toISOString() },
        }],
      });
      return { supported: true, sent: true, at };
    } catch (error) { return { supported: true, sent: false, error: errorMessage(error) }; }
  }

  /* ---------- Appointment scheduling ---------- */

  async function cancelAppointment(appointment) {
    if (!isNative() || !appointment?.id) return { supported: isNative(), cancelled: 0 };
    try {
      const ids = appointmentIdsFor(appointment);
      await plugin().cancel({ notifications: ids.map(id => ({ id })) });
      return { supported: true, cancelled: ids.length };
    } catch (error) { return { supported: true, cancelled: 0, error: errorMessage(error) }; }
  }

  async function scheduleAppointment(appointment) {
    const requested = requestedAppointmentReminders(appointment);
    if (!isNative()) return { supported: false, scheduled: 0, requested, reason: 'browser' };
    if (!requested) return { supported: true, scheduled: 0, requested, reason: 'none-selected' };
    if (FINISHED_STATUSES.includes(appointment.status)) return { supported: true, scheduled: 0, requested, reason: 'finished' };
    const entries = appointmentReminderEntries(appointment);
    if (!entries.length) return { supported: true, scheduled: 0, requested, reason: 'times-passed' };
    const permission = await requestPermission();
    if (!permission.granted) return { supported: true, scheduled: 0, requested, reason: 'permission-denied' };
    await init();
    try {
      await plugin().schedule({ notifications: entries });
      return { supported: true, scheduled: entries.length, requested, skippedPast: requested - entries.length };
    } catch (error) { return { supported: true, scheduled: 0, requested, error: errorMessage(error) }; }
  }

  async function cancelAllAppointments() {
    if (!isNative()) return { supported: false, cancelled: 0 };
    try {
      const pending = await plugin().getPending();
      const items = (pending.notifications || []).filter(item => item.extra?.type === 'appointment' || (item.id >= APPOINTMENT_ID_MIN && item.id < APPOINTMENT_ID_MAX));
      if (items.length) await plugin().cancel({ notifications: items.map(item => ({ id: item.id })) });
      return { supported: true, cancelled: items.length };
    } catch (error) { return { supported: true, cancelled: 0, error: errorMessage(error) }; }
  }

  async function syncAppointments(appointments, options = {}) {
    if (!isNative()) return { supported: false, scheduled: 0, cancelled: 0, reason: 'browser' };
    const permission = options.prompt === false ? await checkPermissionQuietly() : await requestPermission();
    if (!permission.granted) return { supported: true, scheduled: 0, cancelled: 0, reason: 'permission-denied' };
    await init();
    const cleared = await cancelAllAppointments();
    const entries = (appointments || []).flatMap(item => appointmentReminderEntries(item));
    if (!entries.length) return { supported: true, scheduled: 0, cancelled: cleared.cancelled || 0 };
    try {
      await plugin().schedule({ notifications: entries });
      return { supported: true, scheduled: entries.length, cancelled: cleared.cancelled || 0 };
    } catch (error) { return { supported: true, scheduled: 0, cancelled: cleared.cancelled || 0, error: errorMessage(error) }; }
  }

  /* ---------- Listeners ---------- */

  // callback(notification, actionId, event). actionId is "tap" for a plain tap,
  // or "taken" / "skip" / "snooze" for the notification buttons.
  function registerActionListener(callback) {
    if (!isNative() || typeof callback !== 'function' || !plugin().addListener) return null;
    return plugin().addListener('localNotificationActionPerformed', event => callback(event?.notification || event, event?.actionId || 'tap', event));
  }

  function registerReceivedListener(callback) {
    if (!isNative() || typeof callback !== 'function' || !plugin().addListener) return null;
    return plugin().addListener('localNotificationReceived', notification => callback(notification));
  }

  global.HealthLedgerNotifications = {
    isNative, init, requestPermission, createAndroidChannel, listChannels,
    notificationIdForPill, notificationIdsForPill,
    schedulePill, cancelPill, syncPills,
    snoozeDose, cancelSnooze, syncMissedFollowups, syncMissedAppointments, sendTestReminder,
    scheduleAppointment, cancelAppointment, cancelAllAppointments, syncAppointments,
    getPendingSummary, expectedPillReminderCount, expectedAppointmentReminderCount,
    registerActionListener, registerReceivedListener,
    checkExactAlarmPermission, openExactAlarmSettings, plugin,
    APPOINTMENT_OFFSETS,
  };
})(window);
