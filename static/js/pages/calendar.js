(function () {
  const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const WEEKDAYS = ['S','M','T','W','T','F','S'];

  const api = {
    logs: '/api/activity-records',
    log: (logId) => `/api/activity-records/${logId}`
  };

  let today = new Date();
  const requestedDate = new URLSearchParams(window.location.search).get('date');
  const requestedDateMatch = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate || '') ? requestedDate : null;
  let currentYear = requestedDateMatch ? Number(requestedDateMatch.slice(0, 4)) : today.getFullYear();
  let currentMonth = requestedDateMatch ? Number(requestedDateMatch.slice(5, 7)) - 1 : today.getMonth();
  let selectedDate = requestedDateMatch;
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
        distance_km: log.distance_km || '',
        moving_time: log.moving_time || '',
        run_time_seconds: log.run_time_seconds || '',
        official_time: log.official_time || '',
        calendar_run_time: log.calendar_run_time || '',
        run_points: log.run_points || '',
        run_status: log.run_status || '',
        ai_recommendation: log.ai_recommendation || null
      });
    });
  }

  async function loadEntries() {
    const response = await fetch(api.logs);
    const data = await response.json();
    if (!data.success) {
      alert(data.error || 'Could not load calendar entries.');
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
      empty.innerHTML = `<div class="icon">🏃</div><p>No entries for this day.</p>`;
      panel.appendChild(empty);
      return;
    }

    dayEntries.forEach((entry) => {
      const metricsHtml = renderEntryMetrics(entry);
      const card = document.createElement('div');
      card.className = 'agenda-card';
      card.innerHTML = `
        <div class="agenda-item">
          <div class="agenda-color-bar ${entry.type}"></div>
          <div class="agenda-details">
            <div style="display:flex;align-items:center;">
              <div>
                <div class="agenda-date">${friendlyDate(key)} &middot; ${escapeHtml(typeName(entry.type))}</div>
                <div class="agenda-name">${escapeHtml(entry.name)}</div>
              </div>
              <button class="delete-btn" title="Delete entry" onclick="deleteEntry(${entry.id})">&#x2715;</button>
            </div>
            <div class="recording-metric-container">
              ${metricsHtml}
            </div>
            ${renderAiCoachBlock(entry.ai_recommendation)}
          </div>
        </div>`;
      panel.appendChild(card);
    });
  }

  function metricBlock(label, value) {
    if (!value) return '';
    return `
      <div class="metric-block-large">
        <div class="metric-label-small">${escapeHtml(label)}</div>
        <div class="metric-value-huge">${escapeHtml(value)}</div>
      </div>`;
  }

  function metricDivider(previousHtml, nextHtml) {
    return previousHtml && nextHtml ? '<div class="metric-divider-line"></div>' : '';
  }

  function parseDurationSeconds(value) {
    if (value === null || value === undefined || value === '') return 0;
    if (Number.isFinite(Number(value))) return Number(value);
    const match = String(value).trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?/);
    if (!match) return 0;
    const first = Number(match[1]);
    const second = Number(match[2]);
    const third = match[3] === undefined ? null : Number(match[3]);
    return third === null
      ? first * 60 + second
      : first * 3600 + second * 60 + third;
  }

  function formatDuration(seconds) {
    const total = Math.round(Number(seconds) || 0);
    if (!total) return '';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours) {
      return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${minutes}:${String(secs).padStart(2, '0')}`;
  }

  function parseDistanceKm(entry) {
    const direct = Number(entry.distance_km || 0);
    if (direct > 0) return direct;
    const scoreMatch = String(entry.score || '').match(/(\d+(?:\.\d+)?)\s*km/i);
    return scoreMatch ? Number(scoreMatch[1]) : 0;
  }

  function estimated24Time(entry) {
    const distanceKm = parseDistanceKm(entry);
    const seconds = parseDurationSeconds(entry.run_time_seconds || entry.moving_time || entry.time);
    if (distanceKm < 2.4 || !seconds) return '';
    return formatDuration(seconds * (2.4 / distanceKm));
  }

  function renderEntryMetrics(entry) {
    if (entry.type === 'run') {
      const runTime = entry.calendar_run_time || entry.official_time || estimated24Time(entry);
      const points = entry.run_points !== '' && entry.run_points !== null && entry.run_points !== undefined
        ? `${entry.run_points} pts`
        : '';
      const officialHtml = metricBlock('2.4km Time', runTime || '--:--');
      const pointsHtml = metricBlock('Run Points', points);
      return `${officialHtml}${metricDivider(officialHtml, pointsHtml)}${pointsHtml}`;
    }

    const scoreHtml = metricBlock('Score / Reps', entry.score);
    const timeHtml = metricBlock('Time', entry.time);
    return `${scoreHtml}${metricDivider(scoreHtml, timeHtml)}${timeHtml}`;
  }

  function typeName(t) {
    if (t === 'pushup') return 'Push-up';
    if (t === 'situp') return 'Sit-up';
    if (t === 'run') return '2.4km Run';
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  function aiTextHtml(text) {
    if (window.FitLahAiTextFormat) return FitLahAiTextFormat.boldToHtml(text);
    return escapeHtml(text);
  }

  function renderAiCoachBlock(ai) {
    if (!ai) return '';

    if (typeof ai === 'string') {
      return `
        <div class="ai-coach-block">
          <h5>AI PERSONALISED COACH</h5>
          <div class="ai-coach-summary">${aiTextHtml(ai)}</div>
        </div>`;
    }

    if (!ai.summary) return '';

    const dos = (ai.dos || ai.recommendations || []).map(item => `<li>${aiTextHtml(item)}</li>`).join('');
    const dontItems = ai.donts || [ai.weakness].filter(Boolean);
    const donts = dontItems.map(item => `<li>${aiTextHtml(item)}</li>`).join('');
    const focus = ai.safetyNote || (ai.focus_areas || []).join(' · ');
    return `
      <div class="ai-coach-block">
        <h5>AI PERSONALISED COACH</h5>
        <div class="ai-coach-summary">${aiTextHtml(ai.summary)}</div>
        <div class="ai-coach-grid">
          ${dos ? `<div class="ai-coach-list dos"><h6>RECOMMENDED ACTIONS</h6><ul>${dos}</ul></div>` : ''}
          ${donts ? `<div class="ai-coach-list donts"><h6>AVOID NEXT</h6><ul>${donts}</ul></div>` : ''}
        </div>
        ${focus ? `<div class="ai-coach-focus"><strong>${ai.safetyNote ? 'Safety note' : 'Focus area'}:</strong> ${aiTextHtml(focus)}</div>` : ''}
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

  selectedDate = requestedDateMatch || dateKey(today.getFullYear(), today.getMonth(), today.getDate());
  renderCalendar();
  renderDetails();
  loadEntries();

  window.changeMonth = changeMonth;
  window.deleteEntry = deleteEntry;
})();
