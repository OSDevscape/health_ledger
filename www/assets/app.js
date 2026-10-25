/* Health Ledger — offline-first medication and glucose organizer. */
(() => {
  'use strict';
  const KEYS = {
    pills: 'healthLedger.pills', doses: 'healthLedger.doses', glucose: 'healthLedger.glucose',
    settings: 'healthLedger.settings', theme: 'healthLedger.theme', onboarding: 'healthLedger.onboarding',
    appointments: 'healthLedger.appointments', lastBackup: 'healthLedger.lastBackup',
    preRestore: 'healthLedger.preRestore', reminderTest: 'healthLedger.reminderTest',
    reminderSchema: 'healthLedger.reminderSchema',
  };
  const REMINDER_SCHEMA = '2';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const COLORS = ['#4B9B76', '#5B83C8', '#C28B46', '#9875C5', '#D16F72', '#4E9DA7', '#7F8B8A'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const FORMS = ['Tablet', 'Capsule', 'Liquid', 'Injection', 'Powder', 'Other'];
  const SCHEDULES = [{ value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'custom', label: 'Custom days' }, { value: 'asNeeded', label: 'As needed' }];
  const SKIP_REASONS = ['Felt unwell', 'Side effects', 'Out of supply', 'Advised not to take', 'Not needed', 'Other'];
  const SNOOZE_CHOICES = [5, 10, 15, 30];
  const NOTE_MAX = 300;
  const defaultSettings = () => ({ targetLow: 70, targetHigh: 180, glucoseUnit: 'mg/dL', snoozeMinutes: 10 });
  const now = new Date();
  let pills = safeLoad(KEYS.pills, []), doses = safeLoad(KEYS.doses, []), glucose = safeLoad(KEYS.glucose, []), settings = { ...defaultSettings(), ...safeLoad(KEYS.settings, {}) };
  let currentPage = 'today',
    pageHistory = ['today'],
    toastTimer,
    editingGlucoseId = null,
    highlightPillId = null,
    lastBackPressAt = 0;

  const Notify = window.HealthLedgerNotifications;

  /* ====================== Appointments ====================== */

  const FINISHED_APPOINTMENT_STATUSES = new Set(['completed', 'missed', 'canceled']);
  const APPOINTMENT_REMINDER_OPTIONS = [
    { minutes: 1440, label: '1 day before' },
    { minutes: 120, label: '2 hours before' },
    { minutes: 60, label: '1 hour before' },
    { minutes: 15, label: '15 minutes before' },
  ];

  let appointments = safeLoad(KEYS.appointments, []);
  if (!Array.isArray(appointments)) appointments = [];

  function saveAppointments(nextAppointments) {
    try {
      localStorage.setItem(KEYS.appointments, JSON.stringify(nextAppointments));
    } catch (error) {
      console.error('Appointment save failed:', error);
      toast('Could not save appointments. Check device storage.');
      return false;
    }
    appointments = nextAppointments;
    return true;
  }

  // Replaces any scheduled notifications for this appointment with the current ones.
  async function applyAppointmentReminders(appointment) {
    await Notify.cancelAppointment(appointment);
    return Notify.scheduleAppointment(appointment);
  }

  function appointmentReminderMessage(result) {
    if (!result || !result.requested) return '';
    if (!result.supported) return ' Reminders are delivered as notifications in the Android app.';
    if (result.reason === 'permission-denied') return ' Allow notifications to receive reminders.';
    if (result.reason === 'times-passed') return ' Reminder times have already passed.';
    if (result.error) return ' Could not schedule reminders.';
    if (result.scheduled) {
      const skipped = result.skippedPast ? ` ${result.skippedPast} already passed.` : '';
      return ` ${result.scheduled} reminder${result.scheduled === 1 ? '' : 's'} scheduled.${skipped}`;
    }
    return '';
  }

  function appointmentReminderLabels(item) {
    const selected = Array.isArray(item.reminders) ? item.reminders.map(Number) : [];
    return APPOINTMENT_REMINDER_OPTIONS.filter(option => selected.includes(option.minutes)).map(option => option.label);
  }

  function renderAppointments() {
    const list = $('#appointment-list');
    if (!list) return;

    const sorted = [...appointments]
      .filter(item => item && typeof item.id === 'string' && Number.isFinite(parseLocal(item.at).getTime()))
      .sort((a, b) => parseLocal(a.at) - parseLocal(b.at));

    if (!sorted.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon" aria-hidden="true">📅</div>
          <h3>No appointments yet</h3>
          <p>Add a visit or checkup to keep its details together and get reminders before it starts.</p>
          <button type="button" class="primary-button" id="empty-add-appointment">Add appointment</button>
        </div>
      `;
      $('#empty-add-appointment').onclick = () => openAppointmentModal();
      return;
    }

    const nowMs = Date.now();

    const upcoming = sorted.filter(item => !FINISHED_APPOINTMENT_STATUSES.has(item.status) && parseLocal(item.at).getTime() >= nowMs);
    const history = sorted
      .filter(item => FINISHED_APPOINTMENT_STATUSES.has(item.status) || parseLocal(item.at).getTime() < nowMs)
      .reverse();

    function card(item) {
      const date = parseLocal(item.at);
      const finished = FINISHED_APPOINTMENT_STATUSES.has(item.status);
      const status = finished ? item.status : date.getTime() < nowMs ? 'needs-review' : 'scheduled';

      const labels = { scheduled: 'Scheduled', 'needs-review': 'Needs review', completed: 'Completed', missed: 'Missed', canceled: 'Canceled' };
      const details = [item.provider, item.type, item.visitFormat].filter(Boolean).join(' · ');
      const reminderLabels = appointmentReminderLabels(item);

      return `
        <article class="appointment-card card">
          <div class="appointment-date-badge" aria-hidden="true">
            <span class="appointment-date-month">${esc(fmtDate(date, { month: 'short' }))}</span>
            <strong>${date.getDate()}</strong>
            <span class="appointment-date-weekday">${esc(fmtDate(date, { weekday: 'short' }))}</span>
          </div>

          <div class="appointment-card-content">
            <h2>${esc(item.title)}</h2>

            <p class="appointment-time">
              <span class="appointment-date-accessible">${esc(fmtDate(date, { month: 'long', day: 'numeric', year: 'numeric' }))} at</span>
              ${esc(fmtTime(String(item.at).slice(11, 16)))}
            </p>

            ${details ? `<p class="appointment-detail">${esc(details)}</p>` : ''}
            ${item.location ? `<p class="appointment-detail">${esc(item.location)}</p>` : ''}
            ${reminderLabels.length && !finished ? `<p class="appointment-detail">🔔 ${esc(reminderLabels.join(', '))}</p>` : ''}
            ${item.notes ? `<p class="appointment-detail appointment-notes">${esc(item.notes)}</p>` : ''}

            <span class="appointment-state ${status}">${labels[status]}</span>
          </div>

          <div class="appointment-card-actions">
            <button type="button" class="appointment-edit-button" data-edit-appointment="${esc(item.id)}" aria-label="Edit ${esc(item.title)}">Edit</button>

            <select class="appointment-status-menu" data-appointment-status="${esc(item.id)}" aria-label="Change status for ${esc(item.title)}">
              <option value="">Status</option>
              <option value="completed">Completed</option>
              <option value="missed">Missed</option>
              <option value="canceled">Canceled</option>
              ${finished ? '<option value="scheduled">Mark scheduled</option>' : ''}
              <option value="reschedule">Reschedule</option>
            </select>
          </div>
        </article>
      `;
    }

    list.innerHTML = `
      ${upcoming.length ? `
        <h2 class="appointment-group-title">Upcoming</h2>
        ${upcoming.map(card).join('')}
      ` : `<p class="muted">No upcoming appointments.</p>`}

      ${history.length ? `
        <h2 class="appointment-group-title">History</h2>
        ${history.map(card).join('')}
      ` : ''}
    `;

    list.querySelectorAll('[data-edit-appointment]').forEach(button => {
      button.onclick = () => openAppointmentModal(button.dataset.editAppointment);
    });

    list.querySelectorAll('[data-appointment-status]').forEach(menu => {
      menu.onchange = () => {
        const id = menu.dataset.appointmentStatus;
        const action = menu.value;

        // Reset the action menu before opening another modal.
        menu.value = '';
        if (!action) return;

        if (action === 'reschedule') {
          openRescheduleAppointmentModal(id);
          return;
        }

        setAppointmentStatus(id, action);
      };
    });
  }

  function setAppointmentStatus(id, status) {
    const labels = { scheduled: 'Scheduled', completed: 'Completed', missed: 'Missed', canceled: 'Canceled' };
    if (!Object.hasOwn(labels, status)) return;

    const appointment = appointments.find(item => item.id === id);
    if (!appointment) return;
    if ((appointment.status || 'scheduled') === status) return;

    const changedAt = new Date().toISOString();
    const updated = { ...appointment, status, statusChangedAt: changedAt, updatedAt: changedAt };
    const nextAppointments = appointments.map(item => item.id === id ? updated : item);

    if (!saveAppointments(nextAppointments)) return;

    renderAppointments();
    toast(`Appointment marked ${labels[status].toLowerCase()}.`);

    // Finished appointments lose their reminders; reopened ones get them back.
    applyAppointmentReminders(updated).catch(error => console.error('Appointment reminders failed:', error));
  }

  function openRescheduleAppointmentModal(id) {
    const appointment = appointments.find(item => item.id === id);
    if (!appointment) return;

    openModal(`
      <div class="modal-head">
        <h2 id="modal-title">Reschedule appointment</h2>
        <button class="close-modal" data-close aria-label="Close reschedule form">×</button>
      </div>

      <p class="modal-intro">${esc(appointment.title)}</p>

      <div class="appointment-reschedule-current">
        <span>Current appointment</span>
        <strong>
          ${esc(fmtDate(parseLocal(appointment.at), { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }))}
          ·
          ${esc(fmtTime(String(appointment.at).slice(11, 16)))}
        </strong>
      </div>

      <form id="reschedule-appointment-form" class="modal-form">
        <div class="modal-grid">
          <label class="field">
            <span>New date <b>*</b></span>
            <input id="reschedule-appointment-date" type="date" required>
          </label>

          <label class="field">
            <span>New time <b>*</b></span>
            <input id="reschedule-appointment-time" type="time" required>
          </label>
        </div>

        <p class="modal-note">
          Saving changes this appointment’s date and time and returns its status to Scheduled.
          Other details are kept, and your selected reminders are scheduled again for the new time.
        </p>

        <div class="modal-actions">
          <button type="button" class="secondary-button" data-close>Cancel</button>
          <button type="submit" class="primary-button">Save new time</button>
        </div>
      </form>
    `);

    $('#reschedule-appointment-form').onsubmit = async event => {
      event.preventDefault();

      const date = $('#reschedule-appointment-date').value;
      const time = $('#reschedule-appointment-time').value;
      const at = `${date}T${time}`;
      const parsed = parseLocal(at);

      if (!date || !time || !Number.isFinite(parsed.getTime()) || localISO(parsed).slice(0, 16) !== at) {
        toast('Enter a valid new date and time.');
        return;
      }

      if (parsed.getTime() <= Date.now()) {
        toast('Choose a future date and time.');
        return;
      }

      const currentAppointment = appointments.find(item => item.id === id);

      if (!currentAppointment) {
        closeModal();
        toast('This appointment is no longer available.');
        return;
      }

      const changedAt = new Date().toISOString();
      const rescheduleHistory = Array.isArray(currentAppointment.rescheduleHistory) ? currentAppointment.rescheduleHistory : [];

      const updated = {
        ...currentAppointment,
        at,
        status: 'scheduled',
        statusChangedAt: changedAt,
        updatedAt: changedAt,
        rescheduleHistory: [
          ...rescheduleHistory,
          { previousAt: currentAppointment.at, newAt: at, previousStatus: currentAppointment.status || 'scheduled', changedAt },
        ],
      };

      const nextAppointments = appointments.map(item => item.id === id ? updated : item);
      if (!saveAppointments(nextAppointments)) return;

      closeModal();
      renderAppointments();

      let result = null;
      try { result = await applyAppointmentReminders(updated); }
      catch (error) { console.error('Appointment reminders failed:', error); }

      toast('Appointment rescheduled.' + appointmentReminderMessage(result));
    };
  }

  function openAppointmentModal(id = null) {
    const old = appointments.find(item => item.id === id);

    if (id && !old) {
      toast('This appointment is no longer available.');
      return;
    }

    const appointment = old || { title: '', at: '', provider: '', type: '', visitFormat: '', location: '', reminders: [], notes: '' };
    const types = ['Checkup', 'Specialist', 'Lab work', 'Dental', 'Therapy', 'Other'];
    const visitFormats = ['In person', 'Phone', 'Video'];
    const selectedReminders = Array.isArray(appointment.reminders) ? appointment.reminders.map(Number) : [];
    const existingTime = String(appointment.at || '');
    const dateValue = existingTime.slice(0, 10);
    const timeValue = existingTime.slice(11, 16);

    openModal(`
      <div class="modal-head">
        <h2 id="modal-title">${old ? 'Edit appointment' : 'Add appointment'}</h2>
        <button class="close-modal" data-close aria-label="Close appointment form">×</button>
      </div>

      <form id="appointment-form" class="modal-form">
        <label class="field">
          <span>Appointment title <b>*</b></span>
          <input id="appointment-title" type="text" maxlength="100" required value="${esc(appointment.title || '')}">
        </label>

        <div class="modal-grid">
          <label class="field">
            <span>Date <b>*</b></span>
            <input id="appointment-date" type="date" required value="${esc(dateValue)}">
          </label>

          <label class="field">
            <span>Time <b>*</b></span>
            <input id="appointment-clock" type="time" required value="${esc(timeValue)}">
          </label>
        </div>

        <label class="field">
          <span>Provider</span>
          <input id="appointment-provider" type="text" maxlength="100" value="${esc(appointment.provider || '')}">
        </label>

        <div class="modal-grid">
          <label class="field">
            <span>Type</span>
            <select id="appointment-type">
              <option value="">Select type</option>
              ${types.map(type => `<option value="${esc(type)}" ${appointment.type === type ? 'selected' : ''}>${esc(type)}</option>`).join('')}
            </select>
          </label>

          <label class="field">
            <span>Visit format</span>
            <select id="appointment-visit-format">
              <option value="">Select format</option>
              ${visitFormats.map(format => `<option value="${esc(format)}" ${appointment.visitFormat === format ? 'selected' : ''}>${esc(format)}</option>`).join('')}
            </select>
          </label>
        </div>

        <label class="field">
          <span>Location</span>
          <input id="appointment-location" type="text" maxlength="200" value="${esc(appointment.location || '')}">
        </label>

        <fieldset class="appointment-reminder-fieldset">
          <legend>Reminders</legend>

          <div class="appointment-reminder-options">
            ${APPOINTMENT_REMINDER_OPTIONS.map(option => `
              <label class="check-row">
                <input type="checkbox" name="appointment-reminder" value="${option.minutes}" ${selectedReminders.includes(option.minutes) ? 'checked' : ''}>
                <span>${esc(option.label)}</span>
              </label>
            `).join('')}
          </div>

          <p class="modal-note">
            Leave all unchecked for no reminders. Reminders are sent as notifications in the Android app;
            any reminder time that has already passed is skipped.
          </p>
        </fieldset>

        <label class="field">
          <span>Notes</span>
          <textarea id="appointment-notes" rows="3" maxlength="1000">${esc(appointment.notes || '')}</textarea>
        </label>

        <p class="modal-note">Appointment times use your device’s local time zone.</p>

        <div class="modal-actions">
          <button type="button" class="secondary-button" data-close>Cancel</button>
          <button type="submit" class="primary-button">${old ? 'Save changes' : 'Save appointment'}</button>
        </div>

        ${old ? `<button type="button" class="appointment-delete-button" id="delete-appointment">Delete appointment</button>` : ''}
      </form>
    `);

    const deleteButton = $('#delete-appointment');

    if (deleteButton) {
      deleteButton.onclick = () => {
        confirmAction(
          'Delete appointment?',
          `This permanently removes "${old.title}" and its reminders from this device.`,
          () => {
            const nextAppointments = appointments.filter(item => item.id !== old.id);
            if (!saveAppointments(nextAppointments)) return;

            Notify.cancelAppointment(old).catch(() => {});
            renderAppointments();
            toast('Appointment deleted.');
          }
        );
      };
    }

    $('#appointment-form').onsubmit = async event => {
      event.preventDefault();

      const title = $('#appointment-title').value.trim();
      const date = $('#appointment-date').value;
      const time = $('#appointment-clock').value;
      const at = `${date}T${time}`;

      if (!title) {
        toast('Enter an appointment title.');
        $('#appointment-title').focus();
        return;
      }

      if (!date || !time || !Number.isFinite(parseLocal(at).getTime())) {
        toast('Enter a valid appointment date and time.');
        $('#appointment-date').focus();
        return;
      }

      const reminders = Array.from(
        $('#appointment-form').querySelectorAll('input[name="appointment-reminder"]:checked')
      ).map(input => Number(input.value));

      const updated = {
        ...old,
        id: old?.id || uid('appointment'),
        title,
        at,
        status: old?.status || 'scheduled',
        provider: $('#appointment-provider').value.trim(),
        type: $('#appointment-type').value,
        visitFormat: $('#appointment-visit-format').value,
        location: $('#appointment-location').value.trim(),
        reminders,
        notes: $('#appointment-notes').value.trim(),
        createdAt: old?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      const nextAppointments = old
        ? appointments.map(item => item.id === old.id ? updated : item)
        : [...appointments, updated];

      if (!saveAppointments(nextAppointments)) return;

      closeModal();
      renderAppointments();

      let result = null;
      try { result = await applyAppointmentReminders(updated); }
      catch (error) { console.error('Appointment reminders failed:', error); }

      toast((old ? 'Appointment updated.' : 'Appointment saved.') + appointmentReminderMessage(result));
    };
  }

  function returnFromAppointments() {
    closeModal();

    if (currentPage === 'appointments') {
      pageHistory.pop();
      const previousPage = pageHistory[pageHistory.length - 1] || 'today';
      go(previousPage, { fromBack: true });
    }

    openMoreModal();
  }

  /* ====================== Navigation & helpers ====================== */

  function go(page, options = {}) {
    const { fromBack = false } = options;
    if (page === 'more') {
      openMoreModal();
      return;
    }

    if (!page || page === currentPage) return;

    // Record each normal user navigation so Android Back retraces
    // the actual route: Today > Pills > Glucose > More.
    if (!fromBack) {
      pageHistory.push(page);
    }

    currentPage = page;

    $$('.page').forEach(p => {
      p.classList.toggle('active', p.dataset.page === page);
    });

    $$('.nav-item').forEach(button => {
      const active = button.dataset.nav === page;
      button.classList.toggle('active', active);

      if (active) {
        button.setAttribute('aria-current', 'page');
      } else {
        button.removeAttribute('aria-current');
      }
    });

    $('#main-content').focus({ preventScroll: true });
    render();
    window.location.hash = page;
  }
  function safeLoad(key, fallback) { try { const value = JSON.parse(localStorage.getItem(key)); return value == null ? fallback : value; } catch (_) { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { toast('Could not save to this device. Check available storage.'); } }
  function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
  function esc(value = '') { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function dateKey(date = new Date()) { const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000); return d.toISOString().slice(0, 10); }
  function localISO(date = new Date()) { return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:00`; }
  function parseLocal(dateString) { return new Date(String(dateString).length === 16 ? `${dateString}:00` : dateString); }
  function fmtDate(date, options = { weekday: 'long', month: 'long', day: 'numeric' }) { return new Intl.DateTimeFormat(undefined, options).format(date); }
  function fmtTime(time) { const [h, m] = String(time).split(':').map(Number); if (!Number.isFinite(h) || !Number.isFinite(m)) return time; const d = new Date(); d.setHours(h, m, 0, 0); return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d); }
  function fmtStamp(value) { const d = parseLocal(value); return Number.isNaN(d.getTime()) ? 'Unknown time' : `${fmtDate(d, { month: 'short', day: 'numeric' })} · ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d)}`; }
  function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200); }
  function snoozeMinutes() { const value = Number(settings.snoozeMinutes); return SNOOZE_CHOICES.includes(value) ? value : 10; }
  function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }

  /* ====================== Doses ====================== */

  function isScheduled(pill, date) { if (!pill.active || pill.schedule === 'asNeeded') return false; const key = dateKey(date); if (pill.startDate && key < pill.startDate) return false; if (pill.endDate && key > pill.endDate) return false; const day = date.getDay(); if (pill.schedule === 'weekdays' && (day === 0 || day === 6)) return false; if (pill.schedule === 'custom' && !(pill.days || []).includes(day)) return false; return true; }
  function doseId(pillId, key, time) { return `${pillId}__${key}__${time}`; }
  function ensureDoseRecords(date = new Date()) {
    const key = dateKey(date); let changed = false;
    for (const p of pills) {
      if (!isScheduled(p, date)) continue;
      for (const time of p.times || []) {
        const id = doseId(p.id, key, time);
        if (!doses.some(d => d.id === id)) { doses.push({ id, pillId: p.id, scheduledAt: `${key}T${time}:00`, status: 'pending', takenAt: '', note: '' }); changed = true; }
      }
    }
    if (changed) save(KEYS.doses, doses);
  }
  function getDoseTime(dose) { return parseLocal(dose.scheduledAt); }
  function doseTimeOf(dose) { return String(dose.scheduledAt).slice(11, 16); }
  function doseStatus(dose) { if (dose.status !== 'pending') return dose.status; const d = getDoseTime(dose); if (d.getTime() < Date.now() - 60000) return 'missed'; if (Math.abs(d.getTime() - Date.now()) <= 30 * 60000) return 'due'; return 'upcoming'; }
  function doseLabel(status) { return ({ pending: 'Upcoming', upcoming: 'Upcoming', due: 'Due now', taken: 'Taken', skipped: 'Skipped', missed: 'Missed' })[status] || status; }
  function inventoryNumber(value) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return null;
    return Number(number.toFixed(6));
  }
  function cleanNote(value) { return String(value || '').trim().slice(0, NOTE_MAX); }
  function cleanReason(value) { const v = String(value || '').trim(); return v.slice(0, 60); }

  // Finds the stored dose, creating today's/yesterday's record if it should exist but has not been saved yet.
  function ensureDoseRecord(pill, key, time) {
    const id = doseId(pill.id, key, time);
    let dose = doses.find(d => d.id === id);
    if (dose) return dose;
    if (!(pill.times || []).includes(time)) return null;
    const date = parseLocal(`${key}T12:00:00`);
    if (!isScheduled(pill, date)) return null;
    dose = { id, pillId: pill.id, scheduledAt: `${key}T${time}:00`, status: 'pending', takenAt: '', note: '' };
    doses = [...doses, dose];
    save(KEYS.doses, doses);
    return dose;
  }

  // details: { note, skipReason }. Returns true when the change was saved.
  function updateDose(id, status, details = {}) {
    if (!['pending', 'taken', 'skipped'].includes(status)) return false;
    const dose = doses.find(item => item.id === id);
    if (!dose || dose.status === status) return false;
    const pill = pills.find(item => item.id === dose.pillId);
    if (!pill) return false;

    const nextDose = { ...dose };
    const nextPill = { ...pill };
    const quantity = inventoryNumber(pill.quantity);
    const unitsPerDose = inventoryNumber(pill.unitsPerDose);
    let inventoryChanged = false;
    let warning = '';
    const enteringTaken = dose.status !== 'taken' && status === 'taken';
    const leavingTaken = dose.status === 'taken' && status !== 'taken';

    if (enteringTaken) {
      nextDose.inventoryDeducted = 0;
      nextDose.inventoryEpoch = pill.inventoryEpoch || '';
      if (quantity !== null && unitsPerDose !== null && unitsPerDose > 0) {
        const deducted = Math.min(quantity, unitsPerDose);
        nextPill.quantity = Number((quantity - deducted).toFixed(6));
        nextDose.inventoryDeducted = deducted;
        inventoryChanged = deducted > 0;
        if (quantity < unitsPerDose) warning = ' Recorded supply was insufficient; check your remaining quantity.';
      } else if (quantity !== null) {
        warning = ' Supply was not changed. Check your units per dose.';
      }
    }

    if (leavingTaken) {
      const deducted = inventoryNumber(dose.inventoryDeducted) || 0;
      const sameBaseline = (dose.inventoryEpoch || '') === (pill.inventoryEpoch || '');
      if (deducted > 0 && quantity !== null && sameBaseline) {
        const restored = Number((quantity + deducted).toFixed(6));
        if (!Number.isFinite(restored)) { toast('Could not restore supply. Check the recorded quantity.'); return false; }
        nextPill.quantity = restored;
        inventoryChanged = true;
      } else if (deducted > 0) {
        warning = ' Supply was not restored because its recorded baseline changed.';
      }
      nextDose.inventoryDeducted = 0;
      delete nextDose.inventoryEpoch;
    }

    nextDose.status = status;
    nextDose.takenAt = status === 'taken' ? localISO() : '';
    if (details.note !== undefined) nextDose.note = cleanNote(details.note);
    if (status === 'skipped') nextDose.skipReason = cleanReason(details.skipReason);
    else delete nextDose.skipReason;

    const nextPills = pills.map(item => item.id === pill.id ? nextPill : item);
    const nextDoses = doses.map(item => item.id === dose.id ? nextDose : item);
    let previousPills, previousDoses;
    try {
      previousPills = localStorage.getItem(KEYS.pills);
      previousDoses = localStorage.getItem(KEYS.doses);
      if (inventoryChanged) localStorage.setItem(KEYS.pills, JSON.stringify(nextPills));
      localStorage.setItem(KEYS.doses, JSON.stringify(nextDoses));
    } catch (error) {
      try {
        if (previousPills !== undefined && inventoryChanged) { if (previousPills === null) localStorage.removeItem(KEYS.pills); else localStorage.setItem(KEYS.pills, previousPills); }
        if (previousDoses !== undefined) { if (previousDoses === null) localStorage.removeItem(KEYS.doses); else localStorage.setItem(KEYS.doses, previousDoses); }
      } catch (rollbackError) { console.error('Inventory rollback failed:', rollbackError); }
      console.error('Dose update failed:', error);
      toast('Could not save the dose update. Check device storage.');
      return false;
    }
    pills = nextPills;
    doses = nextDoses;

    // A recorded dose should not trigger a leftover snoozed reminder.
    if (status !== 'pending') Notify.cancelSnooze(pill, doseTimeOf(dose)).catch(() => {});

    renderToday();
    if (currentPage === 'pills') renderPills();
    toast((status === 'taken' ? 'Dose marked as taken.' : status === 'skipped' ? 'Dose skipped.' : 'Dose updated.') + warning);
    return true;
  }

  function updateDoseDetails(id, details) {
    const dose = doses.find(item => item.id === id);
    if (!dose) return false;
    const next = { ...dose };
    if (details.note !== undefined) next.note = cleanNote(details.note);
    if (details.skipReason !== undefined && dose.status === 'skipped') next.skipReason = cleanReason(details.skipReason);
    const nextDoses = doses.map(item => item.id === id ? next : item);
    try { localStorage.setItem(KEYS.doses, JSON.stringify(nextDoses)); }
    catch (error) { console.error(error); toast('Could not save the note. Check device storage.'); return false; }
    doses = nextDoses;
    return true;
  }

  function doseTitle(dose) {
    const pill = pills.find(p => p.id === dose.pillId);
    return `${pill ? pill.name : 'Medication'} · ${fmtTime(doseTimeOf(dose))}`;
  }

  function openSkipDoseModal(id, onDone) {
    const dose = doses.find(d => d.id === id);
    if (!dose) return;
    openModal(`
      <div class="modal-head"><h2 id="modal-title">Skip this dose?</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <p class="modal-intro">${esc(doseTitle(dose))}</p>
      <form id="skip-dose-form" class="modal-form">
        <label class="field"><span>Reason <small>Optional</small></span>
          <select id="skip-reason"><option value="">No reason given</option>${SKIP_REASONS.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>Note <small>Optional</small></span>
          <textarea id="skip-note" rows="3" maxlength="${NOTE_MAX}" placeholder="Anything worth remembering">${esc(dose.note || '')}</textarea>
        </label>
        <p class="modal-note">Skipping records that you chose not to take this dose. It does not change your supply.</p>
        <div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button type="submit" class="primary-button">Skip dose</button></div>
      </form>`);
    $('#skip-dose-form').onsubmit = event => {
      event.preventDefault();
      const details = { skipReason: $('#skip-reason').value, note: $('#skip-note').value };
      closeModal();
      const ok = updateDose(id, 'skipped', details);
      if (ok && onDone) onDone();
    };
  }

  function openDoseNoteModal(id) {
    const dose = doses.find(d => d.id === id);
    if (!dose) return;
    openModal(`
      <div class="modal-head"><h2 id="modal-title">Dose note</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <p class="modal-intro">${esc(doseTitle(dose))}</p>
      <form id="dose-note-form" class="modal-form">
        ${dose.status === 'skipped' ? `<label class="field"><span>Skip reason</span>
          <select id="note-skip-reason"><option value="">No reason given</option>${SKIP_REASONS.map(r => `<option value="${esc(r)}" ${dose.skipReason === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}${dose.skipReason && !SKIP_REASONS.includes(dose.skipReason) ? `<option value="${esc(dose.skipReason)}" selected>${esc(dose.skipReason)}</option>` : ''}</select></label>` : ''}
        <label class="field"><span>Note</span>
          <textarea id="dose-note-text" rows="4" maxlength="${NOTE_MAX}" placeholder="e.g., Took with breakfast, felt dizzy afterwards">${esc(dose.note || '')}</textarea>
        </label>
        <div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button type="submit" class="primary-button">Save note</button></div>
      </form>`);
    $('#dose-note-form').onsubmit = event => {
      event.preventDefault();
      const details = { note: $('#dose-note-text').value };
      const reasonSelect = $('#note-skip-reason');
      if (reasonSelect) details.skipReason = reasonSelect.value;
      if (!updateDoseDetails(id, details)) return;
      closeModal();
      renderToday();
      toast('Note saved.');
    };
  }

  function todayDoses() { ensureDoseRecords(); const key = dateKey(); return doses.filter(d => String(d.scheduledAt).slice(0, 10) === key).map(d => ({ ...d, pill: pills.find(p => p.id === d.pillId) })).filter(d => d.pill).sort((a, b) => getDoseTime(a) - getDoseTime(b)); }

  function doseDetailLine(d) {
    const parts = [];
    if (d.status === 'skipped' && d.skipReason) parts.push(`Reason: ${d.skipReason}`);
    if (d.note) parts.push(d.note);
    return parts.join(' · ');
  }

  function renderToday() {
    const list = $('#today-dose-list'); const all = todayDoses();
    const completed = all.filter(d => d.status === 'taken').length;
    const remaining = all.filter(d => !['taken', 'skipped'].includes(d.status)).length;
    const pct = all.length ? Math.round(completed / all.length * 100) : 0;
    const hour = new Date().getHours();
    $('#greeting').textContent = hour < 12 ? 'YOUR MORNING CHECK-IN' : hour < 17 ? 'YOUR AFTERNOON CHECK-IN' : 'YOUR EVENING CHECK-IN';
    $('#today-date').textContent = fmtDate(new Date());
    $('#date-day').textContent = String(new Date().getDate()).padStart(2, '0');
    $('#date-month').textContent = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date()).toUpperCase();
    $('#progress-title').textContent = all.length ? (completed === all.length ? 'All caught up' : `${completed} of ${all.length} taken`) : 'Your day, at a glance';
    $('#progress-copy').textContent = !all.length ? 'Your schedule will appear here.' : completed === all.length ? 'All scheduled doses are complete.' : `${remaining} dose${remaining === 1 ? '' : 's'} remaining today.`;
    $('#progress-percent').textContent = `${pct}%`;
    $('#progress-ring').style.background = `conic-gradient(#d6f2df ${pct * 3.6}deg,rgba(255,255,255,.2) ${pct * 3.6}deg)`;
    $('#progress-ring').setAttribute('aria-label', `${pct}% of scheduled doses taken`);
    $('#progress-bar').style.width = `${pct}%`;
    $('#stat-scheduled').textContent = all.length; $('#stat-taken').textContent = completed; $('#stat-remaining').textContent = remaining;

    if (!all.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">＋</div><h3>${pills.some(p => p.active) ? 'Nothing scheduled today' : 'Stay on top of your medications'}</h3><p>${pills.some(p => p.active) ? 'You have no active medication doses scheduled for today.' : 'Add your first medication to build today’s schedule and receive reminders on Android.'}</p><button class="primary-button" id="empty-add-pill">Add medication</button></div>`;
      $('#empty-add-pill').onclick = () => openPillModal();
    } else {
      list.innerHTML = all.map(d => {
        const p = d.pill, s = doseStatus(d), taken = s === 'taken', final = ['taken', 'skipped'].includes(s);
        const detail = doseDetailLine(d);
        return `<article class="dose-card ${highlightPillId === p.id ? 'dose-highlight' : ''}" style="--pill-color:${esc(p.color || COLORS[0])}" id="dose-${esc(d.id)}">
          <div class="dose-time">${esc(fmtTime(doseTimeOf(d)))}</div><div class="dose-rail"></div>
          <div class="dose-main"><h3>${esc(p.name)}</h3><p>${esc(p.dosage || p.form || 'Medication')}${p.notes ? ` · ${esc(p.notes)}` : ''}</p>
            <span class="dose-status ${esc(s)}">${esc(doseLabel(s))}${taken && d.takenAt ? ` · ${esc(fmtTime(d.takenAt.slice(11, 16)))}` : ''}</span>
            ${detail ? `<p class="dose-note">${esc(detail)}</p>` : ''}
            <div class="dose-sub-actions"><button type="button" class="mini-action" data-dose-note="${esc(d.id)}">${d.note ? 'Edit note' : 'Add note'}</button></div>
          </div>
          <div class="dose-actions">${final ? `<button class="take-button done" data-dose-action="undo" data-id="${esc(d.id)}">Undo</button>` : `<button class="take-button" data-dose-action="taken" data-id="${esc(d.id)}">Mark taken</button><button class="mini-action" data-dose-action="skipped" data-id="${esc(d.id)}">Skip</button>`}</div>
        </article>`;
      }).join('');
      list.querySelectorAll('[data-dose-action]').forEach(btn => btn.onclick = () => {
        const status = btn.dataset.doseAction, id = btn.dataset.id;
        if (status === 'skipped') openSkipDoseModal(id);
        else updateDose(id, status === 'undo' ? 'pending' : status);
      });
      list.querySelectorAll('[data-dose-note]').forEach(btn => btn.onclick = () => openDoseNoteModal(btn.dataset.doseNote));
    }
    const next = all.find(d => !['taken', 'skipped'].includes(doseStatus(d)));
    $('#daily-insight').textContent = !pills.length ? 'Add a medication to build your daily schedule.' : !all.length ? 'You have no scheduled doses today. Your medication list is available any time.' : !next ? 'You completed all scheduled doses for today.' : `Your next dose is ${next.pill.name} at ${fmtTime(doseTimeOf(next))}.`;
    highlightPillId = null;
  }

  /* ====================== Medications ====================== */

  function scheduleSummary(p) { if (p.schedule === 'asNeeded') return 'As needed · no automatic reminders'; const days = p.schedule === 'daily' ? 'Every day' : p.schedule === 'weekdays' ? 'Weekdays' : [...(p.days || [])].sort((a, b) => a - b).map(d => DAYS[d]).join(', ') || 'No days selected'; return `${days}${(p.times || []).length ? ' at ' + p.times.map(fmtTime).join(' and ') : ''}`; }
  function medicationQuantityUnit(form) {
    switch (String(form).toLowerCase()) { case 'tablet': return 'tablets'; case 'capsule': return 'capsules'; case 'liquid': return 'mL'; default: return 'units'; }
  }
  function renderPills() {
    const filter = $('#pill-filter').value, query = $('#pill-search').value.trim().toLowerCase();
    const visible = pills.filter(p => (filter === 'all' || (filter === 'active' ? p.active : !p.active)) && `${p.name} ${p.dosage || ''}`.toLowerCase().includes(query));
    const activeCount = pills.filter(p => p.active).length;
    $('#pill-count').textContent = `${activeCount} active medication${activeCount === 1 ? '' : 's'}`;
    const list = $('#pill-list');
    if (!visible.length) {
      list.innerHTML = `<div class="empty-state"><div class="empty-icon">✚</div><h3>${pills.length ? 'No matching medications' : 'Your list starts here'}</h3><p>${pills.length ? 'Try another search or filter.' : 'Add your first medication to keep its dose and reminder schedule organized.'}</p><button class="primary-button" id="pill-empty-add">Add medication</button></div>`;
      $('#pill-empty-add').onclick = () => openPillModal();
      return;
    }
    list.innerHTML = visible.map(p => {
      const unit = medicationQuantityUnit(p.form);
      const hasQty = p.quantity !== '' && p.quantity != null;
      return `<article class="med-card" style="--pill-color:${esc(p.color || COLORS[0])}"><div class="med-card-top"><div class="med-dot">${p.form === 'Capsule' ? '◒' : p.form === 'Liquid' ? '◉' : p.form === 'Injection' ? '↗' : '＋'}</div><div class="med-info"><h3>${esc(p.name)}</h3><p>${esc([p.dosage, p.form].filter(Boolean).join(' · ') || 'Medication')}</p></div><button class="med-menu" aria-label="More actions for ${esc(p.name)}" data-med-menu="${esc(p.id)}">⋯</button></div>
      <div class="med-details"><div class="med-detail">◷ <span>${esc(scheduleSummary(p))}</span></div>
      ${p.startDate ? `<div class="med-detail">▦ <span>Started ${esc(fmtDate(parseLocal(p.startDate + 'T12:00:00'), { month: 'short', day: 'numeric', year: 'numeric' }))}${p.endDate ? ' · Ends ' + esc(p.endDate) : ''}</span></div>` : ''}
      ${hasQty ? `<div class="med-detail">▤ <span><b>${esc(p.quantity)}</b> ${esc(unit)} remaining</span></div>
        ${p.unitsPerDose !== '' && p.unitsPerDose != null ? `<div class="med-detail">💊 <span>${esc(p.unitsPerDose)} ${esc(unit)} per dose</span></div>` : ''}
        ${p.refillThreshold !== '' && p.refillThreshold != null ? `<div class="med-detail">↻ <span>Low-supply threshold: ${esc(p.refillThreshold)} ${esc(unit)}</span></div>` : ''}` : ''}
      ${p.notes ? `<div class="med-detail">✎ <span>${esc(p.notes)}</span></div>` : ''}</div>
      <div class="med-bottom"><span class="pill-state ${p.active ? '' : 'paused'}">${p.active ? 'Active' : 'Reminders paused'}</span><div class="med-actions"><button data-edit-pill="${esc(p.id)}">Edit</button><button data-toggle-pill="${esc(p.id)}">${p.active ? 'Pause' : 'Resume'}</button></div></div></article>`;
    }).join('');
    list.querySelectorAll('[data-edit-pill]').forEach(b => b.onclick = () => openPillModal(b.dataset.editPill));
    list.querySelectorAll('[data-toggle-pill]').forEach(b => b.onclick = () => togglePill(b.dataset.togglePill));
    list.querySelectorAll('[data-med-menu]').forEach(b => b.onclick = () => showPillActions(b.dataset.medMenu));
  }

  async function togglePill(id) {
    const pill = pills.find(p => p.id === id);
    if (!pill) return;
    const updated = { ...pill, active: !pill.active };
    try { await Notify.cancelPill(pill); } catch (error) { console.error(error); }
    pills = pills.map(p => p.id === id ? updated : p);
    save(KEYS.pills, pills);
    ensureDoseRecords();
    render();
    if (updated.active) {
      let result = null;
      try { result = await Notify.schedulePill(updated); } catch (error) { console.error(error); }
      toast(result && result.supported && result.scheduled ? `${updated.name} resumed · ${result.scheduled} reminder(s) scheduled.` : `${updated.name} resumed.`);
    } else {
      toast(`${updated.name} paused. Reminders are off.`);
    }
  }

  function showPillActions(id) {
    const p = pills.find(item => item.id === id);
    if (!p) return;
    openModal(`
      <div class="modal-head"><h2 id="modal-title">${esc(p.name)}</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <p class="modal-intro">Medication options</p>
      <div class="settings-actions vertical">
        <button class="settings-link" id="action-edit"><span><strong>Edit medication</strong><small>Update dose, schedule or notes</small></span><b aria-hidden="true">›</b></button>
        <button class="settings-link" id="action-toggle"><span><strong>${p.active ? 'Pause reminders' : 'Resume reminders'}</strong><small>Keep the medication record</small></span><b aria-hidden="true">›</b></button>
        <button class="settings-link" id="action-about"><span><strong>About medication</strong><small>Information about your medication</small></span><b aria-hidden="true">›</b></button>
        <button class="settings-link" id="action-history"><span><strong>View history</strong><small>Review the last 30 days</small></span><b aria-hidden="true">›</b></button>
        <button class="settings-link danger-link" id="action-delete"><span><strong>Delete medication</strong><small>Remove this medication and its history</small></span><b aria-hidden="true">×</b></button>
      </div>`);
    $('#action-edit').onclick = () => { closeModal(); openPillModal(id); };
    $('#action-toggle').onclick = () => { closeModal(); togglePill(id); };
    $('#action-about').onclick = () => openMedicationAbout(id);
    $('#action-history').onclick = () => openMedicationHistory(id);
    $('#action-delete').onclick = () => { closeModal(); confirmAction('Delete medication?', `This removes ${p.name} and its dose history from this device.`, () => deletePill(id)); };
  }

  function saveMedicationInfo(id, information) {
    if (!pills.some(pill => pill.id === id)) return false;
    const updatedPills = pills.map(pill => pill.id === id ? { ...pill, medicationInfo: information } : pill);
    try { localStorage.setItem(KEYS.pills, JSON.stringify(updatedPills)); }
    catch (error) { console.error('Could not save medication information:', error); toast('Could not save medication information. Check device storage.'); return false; }
    pills = updatedPills;
    return true;
  }

  function openMedicationAbout(id) {
    const pill = pills.find(item => item.id === id);
    if (!pill) return;
    openModal(`
      <div class="modal-head"><h2 id="modal-title">About ${esc(pill.name)}</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <p class="modal-intro">Medication labeling from openFDA.</p>
      <p class="medication-information-note">Loading information sends this medication’s name to the FDA’s data service. It does not send your dose history, glucose readings, notes, or remaining quantity. Internet access is required.</p>
      <div id="medication-info-content"><button type="button" class="primary-button" id="load-medication-information">Load medication information</button></div>
      <p class="medication-information-note">Search results are not verified matches to your medication. Check the product name, strength, formulation, and manufacturer. Do not use this information to make treatment decisions.</p>
      <div class="modal-actions"><button type="button" class="secondary-button" id="medication-about-back">Back to medication options</button></div>`);

    const content = $('#medication-info-content');
    const loadButton = $('#load-medication-information');
    let controller = null;

    $('#medication-about-back').onclick = () => { controller?.abort(); showPillActions(id); };

    function showMessage(message) {
      content.innerHTML = `<p class="medication-information-note" role="status">${esc(message)}</p><button type="button" class="secondary-button" id="retry-medication-information">Try again</button>`;
      content.querySelector('#retry-medication-information').onclick = loadInformation;
    }
    function fieldValues(record, field) { const value = record.openfda?.[field]; return Array.isArray(value) ? value.map(String).filter(Boolean).join(', ') : ''; }

    function showLabel(record, results = [], savedAt = '') {
      if (!content.isConnected) return;
      const savedDate = savedAt ? new Date(savedAt) : null;
      const savedDateLabel = savedDate && Number.isFinite(savedDate.getTime()) ? savedDate.toLocaleString() : '';
      const brand = fieldValues(record, 'brand_name'), generic = fieldValues(record, 'generic_name'), manufacturer = fieldValues(record, 'manufacturer_name'), route = fieldValues(record, 'route'), productType = fieldValues(record, 'product_type');
      const labelDate = /^\d{8}$/.test(record.effective_time || '') ? `${record.effective_time.slice(0, 4)}-${record.effective_time.slice(4, 6)}-${record.effective_time.slice(6, 8)}` : 'Not provided';
      const sections = [['Boxed warning', 'boxed_warning'], ['Uses', 'indications_and_usage'], ['OTC uses', 'purpose'], ['Warnings', 'warnings'], ['Warnings and precautions', 'warnings_and_cautions'], ['Do not use', 'do_not_use'], ['Contraindications', 'contraindications'], ['Side effects', 'adverse_reactions'], ['Drug interactions', 'drug_interactions'], ['Patient information', 'information_for_patients'], ['Storage', 'storage_and_handling']];
      const sectionHtml = sections.map(([title, field]) => {
        const values = record[field];
        if (!Array.isArray(values) || !values.length) return '';
        const text = values.filter(value => typeof value === 'string').join('\n\n');
        if (!text.trim()) return '';
        return `<details class="medication-label-section"><summary>${esc(title)}</summary><div class="medication-label-text">${esc(text)}</div></details>`;
      }).join('');
      content.innerHTML = `
        <div class="medication-label-identity">
          <p><strong>Brand:</strong> ${esc(brand || 'Not provided')}</p><p><strong>Generic:</strong> ${esc(generic || 'Not provided')}</p>
          <p><strong>Manufacturer:</strong> ${esc(manufacturer || 'Not provided')}</p><p><strong>Route:</strong> ${esc(route || 'Not provided')}</p>
          <p><strong>Product type:</strong> ${esc(productType || 'Not provided')}</p><p><strong>Label effective date:</strong> ${esc(labelDate)}</p>
        </div>
        <p class="medication-information-note">Source: openFDA drug product labeling. These are selected sections, not the complete label. Missing sections do not mean there are no warnings or interactions. Label information may differ from your product’s current packaging.</p>
        ${sectionHtml || '<p class="medication-information-note">No supported text sections were returned for this label.</p>'}
        <p class="medication-information-note">${savedDateLabel ? `Saved on this device: ${esc(savedDateLabel)}. This is a saved copy and is not automatically refreshed.` : 'You can save this label for this medication. Saving does not verify that it matches your product.'}</p>
        <div class="medication-info-actions">
          <button type="button" class="primary-button" id="save-selected-medication-info" ${savedAt ? 'disabled' : ''}>${savedAt ? 'Information saved' : 'Save this medication information'}</button>
          <button type="button" class="secondary-button" id="choose-another-medication-label">Choose different information</button>
          ${savedAt ? '<button type="button" class="secondary-button" id="remove-saved-medication-info">Remove saved information</button>' : ''}
        </div>`;
      content.querySelector('#save-selected-medication-info').onclick = () => {
        const currentPill = pills.find(item => item.id === id);
        if (!currentPill) return;
        const information = { source: 'openFDA', savedAt: new Date().toISOString(), medicationName: currentPill.name, record };
        if (!saveMedicationInfo(id, information)) return;
        toast('Medication information saved.');
        showLabel(record, results, information.savedAt);
      };
      content.querySelector('#choose-another-medication-label').onclick = () => { if (results.length) showResults(results); else loadInformation(); };
      const removeButton = content.querySelector('#remove-saved-medication-info');
      if (removeButton) removeButton.onclick = () => confirmAction('Remove saved information?', 'This removes the saved label only. Your medication, supply, and dose history will remain.', () => { if (saveMedicationInfo(id, null)) toast('Saved medication information removed.'); openMedicationAbout(id); });
    }

    function showResults(results, total = results.length) {
      if (!content.isConnected) return;
      content.innerHTML = `
        <p class="medication-information-note">Choose a label that matches your medication. Showing ${results.length} of ${esc(total)} matching records. A name match alone does not confirm the correct product.</p>
        <div class="settings-card settings-actions vertical">${results.map((record, index) => {
          const brand = fieldValues(record, 'brand_name'), generic = fieldValues(record, 'generic_name'), manufacturer = fieldValues(record, 'manufacturer_name'), route = fieldValues(record, 'route');
          return `<button type="button" class="settings-link" data-medication-label="${index}"><span><strong>${esc(brand || generic || 'Medication label')}</strong><small>${esc([generic, manufacturer, route].filter(Boolean).join(' · ') || 'Product details not provided')}</small></span><b aria-hidden="true">›</b></button>`;
        }).join('')}</div>`;
      content.querySelectorAll('[data-medication-label]').forEach(button => {
        button.onclick = () => { const record = results[Number(button.dataset.medicationLabel)]; if (record) showLabel(record, results); };
      });
    }

    async function loadInformation() {
      if (!content.isConnected) return;
      controller?.abort();
      controller = new AbortController();
      const requestController = controller;
      content.innerHTML = '<p class="medication-information-note" role="status">Loading medication labels…</p>';
      const name = pill.name.trim();
      if (!name) { showMessage('This medication does not have a searchable name.'); return; }
      const safeName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const params = new URLSearchParams({ search: `openfda.brand_name:"${safeName}" OR openfda.generic_name:"${safeName}"`, limit: '10' });
      const timeout = setTimeout(() => requestController.abort(), 15000);
      try {
        const response = await fetch(`https://api.fda.gov/drug/label.json?${params}`, { signal: requestController.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
        if (!content.isConnected || controller !== requestController) return;
        if (response.status === 404) { showMessage('No matching labels were found. Check the medication name. Some medications and supplements may not appear in this database.'); return; }
        if (response.status === 429) { showMessage('The medication information service is busy. Try again later.'); return; }
        if (!response.ok) throw new Error(`Information service returned ${response.status}.`);
        const data = await response.json();
        if (!content.isConnected || controller !== requestController) return;
        const results = Array.isArray(data.results) ? data.results : [];
        if (!results.length) { showMessage('No matching medication labels were returned.'); return; }
        showResults(results, data.meta?.results?.total ?? results.length);
      } catch (error) {
        if (!content.isConnected || controller !== requestController) return;
        showMessage(error.name === 'AbortError' ? 'The request timed out. Try again.' : 'Could not load medication information. Check your connection or try again later.');
        console.error('Medication information request failed:', error);
      } finally { clearTimeout(timeout); }
    }

    loadButton.onclick = loadInformation;
    const savedInformation = pill.medicationInfo;
    if (savedInformation?.source === 'openFDA' && savedInformation.record && savedInformation.medicationName === pill.name) showLabel(savedInformation.record, [], savedInformation.savedAt);
  }

  function openMedicationHistory(id) {
    const p = pills.find(item => item.id === id);
    if (!p) return;
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const firstDay = new Date(today); firstDay.setDate(firstDay.getDate() - 29);
    const firstKey = dateKey(firstDay), lastKey = dateKey(today);
    const records = doses
      .filter(dose => { const key = String(dose.scheduledAt).slice(0, 10); return dose.pillId === id && key >= firstKey && key <= lastKey; })
      .filter(dose => Number.isFinite(getDoseTime(dose).getTime()))
      .sort((a, b) => getDoseTime(b) - getDoseTime(a));
    const counts = { taken: 0, missed: 0, skipped: 0, pending: 0 };
    const grouped = new Map();
    for (const dose of records) {
      const key = String(dose.scheduledAt).slice(0, 10);
      const status = doseStatus(dose);
      if (status === 'taken') counts.taken += 1; else if (status === 'missed') counts.missed += 1; else if (status === 'skipped') counts.skipped += 1; else counts.pending += 1;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({ dose, status });
    }
    const daySections = [];
    for (let offset = 0; offset < 30; offset += 1) {
      const date = new Date(today); date.setDate(today.getDate() - offset);
      const key = dateKey(date);
      const dayRecords = grouped.get(key) || [];
      const rows = dayRecords.length ? dayRecords.map(({ dose, status }) => {
        const takenTime = dose.takenAt ? parseLocal(dose.takenAt) : null;
        const takenDetail = status === 'taken' && takenTime && Number.isFinite(takenTime.getTime()) ? `<small>Taken ${esc(fmtStamp(dose.takenAt))}</small>` : '';
        const extra = doseDetailLine(dose);
        return `<div class="medication-dose-history-row"><div class="medication-dose-history-time"><strong>${esc(fmtTime(doseTimeOf(dose)))}</strong>${takenDetail}${extra ? `<small>${esc(extra)}</small>` : ''}</div><span class="dose-status ${esc(status)}">${esc(doseLabel(status))}</span></div>`;
      }).join('') : '<p class="medication-history-empty">No stored dose records.</p>';
      daySections.push(`<section class="medication-history-day"><h3>${esc(fmtDate(date, { weekday: 'short', month: 'short', day: 'numeric' }))}${key === lastKey ? ' · Today' : ''}</h3>${rows}</section>`);
    }
    openModal(`
      <div class="modal-head"><h2 id="modal-title">${esc(p.name)} history</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <p class="modal-intro">Last 30 days · ${esc(fmtDate(firstDay, { month: 'short', day: 'numeric' }))} – ${esc(fmtDate(today, { month: 'short', day: 'numeric', year: 'numeric' }))}</p>
      <div class="medication-history-summary"><div><strong>${counts.taken}</strong><span>Taken</span></div><div><strong>${counts.missed}</strong><span>Missed</span></div><div><strong>${counts.skipped}</strong><span>Skipped</span></div><div><strong>${counts.pending}</strong><span>Pending</span></div></div>
      <p class="medication-information-note">Only stored dose records are shown here. For adherence percentages that also count unrecorded doses, open Adherence from the Today screen. “Missed” follows the app’s existing overdue-dose rule.</p>
      <div class="medication-history-days">${daySections.join('')}</div>
      <div class="modal-actions history-modal-actions"><button type="button" class="secondary-button" id="medication-history-back">Back to medication options</button></div>`);
    $('#medication-history-back').onclick = () => showPillActions(id);
  }

  function deletePill(id) {
    const p = pills.find(x => x.id === id);
    if (!p) return;
    Notify.cancelPill(p).catch(() => {});
    pills = pills.filter(x => x.id !== id);
    doses = doses.filter(d => d.pillId !== id);
    save(KEYS.pills, pills); save(KEYS.doses, doses);
    render(); toast('Medication deleted.');
  }

  /* ====================== Modals & settings ====================== */

  let settingsModalGroups = [];
  function restoreSettingsContent() {
    const storage = $('#page-more');
    if (!storage) return;
    for (const group of settingsModalGroups) storage.appendChild(group);
    settingsModalGroups = [];
  }

  function openSettingsModal() {
    openModal(`
      <div class="modal-head"><h2 id="modal-title">Settings</h2><button class="close-modal" data-close aria-label="Close settings">×</button></div>
      <p class="modal-intro">Preferences, privacy and tools.</p>
      <div id="settings-modal-content"></div>`);
    const storage = $('#page-more');
    const destination = $('#settings-modal-content');
    if (!storage || !destination) { closeModal(); toast('Settings content is unavailable.'); return; }
    settingsModalGroups = Array.from(storage.children).filter(element => element.classList.contains('settings-group'));
    for (const group of settingsModalGroups) destination.appendChild(group);
    refreshBackupStatus();
    refreshUndoRestore();
    refreshNotificationStatus().catch(error => console.error('Could not refresh notification status:', error));
  }

  function openMoreModal() {
    openModal(`
      <div class="modal-head"><h2 id="modal-title">More</h2><button class="close-modal" data-close aria-label="Close More">×</button></div>
      <div class="settings-card settings-actions vertical">
        <button type="button" class="settings-link" id="open-appointments"><span><strong>📅 Appointments</strong><small>Visits, checkups and reminders</small></span><b aria-hidden="true">›</b></button>
      </div>`);
    $('#open-appointments').onclick = () => { closeModal(); go('appointments'); };
  }

  function openModal(html) {
    restoreSettingsContent();
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">${html}</section></div>`;
    const backdrop = root.querySelector('.modal-backdrop');
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
    root.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal);
    const first = root.querySelector('input,button,select,textarea');
    if (first) setTimeout(() => first.focus(), 20);
    document.addEventListener('keydown', escModal, { once: true });
  }
  function escModal(e) { if (e.key === 'Escape') { closeModal(); return; } document.addEventListener('keydown', escModal, { once: true }); }
  function closeModal() { restoreSettingsContent(); $('#modal-root').innerHTML = ''; }
  function confirmAction(title, body, onConfirm, danger = true) {
    openModal(`<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="close-modal" data-close aria-label="Close">×</button></div><p class="modal-intro">${esc(body)}</p><div class="modal-actions"><button class="secondary-button" data-close>Cancel</button><button class="primary-button ${danger ? 'danger-button' : ''}" id="confirm-action">Confirm</button></div>`);
    $('#confirm-action').onclick = () => { closeModal(); onConfirm(); };
  }

  function openPillModal(id = null) {
    const old = pills.find(p => p.id === id);
    const p = old || { name: '', dosage: '', form: 'Tablet', color: COLORS[0], times: ['08:00'], schedule: 'daily', days: [1, 2, 3, 4, 5, 6, 0], startDate: dateKey(), endDate: '', notes: '', active: true, quantity: '' };
    const colorButtons = COLORS.map(c => `<button type="button" class="swatch ${c === p.color ? 'selected' : ''}" style="--swatch:${c}" data-color="${c}" aria-label="Choose color ${c}" aria-pressed="${c === p.color}"></button>`).join('');
    openModal(`<div class="modal-head"><h2 id="modal-title">${old ? 'Edit medication' : 'Add medication'}</h2><button class="close-modal" data-close aria-label="Close">×</button></div><p class="modal-intro">${old ? 'Keep your medication details up to date.' : 'Build a routine that works for you.'}</p>
    <form id="pill-form" class="modal-form" novalidate>
      <label class="field"><span>Medication name <b>*</b></span><input id="med-name" maxlength="100" required placeholder="e.g., Metformin" value="${esc(p.name)}"><small class="error-text" id="med-name-error"></small></label>
      <div class="modal-grid"><label class="field"><span>Dosage</span><input id="med-dosage" maxlength="60" placeholder="e.g., 500 mg" value="${esc(p.dosage || '')}"></label><label class="field"><span>Form</span><select id="med-form">${FORMS.map(f => `<option ${f.toLowerCase() === String(p.form).toLowerCase() ? 'selected' : ''}>${f}</option>`).join('')}</select></label></div>
      <div class="field"><span>Color marker</span><div class="swatches">${colorButtons}</div><input id="med-color" type="hidden" value="${esc(p.color)}"></div>
      <div class="field"><span>Reminder times</span><div class="time-list" id="time-list">${(p.times || []).map((t, i) => `<div class="time-row"><input aria-label="Reminder time ${i + 1}" type="time" value="${esc(t)}" class="med-time"><button type="button" class="remove-time" aria-label="Remove reminder time">−</button></div>`).join('')}</div><button type="button" class="inline-button" id="add-time">＋ Add another reminder time</button></div>
      <label class="field"><span>Frequency</span><select id="med-schedule">${SCHEDULES.map(s => `<option value="${s.value}" ${s.value === p.schedule ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
      <div class="field" id="days-field" ${p.schedule === 'custom' ? '' : 'hidden'}><span>Repeat on</span><div class="days-picker">${DAYS.map((d, i) => `<button type="button" class="day-toggle ${(p.days || []).includes(i) ? 'selected' : ''}" data-day="${i}" aria-pressed="${(p.days || []).includes(i)}">${d}</button>`).join('')}</div><small class="error-text" id="days-error"></small></div>
      <div class="modal-grid"><label class="field"><span>Start date</span><input id="med-start" type="date" value="${esc(p.startDate || dateKey())}"></label><label class="field"><span>End date <small>Optional</small></span><input id="med-end" type="date" value="${esc(p.endDate || '')}"></label></div>
      <div class="modal-grid"><label class="field"><span>Remaining quantity <small>Optional</small></span><input id="med-quantity" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g., 30 or 100" value="${esc(p.quantity ?? '')}"></label></div>
      <div class="modal-grid"><label class="field"><span>Units per dose</span><input id="med-units-per-dose" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g., 0.5 or 5" value="${esc(p.unitsPerDose ?? '')}"></label><label class="field"><span>Low-supply threshold <small>Optional</small></span><input id="med-refill-threshold" type="number" min="0" step="any" inputmode="decimal" placeholder="e.g., 5" value="${esc(p.refillThreshold ?? '')}"></label></div>
      <p class="modal-note">Supply tracking uses the selected medication form. Enter the quantity used per dose in the same units as your remaining quantity. Leave remaining quantity blank to disable supply tracking. These fields do not recommend a medication dose.</p>
      <label class="field"><span>Notes <small>Optional</small></span><textarea id="med-notes" rows="2" maxlength="500" placeholder="Take with food">${esc(p.notes || '')}</textarea></label>
      <label class="check-row"><input id="med-active" type="checkbox" ${p.active ? 'checked' : ''}> Medication is active and reminders are enabled</label>
      <p class="modal-note">Tablets and capsules are counted individually. Liquid quantities are recorded in mL. Use the same measurement for remaining quantity, units per dose, and the low-supply threshold.</p>
      <div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button type="submit" class="primary-button">${old ? 'Save changes' : 'Save medication'}</button></div></form>`);

    $('#modal-root').querySelectorAll('[data-color]').forEach(b => b.onclick = () => {
      $('#med-color').value = b.dataset.color;
      $('#modal-root').querySelectorAll('[data-color]').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-pressed', String(x === b)); });
    });
    $('#add-time').onclick = () => { const row = document.createElement('div'); row.className = 'time-row'; row.innerHTML = '<input aria-label="Reminder time" type="time" value="12:00" class="med-time"><button type="button" class="remove-time" aria-label="Remove reminder time">−</button>'; $('#time-list').append(row); row.querySelector('input').focus(); };
    $('#time-list').onclick = e => { const btn = e.target.closest('.remove-time'); if (!btn) return; const rows = $$('.time-row'); if (rows.length > 1) btn.closest('.time-row').remove(); else btn.closest('.time-row').querySelector('input').value = ''; };
    $('#med-schedule').onchange = () => $('#days-field').hidden = $('#med-schedule').value !== 'custom';
    $('#days-field').querySelectorAll('[data-day]').forEach(b => b.onclick = () => { b.classList.toggle('selected'); b.setAttribute('aria-pressed', String(b.classList.contains('selected'))); });

    $('#pill-form').onsubmit = async e => {
      e.preventDefault();
      const name = $('#med-name').value.trim(); const error = $('#med-name-error');
      if (!name) { error.textContent = 'Enter a medication name.'; $('#med-name').focus(); return; }
      error.textContent = '';
      const schedule = $('#med-schedule').value;
      const times = [...$('#time-list').querySelectorAll('.med-time')].map(x => x.value).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).sort();
      if (schedule !== 'asNeeded' && !times.length) { toast('Add at least one reminder time, or choose As needed.'); $('#time-list input').focus(); return; }
      const days = $$('#days-field [data-day].selected').map(b => Number(b.dataset.day));
      if (schedule === 'custom' && !days.length) { $('#days-error').textContent = 'Choose at least one day.'; return; }
      $('#days-error').textContent = '';
      const startDate = $('#med-start').value || dateKey(), endDate = $('#med-end').value;
      if (endDate && endDate < startDate) { toast('End date must be on or after the start date.'); return; }
      const quantityText = $('#med-quantity').value.trim(), unitsText = $('#med-units-per-dose').value.trim(), thresholdText = $('#med-refill-threshold').value.trim();
      const quantity = quantityText === '' ? '' : Number(quantityText);
      const unitsPerDose = unitsText === '' ? '' : Number(unitsText);
      const refillThreshold = thresholdText === '' ? '' : Number(thresholdText);
      if (quantity !== '' && (!Number.isFinite(quantity) || quantity < 0)) { toast('Enter a remaining quantity of zero or greater.'); $('#med-quantity').focus(); return; }
      if (unitsPerDose !== '' && (!Number.isFinite(unitsPerDose) || unitsPerDose <= 0)) { toast('Units per dose must be greater than zero.'); $('#med-units-per-dose').focus(); return; }
      if (refillThreshold !== '' && (!Number.isFinite(refillThreshold) || refillThreshold < 0)) { toast('Enter a low-supply threshold of zero or greater.'); $('#med-refill-threshold').focus(); return; }
      if (quantity !== '' && unitsPerDose === '') { toast('Enter how many units are used per dose.'); $('#med-units-per-dose').focus(); return; }
      const dosage = $('#med-dosage').value.trim(), form = $('#med-form').value;
      const updated = {
        id: old?.id || uid('pill'), name, dosage, form, color: $('#med-color').value, times, schedule, days: schedule === 'custom' ? days : [], startDate, endDate,
        notes: $('#med-notes').value.trim(), active: $('#med-active').checked, quantity, unitsPerDose, refillThreshold,
        medicationInfo: old && old.name === name && old.dosage === dosage && old.form === form ? (old.medicationInfo || null) : null,
        inventoryEpoch: old && inventoryNumber(old.quantity) === inventoryNumber(quantity) && old.form === form ? (old.inventoryEpoch || '') : uid('inventory'),
        createdAt: old?.createdAt || new Date().toISOString(),
      };
      if (old) await Notify.cancelPill(old);
      if (old) pills = pills.map(x => x.id === old.id ? updated : x); else pills.push(updated);
      save(KEYS.pills, pills); ensureDoseRecords(); closeModal(); render();
      const result = await Notify.schedulePill(updated);
      if (updated.active && updated.schedule !== 'asNeeded' && updated.times.length) {
        if (result.supported && result.scheduled) toast(`${old ? 'Medication updated' : 'Medication added'} and ${result.scheduled} reminder(s) scheduled.`);
        else toast('Medication saved. Reminder notifications are available in the Android app.');
      } else toast(old ? 'Medication updated.' : 'Medication saved.');
    };
  }

  /* ====================== Glucose ====================== */

  function mmol(value) { return value / 18.0182; } function mgdl(value) { return value * 18.0182; }
  function displayReading(entry, unit = $('#display-unit').value) { return unit === 'mmol/L' ? mmol(entry.unit === 'mg/dL' ? entry.value : mgdl(entry.value)) : entry.unit === 'mg/dL' ? entry.value : mgdl(entry.value); }
  function readingStatus(value, unit) { const v = unit === 'mmol/L' ? mgdl(value) : value; if (v < settings.targetLow) return 'Below personal range'; if (v > settings.targetHigh) return 'Above personal range'; return 'Within personal range'; }
  function renderGlucose() {
    const sorted = [...glucose].sort((a, b) => parseLocal(b.at) - parseLocal(a.at)); const latest = sorted[0]; const unit = $('#display-unit').value; $('#glucose-unit').value = unit; $('#latest-unit').textContent = unit;
    if (!latest) { $('#latest-value').textContent = '—'; $('#latest-date').textContent = 'No readings recorded'; $('#latest-context').textContent = 'Your readings will appear here once you log one.'; }
    else { const value = displayReading(latest, unit); $('#latest-value').textContent = unit === 'mmol/L' ? value.toFixed(1) : Math.round(value); $('#latest-date').textContent = fmtStamp(latest.at); $('#latest-context').textContent = `${latest.context || 'No meal context'} · ${readingStatus(value, unit)} (based on your personal range)`; }
    const cutoff = $('#trend-range').value === 'all' ? 0 : Date.now() - Number($('#trend-range').value) * 86400000;
    const trend = sorted.filter(g => parseLocal(g.at).getTime() >= cutoff).sort((a, b) => parseLocal(a.at) - parseLocal(b.at));
    drawChart(trend, unit);
    const list = $('#glucose-history');
    if (!sorted.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">⌁</div><h3>No glucose readings yet</h3><p>Log a reading to begin tracking your glucose history and trends.</p></div>'; return; }
    list.innerHTML = sorted.map(g => { const value = displayReading(g, unit); return `<article class="history-item"><div class="history-reading"><strong>${unit === 'mmol/L' ? value.toFixed(1) : Math.round(value)} ${esc(unit)}</strong><p>${esc(g.context || 'Other')}${g.notes ? ` · ${esc(g.notes)}` : ''}</p></div><div class="history-meta">${esc(fmtStamp(g.at))}<div class="history-buttons"><button data-edit-glucose="${esc(g.id)}" aria-label="Edit reading">Edit</button><button data-delete-glucose="${esc(g.id)}" aria-label="Delete reading">Delete</button></div></div></article>`; }).join('');
    list.querySelectorAll('[data-edit-glucose]').forEach(b => b.onclick = () => editGlucose(b.dataset.editGlucose));
    list.querySelectorAll('[data-delete-glucose]').forEach(b => b.onclick = () => confirmAction('Delete this reading?', 'This reading will be removed from your local history.', () => { glucose = glucose.filter(g => g.id !== b.dataset.deleteGlucose); save(KEYS.glucose, glucose); renderGlucose(); toast('Reading deleted.'); }));
  }
  function drawChart(data, unit) {
    const root = $('#glucose-chart');
    if (!data.length) { root.innerHTML = '<p class="empty-inline">No readings in this date range yet.</p>'; return; }
    const w = 620, h = 190, pad = { l: 36, r: 12, t: 14, b: 30 };
    const values = data.map(g => displayReading(g, unit));
    let min = Math.min(...values), max = Math.max(...values);
    if (min === max) { min -= unit === 'mmol/L' ? 1 : 18; max += unit === 'mmol/L' ? 1 : 18; }
    const gap = (max - min) * .18; min = Math.max(0, min - gap); max += gap;
    const x = i => pad.l + (data.length === 1 ? (w - pad.l - pad.r) / 2 : i * (w - pad.l - pad.r) / (data.length - 1));
    const y = v => pad.t + (max - v) * (h - pad.t - pad.b) / (max - min);
    const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    const ticks = [min, (min + max) / 2, max];
    const grid = ticks.map(v => `<g><line x1="${pad.l}" y1="${y(v)}" x2="${w - pad.r}" y2="${y(v)}" stroke="var(--border)" stroke-dasharray="3 4"/><text x="${pad.l - 7}" y="${y(v) + 4}" fill="var(--muted)" font-size="10" text-anchor="end">${unit === 'mmol/L' ? v.toFixed(1) : Math.round(v)}</text></g>`).join('');
    const circles = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="var(--accent)" stroke="var(--card)" stroke-width="2"><title>${esc(fmtStamp(data[i].at))}: ${unit === 'mmol/L' ? v.toFixed(1) : Math.round(v)} ${esc(unit)}</title></circle>`).join('');
    const labels = [0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => `<text x="${x(i)}" y="${h - 7}" fill="var(--muted)" font-size="10" text-anchor="${i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}">${esc(fmtDate(parseLocal(data[i].at), { month: 'short', day: 'numeric' }))}</text>`).join('');
    root.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Glucose trend chart with ${data.length} readings"><title>Glucose trend, ${data.length} readings, in ${esc(unit)}</title>${grid}<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${circles}${labels}</svg>`;
  }
  function resetGlucoseForm() { editingGlucoseId = null; $('#glucose-form').reset(); $('#glucose-time').value = localISO().slice(0, 16); $('#glucose-unit').value = $('#display-unit').value; $('#glucose-form').querySelector('button[type="submit"]').textContent = 'Log reading'; }
  function editGlucose(id) { const g = glucose.find(x => x.id === id); if (!g) return; editingGlucoseId = id; $('#glucose-value').value = g.value; $('#glucose-unit').value = g.unit; $('#glucose-context').value = g.context || 'Other'; $('#glucose-time').value = String(g.at).slice(0, 16); $('#glucose-notes').value = g.notes || ''; $('#glucose-form').querySelector('button[type="submit"]').textContent = 'Save changes'; $('#glucose-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#glucose-value').focus({ preventScroll: true }); }
  $('#glucose-form').onsubmit = e => {
    e.preventDefault();
    const value = Number($('#glucose-value').value);
    if (!Number.isFinite(value) || value <= 0 || value > 1000) { toast('Enter a valid glucose reading.'); return; }
    const entry = { id: editingGlucoseId || uid('glucose'), value, unit: $('#glucose-unit').value, context: $('#glucose-context').value, at: $('#glucose-time').value, notes: $('#glucose-notes').value.trim(), createdAt: editingGlucoseId ? glucose.find(g => g.id === editingGlucoseId)?.createdAt : new Date().toISOString() };
    if (!entry.at) { toast('Choose the date and time for this reading.'); return; }
    const wasEditing = !!editingGlucoseId;
    if (editingGlucoseId) glucose = glucose.map(g => g.id === editingGlucoseId ? entry : g); else glucose.push(entry);
    save(KEYS.glucose, glucose); resetGlucoseForm(); renderGlucose(); toast(wasEditing ? 'Reading updated.' : 'Glucose reading saved.');
  };

  function applyTheme(theme, persist = true) {
    const validThemes = ['system', 'light', 'dark', 'osrs'];
    const selectedTheme = validThemes.includes(theme) ? theme : 'system';
    document.documentElement.dataset.theme = selectedTheme;
    const themeSelect = $('#theme-select');
    if (themeSelect) themeSelect.value = selectedTheme;
    if (persist) save(KEYS.theme, selectedTheme);
  }

  /* ====================== Notifications ====================== */

  async function refreshNotificationStatus() {
    const native = Notify.isNative();
    const status = $('#notification-status'), dot = $('#notification-dot'), exact = $('#exact-status');
    if (!status) return;
    if (!native) {
      status.textContent = 'Browser preview mode'; dot.style.background = 'var(--amber)';
      exact.textContent = 'Available in Android app where supported';
      $('#notification-diagnostic').textContent = 'Native scheduled notifications are available after installing this app on Android. Medication schedules and records still work in browser mode.';
      $('#open-exact-settings').disabled = true; $('#open-notification-settings').disabled = true;
      return;
    }
    $('#open-exact-settings').disabled = false; $('#open-notification-settings').disabled = false;
    const p = await Notify.plugin().checkPermissions().catch(() => ({ display: 'unknown' }));
    const granted = p.display === 'granted';
    status.textContent = granted ? 'Enabled' : 'Not allowed';
    dot.style.background = granted ? 'var(--accent)' : 'var(--amber)';
    const a = await Notify.checkExactAlarmPermission();
    exact.textContent = !a.supported ? 'Check Android settings if reminders are late' : a.granted ? 'Enabled' : 'Needs Android setting';
    $('#notification-diagnostic').textContent = granted ? 'Notification permission is enabled. Use Resync reminders after changing medication schedules, or open Reminder health to check everything.' : 'Allow notification access to receive scheduled medication reminders.';
  }

  // Re-creates every medication and appointment reminder from the saved data.
  async function syncNotifications(options = {}) {
    const { quiet = false } = options;
    let pillResult = { supported: false, message: '' }, apptResult = { supported: false };
    try { await Notify.init(); } catch (error) { console.error(error); }
    try { pillResult = await Notify.syncPills(pills); } catch (error) { console.error(error); pillResult = { supported: true, message: 'Reminder sync failed.' }; }
    try { apptResult = await Notify.syncAppointments(appointments, { prompt: false }); } catch (error) { console.error(error); }
    if (!quiet) {
      let message = pillResult.message || 'Reminder sync finished.';
      if (pillResult.supported && apptResult.supported && apptResult.scheduled) message += ` ${plural(apptResult.scheduled, 'appointment reminder')} scheduled.`;
      if (pillResult.exactAlarm?.supported && pillResult.exactAlarm.granted === false) message += ' For reminders at the exact selected time, enable Alarms & reminders for Health Ledger in Android settings.';
      const diagnostic = $('#notification-diagnostic');
      if (diagnostic) diagnostic.textContent = message;
      await refreshNotificationStatus().catch(() => {});
      toast(pillResult.supported ? message : 'Browser preview mode: schedules saved, but native notifications are unavailable.');
    }
    return { pills: pillResult, appointments: apptResult };
  }

  function loadReminderTest() { const t = safeLoad(KEYS.reminderTest, null); return t && typeof t === 'object' ? t : null; }

  async function gatherReminderHealth() {
    const rows = [];
    if (!Notify.isNative()) {
      rows.push({ state: 'info', label: 'Browser preview', detail: 'Reminders only run in the installed Android app. Your schedules and records are still saved.' });
      return rows;
    }
    const permission = await Notify.plugin().checkPermissions().catch(() => ({ display: 'unknown' }));
    rows.push(permission.display === 'granted'
      ? { state: 'ok', label: 'Notification permission', detail: 'Allowed' }
      : { state: 'bad', label: 'Notification permission', detail: 'Not allowed. Reminders cannot appear until you allow notifications.' });

    const channelInfo = await Notify.listChannels();
    if (channelInfo.supported) {
      const channel = channelInfo.channels.find(c => c.id === 'pill-reminders');
      if (!channel) rows.push({ state: 'warn', label: 'Reminder channel', detail: 'Not created yet. Tap Resync reminders.' });
      else if (Number(channel.importance) >= 3) rows.push({ state: 'ok', label: 'Reminder channel', detail: 'Alerts are on' });
      else rows.push({ state: 'bad', label: 'Reminder channel', detail: 'Alerts are muted or silent in Android settings. Open Notification settings and turn sound/pop-up back on.' });
    }

    const exact = await Notify.checkExactAlarmPermission();
    if (exact.supported) rows.push(exact.granted ? { state: 'ok', label: 'Exact alarms', detail: 'Allowed' } : { state: 'warn', label: 'Exact alarms', detail: 'Not allowed. Reminders may arrive a few minutes late. Enable Alarms & reminders for Health Ledger.' });

    let summary = null;
    try { summary = await Notify.getPendingSummary(); } catch (error) { console.error(error); }
    if (summary && summary.supported) {
      const expectedPills = Notify.expectedPillReminderCount(pills);
      if (!expectedPills) rows.push({ state: 'info', label: 'Medication reminders', detail: 'No active scheduled medications.' });
      else rows.push(summary.pill >= expectedPills ? { state: 'ok', label: 'Medication reminders', detail: `${summary.pill} scheduled (${expectedPills} expected)` } : { state: 'warn', label: 'Medication reminders', detail: `${summary.pill} scheduled but ${expectedPills} expected. Tap Resync reminders.` });

      const expectedAppts = Notify.expectedAppointmentReminderCount(appointments);
      if (!expectedAppts && !summary.appointment) rows.push({ state: 'info', label: 'Appointment reminders', detail: 'None waiting.' });
      else rows.push(summary.appointment >= expectedAppts ? { state: 'ok', label: 'Appointment reminders', detail: `${summary.appointment} scheduled (${expectedAppts} expected)` } : { state: 'warn', label: 'Appointment reminders', detail: `${summary.appointment} scheduled but ${expectedAppts} expected. Tap Resync reminders.` });

      rows.push({ state: 'info', label: 'Snoozed reminders', detail: summary.snooze ? `${summary.snooze} waiting` : 'None waiting' });
    }
    rows.push({ state: 'info', label: 'Battery', detail: 'If reminders are delayed, set Health Ledger to “Unrestricted” in Android battery settings.' });

    const test = loadReminderTest();
    if (!test) rows.push({ state: 'info', label: 'Test reminder', detail: 'Not tried yet.' });
    else if (test.confirmedAt) rows.push({ state: 'ok', label: 'Test reminder', detail: `Delivered ${fmtStamp(test.confirmedAt)}` });
    else rows.push({ state: 'warn', label: 'Test reminder', detail: `Sent ${fmtStamp(test.sentAt)}, but not confirmed. Pull down your notifications and tap it.` });
    return rows;
  }

  function reminderHealthRowsHtml(rows) {
    return rows.map(row => `<div class="health-row ${esc(row.state)}"><span class="health-dot" aria-hidden="true"></span><div><strong>${esc(row.label)}</strong><small>${esc(row.detail)}</small></div></div>`).join('');
  }

  function openReminderHealth() {
    openModal(`
      <div class="modal-head"><h2 id="modal-title">Reminder health</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <p class="modal-intro">Check that Android will actually deliver your reminders.</p>
      <div id="reminder-health-rows" class="health-list" aria-live="polite"><p class="medication-information-note">Checking…</p></div>
      <label class="field"><span>Snooze length</span>
        <select id="snooze-minutes">${SNOOZE_CHOICES.map(m => `<option value="${m}" ${m === snoozeMinutes() ? 'selected' : ''}>${m} minutes</option>`).join('')}</select>
      </label>
      <p class="modal-note">The Snooze button on a reminder brings it back after this long. On Android the notification buttons open Health Ledger briefly to save your choice.</p>
      <div class="health-actions">
        <button type="button" class="primary-button" id="health-test">Send test reminder</button>
        <button type="button" class="secondary-button" id="health-resync">Resync reminders</button>
        <button type="button" class="secondary-button" id="health-refresh">Refresh</button>
      </div>
      <div class="modal-actions"><button type="button" class="secondary-button" id="health-back">Back to settings</button></div>`);
    const rowsEl = $('#reminder-health-rows');
    const stillOpen = () => rowsEl && rowsEl.isConnected;
    async function refresh() {
      try { const rows = await gatherReminderHealth(); if (stillOpen()) rowsEl.innerHTML = reminderHealthRowsHtml(rows); }
      catch (error) { console.error(error); if (stillOpen()) rowsEl.innerHTML = '<p class="medication-information-note">Could not check reminders.</p>'; }
    }
    refresh();
    $('#snooze-minutes').onchange = () => { settings.snoozeMinutes = Number($('#snooze-minutes').value); save(KEYS.settings, settings); toast(`Snooze set to ${snoozeMinutes()} minutes.`); };
    $('#health-refresh').onclick = refresh;
    $('#health-back').onclick = openSettingsModal;
    $('#health-resync').onclick = async () => { const b = $('#health-resync'); b.disabled = true; await syncNotifications(); b.disabled = false; refresh(); };
    $('#health-test').onclick = async () => {
      const b = $('#health-test');
      if (!Notify.isNative()) { toast('Test reminders work in the installed Android app.'); return; }
      b.disabled = true;
      const result = await Notify.sendTestReminder(5);
      b.disabled = false;
      if (result.sent) {
        save(KEYS.reminderTest, { sentAt: localISO(), confirmedAt: '' });
        toast('Test reminder sent. Leave the app and wait about 5 seconds.');
      } else if (result.reason === 'permission-denied') toast('Allow notifications first, then try again.');
      else toast(result.error ? 'Could not send the test reminder.' : 'Test reminders are unavailable here.');
      refresh();
    };
  }

  /* ---- Notification taps and action buttons ---- */

  function findDoseForNotification(pill, time, doseIdHint) {
    if (doseIdHint) { const direct = doses.find(d => d.id === doseIdHint); if (direct) return direct; }
    const nowDate = new Date();
    const [h, m] = String(time).split(':').map(Number);
    const todayAt = new Date(nowDate); todayAt.setHours(h || 0, m || 0, 0, 0);
    const yesterday = new Date(nowDate); yesterday.setDate(yesterday.getDate() - 1);
    // A reminder for a time later than "now + 5 min" must have fired yesterday.
    const order = todayAt.getTime() <= nowDate.getTime() + 5 * 60000 ? [nowDate, yesterday] : [yesterday, nowDate];
    for (const date of order) { const dose = ensureDoseRecord(pill, dateKey(date), time); if (dose) return dose; }
    return null;
  }

  async function handleDoseNotificationAction(extra, actionId) {
    const pill = pills.find(p => p.id === extra.pillId);
    if (!pill) { toast('That medication is no longer in your list.'); return; }
    const dose = findDoseForNotification(pill, extra.time, extra.doseId);
    if (!dose) { toast('Could not find that dose. Open Today to record it.'); return; }
    if (actionId !== 'snooze' && dose.status !== 'pending') {
      go('today'); renderToday();
      toast(`${pill.name} was already recorded as ${dose.status}.`);
      return;
    }
    if (actionId === 'taken') { Notify.cancelSnooze(pill, extra.time).catch(() => {}); go('today'); updateDose(dose.id, 'taken'); }
    else if (actionId === 'skip') { go('today'); updateDose(dose.id, 'skipped', {}); }
    else if (actionId === 'snooze') {
      if (dose.status !== 'pending') { toast(`${pill.name} was already recorded.`); return; }
      const minutes = snoozeMinutes();
      const result = await Notify.snoozeDose(pill, extra.time, dose.id, minutes);
      toast(result.scheduled ? `${pill.name} snoozed for ${minutes} minutes.` : 'Could not snooze this reminder. Check notification permission.');
    }
  }

  function showDoseFromNotification(extra) {
    const id = extra?.pillId;
    if (!id) return;
    highlightPillId = id;
    go('today');
    renderToday();
    setTimeout(() => {
      const name = pills.find(p => p.id === id)?.name || '\u0000';
      $$('.dose-card').find(el => el.textContent.includes(name))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 80);
    toast('Reminder opened. Review the dose and record it when appropriate.');
  }

  function markTestConfirmed() {
    const test = loadReminderTest() || { sentAt: localISO() };
    if (!test.confirmedAt) save(KEYS.reminderTest, { ...test, confirmedAt: localISO() });
  }

  function handleNotificationEvent(notification, actionId = 'tap') {
    const extra = notification?.extra || {};
    if (extra.type === 'test') { markTestConfirmed(); toast('Test reminder received. Reminders are working.'); return; }
    if (extra.type === 'appointment') { closeModal(); go('appointments'); renderAppointments(); toast('Appointment reminder opened.'); return; }
    if (extra.type === 'pill-dose' || extra.type === 'pill-snooze' || extra.pillId) {
      if (['taken', 'skip', 'snooze'].includes(actionId)) handleDoseNotificationAction(extra, actionId).catch(error => console.error(error));
      else showDoseFromNotification(extra);
    }
  }

  async function runStartupReminderMaintenance() {
    if (!Notify.isNative()) return;
    try {
      await Notify.init();
      // Older installs scheduled reminders without action buttons; rebuild them once.
      if (localStorage.getItem(KEYS.reminderSchema) !== REMINDER_SCHEMA) {
        const result = await Notify.syncPills(pills);
        if (result.supported && !result.errors?.length && result.permission?.granted) localStorage.setItem(KEYS.reminderSchema, REMINDER_SCHEMA);
      }
      await Notify.syncAppointments(appointments, { prompt: false });
    } catch (error) { console.error('Reminder maintenance failed:', error); }
  }

  /* ====================== Adherence ====================== */

  // Counts stored dose records plus doses that were scheduled but never recorded
  // (they count as missed once overdue). Paused medications and days before a
  // medication was added are not counted.
  function computeAdherence(days) {
    const nowMs = Date.now();
    const byId = new Map(doses.map(d => [d.id, d]));
    const perPill = new Map();
    const reasons = new Map();
    const strip = [];
    const totals = { taken: 0, skipped: 0, missed: 0, pending: 0 };
    const today = new Date(); today.setHours(12, 0, 0, 0);

    const entryFor = pill => { if (!perPill.has(pill.id)) perPill.set(pill.id, { pill, taken: 0, skipped: 0, missed: 0 }); return perPill.get(pill.id); };
    const count = (pill, status, dose, dayEntry) => {
      if (status === 'taken' || status === 'skipped' || status === 'missed') {
        totals[status] += 1; entryFor(pill)[status] += 1; dayEntry[status] += 1;
        if (status === 'skipped') { const reason = (dose && dose.skipReason) || 'No reason given'; reasons.set(reason, (reasons.get(reason) || 0) + 1); }
      } else totals.pending += 1;
    };

    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(today); date.setDate(today.getDate() - offset);
      const key = dateKey(date);
      const dayEntry = { key, date, taken: 0, skipped: 0, missed: 0 };
      const seen = new Set();

      for (const pill of pills) {
        const createdKey = pill.createdAt ? dateKey(new Date(pill.createdAt)) : '';
        for (const time of pill.times || []) {
          const id = doseId(pill.id, key, time);
          const stored = byId.get(id);
          if (stored) { seen.add(id); count(pill, doseStatus(stored), stored, dayEntry); continue; }
          if (!isScheduled(pill, date)) continue;
          if (createdKey && key < createdKey) continue;
          const at = parseLocal(`${key}T${time}:00`);
          count(pill, at.getTime() < nowMs - 60000 ? 'missed' : 'pending', null, dayEntry);
        }
      }
      // Stored records whose time slot was later edited out of the schedule.
      for (const dose of doses) {
        if (String(dose.scheduledAt).slice(0, 10) !== key || seen.has(dose.id)) continue;
        const pill = pills.find(p => p.id === dose.pillId);
        if (!pill || (pill.times || []).includes(doseTimeOf(dose))) continue;
        if (dose.status === 'taken' || dose.status === 'skipped') count(pill, dose.status, dose, dayEntry);
      }
      strip.push(dayEntry);
    }

    const counted = totals.taken + totals.skipped + totals.missed;
    const percent = counted ? Math.round(totals.taken / counted * 100) : null;
    const meds = [...perPill.values()].filter(e => e.taken + e.skipped + e.missed > 0).sort((a, b) => a.pill.name.localeCompare(b.pill.name));
    return { days, totals, counted, percent, meds, reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]), strip };
  }

  function openAdherence(days = 7) {
    const data = computeAdherence(days);
    const t = data.totals;
    const pctText = data.percent === null ? '—' : `${data.percent}%`;
    const medRows = data.meds.map(e => {
      const total = e.taken + e.skipped + e.missed;
      const pct = Math.round(e.taken / total * 100);
      return `<div class="adherence-med" style="--pill-color:${esc(e.pill.color || COLORS[0])}"><div class="adherence-med-head"><strong>${esc(e.pill.name)}</strong><span>${pct}%</span></div><div class="adherence-bar" role="img" aria-label="${esc(e.pill.name)}: ${e.taken} taken, ${e.skipped} skipped, ${e.missed} missed"><i class="taken" style="width:${e.taken / total * 100}%"></i><i class="skipped" style="width:${e.skipped / total * 100}%"></i><i class="missed" style="width:${e.missed / total * 100}%"></i></div><small>${e.taken} taken · ${e.skipped} skipped · ${e.missed} missed</small></div>`;
    }).join('');
    const dayCells = data.strip.map(d => {
      const total = d.taken + d.skipped + d.missed;
      const level = !total ? 'none' : d.taken === total ? 'full' : d.taken === 0 ? 'zero' : 'part';
      const label = `${fmtDate(d.date, { weekday: 'short', month: 'short', day: 'numeric' })}: ${total ? `${d.taken} of ${total} taken` : 'no doses'}`;
      return `<span class="adherence-day ${level}" title="${esc(label)}" role="img" aria-label="${esc(label)}">${days <= 7 ? esc(fmtDate(d.date, { weekday: 'narrow' })) : ''}</span>`;
    }).join('');

    openModal(`
      <div class="modal-head"><h2 id="modal-title">Adherence</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <div class="segmented" role="group" aria-label="Time range">
        <button type="button" data-range="7" class="${days === 7 ? 'active' : ''}" aria-pressed="${days === 7}">7 days</button>
        <button type="button" data-range="30" class="${days === 30 ? 'active' : ''}" aria-pressed="${days === 30}">30 days</button>
      </div>
      <div class="adherence-summary">
        <div class="adherence-ring" style="--pct:${data.percent ?? 0}"><strong>${pctText}</strong><span>taken</span></div>
        <div class="adherence-stats">
          <div><strong>${t.taken}</strong><span>Taken</span></div><div><strong>${t.skipped}</strong><span>Skipped</span></div>
          <div><strong>${t.missed}</strong><span>Missed</span></div><div><strong>${t.pending}</strong><span>Still due</span></div>
        </div>
      </div>
      ${data.counted ? `<div class="adherence-strip ${days > 7 ? 'dense' : ''}" aria-label="Daily adherence">${dayCells}</div>` : ''}
      ${data.meds.length ? `<h3 class="adherence-heading">By medication</h3>${medRows}` : '<p class="medication-information-note">No scheduled doses in this period yet. Add a medication and its schedule to see adherence here.</p>'}
      ${data.reasons.length ? `<h3 class="adherence-heading">Skip reasons</h3><ul class="adherence-reasons">${data.reasons.map(([r, n]) => `<li><span>${esc(r)}</span><b>${n}</b></li>`).join('')}</ul>` : ''}
      <p class="medication-information-note">Percent taken = taken ÷ (taken + skipped + missed). Doses you never recorded count as missed once they are overdue, and paused medications are left out. This is a personal log, not medical advice — share it with your care team if useful.</p>
      <div class="modal-actions"><button type="button" class="secondary-button" data-close>Close</button></div>`);
    $('#modal-root').querySelectorAll('[data-range]').forEach(b => b.onclick = () => openAdherence(Number(b.dataset.range)));
  }

  /* ====================== Backups ====================== */

  const BACKUP_VERSION = '1.1.0';
  function countsOf(source) { return { pills: source.pills.length, doses: source.doses.length, glucose: source.glucose.length, appointments: source.appointments.length }; }

  function buildBackup() {
    return {
      app: 'Health Ledger', version: BACKUP_VERSION, schema: 2, exportedAt: new Date().toISOString(),
      pills, doses, glucose, appointments, settings, theme: localStorage.getItem(KEYS.theme) || 'system',
    };
  }

  function recordBackup(fileName) {
    save(KEYS.lastBackup, { at: new Date().toISOString(), fileName, counts: countsOf({ pills, doses, glucose, appointments }) });
    refreshBackupStatus();
  }

  function refreshBackupStatus() {
    const el = $('#backup-status');
    if (!el) return;
    const last = safeLoad(KEYS.lastBackup, null);
    const hasData = pills.length || glucose.length || appointments.length || doses.length;
    el.classList.remove('warn');
    if (!last || !last.at) {
      el.textContent = hasData ? 'No backup yet. Export one so your records are safe if you lose this phone.' : 'No backup yet.';
      if (hasData) el.classList.add('warn');
      return;
    }
    const when = new Date(last.at);
    const ageDays = Math.floor((Date.now() - when.getTime()) / 86400000);
    const c = last.counts || {};
    el.textContent = `Last backup: ${fmtStamp(last.at)}${ageDays >= 1 ? ` (${plural(ageDays, 'day')} ago)` : ' (today)'}${c.pills != null ? ` · ${plural(c.pills, 'medication')}, ${plural(c.glucose || 0, 'reading')}` : ''}.${ageDays > 30 ? ' It has been over 30 days — consider exporting a new one.' : ''}`;
    if (ageDays > 30) el.classList.add('warn');
  }

  function refreshUndoRestore() {
    const button = $('#undo-restore');
    if (!button) return;
    const snapshot = safeLoad(KEYS.preRestore, null);
    button.hidden = !snapshot;
    const small = button.querySelector('small');
    if (snapshot && small) small.textContent = `Go back to the data you had before the restore on ${fmtStamp(snapshot.savedAt)}`;
  }

  async function exportData() {
    const data = buildBackup();
    const fileName = `health-ledger-backup-${dateKey()}.json`;
    const contents = JSON.stringify(data, null, 2);
    const cap = window.Capacitor;
    const Filesystem = cap?.Plugins?.Filesystem;
    const isNative = typeof cap?.isNativePlatform === 'function' ? cap.isNativePlatform() : ['android', 'ios'].includes(cap?.getPlatform?.());

    if (!isNative) {
      const blob = new Blob([contents], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = fileName; link.style.display = 'none';
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      recordBackup(fileName);
      toast('Backup download started.');
      return;
    }
    if (!Filesystem) { toast('Filesystem plugin is unavailable. Sync Android and rebuild the app.'); return; }
    const DownloadsExport = window.Capacitor?.registerPlugin ? window.Capacitor.registerPlugin('DownloadsExport') : window.Capacitor?.Plugins?.DownloadsExport;
    if (!DownloadsExport) { toast('Downloads export unavailable. Sync Android and rebuild the app.'); return; }
    try {
      await DownloadsExport.saveJson({ filename: fileName, contents });
      recordBackup(fileName);
      toast('Backup saved to Downloads/Health Ledger.');
    } catch (error) {
      console.error('Health Ledger Downloads export failed:', error);
      toast('Could not save backup: ' + (error?.message || JSON.stringify(error) || 'unknown error'));
    }
  }

  const validDate = value => typeof value === 'string' && Number.isFinite(parseLocal(value).getTime());

  // Validates a backup file and returns cleaned data plus what was dropped.
  function parseBackup(text) {
    let raw;
    try { raw = JSON.parse(text); } catch (_) { return { error: 'That file is not valid JSON, so it cannot be a Health Ledger backup.' }; }
    if (!raw || raw.app !== 'Health Ledger' || !Array.isArray(raw.pills) || !Array.isArray(raw.doses) || !Array.isArray(raw.glucose)) return { error: 'This file is not a Health Ledger backup.' };

    const dropped = { pills: 0, doses: 0, glucose: 0, appointments: 0 };
    const dedupe = (list, ok, kind) => {
      const seen = new Set(), out = [];
      for (const item of list) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !item.id || seen.has(item.id) || !ok(item)) { dropped[kind] += 1; continue; }
        seen.add(item.id); out.push(item);
      }
      return out;
    };
    const cleanPills = dedupe(raw.pills, p => typeof p.name === 'string' && p.name.trim() && Array.isArray(p.times || []), 'pills');
    const pillIds = new Set(cleanPills.map(p => p.id));
    let cleanDoses = dedupe(raw.doses, d => typeof d.pillId === 'string' && validDate(d.scheduledAt) && ['pending', 'taken', 'skipped'].includes(d.status), 'doses');
    const before = cleanDoses.length;
    cleanDoses = cleanDoses.filter(d => pillIds.has(d.pillId));
    dropped.doses += before - cleanDoses.length;
    const cleanGlucose = dedupe(raw.glucose, g => Number.isFinite(Number(g.value)) && Number(g.value) > 0 && validDate(g.at) && (g.unit === 'mg/dL' || g.unit === 'mmol/L'), 'glucose').map(g => ({ ...g, value: Number(g.value) }));
    const hasAppointments = Array.isArray(raw.appointments);
    const cleanAppointments = hasAppointments ? dedupe(raw.appointments, a => typeof a.title === 'string' && a.title.trim() && validDate(a.at), 'appointments') : [];

    const rawSettings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    const merged = { ...defaultSettings() };
    if (Number.isFinite(Number(rawSettings.targetLow)) && Number(rawSettings.targetLow) > 0) merged.targetLow = Number(rawSettings.targetLow);
    if (Number.isFinite(Number(rawSettings.targetHigh)) && Number(rawSettings.targetHigh) > 0) merged.targetHigh = Number(rawSettings.targetHigh);
    if (['mg/dL', 'mmol/L'].includes(rawSettings.glucoseUnit)) merged.glucoseUnit = rawSettings.glucoseUnit;
    if (SNOOZE_CHOICES.includes(Number(rawSettings.snoozeMinutes))) merged.snoozeMinutes = Number(rawSettings.snoozeMinutes);

    return {
      data: { pills: cleanPills, doses: cleanDoses, glucose: cleanGlucose, appointments: cleanAppointments, hasAppointments, settings: merged, theme: ['system', 'light', 'dark', 'osrs'].includes(raw.theme) ? raw.theme : null },
      info: { exportedAt: validDate(raw.exportedAt) || !Number.isNaN(Date.parse(raw.exportedAt)) ? raw.exportedAt : '', version: raw.version || 'unknown', dropped },
    };
  }

  function rangeText(values) {
    const stamps = values.map(v => parseLocal(v).getTime()).filter(Number.isFinite);
    if (!stamps.length) return '—';
    const f = ms => fmtDate(new Date(ms), { month: 'short', day: 'numeric', year: 'numeric' });
    const lo = Math.min(...stamps), hi = Math.max(...stamps);
    return lo === hi ? f(lo) : `${f(lo)} – ${f(hi)}`;
  }

  function openImportPreview(parsed, fileName) {
    const { data, info } = parsed;
    const current = countsOf({ pills, doses, glucose, appointments });
    const incoming = countsOf(data);
    const droppedTotal = Object.values(info.dropped).reduce((a, b) => a + b, 0);
    const warnings = [];
    if (droppedTotal) warnings.push(`${plural(droppedTotal, 'invalid or duplicate record')} will be skipped.`);
    if (!data.hasAppointments) warnings.push('This backup has no appointments (it was made by an older version). Your current appointments will be kept.');
    if (current.pills + current.glucose + current.appointments + current.doses > 0) warnings.push('Restoring replaces the data currently on this device. You can undo it afterwards from Settings.');
    const row = (label, a, b) => `<tr><th scope="row">${esc(label)}</th><td>${a}</td><td>${b}</td></tr>`;

    openModal(`
      <div class="modal-head"><h2 id="modal-title">Restore preview</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <p class="modal-intro">${esc(fileName || 'Backup file')}${info.exportedAt ? ` · saved ${esc(fmtStamp(info.exportedAt))}` : ''}</p>
      <table class="import-table"><thead><tr><th></th><th>In backup</th><th>On this device</th></tr></thead><tbody>
        ${row('Medications', incoming.pills, current.pills)}${row('Dose records', incoming.doses, current.doses)}${row('Glucose readings', incoming.glucose, current.glucose)}
        ${row('Appointments', data.hasAppointments ? incoming.appointments : 'not included', current.appointments)}
      </tbody></table>
      <p class="import-range"><span>Dose records:</span> ${esc(rangeText(data.doses.map(d => d.scheduledAt)))}<br><span>Glucose readings:</span> ${esc(rangeText(data.glucose.map(g => g.at)))}</p>
      ${warnings.length ? `<ul class="import-warnings">${warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
      <div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button type="button" class="primary-button" id="confirm-restore">Restore backup</button></div>`);
    $('#confirm-restore').onclick = () => restoreBackup(parsed);
  }

  function snapshotCurrent() {
    return { savedAt: new Date().toISOString(), pills, doses, glucose, appointments, settings, theme: localStorage.getItem(KEYS.theme) || 'system' };
  }

  async function replaceAllData(next) {
    const oldPills = pills, oldAppointments = appointments;
    await Promise.all([...oldPills.map(p => Notify.cancelPill(p).catch(() => {})), ...oldAppointments.map(a => Notify.cancelAppointment(a).catch(() => {}))]);
    pills = next.pills; doses = next.doses; glucose = next.glucose; appointments = next.appointments; settings = { ...defaultSettings(), ...next.settings };
    save(KEYS.pills, pills); save(KEYS.doses, doses); save(KEYS.glucose, glucose); save(KEYS.appointments, appointments); save(KEYS.settings, settings);
    if (next.theme) applyTheme(next.theme);
    $('#display-unit').value = settings.glucoseUnit || 'mg/dL';
    ensureDoseRecords();
    const sync = await syncNotifications({ quiet: true });
    render();
    refreshBackupStatus();
    return sync;
  }

  async function restoreBackup(parsed) {
    const { data, info } = parsed;
    const before = countsOf({ pills, doses, glucose, appointments });
    let undoSaved = true;
    try { localStorage.setItem(KEYS.preRestore, JSON.stringify(snapshotCurrent())); } catch (_) { undoSaved = false; }
    const next = { ...data, appointments: data.hasAppointments ? data.appointments : appointments, theme: data.theme };
    closeModal();
    const sync = await replaceAllData(next);
    const after = countsOf(next);
    const droppedTotal = Object.values(info.dropped).reduce((a, b) => a + b, 0);
    const pillRem = sync.pills.supported ? plural(sync.pills.scheduled || 0, 'repeating medication reminder') : null;
    const apptRem = sync.appointments.supported ? plural(sync.appointments.scheduled || 0, 'appointment reminder') : null;

    openModal(`
      <div class="modal-head"><h2 id="modal-title">Backup restored</h2><button class="close-modal" data-close aria-label="Close">×</button></div>
      <table class="import-table"><thead><tr><th></th><th>Restored</th><th>Before</th></tr></thead><tbody>
        <tr><th scope="row">Medications</th><td>${after.pills}</td><td>${before.pills}</td></tr>
        <tr><th scope="row">Dose records</th><td>${after.doses}</td><td>${before.doses}</td></tr>
        <tr><th scope="row">Glucose readings</th><td>${after.glucose}</td><td>${before.glucose}</td></tr>
        <tr><th scope="row">Appointments</th><td>${after.appointments}${data.hasAppointments ? '' : ' (kept)'}</td><td>${before.appointments}</td></tr>
      </tbody></table>
      <ul class="import-warnings">
        ${droppedTotal ? `<li>${plural(droppedTotal, 'invalid or duplicate record')} skipped.</li>` : ''}
        <li>${pillRem ? `${esc(pillRem)} and ${esc(apptRem)} scheduled.` : 'Reminders will be scheduled when you open the Android app.'}</li>
        ${undoSaved ? '<li>You can undo this restore from Settings → Data &amp; privacy.</li>' : '<li>Undo is unavailable because there was not enough storage space.</li>'}
      </ul>
      <div class="modal-actions">${undoSaved ? '<button type="button" class="secondary-button" id="undo-restore-now">Undo restore</button>' : ''}<button type="button" class="primary-button" data-close>Done</button></div>`);
    const undo = $('#undo-restore-now');
    if (undo) undo.onclick = () => { closeModal(); undoRestore(); };
  }

  function undoRestore() {
    const snapshot = safeLoad(KEYS.preRestore, null);
    if (!snapshot) { toast('Nothing to undo.'); return; }
    confirmAction('Undo last restore?', `This puts back the data you had on ${fmtStamp(snapshot.savedAt)}, before the backup was restored.`, async () => {
      await replaceAllData({ pills: snapshot.pills || [], doses: snapshot.doses || [], glucose: snapshot.glucose || [], appointments: snapshot.appointments || [], settings: snapshot.settings || {}, theme: snapshot.theme });
      localStorage.removeItem(KEYS.preRestore);
      refreshUndoRestore();
      toast('Restore undone.');
    }, false);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onerror = () => toast('Could not read that file.');
    reader.onload = () => {
      const parsed = parseBackup(String(reader.result));
      if (parsed.error) { toast(parsed.error); return; }
      openImportPreview(parsed, file.name);
    };
    reader.readAsText(file);
  }

  /* ====================== Demo, clear, history ====================== */

  function loadDemo() {
    confirmAction('Load demo data?', 'Sample medications and glucose readings will be added alongside your existing records.', () => {
      const today = new Date();
      const mkDate = (offset, hour, minute) => { const d = new Date(today); d.setDate(d.getDate() - offset); d.setHours(hour, minute, 0, 0); return localISO(d); };
      const base = { days: [], startDate: dateKey(), endDate: '', active: true, quantity: '', createdAt: new Date().toISOString() };
      const demo = [
        { ...base, id: uid('pill'), name: 'Metformin', dosage: '500 mg', form: 'Tablet', color: COLORS[0], times: ['08:00', '20:00'], schedule: 'daily', notes: 'Take with food' },
        { ...base, id: uid('pill'), name: 'Vitamin D3', dosage: '2,000 IU', form: 'Capsule', color: COLORS[1], times: ['08:00'], schedule: 'daily', notes: '' },
        { ...base, id: uid('pill'), name: 'Lisinopril', dosage: '10 mg', form: 'Tablet', color: COLORS[2], times: ['20:00'], schedule: 'weekdays', notes: '' },
      ];
      pills.push(...demo);
      const mk = (value, context, at) => ({ id: uid('glucose'), value, unit: 'mg/dL', context, at, notes: '', createdAt: new Date().toISOString() });
      glucose.push(mk(102, 'Fasting', mkDate(0, 7, 42)), mk(118, 'After meal', mkDate(1, 13, 5)), mk(96, 'Fasting', mkDate(3, 7, 30)), mk(109, 'Before meal', mkDate(5, 11, 50)));
      save(KEYS.pills, pills); save(KEYS.glucose, glucose); ensureDoseRecords();
      syncNotifications({ quiet: true }); render(); toast('Demo records added.');
    }, false);
  }

  function clearAll() {
    confirmAction('Clear all Health Ledger data?', 'This permanently removes medications, dose history, glucose readings, appointments and preferences stored by this app. Export a backup first if you may need it.', async () => {
      const oldPills = pills, oldAppointments = appointments;
      await Promise.all([...oldPills.map(p => Notify.cancelPill(p).catch(() => {})), ...oldAppointments.map(a => Notify.cancelAppointment(a).catch(() => {}))]);
      pills = []; doses = []; glucose = []; appointments = []; settings = defaultSettings();
      [KEYS.pills, KEYS.doses, KEYS.glucose, KEYS.settings, KEYS.onboarding, KEYS.appointments, KEYS.preRestore, KEYS.reminderTest, KEYS.lastBackup].forEach(k => localStorage.removeItem(k));
      save(KEYS.settings, settings);
      refreshBackupStatus(); refreshUndoRestore(); render(); toast('Local records cleared.');
    });
  }

  function openHistoryCalendar() {
    const today = new Date(); const todayKey = dateKey(today); const dates = [];
    for (let offset = 29; offset >= 0; offset -= 1) { const date = new Date(today); date.setHours(12, 0, 0, 0); date.setDate(today.getDate() - offset); dates.push(date); }
    const pillIds = new Set(pills.map(pill => pill.id)); const doseCounts = new Map(); const glucoseCounts = new Map();
    for (const dose of doses) { if (!pillIds.has(dose.pillId)) continue; const key = String(dose.scheduledAt).slice(0, 10); doseCounts.set(key, (doseCounts.get(key) || 0) + 1); }
    for (const reading of glucose) { const key = String(reading.at).slice(0, 10); glucoseCounts.set(key, (glucoseCounts.get(key) || 0) + 1); }
    const rangeLabel = `${fmtDate(dates[0], { month: 'short', day: 'numeric' })} – ${fmtDate(dates[dates.length - 1], { month: 'short', day: 'numeric', year: 'numeric' })}`;
    let previousMonth = '';
    const dateButtons = dates.map(date => {
      const key = dateKey(date), monthKey = key.slice(0, 7), isToday = key === todayKey;
      const doseCount = doseCounts.get(key) || 0, glucoseCount = glucoseCounts.get(key) || 0;
      const description = [fmtDate(date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }), isToday ? 'Today' : '', `${doseCount} dose record${doseCount === 1 ? '' : 's'}`, `${glucoseCount} glucose reading${glucoseCount === 1 ? '' : 's'}`].filter(Boolean).join('. ');
      let monthMarker = '';
      if (monthKey !== previousMonth) { monthMarker = `<p class="history-month-marker">${esc(fmtDate(date, { month: 'long', year: 'numeric' }))}</p>`; previousMonth = monthKey; }
      return `${monthMarker}<button type="button" class="history-day${isToday ? ' today' : ''}" data-history-date="${esc(key)}" aria-label="${esc(description)}" ${isToday ? 'aria-current="date"' : ''}><span class="history-day-weekday">${esc(fmtDate(date, { weekday: 'short' }))}</span><strong>${date.getDate()}</strong><span class="history-day-dots" aria-hidden="true"><span class="history-dot-slot">${doseCount ? '<span class="history-dot dose"></span>' : ''}</span><span class="history-dot-slot">${glucoseCount ? '<span class="history-dot glucose"></span>' : ''}</span></span></button>`;
    }).join('');
    openModal(`
      <div class="modal-head"><div><h2 id="modal-title">Medication history</h2><p class="modal-intro">Last 30 days · ${esc(rangeLabel)}</p></div><button class="close-modal" data-close aria-label="Close">×</button></div>
      <div class="history-calendar-legend"><span><span class="history-dot dose" aria-hidden="true"></span> Dose records</span><span><span class="history-dot glucose" aria-hidden="true"></span> Glucose readings</span></div>
      <div class="history-calendar" aria-label="Dose and glucose history for the last 30 days">${dateButtons}</div>
      <p class="history-calendar-note">Dots show stored records, not whether every dose was taken. Tap a date to view details, or open Adherence for 7- and 30-day summaries.</p>`);
    $('#modal-root').querySelectorAll('[data-history-date]').forEach(button => { button.onclick = () => openHistoryDay(button.dataset.historyDate); });
  }

  function openHistoryDay(key) {
    const selectedDate = parseLocal(`${key}T12:00:00`);
    const selectedDateLabel = fmtDate(selectedDate, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const dayDoses = doses.filter(dose => String(dose.scheduledAt).slice(0, 10) === key).map(dose => ({ ...dose, pill: pills.find(pill => pill.id === dose.pillId) })).filter(dose => dose.pill).sort((a, b) => getDoseTime(a) - getDoseTime(b));
    const dayGlucose = glucose.filter(reading => String(reading.at).slice(0, 10) === key).sort((a, b) => parseLocal(b.at) - parseLocal(a.at));

    const medicationContent = dayDoses.length ? `<div class="history-detail-list">${dayDoses.map(dose => {
      const status = doseStatus(dose);
      const scheduledTime = fmtTime(doseTimeOf(dose));
      const takenTime = dose.takenAt ? fmtTime(String(dose.takenAt).slice(11, 16)) : '';
      const statusDetail = status === 'taken' && takenTime ? `Taken at ${takenTime}` : status === 'skipped' ? 'Skipped' : status === 'missed' ? 'Missed' : status === 'due' ? 'Due now' : 'Not yet taken';
      const extra = doseDetailLine(dose);
      return `<article class="history-detail-item" style="--history-pill-color:${esc(dose.pill.color || COLORS[0])}"><div class="history-detail-marker history-pill-marker ${esc(status)}" aria-hidden="true"></div><div class="history-detail-copy"><strong>${esc(dose.pill.name)}</strong><span>${esc([scheduledTime, dose.pill.dosage || dose.pill.form || 'Medication'].filter(Boolean).join(' · '))}</span>${extra ? `<span class="history-dose-note">${esc(extra)}</span>` : ''}</div><div class="history-detail-status ${esc(status)}"><strong>${esc(doseLabel(status))}</strong><span>${esc(statusDetail)}</span></div></article>`;
    }).join('')}</div>` : '<div class="history-empty"><span aria-hidden="true">◷</span><p>No medication doses were recorded for this day.</p></div>';

    const glucoseUnit = $('#display-unit')?.value || settings.glucoseUnit || 'mg/dL';
    const glucoseContent = dayGlucose.length ? `<div class="history-detail-list">${dayGlucose.map(reading => {
      const value = displayReading(reading, glucoseUnit);
      const valueText = glucoseUnit === 'mmol/L' ? value.toFixed(1) : Math.round(value);
      return `<article class="history-detail-item glucose"><div class="history-detail-marker glucose" aria-hidden="true"></div><div class="history-detail-copy"><strong>${esc(`${valueText} ${glucoseUnit}`)}</strong><span>${esc([fmtTime(String(reading.at).slice(11, 16)), reading.context || 'Other'].join(' · '))}</span></div><div class="history-detail-status glucose"><strong>${esc(readingStatus(value, glucoseUnit))}</strong>${reading.notes ? `<span>${esc(reading.notes)}</span>` : '<span>Glucose reading</span>'}</div></article>`;
    }).join('')}</div>` : '<div class="history-empty"><span aria-hidden="true">⌁</span><p>No glucose readings were recorded for this day.</p></div>';

    openModal(`
      <div class="modal-head"><div><h2 id="modal-title">${esc(selectedDateLabel)}</h2><p class="modal-intro">Your recorded health history for this day.</p></div><button class="close-modal" data-close aria-label="Close">×</button></div>
      <section class="history-detail-section" aria-labelledby="history-medications-title"><div class="history-detail-heading"><h3 id="history-medications-title">Medication history</h3><span>${dayDoses.length}</span></div>${medicationContent}</section>
      <section class="history-detail-section" aria-labelledby="history-glucose-title"><div class="history-detail-heading"><h3 id="history-glucose-title">Glucose readings</h3><span>${dayGlucose.length}</span></div>${glucoseContent}</section>
      <div class="modal-actions history-modal-actions"><button type="button" class="secondary-button" id="history-back-to-calendar">Back to 30-day history</button></div>`);
    $('#history-back-to-calendar').onclick = openHistoryCalendar;
  }

  /* ====================== Rendering & wiring ====================== */

  function render() {
    ensureDoseRecords();
    if (currentPage === 'today') renderToday();
    if (currentPage === 'pills') renderPills();
    if (currentPage === 'glucose') renderGlucose();
    if (currentPage === 'appointments') renderAppointments();
    if (currentPage === 'more') refreshNotificationStatus();
  }

  $$('.nav-item').forEach(b => b.onclick = () => go(b.dataset.nav));
  $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
  $('#header-settings').onclick = openSettingsModal;
  $('#quick-history').onclick = openHistoryCalendar;
  const adherenceButton = $('#quick-adherence'); if (adherenceButton) adherenceButton.onclick = () => openAdherence(7);
  $('#add-pill').onclick = () => openPillModal();
  $('#pill-filter').onchange = renderPills;
  $('#pill-search').oninput = renderPills;
  $('#display-unit').onchange = () => { settings.glucoseUnit = $('#display-unit').value; save(KEYS.settings, settings); renderGlucose(); };
  $('#trend-range').onchange = renderGlucose;
  $('#theme-select').onchange = () => applyTheme($('#theme-select').value);
  $('#export-data').onclick = exportData;
  $('#import-file').onchange = e => { if (e.target.files?.[0]) importData(e.target.files[0]); e.target.value = ''; };
  $('#load-demo').onclick = loadDemo;
  $('#clear-data').onclick = clearAll;
  $('#resync-notifications').onclick = () => syncNotifications();
  const healthButton = $('#open-reminder-health'); if (healthButton) healthButton.onclick = openReminderHealth;
  const undoButton = $('#undo-restore'); if (undoButton) undoButton.onclick = undoRestore;
  $('#open-exact-settings').onclick = async () => {
    const result = await Notify.openExactAlarmSettings();
    toast(result.opened ? 'Check the Alarms & reminders setting for Health Ledger.' : 'Open Android Settings → Apps → Health Ledger → Alarms & reminders.');
  };
  $('#open-notification-settings').onclick = async () => {
    if (!Notify.isNative()) { toast('Native notification settings are available in the Android app.'); return; }
    const p = Notify.plugin();
    if (p.openNotificationSettings) await p.openNotificationSettings(); else toast('Open Android Settings → Apps → Health Ledger → Notifications.');
  };

  applyTheme(safeLoad(KEYS.theme, 'system'), false);
  $('#display-unit').value = settings.glucoseUnit || 'mg/dL';
  $('#glucose-time').value = localISO().slice(0, 16);
  $('#glucose-unit').value = settings.glucoseUnit || 'mg/dL';

  const initial = (location.hash || '#today').slice(1);
  const initialPage = ['today', 'pills', 'glucose'].includes(initial) ? initial : 'today';
  currentPage = initialPage;
  pageHistory = initialPage === 'today' ? ['today'] : ['today', initialPage];
  $$('.page').forEach(el => el.classList.toggle('active', el.dataset.page === currentPage));
  $$('.nav-item').forEach(button => {
    const isActive = button.dataset.nav === currentPage;
    button.classList.toggle('active', isActive);
    if (isActive) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  render();
  refreshBackupStatus();

  Notify.registerActionListener((notification, actionId) => handleNotificationEvent(notification, actionId));
  Notify.registerReceivedListener(notification => { if (notification?.extra?.type === 'test') { markTestConfirmed(); toast('Test reminder received. Reminders are working.'); } });
  runStartupReminderMaintenance();
  window.addEventListener('focus', () => { ensureDoseRecords(); renderToday(); });

  function installAndroidBackHandler() {
    const App = window.Capacitor?.Plugins?.App;
    if (!App?.addListener) return;
    App.addListener('backButton', async () => {
      if (document.querySelector('#modal-root .modal-backdrop')) { closeModal(); return; }
      if (currentPage === 'appointments') { returnFromAppointments(); return; }
      if (pageHistory.length > 1) { pageHistory.pop(); go(pageHistory[pageHistory.length - 1], { fromBack: true }); return; }
      const pressedAt = Date.now();
      if (pressedAt - lastBackPressAt < 2000) { await App.exitApp(); return; }
      lastBackPressAt = pressedAt;
      toast('Press Back again to exit Health Ledger.');
    });
  }

  $('#add-appointment').onclick = () => openAppointmentModal();
  $('#appointments-back').onclick = returnFromAppointments;
  installAndroidBackHandler();
})();
