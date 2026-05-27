(function () {
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAYS = ['S','M','T','W','T','F','S'];

  const api = {
    logs: '/api/performance-log',
    log: (logId) => `/api/performance-log/${logId}`
  };

  let today = new Date();
  let currentYear = today.getFullYear();
  let currentMonth = today.getMonth();
  let selectedDate = null;
  let entries = {};

  function setEntriesFromLogs(logs) {
    entries = {};
    logs.forEach(log => {
      const key = log.date;
      if (!entries[key]) entries[key] = [];
      entries[key].push({
        id: log.id,
        name: log.name || log.event,
        type: log.type || 'logged',
        score: log.score || '',
        time: log.time || '',
        notes: log.notes || '',
        ai_recommendation: log.ai_recommendation || null,
        session_id: log.session_id || null
      });
    });
  }

  async function loadEntries() {
    const response = await fetch(api.logs);
    const data = await response.json();
    if (!data.success) {
      alert(data.error || 'Could not load performance log.');
      return;
    }
    setEntriesFromLogs(data.logs);
    renderCalendar();
    renderDetails();
  }

  function dateKey(y, m, d) {
    return `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  function friendlyDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    return `${MONTHS[m-1]} ${d}, ${y}`;
  }

  function renderCalendar() {
    const title = document.getElementById('monthTitle');
    title.textContent = `${MONTHS[currentMonth]} ${currentYear}`;

    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = '';

    WEEKDAYS.forEach(w => {
      const el = document.createElement('div');
      el.className = 'weekday-label';
      el.textContent = w;
      grid.appendChild(el);
    });

    const firstDay = new Date(currentYear, currentMonth, 1).getDay();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

    for (let i = 0; i < firstDay; i++) {
      const el = document.createElement('div');
      el.className = 'calendar-day empty';
      grid.appendChild(el);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const key = dateKey(currentYear, currentMonth, day);
      const dayEntries = entries[key] || [];
      const isToday = (today.getFullYear() === currentYear && today.getMonth() === currentMonth && today.getDate() === day);
      const isSelected = selectedDate === key;

      const el = document.createElement('div');
      el.className = 'calendar-day' + (isToday ? ' today' : '') + (isSelected ? ' active-selected' : '');
      el.innerHTML = `<span>${day}</span>`;

      if (dayEntries.length > 0) {
        const dots = document.createElement('div');
        dots.className = 'day-dots';
        const types = [...new Set(dayEntries.map(e => e.type))];
        types.forEach(t => {
          const dot = document.createElement('div');
          dot.className = `dot ${t}`;
          dots.appendChild(dot);
        });
        el.appendChild(dots);
      }

      el.addEventListener('click', () => selectDay(key));
      grid.appendChild(el);
    }
  }

  function selectDay(key) {
    selectedDate = key;
    renderCalendar();
    renderDetails();
  }

  function renderDetails() {
    const panel = document.getElementById('detailsPanel');
    panel.innerHTML = '';

    const key = selectedDate;

    if (!key) {
      panel.innerHTML = `<div class="no-entry"><div class="icon">📅</div><p>Select a date to view entries.</p></div>`;
      return;
    }

    const dayEntries = entries[key] || [];
    const header = document.createElement('div');
    header.className = 'selected-date-header';
    header.textContent = friendlyDate(key);
    panel.appendChild(header);

    if (dayEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'no-entry';
      empty.innerHTML = `<div class="icon">🏃</div><p>No entries for this day.<br><strong>Click "Add Entry"</strong> to log something.</p>`;
      panel.appendChild(empty);
      return;
    }

    dayEntries.forEach((entry) => {
      const card = document.createElement('div');
      card.className = 'agenda-card';
      card.innerHTML = `
        <div class="agenda-item">
          <div class="agenda-color-bar ${entry.type}"></div>
          <div class="agenda-details">
            <div style="display:flex;align-items:center;">
              <div>
                <div class="agenda-date">${friendlyDate(key)} &middot; ${typeName(entry.type)}</div>
                <div class="agenda-name">${entry.name}</div>
              </div>
              <button class="delete-btn" title="Delete entry" onclick="deleteEntry(${entry.id})">&#x2715;</button>
            </div>
            <div class="recording-metric-container">
              ${entry.score ? `<div class="metric-block-large">
                <div class="metric-label-small">Score / Reps</div>
                <div class="metric-value-huge">${entry.score}</div>
              </div>` : ''}
              ${entry.score && entry.time ? '<div class="metric-divider-line"></div>' : ''}
              ${entry.time ? `<div class="metric-block-large">
                <div class="metric-label-small">Time</div>
                <div class="metric-value-huge">${entry.time}</div>
              </div>` : ''}
              ${entry.notes ? `${(entry.score || entry.time) ? '<div class="metric-divider-line"></div>' : ''}<div class="metric-block-large" style="flex:1;">
                <div class="metric-label-small">Notes</div>
                <div style="font-size:13.5px;color:#334155;line-height:1.5;">${escapeHtml(entry.notes)}</div>
              </div>` : ''}
            </div>
            ${renderAiCoachBlock(entry.ai_recommendation)}
          </div>
        </div>`;
      panel.appendChild(card);
    });
  }

  function typeName(t) {
    return t === 'logged' ? 'Workout' : t.toUpperCase();
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function renderAiCoachBlock(ai) {
    if (!ai) return '';

    if (typeof ai === 'string') {
      return `
        <div class="ai-coach-block">
          <h5>✦ AI Personalised Coach</h5>
          <div class="ai-coach-summary">${escapeHtml(ai)}</div>
        </div>`;
    }

    if (!ai.summary) return '';

    const dos = (ai.dos || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
    const donts = (ai.donts || []).map(item => `<li>${escapeHtml(item)}</li>`).join('');
    const focus = (ai.focus_areas || []).join(' · ');
    return `
      <div class="ai-coach-block">
        <h5>✦ AI Personalised Coach</h5>
        <div class="ai-coach-summary">${escapeHtml(ai.summary)}</div>
        <div class="ai-coach-grid">
          ${dos ? `<div class="ai-coach-list dos"><h6>What to do</h6><ul>${dos}</ul></div>` : ''}
          ${donts ? `<div class="ai-coach-list donts"><h6>What to avoid</h6><ul>${donts}</ul></div>` : ''}
        </div>
        ${focus ? `<div class="ai-coach-focus"><strong>Next focus:</strong> ${escapeHtml(focus)}</div>` : ''}
      </div>`;
  }

  async function deleteEntry(logId) {
    if (!confirm('Delete this entry?')) return;
    const response = await fetch(api.log(logId), {
      method: 'DELETE'
    });
    const data = await response.json();
    if (!data.success) {
      alert(data.error || 'Could not delete entry.');
      return;
    }
    await loadEntries();
  }

  function changeMonth(dir) {
    currentMonth += dir;
    if (currentMonth > 11) { currentMonth = 0; currentYear++; }
    if (currentMonth < 0) { currentMonth = 11; currentYear--; }
    renderCalendar();
  }

  function openModal() {
    document.getElementById('modalOverlay').classList.add('open');
    document.getElementById('eventName').focus();
  }

  function closeModal() {
    document.getElementById('modalOverlay').classList.remove('open');
    document.getElementById('eventName').value = '';
    document.getElementById('eventScore').value = '';
    document.getElementById('eventTime').value = '';
    document.getElementById('eventNotes').value = '';
    document.getElementById('eventType').value = 'logged';
  }

  function closeModalOnBg(e) {
    if (e.target === document.getElementById('modalOverlay')) closeModal();
  }

  async function saveEntry() {
    const name = document.getElementById('eventName').value.trim();
    if (!name) {
      alert('Please enter an event name.');
      return;
    }

    const key = selectedDate || dateKey(today.getFullYear(), today.getMonth(), today.getDate());
    const response = await fetch(api.logs, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        date: key,
        name,
        type: document.getElementById('eventType').value,
        score: document.getElementById('eventScore').value.trim(),
        time: document.getElementById('eventTime').value.trim(),
        notes: document.getElementById('eventNotes').value.trim(),
      })
    });

    const data = await response.json();
    if (!data.success) {
      alert(data.error || 'Could not save entry.');
      return;
    }

    closeModal();

    const [y, m] = key.split('-').map(Number);
    currentYear = y;
    currentMonth = m - 1;
    selectedDate = key;
    await loadEntries();
  }

  selectedDate = dateKey(today.getFullYear(), today.getMonth(), today.getDate());
  renderCalendar();
  renderDetails();
  loadEntries();

  window.changeMonth = changeMonth;
  window.openModal = openModal;
  window.closeModal = closeModal;
  window.closeModalOnBg = closeModalOnBg;
  window.saveEntry = saveEntry;
  window.deleteEntry = deleteEntry;
})();
