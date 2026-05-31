/*
 Dashboard Strava UI script
 - Fetches recent activities
 - Renders up to top 3 mini-cards with route mini-maps
 - Allows preview (full route + IPPT analysis) and saving session
*/

async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function el(tag, cls) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    return d;
}

function activityDetail(label, value) {
    const item = el('div', 'activity-detail-item');
    const labelEl = el('span', 'activity-detail-label');
    labelEl.textContent = label;
    const valueEl = el('span', 'activity-detail-value');
    valueEl.textContent = value;
    item.append(labelEl, valueEl);
    return item;
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function calendarLinkFor(log) {
    const date = log && log.date ? encodeURIComponent(log.date) : '';
    return `/calendar${date ? `?date=${date}` : ''}`;
}

function renderRunCoachCard(rec) {
    if (!rec) return '';
    const recommendations = rec.recommendations || rec.dos || [];
    const avoid = [rec.weakness || (rec.donts || [])[0]].filter(Boolean);
    const focus = rec.safetyNote || (rec.focus_areas || []).join(' · ');

    if (!rec.summary && !recommendations.length && !avoid.length && !focus) return '';

    return `
        <div class="strava-coach-card">
            <h5>AI Personalised Coach</h5>
            ${rec.summary ? `<div class="strava-coach-summary">${escapeHtml(rec.summary)}</div>` : ''}
            <div class="strava-coach-grid">
                ${recommendations.length ? `
                    <div class="strava-coach-list dos">
                        <h6>What to do</h6>
                        <ul>${recommendations.slice(0, 3).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
                    </div>
                ` : ''}
                ${avoid.length ? `
                    <div class="strava-coach-list donts">
                        <h6>What to avoid</h6>
                            <ul>${avoid.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
                    </div>
                ` : ''}
            </div>
            ${focus ? `<div class="strava-coach-focus"><strong>Safety:</strong> ${escapeHtml(focus)}</div>` : ''}
        </div>
    `;
}

function renderMiniRoute(svgEl, latlng) {
    if (!svgEl || !latlng || !latlng.length) return;
    const w = svgEl.viewBox.baseVal.width || svgEl.clientWidth || 240;
    const h = svgEl.viewBox.baseVal.height || svgEl.clientHeight || 120;
    const lats = latlng.map(p => p[0]);
    const lons = latlng.map(p => p[1]);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLon = Math.min(...lons), maxLon = Math.max(...lons);
    const latRange = maxLat - minLat || 1e-6;
    const lonRange = maxLon - minLon || 1e-6;
    const points = latlng.map(p => {
        const x = ((p[1] - minLon) / lonRange) * (w - 8) + 4;
        const y = h - (((p[0] - minLat) / latRange) * (h - 8) + 4);
        return [x, y];
    });
    const pathD = points.map((pt, i) => (i === 0 ? `M ${pt[0]} ${pt[1]}` : `L ${pt[0]} ${pt[1]}`)).join(' ');
    svgEl.innerHTML = `\n        <path d="${pathD}" stroke="#FC4C02" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>\n    `;
}

function makeMiniCard(activity) {
    const id = activity.id;
    const card = el('div', 'strava-preview-run');
    card.dataset.activityId = id;

    const left = el('div');
    left.className = 'strava-run-copy';
    const name = document.createElement('strong');
    name.textContent = activity.name;
    const meta = el('div');
    meta.textContent = `${Number(activity.distance_km || 0).toFixed(2)} km - ${activity.time || ''} - ${activity.date || ''}`;
    left.append(name, meta);

    const mini = el('div');
    mini.className = 'strava-route-mini';
    mini.innerHTML = `<svg id="routeMini-${id}" width="160" height="90" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid meet"></svg>`;

    const actions = el('div', 'strava-preview-actions');

    const previewBtn = el('button');
    previewBtn.type = 'button';
    previewBtn.className = 'strava-btn strava-btn-primary';
    previewBtn.textContent = 'Review';
    previewBtn.addEventListener('click', () => previewActivityDashboard(activity.id, activity));

    actions.append(previewBtn);

    card.append(left, mini, actions);
    return card;
}

async function loadDashboardStrava() {
    const list = document.getElementById('dashboardStravaList');
    const previewArea = document.getElementById('dashboardStravaPreview');
    if (!list) return;
    list.innerHTML = '<div class="strava-preview-run"><div><strong>Loading Strava activities...</strong><span>Fetching your latest runs from Strava</span></div></div>';
    try {
        const data = await fetchJson('/api/strava/activities');
        const activities = (data.activities || []).slice(0, 3);
        if (!activities.length) {
            list.innerHTML = '<div class="empty-recent">No recent Strava runs found.</div>';
            return;
        }
        list.innerHTML = '';
        for (const activity of activities) {
            const card = makeMiniCard(activity);
            list.append(card);
            // fetch streams for mini-map
            (async () => {
                try {
                    const pv = await fetchJson('/api/strava/activity-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity_id: activity.id }) });
                    const svg = document.getElementById(`routeMini-${activity.id}`);
                    renderMiniRoute(svg, pv.streams.latlng || []);
                } catch (e) {
                    // ignore mini-map errors
                }
            })();
        }
    } catch (err) {
        list.innerHTML = `<div class="strava-preview-run"><div><strong style="color:#991B1B">Error</strong><span>${escapeHtml(err.message)}</span></div></div>`;
    }
}

async function previewActivityDashboard(activityId, activityMeta) {
    const preview = document.getElementById('dashboardStravaPreview');
    const list = document.getElementById('dashboardStravaList');
    if (list) list.style.display = 'none';
    preview.style.display = 'block';
    preview.innerHTML = `<div style="padding:12px;border:1px solid #E2E8F0;border-radius:8px;background:#fff">Loading preview...</div>`;
    try {
        const data = await fetchJson('/api/strava/activity-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity_id: activityId }) });
        const activity = data.activity;
        const streams = data.streams || {};
        const latlng = streams.latlng || [];
        const hasGps = latlng && latlng.length && latlng[0] && latlng[0].length === 2;
        let mapHtml = '';
        if (hasGps) {
            mapHtml = `<div id="dashboardRouteMap" class="strava-route-map"></div>`;
        } else {
            mapHtml = `<div class="strava-empty-map">No GPS route available for this activity.</div>`;
        }

        preview.innerHTML = `
            <div class="strava-preview-panel">
                <div class="strava-preview-top">
                    <div class="strava-preview-title">
                        <span>Run preview</span>
                        <strong>${escapeHtml(activity.name)}</strong>
                        <small>${escapeHtml(activityMeta ? activityMeta.date : '')}</small>
                    </div>
                    <div class="strava-preview-stats">
                        <div><span>Distance</span><strong>${(activity.distance || 0).toFixed(2)} km</strong></div>
                        <div><span>Time</span><strong>${escapeHtml(activityMeta ? activityMeta.time : '')}</strong></div>
                        <div><span>Pace</span><strong>${escapeHtml(activity.pace || '--/km')}</strong></div>
                    </div>
                </div>
                ${mapHtml}
                <div id="dashboardIpptArea"></div>
                <div class="strava-preview-footer">
                    <button id="dashboardPreviewBackBtn" class="strava-btn strava-btn-ghost" type="button">Back</button>
                    <button id="dashboardAnalyzeBtn" class="strava-btn strava-btn-secondary" type="button">Analyse</button>
                    <button id="dashboardSaveBtn" class="strava-btn strava-btn-primary" type="button" disabled>Save session</button>
                </div>
            </div>
        `;

        if (hasGps && typeof L !== 'undefined') {
            try {
                const coords = latlng.map(p => [p[0], p[1]]);
                const map = L.map('dashboardRouteMap', { scrollWheelZoom: false, zoomControl: true });
                L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
                    attribution: '&copy; <a href="https://www.openstreetmap.org">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
                }).addTo(map);
                const poly = L.polyline(coords, { color: '#FC4C02', weight: 4, opacity: 0.95 }).addTo(map);
                map.fitBounds(poly.getBounds(), { padding: [20, 20] });
                L.circleMarker(coords[0], { radius: 5, color: '#10B981', fillColor: '#10B981' }).addTo(map);
                L.circleMarker(coords[coords.length - 1], { radius: 5, color: '#2563EB', fillColor: '#2563EB' }).addTo(map);
                preview._leafletMap = map;
            } catch (e) {
                // fallback
            }
        }
        const backBtn = document.getElementById('dashboardPreviewBackBtn');
        if (backBtn) backBtn.addEventListener('click', () => {
            if (preview._leafletMap) { try { preview._leafletMap.remove(); } catch (e) {} preview._leafletMap = null; }
            preview.innerHTML = '';
            preview.style.display = 'none';
            if (list) list.style.display = '';
        });
        document.getElementById('dashboardAnalyzeBtn').addEventListener('click', async () => {
            await analyzeIpptPreviewDashboard(activityId);
        });
        document.getElementById('dashboardSaveBtn').addEventListener('click', async () => {
            await saveSessionDashboard(activityId);
        });
    } catch (err) {
        preview.innerHTML = `<div style="padding:12px;background:#FEE2E2;border:1px solid #FECACA;border-radius:8px;color:#991B1B">${escapeHtml(err.message)}</div>`;
    }
}

async function analyzeIpptPreviewDashboard(activityId) {
    const area = document.getElementById('dashboardIpptArea');
    area.innerHTML = '<div class="loading-spinner active"><div class="spinner"></div><p>Analysing 2.4km...</p></div>';
    try {
        const data = await fetchJson('/api/strava/ippt-24/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity_id: activityId }) });
        const r = data.result;
        const rec = data.recommendation || {};
        area.innerHTML = `
            <div class="strava-analysis-card">
                <div class="strava-analysis-metrics">
                    <div><span>2.4km time</span><strong>${escapeHtml(r.official_time)}</strong></div>
                    <div><span>Status</span><strong>${escapeHtml(r.status)}</strong></div>
                    <div><span>Points</span><strong>${escapeHtml(r.run_points)}</strong></div>
                </div>
                ${renderRunCoachCard(rec)}
            </div>
        `;
        document.getElementById('dashboardSaveBtn').disabled = false;
    } catch (err) {
        area.innerHTML = `<div style="padding:10px;background:#FEE2E2;border:1px solid #FECACA;border-radius:8px;color:#991B1B">${escapeHtml(err.message)}</div>`;
    }
}

async function saveSessionDashboard(activityId) {
    const saveBtn = document.getElementById('dashboardSaveBtn');
    if (!saveBtn) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
        await fetchJson('/api/strava/ippt-24', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity_id: activityId }) });
        let aiRecommendation = null;
        try {
            const recData = await fetchJson('/api/strava/ippt-24/recommendation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activity_id: activityId }) });
            aiRecommendation = recData.ai_recommendation || null;
        } catch (recommendationError) {
            console.warn('Saved Strava run without AI recommendation:', recommendationError);
        }
        const importData = await fetchJson('/api/strava/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activity_id: activityId, ai_recommendation: aiRecommendation })
        });
        // show simple success
        const preview = document.getElementById('dashboardStravaPreview');
        preview.innerHTML = `
            <div class="strava-import-status">
                Saved session: ${escapeHtml(importData.log.name)}
                <a href="${calendarLinkFor(importData.log)}" style="margin-left:8px;color:inherit;text-decoration:underline">View in Calendar</a>
            </div>
        `;
        saveBtn.textContent = 'Saved';
        saveBtn.disabled = true;
    } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save session';
        const preview = document.getElementById('dashboardStravaPreview');
        preview.innerHTML = `<div class="strava-import-status error">${escapeHtml(err.message)}</div>`;
    }
}

document.addEventListener('DOMContentLoaded', function() {
    loadDashboardStrava();
});
