/* Health Ledger — offline-first medication and glucose organizer. */
(() => {
  'use strict';
  const KEYS = { pills: 'healthLedger.pills', doses: 'healthLedger.doses', glucose: 'healthLedger.glucose', settings: 'healthLedger.settings', theme: 'healthLedger.theme', onboarding: 'healthLedger.onboarding' };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const COLORS = ['#4B9B76', '#5B83C8', '#C28B46', '#9875C5', '#D16F72', '#4E9DA7', '#7F8B8A'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const FORMS = ['Tablet', 'Capsule', 'Liquid', 'Injection', 'Powder', 'Other'];
  const SCHEDULES = [{ value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }, { value: 'custom', label: 'Custom days' }, { value: 'asNeeded', label: 'As needed' }];
  const now = new Date();
  let pills = safeLoad(KEYS.pills, []), doses = safeLoad(KEYS.doses, []), glucose = safeLoad(KEYS.glucose, []), settings = safeLoad(KEYS.settings, { targetLow: 70, targetHigh: 180, glucoseUnit: 'mg/dL' });
  let currentPage = 'today',
    pageHistory = ['today'],
    toastTimer,
    editingGlucoseId = null,
    highlightPillId = null,
    lastBackPressAt = 0;

    const APPOINTMENT_KEY = 'healthLedger.appointments';

let appointments = safeLoad(APPOINTMENT_KEY, []);
if (!Array.isArray(appointments)) appointments = [];

function saveAppointments(nextAppointments) {
  try {
    localStorage.setItem(
      APPOINTMENT_KEY,
      JSON.stringify(nextAppointments)
    );
  } catch (error) {
    console.error('Appointment save failed:', error);
    toast('Could not save appointments. Check device storage.');
    return false;
  }

  appointments = nextAppointments;
  return true;
}

function renderAppointments() {
  const list = $('#appointment-list');
  if (!list) return;

  const sorted = [...appointments]
    .filter(item => {
      return (
        item &&
        typeof item.id === 'string' &&
        Number.isFinite(parseLocal(item.at).getTime())
      );
    })
    .sort((a, b) => parseLocal(a.at) - parseLocal(b.at));

  if (!sorted.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">📅</div>
        <h3>No appointments yet</h3>
        <p>Add a visit or checkup to keep its details together.</p>

        <button
          type="button"
          class="primary-button"
          id="empty-add-appointment"
        >
          Add appointment
        </button>
      </div>
    `;

    $('#empty-add-appointment').onclick = () => {
      openAppointmentModal();
    };

    return;
  }

  const now = Date.now();

  const finishedStatuses = new Set([
    'completed',
    'missed',
    'canceled',
  ]);

  const upcoming = sorted.filter(item => {
    return (
      !finishedStatuses.has(item.status) &&
      parseLocal(item.at).getTime() >= now
    );
  });

  const history = sorted
    .filter(item => {
      return (
        finishedStatuses.has(item.status) ||
        parseLocal(item.at).getTime() < now
      );
    })
    .reverse();

  function card(item) {
    const date = parseLocal(item.at);

    const status = finishedStatuses.has(item.status)
      ? item.status
      : date.getTime() < now
        ? 'needs-review'
        : 'scheduled';

    const labels = {
      scheduled: 'Scheduled',
      'needs-review': 'Needs review',
      completed: 'Completed',
      missed: 'Missed',
      canceled: 'Canceled',
    };

    const details = [
      item.provider,
      item.type,
      item.visitFormat,
    ].filter(Boolean).join(' · ');

    return `
      <article class="appointment-card card">
        <div class="appointment-date-badge" aria-hidden="true">
          <span class="appointment-date-month">
            ${esc(fmtDate(date, { month: 'short' }))}
          </span>

          <strong>${date.getDate()}</strong>

          <span class="appointment-date-weekday">
            ${esc(fmtDate(date, { weekday: 'short' }))}
          </span>
        </div>

        <div class="appointment-card-content">
          <h2>${esc(item.title)}</h2>

          <p class="appointment-time">
            <span class="appointment-date-accessible">
              ${esc(fmtDate(date, {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              }))}
              at
            </span>

            ${esc(fmtTime(String(item.at).slice(11, 16)))}
          </p>

          ${details ? `
            <p class="appointment-detail">${esc(details)}</p>
          ` : ''}

          ${item.location ? `
            <p class="appointment-detail">
              ${esc(item.location)}
            </p>
          ` : ''}

          <span class="appointment-state ${status}">
            ${labels[status]}
          </span>
        </div>

        <div class="appointment-card-actions">
          <button
            type="button"
            class="appointment-edit-button"
            data-edit-appointment="${esc(item.id)}"
            aria-label="Edit ${esc(item.title)}"
          >
            Edit
          </button>

          <select
            class="appointment-status-menu"
            data-appointment-status="${esc(item.id)}"
            aria-label="Change status for ${esc(item.title)}"
          >
            <option value="">Status</option>
            <option value="completed">Completed</option>
            <option value="missed">Missed</option>
            <option value="canceled">Canceled</option>
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
    ` : `
      <p class="muted">No upcoming appointments.</p>
    `}

    ${history.length ? `
      <h2 class="appointment-group-title">History</h2>
      ${history.map(card).join('')}
    ` : ''}
  `;

  list.querySelectorAll('[data-edit-appointment]')
    .forEach(button => {
      button.onclick = () => {
        openAppointmentModal(button.dataset.editAppointment);
      };
    });

  list.querySelectorAll('[data-appointment-status]')
    .forEach(menu => {
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
  const labels = {
    completed: 'Completed',
    missed: 'Missed',
    canceled: 'Canceled',
  };

  if (!Object.hasOwn(labels, status)) return;

  const appointment = appointments.find(item => item.id === id);
  if (!appointment) return;

  if (appointment.status === status) return;

  const changedAt = new Date().toISOString();

  const nextAppointments = appointments.map(item =>
    item.id === id
      ? {
          ...item,
          status,
          statusChangedAt: changedAt,
          updatedAt: changedAt,
        }
      : item
  );

  if (!saveAppointments(nextAppointments)) return;

  renderAppointments();
  toast(`Appointment marked ${labels[status].toLowerCase()}.`);
}

function openRescheduleAppointmentModal(id) {
  const appointment = appointments.find(item => item.id === id);
  if (!appointment) return;

  openModal(`
    <div class="modal-head">
      <h2 id="modal-title">Reschedule appointment</h2>

      <button
        class="close-modal"
        data-close
        aria-label="Close reschedule form"
      >×</button>
    </div>

    <p class="modal-intro">
      ${esc(appointment.title)}
    </p>

    <div class="appointment-reschedule-current">
      <span>Current appointment</span>
      <strong>
        ${esc(fmtDate(parseLocal(appointment.at), {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }))}
        ·
        ${esc(fmtTime(String(appointment.at).slice(11, 16)))}
      </strong>
    </div>

    <form id="reschedule-appointment-form" class="modal-form">
      <div class="modal-grid">
        <label class="field">
          <span>New date <b>*</b></span>
          <input
            id="reschedule-appointment-date"
            type="date"
            required
          >
        </label>

        <label class="field">
          <span>New time <b>*</b></span>
          <input
            id="reschedule-appointment-time"
            type="time"
            required
          >
        </label>
      </div>

      <p class="modal-note">
        Saving changes this appointment’s date and time and returns
        its status to Scheduled. Other details are kept.
        Notification scheduling is not enabled yet.
      </p>

      <div class="modal-actions">
        <button
          type="button"
          class="secondary-button"
          data-close
        >
          Cancel
        </button>

        <button type="submit" class="primary-button">
          Save new time
        </button>
      </div>
    </form>
  `);

  $('#reschedule-appointment-form').onsubmit = event => {
    event.preventDefault();

    const date = $('#reschedule-appointment-date').value;
    const time = $('#reschedule-appointment-time').value;
    const at = `${date}T${time}`;
    const parsed = parseLocal(at);

    if (
      !date ||
      !time ||
      !Number.isFinite(parsed.getTime()) ||
      localISO(parsed).slice(0, 16) !== at
    ) {
      toast('Enter a valid new date and time.');
      return;
    }

    if (parsed.getTime() <= Date.now()) {
      toast('Choose a future date and time.');
      return;
    }

    const currentAppointment = appointments.find(
      item => item.id === id
    );

    if (!currentAppointment) {
      closeModal();
      toast('This appointment is no longer available.');
      return;
    }

    const changedAt = new Date().toISOString();

    const rescheduleHistory = Array.isArray(
      currentAppointment.rescheduleHistory
    )
      ? currentAppointment.rescheduleHistory
      : [];

    const updated = {
      ...currentAppointment,
      at,
      status: 'scheduled',
      statusChangedAt: changedAt,
      updatedAt: changedAt,
      rescheduleHistory: [
        ...rescheduleHistory,
        {
          previousAt: currentAppointment.at,
          newAt: at,
          previousStatus: currentAppointment.status || 'scheduled',
          changedAt,
        },
      ],
    };

    const nextAppointments = appointments.map(item =>
      item.id === id ? updated : item
    );

    if (!saveAppointments(nextAppointments)) return;

    closeModal();
    renderAppointments();
    toast('Appointment rescheduled.');
  };
}

function openAppointmentModal(id = null) {
  const old = appointments.find(item => item.id === id);

  if (id && !old) {
    toast('This appointment is no longer available.');
    return;
  }

  const appointment = old || {
    title: '',
    at: '',
    provider: '',
    type: '',
    visitFormat: '',
    location: '',
    reminders: [],
    notes: '',
  };

  const types = [
    'Checkup',
    'Specialist',
    'Lab work',
    'Dental',
    'Therapy',
    'Other',
  ];

  const visitFormats = [
    'In person',
    'Phone',
    'Video',
  ];

  const reminderOptions = [
    { minutes: 1440, label: '1 day before' },
    { minutes: 120, label: '2 hours before' },
    { minutes: 60, label: '1 hour before' },
    { minutes: 15, label: '15 minutes before' },
  ];

  const selectedReminders = Array.isArray(appointment.reminders)
    ? appointment.reminders.map(Number)
    : [];

  const existingTime = String(appointment.at || '');
  const dateValue = existingTime.slice(0, 10);
  const timeValue = existingTime.slice(11, 16);

  openModal(`
    <div class="modal-head">
      <h2 id="modal-title">
        ${old ? 'Edit appointment' : 'Add appointment'}
      </h2>

      <button
        class="close-modal"
        data-close
        aria-label="Close appointment form"
      >×</button>
    </div>

    <form id="appointment-form" class="modal-form">
      <label class="field">
        <span>Appointment title <b>*</b></span>
        <input
          id="appointment-title"
          type="text"
          maxlength="100"
          required
          value="${esc(appointment.title || '')}"
        >
      </label>

      <div class="modal-grid">
        <label class="field">
          <span>Date <b>*</b></span>
          <input
            id="appointment-date"
            type="date"
            required
            value="${esc(dateValue)}"
          >
        </label>

        <label class="field">
          <span>Time <b>*</b></span>
          <input
            id="appointment-clock"
            type="time"
            required
            value="${esc(timeValue)}"
          >
        </label>
      </div>

      <label class="field">
        <span>Provider</span>
        <input
          id="appointment-provider"
          type="text"
          maxlength="100"
          value="${esc(appointment.provider || '')}"
        >
      </label>

      <div class="modal-grid">
        <label class="field">
          <span>Type</span>
          <select id="appointment-type">
            <option value="">Select type</option>

            ${types.map(type => `
              <option
                value="${esc(type)}"
                ${appointment.type === type ? 'selected' : ''}
              >
                ${esc(type)}
              </option>
            `).join('')}
          </select>
        </label>

        <label class="field">
          <span>Visit format</span>
          <select id="appointment-visit-format">
            <option value="">Select format</option>

            ${visitFormats.map(format => `
              <option
                value="${esc(format)}"
                ${appointment.visitFormat === format ? 'selected' : ''}
              >
                ${esc(format)}
              </option>
            `).join('')}
          </select>
        </label>
      </div>

      <label class="field">
        <span>Location</span>
        <input
          id="appointment-location"
          type="text"
          maxlength="200"
          value="${esc(appointment.location || '')}"
        >
      </label>

      <fieldset class="appointment-reminder-fieldset">
        <legend>Reminders</legend>

        <div class="appointment-reminder-options">
          ${reminderOptions.map(option => `
            <label class="check-row">
              <input
                type="checkbox"
                name="appointment-reminder"
                value="${option.minutes}"
                ${selectedReminders.includes(option.minutes)
                  ? 'checked'
                  : ''}
              >
              <span>${esc(option.label)}</span>
            </label>
          `).join('')}
        </div>

        <p class="modal-note">
          Leave all unchecked for no reminders.
          Selections are saved, but notifications are not enabled yet.
        </p>
      </fieldset>

      <label class="field">
        <span>Notes</span>
        <textarea
          id="appointment-notes"
          rows="3"
          maxlength="1000"
        >${esc(appointment.notes || '')}</textarea>
      </label>

      <p class="modal-note">
        Appointment times use your device’s local time zone.
      </p>

      <div class="modal-actions">
        <button
          type="button"
          class="secondary-button"
          data-close
        >
          Cancel
        </button>

        <button type="submit" class="primary-button">
          ${old ? 'Save changes' : 'Save appointment'}
        </button>
      </div>

      ${old ? `
  <button
    type="button"
    class="appointment-delete-button"
    id="delete-appointment"
  >
    Delete appointment
  </button>
` : ''}
    </form>
  `);

  const deleteButton = $('#delete-appointment');

if (deleteButton) {
  deleteButton.onclick = () => {
    confirmAction(
      'Delete appointment?',
      `This permanently removes "${old.title}" from this device.`,
      () => {
        const nextAppointments = appointments.filter(
          item => item.id !== old.id
        );

        if (!saveAppointments(nextAppointments)) return;

        renderAppointments();
        toast('Appointment deleted.');
      }
    );
  };
}

  $('#appointment-form').onsubmit = event => {
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

    if (
      !date ||
      !time ||
      !Number.isFinite(parseLocal(at).getTime())
    ) {
      toast('Enter a valid appointment date and time.');
      $('#appointment-date').focus();
      return;
    }

    const reminders = Array.from(
      $('#appointment-form').querySelectorAll(
        'input[name="appointment-reminder"]:checked'
      )
    ).map(input => Number(input.value));

    const updated = {
      ...old,
      id: old?.id || uid('appointment'),
      title,
      at,
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
      ? appointments.map(item =>
          item.id === old.id ? updated : item
        )
      : [...appointments, updated];

    if (!saveAppointments(nextAppointments)) return;

    closeModal();
    renderAppointments();

    toast(old ? 'Appointment updated.' : 'Appointment saved.');
  };
}

function returnFromAppointments() {
  closeModal();

  if (currentPage === 'appointments') {
    pageHistory.pop();

  if (currentPage === 'appointments') renderAppointments();

    const previousPage = pageHistory[pageHistory.length - 1] || 'today';
    go(previousPage, { fromBack: true });
  }

  openMoreModal();
}

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

  function isScheduled(pill, date) { if (!pill.active || pill.schedule === 'asNeeded') return false; const key = dateKey(date); if (pill.startDate && key < pill.startDate) return false; if (pill.endDate && key > pill.endDate) return false; const day = date.getDay(); if (pill.schedule === 'weekdays' && (day === 0 || day === 6)) return false; if (pill.schedule === 'custom' && !(pill.days || []).includes(day)) return false; return true; }
  function doseId(pillId, key, time) { return `${pillId}__${key}__${time}`; }
  function ensureDoseRecords(date = new Date()) { const key = dateKey(date); const expected = []; for (const p of pills) { if (!isScheduled(p, date)) continue; for (const time of p.times || []) { const id = doseId(p.id, key, time); expected.push({ id, pillId: p.id, scheduledAt: `${key}T${time}:00`, status: 'pending', takenAt: '', note: '' }); } } let changed = false; for (const dose of expected) { if (!doses.some(d => d.id === dose.id)) { doses.push(dose); changed = true; } } if (changed) save(KEYS.doses, doses); }
  function getDoseTime(dose) { return parseLocal(dose.scheduledAt); }
  function doseStatus(dose) { if (dose.status !== 'pending') return dose.status; const d = getDoseTime(dose); if (d.getTime() < Date.now() - 60000) return 'missed'; if (Math.abs(d.getTime() - Date.now()) <= 30 * 60000) return 'due'; return 'upcoming'; }
  function doseLabel(status) { return ({ pending: 'Upcoming', due: 'Due now', taken: 'Taken', skipped: 'Skipped', missed: 'Missed' })[status] || status; }
  function inventoryNumber(value) {
  if (value == null || String(value).trim() === '') return null;

  const number = Number(value);

  if (!Number.isFinite(number) || number < 0) return null;

  return Number(number.toFixed(6));
}

function updateDose(id, status) {
  if (!['pending', 'taken', 'skipped'].includes(status)) return;

  const dose = doses.find(item => item.id === id);
  if (!dose || dose.status === status) return;

  const pill = pills.find(item => item.id === dose.pillId);
  if (!pill) return;

  const nextDose = { ...dose };
  const nextPill = { ...pill };

  const quantity = inventoryNumber(pill.quantity);
  const unitsPerDose = inventoryNumber(pill.unitsPerDose);

  let inventoryChanged = false;
  let warning = '';

  const enteringTaken =
    dose.status !== 'taken' && status === 'taken';

  const leavingTaken =
    dose.status === 'taken' && status !== 'taken';

  if (enteringTaken) {
    nextDose.inventoryDeducted = 0;
    nextDose.inventoryEpoch = pill.inventoryEpoch || '';

    if (quantity !== null && unitsPerDose !== null && unitsPerDose > 0) {
      const deducted = Math.min(quantity, unitsPerDose);

      nextPill.quantity = Number(
        (quantity - deducted).toFixed(6)
      );

      nextDose.inventoryDeducted = deducted;
      inventoryChanged = deducted > 0;

      if (quantity < unitsPerDose) {
        warning =
          ' Recorded supply was insufficient; check your remaining quantity.';
      }
    } else if (quantity !== null) {
      warning =
        ' Supply was not changed. Check your units per dose.';
    }
  }

  if (leavingTaken) {
    const deducted = inventoryNumber(dose.inventoryDeducted) || 0;

    const sameInventoryBaseline =
      (dose.inventoryEpoch || '') === (pill.inventoryEpoch || '');

    if (deducted > 0 && quantity !== null && sameInventoryBaseline) {
      const restored = Number((quantity + deducted).toFixed(6));

      if (!Number.isFinite(restored)) {
        toast('Could not restore supply. Check the recorded quantity.');
        return;
      }

      nextPill.quantity = restored;
      inventoryChanged = true;
    } else if (deducted > 0) {
      warning =
        ' Supply was not restored because its recorded baseline changed.';
    }

    nextDose.inventoryDeducted = 0;
    delete nextDose.inventoryEpoch;
  }

  nextDose.status = status;
  nextDose.takenAt = status === 'taken' ? localISO() : '';

  const nextPills = pills.map(item =>
    item.id === pill.id ? nextPill : item
  );

  const nextDoses = doses.map(item =>
    item.id === dose.id ? nextDose : item
  );

  let previousPills;
  let previousDoses;

  try {
    previousPills = localStorage.getItem(KEYS.pills);
    previousDoses = localStorage.getItem(KEYS.doses);

    if (inventoryChanged) {
      localStorage.setItem(KEYS.pills, JSON.stringify(nextPills));
    }

    localStorage.setItem(KEYS.doses, JSON.stringify(nextDoses));
  } catch (error) {
    try {
      if (previousPills !== undefined && inventoryChanged) {
        if (previousPills === null) {
          localStorage.removeItem(KEYS.pills);
        } else {
          localStorage.setItem(KEYS.pills, previousPills);
        }
      }

      if (previousDoses !== undefined) {
        if (previousDoses === null) {
          localStorage.removeItem(KEYS.doses);
        } else {
          localStorage.setItem(KEYS.doses, previousDoses);
        }
      }
    } catch (rollbackError) {
      console.error('Inventory rollback failed:', rollbackError);
    }

    console.error('Dose update failed:', error);
    toast('Could not save the dose update. Check device storage.');
    return;
  }

  pills = nextPills;
  doses = nextDoses;

  renderToday();

  if (currentPage === 'pills') {
    renderPills();
  }

  const message =
    status === 'taken'
      ? 'Dose marked as taken.'
      : status === 'skipped'
        ? 'Dose skipped.'
        : 'Dose updated.';

  toast(message + warning);
}
  function todayDoses() { ensureDoseRecords(); const key = dateKey(); return doses.filter(d => String(d.scheduledAt).slice(0, 10) === key).map(d => ({ ...d, pill: pills.find(p => p.id === d.pillId) })).filter(d => d.pill).sort((a, b) => getDoseTime(a) - getDoseTime(b)); }
  function renderToday() {
    const list = $('#today-dose-list'); const all = todayDoses(); const active = pills.filter(p => p.active).length; const completed = all.filter(d => d.status === 'taken').length; const remaining = all.filter(d => !['taken', 'skipped'].includes(d.status)).length; const pct = all.length ? Math.round(completed / all.length * 100) : 0; $('#greeting').textContent = new Date().getHours() < 12 ? 'YOUR MORNING CHECK-IN' : new Date().getHours() < 17 ? 'YOUR AFTERNOON CHECK-IN' : 'YOUR EVENING CHECK-IN'; $('#today-date').textContent = fmtDate(new Date()); $('#date-day').textContent = String(new Date().getDate()).padStart(2, '0'); $('#date-month').textContent = new Intl.DateTimeFormat(undefined, { month: 'short' }).format(new Date()).toUpperCase(); $('#progress-title').textContent = all.length ? (completed === all.length ? 'All caught up' : `${completed} of ${all.length} taken`) : 'Your day, at a glance'; $('#progress-copy').textContent = !all.length ? 'Your schedule will appear here.' : completed === all.length ? 'All scheduled doses are complete.' : `${remaining} dose${remaining === 1 ? '' : 's'} remaining today.`; $('#progress-percent').textContent = `${pct}%`; $('#progress-ring').style.background = `conic-gradient(#d6f2df ${pct * 3.6}deg,rgba(255,255,255,.2) ${pct * 3.6}deg)`; $('#progress-ring').setAttribute('aria-label', `${pct}% of scheduled doses taken`); $('#progress-bar').style.width = `${pct}%`; $('#stat-scheduled').textContent = all.length; $('#stat-taken').textContent = completed; $('#stat-remaining').textContent = remaining;
    if (!all.length) { list.innerHTML = `<div class="empty-state"><div class="empty-icon">＋</div><h3>${pills.some(p => p.active) ? 'Nothing scheduled today' : 'Stay on top of your medications'}</h3><p>${pills.some(p => p.active) ? 'You have no active medication doses scheduled for today.' : 'Add your first medication to build today’s schedule and receive reminders on Android.'}</p><button class="primary-button" id="empty-add-pill">Add medication</button></div>`; $('#empty-add-pill').onclick = () => openPillModal(); }
    else list.innerHTML = all.map(d => { const p = d.pill, s = doseStatus(d), taken = s === 'taken', final = ['taken', 'skipped'].includes(s); return `<article class="dose-card ${highlightPillId === p.id ? 'dose-highlight' : ''}" style="--pill-color:${esc(p.color || COLORS[0])}" id="dose-${esc(d.id)}"><div class="dose-time">${esc(fmtTime(String(d.scheduledAt).slice(11, 16)))}</div><div class="dose-rail"></div><div class="dose-main"><h3>${esc(p.name)}</h3><p>${esc(p.dosage || p.form || 'Medication')}${p.notes ? ` · ${esc(p.notes)}` : ''}</p><span class="dose-status ${esc(s)}">${esc(doseLabel(s))}${taken && d.takenAt ? ` · ${esc(fmtTime(d.takenAt.slice(11, 16)))}` : ''}</span></div><div class="dose-actions">${taken ? `<button class="take-button done" data-dose-action="undo" data-id="${esc(d.id)}">Undo</button>` : final ? `<button class="take-button done" data-dose-action="undo" data-id="${esc(d.id)}">Undo</button>` : `<button class="take-button" data-dose-action="taken" data-id="${esc(d.id)}">Mark taken</button><button class="mini-action" data-dose-action="skipped" data-id="${esc(d.id)}">Skip</button>`}</div></article>`; }).join(''); list.querySelectorAll('[data-dose-action]').forEach(btn => btn.onclick = () => { const status = btn.dataset.doseAction; updateDose(btn.dataset.id, status === 'undo' ? 'pending' : status); }); const next = all.find(d => !['taken', 'skipped'].includes(doseStatus(d))); $('#daily-insight').textContent = !pills.length ? 'Add a medication to build your daily schedule.' : !all.length ? 'You have no scheduled doses today. Your medication list is available any time.' : !next ? 'You completed all scheduled doses for today.' : `Your next dose is ${next.pill.name} at ${fmtTime(String(next.scheduledAt).slice(11, 16))}.`; highlightPillId = null;
  }
  function scheduleSummary(p) { if (p.schedule === 'asNeeded') return 'As needed · no automatic reminders'; const days = p.schedule === 'daily' ? 'Every day' : p.schedule === 'weekdays' ? 'Weekdays' : (p.days || []).sort((a, b) => a - b).map(d => DAYS[d]).join(', ') || 'No days selected'; return `${days}${(p.times || []).length ? ' at ' + p.times.map(fmtTime).join(' and ') : ''}`; }
  function renderPills() { const filter = $('#pill-filter').value, query = $('#pill-search').value.trim().toLowerCase(); const visible = pills.filter(p => (filter === 'all' || (filter === 'active' ? p.active : !p.active)) && `${p.name} ${p.dosage || ''}`.toLowerCase().includes(query)); $('#pill-count').textContent = `${pills.filter(p => p.active).length} active medication${pills.filter(p => p.active).length === 1 ? '' : 's'}`; const list = $('#pill-list'); if (!visible.length) { list.innerHTML = `<div class="empty-state"><div class="empty-icon">✚</div><h3>${pills.length ? 'No matching medications' : 'Your list starts here'}</h3><p>${pills.length ? 'Try another search or filter.' : 'Add your first medication to keep its dose and reminder schedule organized.'}</p><button class="primary-button" id="pill-empty-add">Add medication</button></div>`; $('#pill-empty-add').onclick = () => openPillModal(); return; } list.innerHTML = visible.map(p => `<article class="med-card" style="--pill-color:${esc(p.color || COLORS[0])}"><div class="med-card-top"><div class="med-dot">${p.form === 'Capsule' ? '◒' : p.form === 'Liquid' ? '◉' : p.form === 'Injection' ? '↗' : '＋'}</div><div class="med-info"><h3>${esc(p.name)}</h3><p>${esc([p.dosage, p.form].filter(Boolean).join(' · ') || 'Medication')}</p></div><button class="med-menu" aria-label="More actions for ${esc(p.name)}" data-med-menu="${esc(p.id)}">⋯</button></div><div class="med-details"><div class="med-detail">◷ <span>${esc(scheduleSummary(p))}</span></div>${p.startDate ? `<div class="med-detail">▦ <span>Started ${esc(fmtDate(parseLocal(p.startDate + 'T12:00:00'), { month: 'short', day: 'numeric', year: 'numeric' }))}${p.endDate ? ' · Ends ' + esc(p.endDate) : ''}</span></div>` : ''}${p.quantity !== '' && p.quantity != null ? `
  <div class="med-detail">
    ▤
    <span>
      <b>${esc(p.quantity)}</b>
      ${esc(medicationQuantityUnit(p.form))} remaining
    </span>
  </div>

  ${p.unitsPerDose !== '' && p.unitsPerDose != null ? `
    <div class="med-detail">
      💊
      <span>
        ${esc(p.unitsPerDose)}
        ${esc(medicationQuantityUnit(p.form))} per dose
      </span>
    </div>
  ` : ''}

  ${p.refillThreshold !== '' && p.refillThreshold != null ? `
    <div class="med-detail">
      ↻
      <span>
        Low-supply threshold:
        ${esc(p.refillThreshold)}
        ${esc(medicationQuantityUnit(p.form))}
      </span>
    </div>
  ` : ''}
` : ''}${p.notes ? `<div class="med-detail">✎ <span>${esc(p.notes)}</span></div>` : ''}</div><div class="med-bottom"><span class="pill-state ${p.active ? '' : 'paused'}">${p.active ? 'Active' : 'Reminders paused'}</span><div class="med-actions"><button data-edit-pill="${esc(p.id)}">Edit</button><button data-toggle-pill="${esc(p.id)}">${p.active ? 'Pause' : 'Resume'}</button></div></div></article>`).join(''); list.querySelectorAll('[data-edit-pill]').forEach(b => b.onclick = () => openPillModal(b.dataset.editPill)); list.querySelectorAll('[data-toggle-pill]').forEach(b => b.onclick = () => togglePill(b.dataset.togglePill)); list.querySelectorAll('[data-med-menu]').forEach(b => b.onclick = () => showPillActions(b.dataset.medMenu)); }
  function showPillActions(id) { const p = pills.find(x => x.id === id); if (!p) return; openModal(`<div class="modal-head"><h2>${esc(p.name)}</h2><button class="close-modal" data-close aria-label="Close">×</button></div><p class="modal-intro">Medication options</p><div class="settings-actions vertical"><button class="settings-link" id="action-edit"><span><strong>Edit medication</strong><small>Update dose, schedule or notes</small></span><b>›</b></button><button class="settings-link" id="action-toggle"><span><strong>${p.active ? 'Pause reminders' : 'Resume reminders'}</strong><small>Keep the medication record</small></span><b>›</b></button><button class="settings-link" id="action-history"><span><strong>View history</strong><small>Review logged doses</small></span><b>›</b></button><button class="settings-link danger-link" id="action-delete"><span><strong>Delete medication</strong><small>Remove this medication and its history</small></span><b>×</b></button></div>`); $('#action-edit').onclick = () => { closeModal(); openPillModal(id) }; $('#action-toggle').onclick = () => { closeModal(); togglePill(id) }; $('#action-history').onclick = () => { closeModal(); go('today'); toast(`Dose history is shown in today's schedule; ${doses.filter(d => d.pillId === id).length} record(s) stored.`) }; $('#action-delete').onclick = () => { closeModal(); confirmAction('Delete medication?', `This removes ${p.name} and its dose history from this device.`, () => deletePill(id)); }; }
  function showPillActions(id) {
  const p = pills.find(item => item.id === id);
  if (!p) return;

  openModal(`
    <div class="modal-head">
      <h2 id="modal-title">${esc(p.name)}</h2>
      <button
        class="close-modal"
        data-close
        aria-label="Close"
      >×</button>
    </div>

    <p class="modal-intro">Medication options</p>

    <div class="settings-actions vertical">
      <button class="settings-link" id="action-edit">
        <span>
          <strong>Edit medication</strong>
          <small>Update dose, schedule or notes</small>
        </span>
        <b aria-hidden="true">›</b>
      </button>

      <button class="settings-link" id="action-toggle">
        <span>
          <strong>
            ${p.active ? 'Pause reminders' : 'Resume reminders'}
          </strong>
          <small>Keep the medication record</small>
        </span>
        <b aria-hidden="true">›</b>
      </button>

      <button class="settings-link" id="action-about">
        <span>
          <strong>About medication</strong>
          <small>Information about your medication</small>
        </span>
        <b aria-hidden="true">›</b>
      </button>

      <button class="settings-link" id="action-history">
        <span>
          <strong>View history</strong>
          <small>Review the last 30 days</small>
        </span>
        <b aria-hidden="true">›</b>
      </button>

      <button
        class="settings-link danger-link"
        id="action-delete"
      >
        <span>
          <strong>Delete medication</strong>
          <small>Remove this medication and its history</small>
        </span>
        <b aria-hidden="true">×</b>
      </button>
    </div>
  `);

  $('#action-edit').onclick = () => {
    closeModal();
    openPillModal(id);
  };

  $('#action-toggle').onclick = () => {
    closeModal();
    togglePill(id);
  };

  $('#action-about').onclick = () => openMedicationAbout(id);

  $('#action-history').onclick = () => {
    openMedicationHistory(id);
  };

  $('#action-delete').onclick = () => {
    closeModal();

    confirmAction(
      'Delete medication?',
      `This removes ${p.name} and its dose history from this device.`,
      () => deletePill(id)
    );
  };
}

function saveMedicationInfo(id, information) {
  const index = pills.findIndex(pill => pill.id === id);
  if (index === -1) return false;

  const updatedPills = pills.map(pill =>
    pill.id === id
      ? { ...pill, medicationInfo: information }
      : pill
  );

  try {
    localStorage.setItem(KEYS.pills, JSON.stringify(updatedPills));
  } catch (error) {
    console.error('Could not save medication information:', error);
    toast('Could not save medication information. Check device storage.');
    return false;
  }

  pills = updatedPills;
  return true;
}

function openMedicationAbout(id) {
  const pill = pills.find(item => item.id === id);
  if (!pill) return;

  openModal(`
    <div class="modal-head">
      <h2 id="modal-title">About ${esc(pill.name)}</h2>
      <button
        class="close-modal"
        data-close
        aria-label="Close"
      >×</button>
    </div>

    <p class="modal-intro">
      Medication labeling from openFDA.
    </p>

    <p class="medication-information-note">
      Loading information sends this medication’s name to the
      FDA’s data service. It does not send your dose history,
      glucose readings, notes, or remaining quantity.
      Internet access is required.
    </p>

    <div id="medication-info-content">
      <button
        type="button"
        class="primary-button"
        id="load-medication-information"
      >
        Load medication information
      </button>
    </div>

    <p class="medication-information-note">
      Search results are not verified matches to your medication.
      Check the product name, strength, formulation, and manufacturer.
      Do not use this information to make treatment decisions.
    </p>

    <div class="modal-actions">
      <button
        type="button"
        class="secondary-button"
        id="medication-about-back"
      >
        Back to medication options
      </button>
    </div>
  `);

  const content = $('#medication-info-content');
  const loadButton = $('#load-medication-information');
  let controller = null;

  $('#medication-about-back').onclick = () => {
    controller?.abort();
    showPillActions(id);
  };

  function showMessage(message) {
  content.innerHTML = `
    <p class="medication-information-note" role="status">
      ${esc(message)}
    </p>

    <button
      type="button"
      class="secondary-button"
      id="retry-medication-information"
    >
      Try again
    </button>
  `;

  content.querySelector('#retry-medication-information')
    .onclick = loadInformation;
}

  function fieldValues(record, field) {
    const value = record.openfda?.[field];

    return Array.isArray(value)
      ? value.map(String).filter(Boolean).join(', ')
      : '';
  }

  function showLabel(record, results = [], savedAt = '') {
  if (!content.isConnected) return;

  const savedDate = savedAt ? new Date(savedAt) : null;

  const savedDateLabel =
    savedDate && Number.isFinite(savedDate.getTime())
      ? savedDate.toLocaleString()
      : '';

    const brand = fieldValues(record, 'brand_name');
    const generic = fieldValues(record, 'generic_name');
    const manufacturer = fieldValues(record, 'manufacturer_name');
    const route = fieldValues(record, 'route');
    const productType = fieldValues(record, 'product_type');

    const labelDate = /^\d{8}$/.test(record.effective_time || '')
      ? `${record.effective_time.slice(0, 4)}-${record.effective_time.slice(4, 6)}-${record.effective_time.slice(6, 8)}`
      : 'Not provided';

    const sections = [
      ['Boxed warning', 'boxed_warning'],
      ['Uses', 'indications_and_usage'],
      ['OTC uses', 'purpose'],
      ['Warnings', 'warnings'],
      ['Warnings and precautions', 'warnings_and_cautions'],
      ['Do not use', 'do_not_use'],
      ['Contraindications', 'contraindications'],
      ['Side effects', 'adverse_reactions'],
      ['Drug interactions', 'drug_interactions'],
      ['Patient information', 'information_for_patients'],
      ['Storage', 'storage_and_handling'],
    ];

    const sectionHtml = sections.map(([title, field]) => {
      const values = record[field];

      if (!Array.isArray(values) || !values.length) return '';

      const text = values
        .filter(value => typeof value === 'string')
        .join('\n\n');

      if (!text.trim()) return '';

      return `
        <details class="medication-label-section">
          <summary>${esc(title)}</summary>
          <div class="medication-label-text">${esc(text)}</div>
        </details>
      `;
    }).join('');

    content.innerHTML = `
      <div class="medication-label-identity">
        <p><strong>Brand:</strong> ${esc(brand || 'Not provided')}</p>
        <p><strong>Generic:</strong> ${esc(generic || 'Not provided')}</p>
        <p>
          <strong>Manufacturer:</strong>
          ${esc(manufacturer || 'Not provided')}
        </p>
        <p><strong>Route:</strong> ${esc(route || 'Not provided')}</p>
        <p>
          <strong>Product type:</strong>
          ${esc(productType || 'Not provided')}
        </p>
        <p><strong>Label effective date:</strong> ${esc(labelDate)}</p>
      </div>

      <p class="medication-information-note">
        Source: openFDA drug product labeling.
        These are selected sections, not the complete label.
        Missing sections do not mean there are no warnings or interactions.
        Label information may differ from your product’s current packaging.
      </p>

      ${sectionHtml || `
        <p class="medication-information-note">
          No supported text sections were returned for this label.
        </p>
      `}

      <p class="medication-information-note">
        ${savedDateLabel
          ? `Saved on this device: ${esc(savedDateLabel)}.
             This is a saved copy and is not automatically refreshed.`
          : 'You can save this label for this medication. Saving does not verify that it matches your product.'}
      </p>

      <div class="medication-info-actions">
        <button
          type="button"
          class="primary-button"
          id="save-selected-medication-info"
          ${savedAt ? 'disabled' : ''}
        >
          ${savedAt
            ? 'Information saved'
            : 'Save this medication information'}
        </button>

        <button
          type="button"
          class="secondary-button"
          id="choose-another-medication-label"
        >
          Choose different information
        </button>

        ${savedAt ? `
          <button
            type="button"
            class="secondary-button"
            id="remove-saved-medication-info"
          >
            Remove saved information
          </button>
        ` : ''}
      </div>
    `;

    content.querySelector('#save-selected-medication-info')
  .onclick = () => {
    const currentPill = pills.find(item => item.id === id);
    if (!currentPill) return;

    const information = {
      source: 'openFDA',
      savedAt: new Date().toISOString(),
      medicationName: currentPill.name,
      record,
    };

    if (!saveMedicationInfo(id, information)) return;

    toast('Medication information saved.');
    showLabel(record, results, information.savedAt);
  };

content.querySelector('#choose-another-medication-label')
  .onclick = () => {
    if (results.length) {
      showResults(results);
    } else {
      loadInformation();
    }
  };

const removeButton =
  content.querySelector('#remove-saved-medication-info');

if (removeButton) {
  removeButton.onclick = () => {
    confirmAction(
      'Remove saved information?',
      'This removes the saved label only. Your medication, supply, and dose history will remain.',
      () => {
        if (saveMedicationInfo(id, null)) {
          toast('Saved medication information removed.');
        }

        openMedicationAbout(id);
      }
    );
  };
}
  }

  function showResults(results, total = results.length) {
    if (!content.isConnected) return;

    content.innerHTML = `
      <p class="medication-information-note">
        Choose a label that matches your medication.
        Showing ${results.length} of ${esc(total)} matching records.
        A name match alone does not confirm the correct product.
      </p>

      <div class="settings-card settings-actions vertical">
        ${results.map((record, index) => {
          const brand = fieldValues(record, 'brand_name');
          const generic = fieldValues(record, 'generic_name');
          const manufacturer = fieldValues(record, 'manufacturer_name');
          const route = fieldValues(record, 'route');

          return `
            <button
              type="button"
              class="settings-link"
              data-medication-label="${index}"
            >
              <span>
                <strong>
                  ${esc(brand || generic || 'Medication label')}
                </strong>
                <small>
                  ${esc(
                    [generic, manufacturer, route]
                      .filter(Boolean)
                      .join(' · ') || 'Product details not provided'
                  )}
                </small>
              </span>
              <b aria-hidden="true">›</b>
            </button>
          `;
        }).join('')}
      </div>
    `;

    content.querySelectorAll('[data-medication-label]')
      .forEach(button => {
        button.onclick = () => {
          const record = results[Number(button.dataset.medicationLabel)];
          if (record) showLabel(record, results);
        };
      });
  }

  async function loadInformation() {
    if (!content.isConnected) return;

    controller?.abort();
    controller = new AbortController();

    const requestController = controller;

    content.innerHTML = `
      <p class="medication-information-note" role="status">
        Loading medication labels…
      </p>
    `;

    const name = pill.name.trim();

    if (!name) {
      showMessage('This medication does not have a searchable name.');
      return;
    }

    const safeName = name
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');

    const query =
      `openfda.brand_name:"${safeName}" OR ` +
      `openfda.generic_name:"${safeName}"`;

    const params = new URLSearchParams({
      search: query,
      limit: '10',
    });

    const timeout = setTimeout(() => {
      requestController.abort();
    }, 15000);

    try {
      const response = await fetch(
        `https://api.fda.gov/drug/label.json?${params}`,
        {
          signal: requestController.signal,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        }
      );

      if (!content.isConnected || controller !== requestController) return;

      if (response.status === 404) {
        showMessage(
          'No matching labels were found. Check the medication name. ' +
          'Some medications and supplements may not appear in this database.'
        );
        return;
      }

      if (response.status === 429) {
        showMessage(
          'The medication information service is busy. Try again later.'
        );
        return;
      }

      if (!response.ok) {
        throw new Error(`Information service returned ${response.status}.`);
      }

      const data = await response.json();

      if (!content.isConnected || controller !== requestController) return;

      const results = Array.isArray(data.results) ? data.results : [];

      if (!results.length) {
        showMessage('No matching medication labels were returned.');
        return;
      }

      showResults(
        results,
        data.meta?.results?.total ?? results.length
      );
    } catch (error) {
      if (!content.isConnected || controller !== requestController) return;

      showMessage(
        error.name === 'AbortError'
          ? 'The request timed out. Try again.'
          : 'Could not load medication information. Check your connection ' +
            'or try again later.'
      );

      console.error('Medication information request failed:', error);
    } finally {
      clearTimeout(timeout);
    }
  }

  loadButton.onclick = loadInformation;

const savedInformation = pill.medicationInfo;

if (
  savedInformation?.source === 'openFDA' &&
  savedInformation.record &&
  savedInformation.medicationName === pill.name
) {
  showLabel(
    savedInformation.record,
    [],
    savedInformation.savedAt
  );
}
}

function openMedicationHistory(id) {
  const p = pills.find(item => item.id === id);
  if (!p) return;

  const today = new Date();
  today.setHours(12, 0, 0, 0);

  const firstDay = new Date(today);
  firstDay.setDate(firstDay.getDate() - 29);

  const firstKey = dateKey(firstDay);
  const lastKey = dateKey(today);

  const records = doses
    .filter(dose => {
      const key = String(dose.scheduledAt).slice(0, 10);

      return (
        dose.pillId === id &&
        key >= firstKey &&
        key <= lastKey
      );
    })
    .filter(dose => {
      return Number.isFinite(getDoseTime(dose).getTime());
    })
    .sort((a, b) => getDoseTime(b) - getDoseTime(a));

  const counts = {
    taken: 0,
    missed: 0,
    skipped: 0,
    pending: 0,
  };

  const grouped = new Map();

  for (const dose of records) {
    const key = String(dose.scheduledAt).slice(0, 10);
    const status = doseStatus(dose);

    if (status === 'taken') {
      counts.taken += 1;
    } else if (status === 'missed') {
      counts.missed += 1;
    } else if (status === 'skipped') {
      counts.skipped += 1;
    } else {
      counts.pending += 1;
    }

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }

    grouped.get(key).push({ dose, status });
  }

  const daySections = [];

  for (let offset = 0; offset < 30; offset += 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);

    const key = dateKey(date);
    const dayRecords = grouped.get(key) || [];

    const rows = dayRecords.length
      ? dayRecords.map(({ dose, status }) => {
          const label =
            status === 'upcoming'
              ? 'Upcoming'
              : doseLabel(status);

          const takenTime = dose.takenAt
            ? parseLocal(dose.takenAt)
            : null;

          const takenDetail =
            status === 'taken' &&
            takenTime &&
            Number.isFinite(takenTime.getTime())
              ? `
                  <small>
                    Taken ${esc(fmtStamp(dose.takenAt))}
                  </small>
                `
              : '';

          return `
            <div class="medication-dose-history-row">
              <div class="medication-dose-history-time">
                <strong>
                  ${esc(fmtTime(
                    String(dose.scheduledAt).slice(11, 16)
                  ))}
                </strong>

                ${takenDetail}
              </div>

              <span class="dose-status ${esc(status)}">
                ${esc(label)}
              </span>
            </div>
          `;
        }).join('')
      : `
          <p class="medication-history-empty">
            No stored dose records.
          </p>
        `;

    daySections.push(`
      <section class="medication-history-day">
        <h3>
          ${esc(fmtDate(date, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          }))}
          ${key === lastKey ? ' · Today' : ''}
        </h3>

        ${rows}
      </section>
    `);
  }

  openModal(`
    <div class="modal-head">
      <h2 id="modal-title">${esc(p.name)} history</h2>
      <button
        class="close-modal"
        data-close
        aria-label="Close"
      >×</button>
    </div>

    <p class="modal-intro">
      Last 30 days ·
      ${esc(fmtDate(firstDay, {
        month: 'short',
        day: 'numeric',
      }))}
      –
      ${esc(fmtDate(today, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }))}
    </p>

    <div class="medication-history-summary">
      <div>
        <strong>${counts.taken}</strong>
        <span>Taken</span>
      </div>

      <div>
        <strong>${counts.missed}</strong>
        <span>Missed</span>
      </div>

      <div>
        <strong>${counts.skipped}</strong>
        <span>Skipped</span>
      </div>

      <div>
        <strong>${counts.pending}</strong>
        <span>Pending</span>
      </div>
    </div>

    <p class="medication-information-note">
      Only stored dose records are shown. Missing records are not
      counted as missed doses. “Missed” follows the app’s existing
      overdue-dose rule.
    </p>

    <div class="medication-history-days">
      ${daySections.join('')}
    </div>

    <div class="modal-actions history-modal-actions">
      <button
        type="button"
        class="secondary-button"
        id="medication-history-back"
      >
        Back to medication options
      </button>
    </div>
  `);

  $('#medication-history-back').onclick = () => {
    showPillActions(id);
  };
}
  function deletePill(id) { const p = pills.find(x => x.id === id); if (!p) return; HealthLedgerNotifications.cancelPill(p).then(() => { }); pills = pills.filter(x => x.id !== id); doses = doses.filter(d => d.pillId !== id); save(KEYS.pills, pills); save(KEYS.doses, doses); render(); toast('Medication deleted.'); } let settingsModalGroups = [];

function restoreSettingsContent() {
  const storage = $('#page-more');
  if (!storage) return;

  for (const group of settingsModalGroups) {
    storage.appendChild(group);
  }

  settingsModalGroups = [];
}

function openSettingsModal() {
  openModal(`
    <div class="modal-head">
      <h2 id="modal-title">Settings</h2>
      <button
        class="close-modal"
        data-close
        aria-label="Close settings"
      >×</button>
    </div>

    <p class="modal-intro">
      Preferences, privacy and tools.
    </p>

    <div id="settings-modal-content"></div>
  `);

  const storage = $('#page-more');
  const destination = $('#settings-modal-content');

  if (!storage || !destination) {
    closeModal();
    toast('Settings content is unavailable.');
    return;
  }

  settingsModalGroups = Array.from(storage.children)
    .filter(element => element.classList.contains('settings-group'));

  for (const group of settingsModalGroups) {
    destination.appendChild(group);
  }

  refreshNotificationStatus().catch(error => {
    console.error('Could not refresh notification status:', error);
  });
}

function openMoreModal() {
  openModal(`
    <div class="modal-head">
      <h2 id="modal-title">More</h2>
      <button
        class="close-modal"
        data-close
        aria-label="Close More"
      >×</button>
    </div>

    <div class="settings-card settings-actions vertical">
      <button
        type="button"
        class="settings-link"
        id="open-appointments"
      >
        <span>
          <strong>📅 Appointments</strong>
          <small>Visits and checkups</small>
        </span>
        <b aria-hidden="true">›</b>
      </button>
    </div>
  `);

  $('#open-appointments').onclick = () => {
    closeModal();
    go('appointments');
  };
}
  function openModal(html) {
  restoreSettingsContent();

  const root = $('#modal-root'); root.innerHTML = `<div class="modal-backdrop" role="presentation"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">${html}</section></div>`; const backdrop = root.querySelector('.modal-backdrop'); backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); }); root.querySelectorAll('[data-close]').forEach(b => b.onclick = closeModal); const first = root.querySelector('input,button,select,textarea'); if (first) setTimeout(() => first.focus(), 20); document.addEventListener('keydown', escModal, { once: true }); }
  function escModal(e) { if (e.key === 'Escape') { closeModal(); return; } document.addEventListener('keydown', escModal, { once: true }); }
  function closeModal() {
  restoreSettingsContent();
  $('#modal-root').innerHTML = '';
}
  function confirmAction(title, body, onConfirm, danger = true) { openModal(`<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="close-modal" data-close aria-label="Close">×</button></div><p class="modal-intro">${esc(body)}</p><div class="modal-actions"><button class="secondary-button" data-close>Cancel</button><button class="primary-button ${danger ? 'danger-button' : ''}" id="confirm-action">Confirm</button></div>`); $('#confirm-action').onclick = () => { closeModal(); onConfirm(); }; } function medicationQuantityUnit(form) {
  switch (String(form).toLowerCase()) {
    case 'tablet':
      return 'tablets';
    case 'capsule':
      return 'capsules';
    case 'liquid':
      return 'mL';
    default:
      return 'units';
  }
}
  function openPillModal(id = null) {
    const old = pills.find(p => p.id === id); const p = old || { name: '', dosage: '', form: 'Tablet', color: COLORS[0], times: ['08:00'], schedule: 'daily', days: [1, 2, 3, 4, 5, 6, 0], startDate: dateKey(), endDate: '', notes: '', active: true, quantity: '' }; const colorButtons = COLORS.map(c => `<button type="button" class="swatch ${c === p.color ? 'selected' : ''}" style="--swatch:${c}" data-color="${c}" aria-label="Choose color ${c}" aria-pressed="${c === p.color}"></button>`).join(''); openModal(`<div class="modal-head"><h2 id="modal-title">${old ? 'Edit medication' : 'Add medication'}</h2><button class="close-modal" data-close aria-label="Close">×</button></div><p class="modal-intro">${old ? 'Keep your medication details up to date.' : 'Build a routine that works for you.'}</p><form id="pill-form" class="modal-form" novalidate><label class="field"><span>Medication name <b>*</b></span><input id="med-name" maxlength="100" required placeholder="e.g., Metformin" value="${esc(p.name)}"><small class="error-text" id="med-name-error"></small></label><div class="modal-grid"><label class="field"><span>Dosage</span><input id="med-dosage" maxlength="60" placeholder="e.g., 500 mg" value="${esc(p.dosage || '')}"></label><label class="field"><span>Form</span><select id="med-form">${FORMS.map(f => `<option ${f.toLowerCase() === String(p.form).toLowerCase() ? 'selected' : ''}>${f}</option>`).join('')}</select></label></div><div class="field"><span>Color marker</span><div class="swatches">${colorButtons}</div><input id="med-color" type="hidden" value="${esc(p.color)}"></div><div class="field"><span>Reminder times</span><div class="time-list" id="time-list">${(p.times || []).map((t, i) => `<div class="time-row"><input aria-label="Reminder time ${i + 1}" type="time" value="${esc(t)}" class="med-time"><button type="button" class="remove-time" aria-label="Remove reminder time">−</button></div>`).join('')}</div><button type="button" class="inline-button" id="add-time">＋ Add another reminder time</button></div><label class="field"><span>Frequency</span><select id="med-schedule">${SCHEDULES.map(s => `<option value="${s.value}" ${s.value === p.schedule ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label><div class="field" id="days-field" ${p.schedule === 'custom' ? '' : 'hidden'}><span>Repeat on</span><div class="days-picker">${DAYS.map((d, i) => `<button type="button" class="day-toggle ${(p.days || []).includes(i) ? 'selected' : ''}" data-day="${i}" aria-pressed="${(p.days || []).includes(i)}">${d}</button>`).join('')}</div><small class="error-text" id="days-error"></small></div><div class="modal-grid"><label class="field"><span>Start date</span><input id="med-start" type="date" value="${esc(p.startDate || dateKey())}"></label><label class="field"><span>End date <small>Optional</small></span><input id="med-end" type="date" value="${esc(p.endDate || '')}"></label></div><div class="modal-grid">
  <label class="field">
    <span>Remaining quantity <small>Optional</small></span>
    <input
      id="med-quantity"
      type="number"
      min="0"
      step="any"
      inputmode="decimal"
      placeholder="e.g., 30 or 100"
      value="${esc(p.quantity ?? '')}"
    >
  </label>
</div>

<div class="modal-grid">
  <label class="field">
    <span>Units per dose</span>
    <input
      id="med-units-per-dose"
      type="number"
      min="0"
      step="any"
      inputmode="decimal"
      placeholder="e.g., 0.5 or 5"
      value="${esc(p.unitsPerDose ?? '')}"
    >
  </label>

  <label class="field">
    <span>Low-supply threshold <small>Optional</small></span>
    <input
      id="med-refill-threshold"
      type="number"
      min="0"
      step="any"
      inputmode="decimal"
      placeholder="e.g., 5"
      value="${esc(p.refillThreshold ?? '')}"
    >
  </label>
</div>

<p class="modal-note">
  Supply tracking uses the selected medication form.
  Enter the quantity used per dose in the same units as your
  remaining quantity. Leave remaining quantity blank to disable
  supply tracking. These fields do not recommend a medication dose.
</p><label class="field"><span>Notes <small>Optional</small></span><textarea id="med-notes" rows="2" maxlength="500" placeholder="Take with food">${esc(p.notes || '')}</textarea></label><label class="check-row"><input id="med-active" type="checkbox" ${p.active ? 'checked' : ''}> Medication is active and reminders are enabled</label><p class="modal-note">
  Tablets and capsules are counted individually. Liquid quantities
  are recorded in mL. Use the same measurement for remaining
  quantity, units per dose, and the low-supply threshold.
  Leave remaining quantity blank to disable supply tracking.
  These fields record supply and do not recommend a medication dose.
</p><div class="modal-actions"><button type="button" class="secondary-button" data-close>Cancel</button><button type="submit" class="primary-button">${old ? 'Save changes' : 'Save medication'}</button></div></form>`);
    let selectedColor = p.color; $('#modal-root').querySelectorAll('[data-color]').forEach(b => b.onclick = () => { selectedColor = b.dataset.color; $('#med-color').value = selectedColor; $('#modal-root').querySelectorAll('[data-color]').forEach(x => { x.classList.toggle('selected', x === b); x.setAttribute('aria-pressed', String(x === b)); }); });
    $('#add-time').onclick = () => { const row = document.createElement('div'); row.className = 'time-row'; row.innerHTML = `<input aria-label="Reminder time" type="time" value="12:00" class="med-time"><button type="button" class="remove-time" aria-label="Remove reminder time">−</button>`; $('#time-list').append(row); row.querySelector('input').focus(); }; $('#time-list').onclick = e => { if (e.target.closest('.remove-time')) { const rows = $$('.time-row'); if (rows.length > 1) e.target.closest('.time-row').remove(); else e.target.closest('input')?.setAttribute('value', ''); } };
    $('#med-schedule').onchange = () => $('#days-field').hidden = $('#med-schedule').value !== 'custom'; $('#days-field').querySelectorAll('[data-day]').forEach(b => b.onclick = () => { b.classList.toggle('selected'); b.setAttribute('aria-pressed', String(b.classList.contains('selected'))); });
    $('#pill-form').onsubmit = async e => { e.preventDefault(); const name = $('#med-name').value.trim(); const error = $('#med-name-error'); if (!name) { error.textContent = 'Enter a medication name.'; $('#med-name').focus(); return; } error.textContent = ''; const schedule = $('#med-schedule').value; const times = [...$('#time-list').querySelectorAll('.med-time')].map(x => x.value).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).sort(); if (schedule !== 'asNeeded' && !times.length) { toast('Add at least one reminder time, or choose As needed.'); $('#time-list input').focus(); return; } const days = $$('#days-field [data-day].selected').map(b => Number(b.dataset.day)); if (schedule === 'custom' && !days.length) { $('#days-error').textContent = 'Choose at least one day.'; return; } $('#days-error').textContent = ''; const startDate = $('#med-start').value || dateKey(), endDate = $('#med-end').value; if (endDate && endDate < startDate) { toast('End date must be on or after the start date.'); return; } const quantityText = $('#med-quantity').value.trim();
const unitsText = $('#med-units-per-dose').value.trim();
const thresholdText = $('#med-refill-threshold').value.trim();

const quantity = quantityText === '' ? '' : Number(quantityText);
const unitsPerDose = unitsText === '' ? '' : Number(unitsText);
const refillThreshold =
  thresholdText === '' ? '' : Number(thresholdText);

if (
  quantity !== '' &&
  (!Number.isFinite(quantity) || quantity < 0)
) {
  toast('Enter a remaining quantity of zero or greater.');
  $('#med-quantity').focus();
  return;
}

if (
  unitsPerDose !== '' &&
  (!Number.isFinite(unitsPerDose) || unitsPerDose <= 0)
) {
  toast('Units per dose must be greater than zero.');
  $('#med-units-per-dose').focus();
  return;
}

if (
  refillThreshold !== '' &&
  (!Number.isFinite(refillThreshold) || refillThreshold < 0)
) {
  toast('Enter a low-supply threshold of zero or greater.');
  $('#med-refill-threshold').focus();
  return;
}

if (quantity !== '' && unitsPerDose === '') {
  toast('Enter how many units are used per dose.');
  $('#med-units-per-dose').focus();
  return;
} const updated = { id: old?.id || uid('pill'), name, dosage: $('#med-dosage').value.trim(), form: $('#med-form').value, color: $('#med-color').value, times, schedule, days: schedule === 'custom' ? days : [], startDate, endDate, notes: $('#med-notes').value.trim(), active: $('#med-active').checked, quantity,
unitsPerDose,
refillThreshold, medicationInfo:
  old &&
  old.name === name &&
  old.dosage === $('#med-dosage').value.trim() &&
  old.form === $('#med-form').value
    ? (old.medicationInfo || null)
    : null, inventoryEpoch:
  old &&
  inventoryNumber(old.quantity) === inventoryNumber(quantity) &&
  old.form === $('#med-form').value
    ? (old.inventoryEpoch || '')
    : uid('inventory'), createdAt: old?.createdAt || new Date().toISOString() }; if (old) await HealthLedgerNotifications.cancelPill(old); if (old) pills = pills.map(x => x.id === old.id ? updated : x); else pills.push(updated); save(KEYS.pills, pills); ensureDoseRecords(); closeModal(); render(); const result = await HealthLedgerNotifications.schedulePill(updated); if (updated.active && updated.schedule !== 'asNeeded' && updated.times.length) { if (result.supported && result.scheduled) toast(`${old ? 'Medication updated' : 'Medication added'} and ${result.scheduled} reminder(s) scheduled.`); else toast('Medication saved. Reminder notifications are available in the Android app.'); } else toast(old ? 'Medication updated.' : 'Medication saved.'); };
  }
  function mmol(value) { return value / 18.0182; } function mgdl(value) { return value * 18.0182; }
  function displayReading(entry, unit = $('#display-unit').value) { return unit === 'mmol/L' ? mmol(entry.unit === 'mg/dL' ? entry.value : mgdl(entry.value)) : entry.unit === 'mg/dL' ? entry.value : mgdl(entry.value); }
  function readingStatus(value, unit) { const v = unit === 'mmol/L' ? mgdl(value) : value; if (v < settings.targetLow) return 'Below personal range'; if (v > settings.targetHigh) return 'Above personal range'; return 'Within personal range'; }
  function renderGlucose() {
    const sorted = [...glucose].sort((a, b) => parseLocal(b.at) - parseLocal(a.at)); const latest = sorted[0]; const unit = $('#display-unit').value; $('#glucose-unit').value = unit; $('#latest-unit').textContent = unit; if (!latest) { $('#latest-value').textContent = '—'; $('#latest-date').textContent = 'No readings recorded'; $('#latest-context').textContent = 'Your readings will appear here once you log one.'; } else { const value = displayReading(latest, unit); $('#latest-value').textContent = unit === 'mmol/L' ? value.toFixed(1) : Math.round(value); $('#latest-date').textContent = fmtStamp(latest.at); $('#latest-context').textContent = `${latest.context || 'No meal context'} · ${readingStatus(value, unit)} (based on your personal range)`; }
    const cutoff = $('#trend-range').value === 'all' ? 0 : Date.now() - Number($('#trend-range').value) * 86400000; const trend = sorted.filter(g => parseLocal(g.at).getTime() >= cutoff).sort((a, b) => parseLocal(a.at) - parseLocal(b.at)); drawChart(trend, unit); const list = $('#glucose-history'); if (!sorted.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">⌁</div><h3>No glucose readings yet</h3><p>Log a reading to begin tracking your glucose history and trends.</p></div>'; return; } list.innerHTML = sorted.map(g => { const value = displayReading(g, unit); return `<article class="history-item"><div class="history-reading"><strong>${unit === 'mmol/L' ? value.toFixed(1) : Math.round(value)} ${esc(unit)}</strong><p>${esc(g.context || 'Other')}${g.notes ? ` · ${esc(g.notes)}` : ''}</p></div><div class="history-meta">${esc(fmtStamp(g.at))}<div class="history-buttons"><button data-edit-glucose="${esc(g.id)}" aria-label="Edit reading">Edit</button><button data-delete-glucose="${esc(g.id)}" aria-label="Delete reading">Delete</button></div></div></article>`; }).join(''); list.querySelectorAll('[data-edit-glucose]').forEach(b => b.onclick = () => editGlucose(b.dataset.editGlucose)); list.querySelectorAll('[data-delete-glucose]').forEach(b => b.onclick = () => confirmAction('Delete this reading?', 'This reading will be removed from your local history.', () => { glucose = glucose.filter(g => g.id !== b.dataset.deleteGlucose); save(KEYS.glucose, glucose); renderGlucose(); toast('Reading deleted.'); }));
  }
  function drawChart(data, unit) { const root = $('#glucose-chart'); if (!data.length) { root.innerHTML = '<p class="empty-inline">No readings in this date range yet.</p>'; return; } const w = 620, h = 190, pad = { l: 36, r: 12, t: 14, b: 30 }; const values = data.map(g => displayReading(g, unit)); let min = Math.min(...values), max = Math.max(...values); if (min === max) { min -= unit === 'mmol/L' ? 1 : 18; max += unit === 'mmol/L' ? 1 : 18; } const gap = (max - min) * .18; min = Math.max(0, min - gap); max += gap; const x = i => pad.l + (data.length === 1 ? (w - pad.l - pad.r) / 2 : i * (w - pad.l - pad.r) / (data.length - 1)); const y = v => pad.t + (max - v) * (h - pad.t - pad.b) / (max - min); const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' '); const ticks = [min, (min + max) / 2, max]; const grid = ticks.map(v => `<g><line x1="${pad.l}" y1="${y(v)}" x2="${w - pad.r}" y2="${y(v)}" stroke="var(--border)" stroke-dasharray="3 4"/><text x="${pad.l - 7}" y="${y(v) + 4}" fill="var(--muted)" font-size="10" text-anchor="end">${unit === 'mmol/L' ? v.toFixed(1) : Math.round(v)}</text></g>`).join(''); const circles = values.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="var(--accent)" stroke="var(--card)" stroke-width="2"><title>${esc(fmtStamp(data[i].at))}: ${unit === 'mmol/L' ? v.toFixed(1) : Math.round(v)} ${esc(unit)}</title></circle>`).join(''); const labels = [0, Math.floor((data.length - 1) / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i).map(i => `<text x="${x(i)}" y="${h - 7}" fill="var(--muted)" font-size="10" text-anchor="${i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}">${esc(fmtDate(parseLocal(data[i].at), { month: 'short', day: 'numeric' }))}</text>`).join(''); root.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Glucose trend chart with ${data.length} readings"><title>Glucose trend, ${data.length} readings, in ${esc(unit)}</title>${grid}<polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${circles}${labels}</svg>`; }
  function resetGlucoseForm() { editingGlucoseId = null; $('#glucose-form').reset(); $('#glucose-time').value = localISO().slice(0, 16); $('#glucose-unit').value = $('#display-unit').value; $('#glucose-form').querySelector('button[type="submit"]').textContent = 'Log reading'; }
  function editGlucose(id) { const g = glucose.find(x => x.id === id); if (!g) return; editingGlucoseId = id; $('#glucose-value').value = g.value; $('#glucose-unit').value = g.unit; $('#glucose-context').value = g.context || 'Other'; $('#glucose-time').value = String(g.at).slice(0, 16); $('#glucose-notes').value = g.notes || ''; $('#glucose-form').querySelector('button[type="submit"]').textContent = 'Save changes'; $('#glucose-form').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#glucose-value').focus({ preventScroll: true }); }
  $('#glucose-form').onsubmit = e => { e.preventDefault(); const value = Number($('#glucose-value').value); if (!Number.isFinite(value) || value <= 0 || value > 1000) { toast('Enter a valid glucose reading.'); return; } const entry = { id: editingGlucoseId || uid('glucose'), value, unit: $('#glucose-unit').value, context: $('#glucose-context').value, at: $('#glucose-time').value, notes: $('#glucose-notes').value.trim(), createdAt: editingGlucoseId ? glucose.find(g => g.id === editingGlucoseId)?.createdAt : new Date().toISOString() }; if (!entry.at) { toast('Choose the date and time for this reading.'); return; } if (editingGlucoseId) glucose = glucose.map(g => g.id === editingGlucoseId ? entry : g); else glucose.push(entry); save(KEYS.glucose, glucose); resetGlucoseForm(); renderGlucose(); toast(editingGlucoseId ? 'Reading updated.' : 'Glucose reading saved.'); };
  function applyTheme(theme, persist = true) {
  const validThemes = ['system', 'light', 'dark', 'osrs'];
  const selectedTheme = validThemes.includes(theme) ? theme : 'system';

  document.documentElement.dataset.theme = selectedTheme;

  const themeSelect = $('#theme-select');
  if (themeSelect) {
    themeSelect.value = selectedTheme;
  }

  if (persist) {
    save(KEYS.theme, selectedTheme);
  }
}
  async function refreshNotificationStatus() { const native = HealthLedgerNotifications.isNative(); const status = $('#notification-status'), dot = $('#notification-dot'), exact = $('#exact-status'); if (!native) { status.textContent = 'Browser preview mode'; dot.style.background = 'var(--amber)'; exact.textContent = 'Available in Android app where supported'; $('#notification-diagnostic').textContent = 'Native scheduled notifications are available after installing this app on Android. Medication schedules and records still work in browser mode.'; $('#open-exact-settings').disabled = true; $('#open-notification-settings').disabled = true; return; } $('#open-exact-settings').disabled = false; $('#open-notification-settings').disabled = false; const p = await HealthLedgerNotifications.plugin().checkPermissions().catch(() => ({ display: 'unknown' })); const granted = p.display === 'granted'; status.textContent = granted ? 'Enabled' : 'Not allowed'; dot.style.background = granted ? 'var(--accent)' : 'var(--amber)'; const a = await HealthLedgerNotifications.checkExactAlarmPermission(); exact.textContent = !a.supported ? 'Check Android settings if reminders are late' : a.granted ? 'Enabled' : 'Needs Android setting'; $('#notification-diagnostic').textContent = granted ? 'Notification permission is enabled. Use Resync reminders after changing medication schedules.' : 'Allow notification access to receive scheduled medication reminders.'; }
  async function syncNotifications() { const result = await HealthLedgerNotifications.syncPills(pills); let message = result.message || 'Reminder sync finished.'; if (result.exactAlarm?.supported && result.exactAlarm.granted === false) message += ' For reminders at the exact selected time, enable Alarms & reminders for Health Ledger in Android settings.'; $('#notification-diagnostic').textContent = message; await refreshNotificationStatus(); toast(result.supported ? message : 'Browser preview mode: medication schedules saved, but native notifications are unavailable.'); }
  function render() { ensureDoseRecords(); if (currentPage === 'today') renderToday(); if (currentPage === 'pills') renderPills(); if (currentPage === 'glucose') renderGlucose(); if (currentPage === 'appointments') {
  renderAppointments();
} if (currentPage === 'more') refreshNotificationStatus(); }
  async function exportData() {
  const data = {
    app: 'Health Ledger',
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    pills: pills,
    doses: doses,
    glucose: glucose,
    settings: settings,
    theme: localStorage.getItem(KEYS.theme) || 'system'
  };

  const fileName = `health-ledger-backup-${dateKey()}.json`;
  const contents = JSON.stringify(data, null, 2);

  const cap = window.Capacitor;
  const Filesystem = cap?.Plugins?.Filesystem;

  const isNative =
    typeof cap?.isNativePlatform === 'function'
      ? cap.isNativePlatform()
      : ['android', 'ios'].includes(cap?.getPlatform?.());

  if (!isNative) {
    const blob = new Blob([contents], {
      type: 'application/json'
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = url;
    link.download = fileName;
    link.style.display = 'none';

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);

    toast('Backup download started.');
    return;
  }

  if (!Filesystem) {
    toast(
      'Filesystem plugin is unavailable. Sync Android and rebuild the app.'
    );
    return;
  }

  const DownloadsExport =
  window.Capacitor?.registerPlugin
    ? window.Capacitor.registerPlugin('DownloadsExport')
    : window.Capacitor?.Plugins?.DownloadsExport;

if (!DownloadsExport) {
  const names = Object.keys(
    window.Capacitor?.Plugins || {}
  ).join(', ');

  toast(
    'Downloads export unavailable. Plugins: ' +
    (names || 'none')
  );
  return;
}

try {
  await DownloadsExport.saveJson({
    filename: fileName,
    contents: contents
  });

  toast('Backup saved to Downloads/Health Ledger.');
} catch (error) {
  console.error(
    'Health Ledger Downloads export failed:',
    error
  );

  toast(
    'Could not save backup: ' +
    (error?.message || JSON.stringify(error) || 'unknown error')
  );
}
}
  function importData(file) { const reader = new FileReader(); reader.onload = () => { try { const data = JSON.parse(reader.result); if (data.app !== 'Health Ledger' || !Array.isArray(data.pills) || !Array.isArray(data.doses) || !Array.isArray(data.glucose)) throw new Error('This file is not a Health Ledger backup.'); confirmAction('Import backup?', 'Imported records will replace the current medication, dose and glucose data on this device.', () => { pills = data.pills; doses = data.doses; glucose = data.glucose; settings = data.settings || settings; save(KEYS.pills, pills); save(KEYS.doses, doses); save(KEYS.glucose, glucose); save(KEYS.settings, settings); if (data.theme) applyTheme(data.theme); syncNotifications(); render(); toast('Backup imported.'); }, false); } catch (err) { toast(err.message || 'Could not read that backup file.'); } }; reader.readAsText(file); }
  function loadDemo() { confirmAction('Load demo data?', 'Sample medications and glucose readings will be added alongside your existing records.', () => { const today = new Date(); const mkDate = (offset, hour, minute) => { const d = new Date(today); d.setDate(d.getDate() - offset); d.setHours(hour, minute, 0, 0); return localISO(d); }; const demo = [{ id: uid('pill'), name: 'Metformin', dosage: '500 mg', form: 'Tablet', color: COLORS[0], times: ['08:00', '20:00'], schedule: 'daily', days: [], startDate: dateKey(), endDate: '', notes: 'Take with food', active: true, quantity: '', createdAt: new Date().toISOString() }, { id: uid('pill'), name: 'Vitamin D3', dosage: '2,000 IU', form: 'Capsule', color: COLORS[1], times: ['08:00'], schedule: 'daily', days: [], startDate: dateKey(), endDate: '', notes: '', active: true, quantity: '', createdAt: new Date().toISOString() }, { id: uid('pill'), name: 'Lisinopril', dosage: '10 mg', form: 'Tablet', color: COLORS[2], times: ['20:00'], schedule: 'weekdays', days: [], startDate: dateKey(), endDate: '', notes: '', active: true, quantity: '', createdAt: new Date().toISOString() }]; pills.push(...demo); glucose.push({ id: uid('glucose'), value: 102, unit: 'mg/dL', context: 'Fasting', at: mkDate(0, 7, 42), notes: '', createdAt: new Date().toISOString() }, { id: uid('glucose'), value: 118, unit: 'mg/dL', context: 'After meal', at: mkDate(1, 13, 5), notes: '', createdAt: new Date().toISOString() }, { id: uid('glucose'), value: 96, unit: 'mg/dL', context: 'Fasting', at: mkDate(3, 7, 30), notes: '', createdAt: new Date().toISOString() }, { id: uid('glucose'), value: 109, unit: 'mg/dL', context: 'Before meal', at: mkDate(5, 11, 50), notes: '', createdAt: new Date().toISOString() }); save(KEYS.pills, pills); save(KEYS.glucose, glucose); ensureDoseRecords(); syncNotifications(); render(); toast('Demo records added.'); }, false); }
  function clearAll() { confirmAction('Clear all Health Ledger data?', 'This permanently removes medications, dose history, glucose readings and preferences stored by this app. Export a backup first if you may need it.', () => { pills.forEach(p => HealthLedgerNotifications.cancelPill(p)); pills = []; doses = []; glucose = []; settings = { targetLow: 70, targetHigh: 180, glucoseUnit: 'mg/dL' };[KEYS.pills, KEYS.doses, KEYS.glucose, KEYS.settings, KEYS.onboarding].forEach(k => localStorage.removeItem(k)); save(KEYS.settings, settings); render(); toast('Local records cleared.'); }); }

function openHistoryCalendar() {
  const today = new Date();
  const todayKey = dateKey(today);
  const dates = [];

  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setHours(12, 0, 0, 0);
    date.setDate(today.getDate() - offset);
    dates.push(date);
  }

  const pillIds = new Set(pills.map(pill => pill.id));
  const doseCounts = new Map();
  const glucoseCounts = new Map();

  for (const dose of doses) {
    if (!pillIds.has(dose.pillId)) continue;

    const key = String(dose.scheduledAt).slice(0, 10);
    doseCounts.set(key, (doseCounts.get(key) || 0) + 1);
  }

  for (const reading of glucose) {
    const key = String(reading.at).slice(0, 10);
    glucoseCounts.set(key, (glucoseCounts.get(key) || 0) + 1);
  }

  const rangeLabel = `${fmtDate(dates[0], {
    month: 'short',
    day: 'numeric',
  })} – ${fmtDate(dates[dates.length - 1], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;

  let previousMonth = '';

  const dateButtons = dates.map(date => {
    const key = dateKey(date);
    const monthKey = key.slice(0, 7);
    const isToday = key === todayKey;
    const doseCount = doseCounts.get(key) || 0;
    const glucoseCount = glucoseCounts.get(key) || 0;

    const fullDate = fmtDate(date, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

    const description = [
      fullDate,
      isToday ? 'Today' : '',
      `${doseCount} dose record${doseCount === 1 ? '' : 's'}`,
      `${glucoseCount} glucose reading${glucoseCount === 1 ? '' : 's'}`,
    ].filter(Boolean).join('. ');

    let monthMarker = '';

    if (monthKey !== previousMonth) {
      monthMarker = `
        <p class="history-month-marker">
          ${esc(fmtDate(date, {
            month: 'long',
            year: 'numeric',
          }))}
        </p>
      `;

      previousMonth = monthKey;
    }

    return `
      ${monthMarker}

      <button
        type="button"
        class="history-day${isToday ? ' today' : ''}"
        data-history-date="${esc(key)}"
        aria-label="${esc(description)}"
        ${isToday ? 'aria-current="date"' : ''}
      >
        <span class="history-day-weekday">
          ${esc(fmtDate(date, { weekday: 'short' }))}
        </span>

        <strong>${date.getDate()}</strong>

        <span class="history-day-dots" aria-hidden="true">
          <span class="history-dot-slot">
            ${doseCount ? '<span class="history-dot dose"></span>' : ''}
          </span>

          <span class="history-dot-slot">
            ${glucoseCount ? '<span class="history-dot glucose"></span>' : ''}
          </span>
        </span>
      </button>
    `;
  }).join('');

  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">Medication history</h2>
        <p class="modal-intro">
          Last 30 days · ${esc(rangeLabel)}
        </p>
      </div>

      <button class="close-modal" data-close aria-label="Close">
        ×
      </button>
    </div>

    <div class="history-calendar-legend">
      <span>
        <span class="history-dot dose" aria-hidden="true"></span>
        Dose records
      </span>

      <span>
        <span class="history-dot glucose" aria-hidden="true"></span>
        Glucose readings
      </span>
    </div>

    <div
      class="history-calendar"
      aria-label="Dose and glucose history for the last 30 days"
    >
      ${dateButtons}
    </div>

    <p class="history-calendar-note">
      Dots show stored records, not whether every dose was taken.
      Tap a date to view details.
    </p>
  `);

  $('#modal-root')
    .querySelectorAll('[data-history-date]')
    .forEach(button => {
      button.onclick = () => {
        openHistoryDay(button.dataset.historyDate);
      };
    });
}

function openHistoryDay(key) {
  const selectedDate = parseLocal(`${key}T12:00:00`);
  const selectedDateLabel = fmtDate(selectedDate, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });

  const dayDoses = doses
    .filter(dose => String(dose.scheduledAt).slice(0, 10) === key)
    .map(dose => ({
      ...dose,
      pill: pills.find(pill => pill.id === dose.pillId),
    }))
    .filter(dose => dose.pill)
    .sort((a, b) => getDoseTime(a) - getDoseTime(b));

  const dayGlucose = glucose
    .filter(reading => String(reading.at).slice(0, 10) === key)
    .sort((a, b) => parseLocal(b.at) - parseLocal(a.at));

  const medicationContent = dayDoses.length
    ? `
      <div class="history-detail-list">
        ${dayDoses.map(dose => {
          const status = doseStatus(dose);
          const scheduledTime = fmtTime(String(dose.scheduledAt).slice(11, 16));
          const takenTime = dose.takenAt
            ? fmtTime(String(dose.takenAt).slice(11, 16))
            : '';

          const statusDetail =
            status === 'taken' && takenTime
              ? `Taken at ${takenTime}`
              : status === 'skipped'
                ? 'Skipped'
                : status === 'missed'
                  ? 'Missed'
                  : status === 'due'
                    ? 'Due now'
                    : 'Not yet taken';

          return `
  <article
    class="history-detail-item"
    style="--history-pill-color:${esc(dose.pill.color || COLORS[0])}"
  >
    <div
      class="history-detail-marker history-pill-marker ${esc(status)}"
      aria-hidden="true"
    ></div>

              <div class="history-detail-copy">
                <strong>${esc(dose.pill.name)}</strong>
                <span>
                  ${esc([
                    scheduledTime,
                    dose.pill.dosage || dose.pill.form || 'Medication',
                  ].filter(Boolean).join(' · '))}
                </span>
              </div>

              <div class="history-detail-status ${esc(status)}">
                <strong>${esc(doseLabel(status))}</strong>
                <span>${esc(statusDetail)}</span>
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `
    : `
      <div class="history-empty">
        <span aria-hidden="true">◷</span>
        <p>No medication doses were recorded for this day.</p>
      </div>
    `;

  const glucoseUnit = $('#display-unit')?.value || settings.glucoseUnit || 'mg/dL';

  const glucoseContent = dayGlucose.length
    ? `
      <div class="history-detail-list">
        ${dayGlucose.map(reading => {
          const value = displayReading(reading, glucoseUnit);
          const valueText = glucoseUnit === 'mmol/L'
            ? value.toFixed(1)
            : Math.round(value);

          return `
            <article class="history-detail-item glucose">
              <div class="history-detail-marker glucose" aria-hidden="true"></div>

              <div class="history-detail-copy">
                <strong>${esc(`${valueText} ${glucoseUnit}`)}</strong>
                <span>
                  ${esc([
                    fmtTime(String(reading.at).slice(11, 16)),
                    reading.context || 'Other',
                  ].join(' · '))}
                </span>
              </div>

              <div class="history-detail-status glucose">
                <strong>${esc(readingStatus(value, glucoseUnit))}</strong>
                ${reading.notes
                  ? `<span>${esc(reading.notes)}</span>`
                  : '<span>Glucose reading</span>'}
              </div>
            </article>
          `;
        }).join('')}
      </div>
    `
    : `
      <div class="history-empty">
        <span aria-hidden="true">⌁</span>
        <p>No glucose readings were recorded for this day.</p>
      </div>
    `;

  openModal(`
    <div class="modal-head">
      <div>
        <h2 id="modal-title">${esc(selectedDateLabel)}</h2>
        <p class="modal-intro">Your recorded health history for this day.</p>
      </div>
      <button class="close-modal" data-close aria-label="Close">×</button>
    </div>

    <section class="history-detail-section" aria-labelledby="history-medications-title">
      <div class="history-detail-heading">
        <h3 id="history-medications-title">Medication history</h3>
        <span>${dayDoses.length}</span>
      </div>
      ${medicationContent}
    </section>

    <section class="history-detail-section" aria-labelledby="history-glucose-title">
      <div class="history-detail-heading">
        <h3 id="history-glucose-title">Glucose readings</h3>
        <span>${dayGlucose.length}</span>
      </div>
      ${glucoseContent}
    </section>

    <div class="modal-actions history-modal-actions">
      <button
        type="button"
        class="secondary-button"
        id="history-back-to-calendar"
      >
        Back to 30-day history
      </button>
    </div>
  `);

  $('#history-back-to-calendar').onclick = openHistoryCalendar;
}

  $$('.nav-item').forEach(b => b.onclick = () => go(b.dataset.nav)); $$('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go)); $('#header-settings').onclick = openSettingsModal; $('#quick-history').onclick = openHistoryCalendar; $('#add-pill').onclick = () => openPillModal(); $('#pill-filter').onchange = renderPills; $('#pill-search').oninput = renderPills; $('#display-unit').onchange = () => { settings.glucoseUnit = $('#display-unit').value; save(KEYS.settings, settings); renderGlucose(); }; $('#trend-range').onchange = renderGlucose; $('#theme-select').onchange = () => { applyTheme($('#theme-select').value); }; $('#export-data').onclick = exportData; $('#import-file').onchange = e => { if (e.target.files?.[0]) importData(e.target.files[0]); e.target.value = ''; }; $('#load-demo').onclick = loadDemo; $('#clear-data').onclick = clearAll; $('#resync-notifications').onclick = syncNotifications; $('#open-exact-settings').onclick = async () => { const result = await HealthLedgerNotifications.openExactAlarmSettings(); if (!result.opened) toast('Open Android Settings → Apps → Health Ledger → Alarms & reminders.'); else toast('Check the Alarms & reminders setting for Health Ledger.'); }; $('#open-notification-settings').onclick = async () => { if (!HealthLedgerNotifications.isNative()) { toast('Native notification settings are available in the Android app.'); return; } const p = await HealthLedgerNotifications.plugin(); if (p.openNotificationSettings) { await p.openNotificationSettings(); } else toast('Open Android Settings → Apps → Health Ledger → Notifications.'); };
  const storedTheme = safeLoad(KEYS.theme, 'system');
applyTheme(storedTheme, false);$('#display-unit').value = settings.glucoseUnit || 'mg/dL'; $('#glucose-time').value = localISO().slice(0, 16); $('#glucose-unit').value = settings.glucoseUnit || 'mg/dL';
  const initial = (location.hash || '#today').slice(1);
  const initialPage = ['today', 'pills', 'glucose'].includes(initial)
    ? initial
    : 'today';

  currentPage = initialPage;
  pageHistory = initialPage === 'today'
    ? ['today']
    : ['today', initialPage];

  $$('.page').forEach(pageElement => {
    pageElement.classList.toggle(
      'active',
      pageElement.dataset.page === currentPage
    );
  });

  $$('.nav-item').forEach(button => {
    const isActive = button.dataset.nav === currentPage;

    button.classList.toggle('active', isActive);

    if (isActive) {
      button.setAttribute('aria-current', 'page');
    } else {
      button.removeAttribute('aria-current');
    }
  });

  render();
  HealthLedgerNotifications.registerActionListener(notification => { const id = notification?.extra?.pillId; if (id) { highlightPillId = id; go('today'); setTimeout(() => { const row = $$('.dose-card').find(el => el.textContent.includes(pills.find(p => p.id === id)?.name || '\u0000')); row?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 80); toast('Reminder opened. Review the dose and record it when appropriate.'); } });
  window.addEventListener('focus', () => { ensureDoseRecords(); renderToday(); });

  function installAndroidBackHandler() {
  const App = window.Capacitor?.Plugins?.App;

  // This runs only inside the installed Capacitor Android app.
  // Browser preview keeps working normally.
  if (!App?.addListener) return;

  App.addListener('backButton', async () => {
    // First Back closes any open add/edit/delete/settings dialog.
    if (document.querySelector('#modal-root .modal-backdrop')) {
      closeModal();
      return;
    }

    // Leaving Appointments returns to the previous page and opens More.
    if (currentPage === 'appointments') {
      returnFromAppointments();
      return;
    }

    // Remove the current page and display the page visited before it.
    if (pageHistory.length > 1) {
      pageHistory.pop();
      const previousPage = pageHistory[pageHistory.length - 1];
      go(previousPage, { fromBack: true });
      return;
    }

    // At the root screen (Today): require a second press to exit.
    const now = Date.now();

    if (now - lastBackPressAt < 2000) {
      await App.exitApp();
      return;
    }

    lastBackPressAt = now;
    toast('Press Back again to exit Health Ledger.');
  });
}

  $('#add-appointment').onclick = () => openAppointmentModal();
  $('#appointments-back').onclick = returnFromAppointments;

  installAndroidBackHandler();
})();
