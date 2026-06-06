async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

function postActivityJson(url, activityId) {
    return fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: activityId })
    });
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function aiTextHtml(value) {
    if (window.FitLahAiTextFormat) return FitLahAiTextFormat.boldToHtml(value);
    return escapeHtml(value);
}

function uniqueAiItems(items) {
    const seen = new Set();
    return (items || []).filter(item => {
        const key = String(item || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function formatValidityStatus(value) {
    return String(value || '').toLowerCase() === 'valid' ? 'Valid' : 'Invalid';
}

function validityClass(value) {
    return String(value || '').toLowerCase() === 'valid' ? 'valid' : 'invalid';
}

function calendarLinkFor(log) {
    const date = log && log.date ? encodeURIComponent(log.date) : '';
    return `/calendar${date ? `?date=${date}` : ''}`;
}

function renderRunCoachCard(rec) {
    if (!rec) return '';
    const recommendations = rec.recommendations || rec.dos || [];
    const avoid = uniqueAiItems([rec.weakness, ...(rec.donts || [])]);
    const focus = rec.safetyNote || (rec.focus_areas || []).join(' | ') || (rec.strength ? `Strength: ${rec.strength}` : '');

    if (!rec.summary && !recommendations.length && !avoid.length && !focus) return '';

    return `
        <div class="strava-coach-card">
            <h5><img class="ai-summary-inline-icon" src="/static/icons/aisummary.png" alt="">AI PERSONALISED COACH</h5>
            ${rec.summary ? `<div class="strava-coach-summary">${aiTextHtml(rec.summary)}</div>` : ''}
            <div class="strava-coach-grid">
                ${recommendations.length ? `
                    <div class="strava-coach-list dos">
                        <h6><img src="/static/icons/greentarget.png" alt="">RECOMMENDED ACTIONS</h6>
                        <ul>${recommendations.map(item => `<li>${aiTextHtml(item)}</li>`).join('')}</ul>
                    </div>
                ` : ''}
                ${avoid.length ? `
                    <div class="strava-coach-list donts">
                        <h6><img src="/static/icons/exclaim.png" alt="">AVOID NEXT</h6>
                        <ul>${avoid.map(item => `<li>${aiTextHtml(item)}</li>`).join('')}</ul>
                    </div>
                ` : ''}
            </div>
            ${focus ? `
                <div class="strava-coach-focus">
                    <img src="/static/icons/bluetarget.png" alt="">
                    <span><strong>${rec.safetyNote ? 'Safety note' : 'Focus area'}:</strong> ${aiTextHtml(focus)}</span>
                </div>
            ` : ''}
        </div>
    `;
}

function loadingCard(label) {
    return `
        <div class="strava-loading-card ai-loading-card">
            <span class="ai-loading-dot"></span>
            <span>${escapeHtml(label)}</span>
        </div>
    `;
}

function speedForIndex(streams, index) {
    const velocity = streams.velocity_smooth || [];
    const directSpeed = Number(velocity[index]);
    if (Number.isFinite(directSpeed) && directSpeed > 0) return directSpeed;

    const times = streams.time || [];
    const distances = streams.distance || [];
    if (index <= 0 || index >= times.length || index >= distances.length) return null;

    const deltaTime = Number(times[index]) - Number(times[index - 1]);
    const deltaDistance = Number(distances[index]) - Number(distances[index - 1]);
    if (deltaTime <= 0 || deltaDistance < 0) return null;
    return deltaDistance / deltaTime;
}

function percentile(values, ratio) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
    return sorted[index];
}

function colorForSpeed(speed, minSpeed, maxSpeed) {
    if (!Number.isFinite(speed)) return '#94A3B8';
    if (!Number.isFinite(minSpeed) || !Number.isFinite(maxSpeed) || maxSpeed <= minSpeed) return '#FC4C02';

    const ratio = Math.max(0, Math.min(1, (speed - minSpeed) / (maxSpeed - minSpeed)));
    if (ratio < 0.25) return '#DC2626';
    if (ratio < 0.5) return '#F97316';
    if (ratio < 0.75) return '#FACC15';
    return '#16A34A';
}

function routeSpeedSegments(latlng, streams) {
    const coords = latlng
        .filter(point => Array.isArray(point) && point.length === 2)
        .map(point => [Number(point[0]), Number(point[1])])
        .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
    if (coords.length < 2) return { coords, segments: [] };

    const speeds = coords
        .map((_, index) => speedForIndex(streams, index))
        .filter(speed => Number.isFinite(speed) && speed > 0);
    const minSpeed = percentile(speeds, 0.08);
    const maxSpeed = percentile(speeds, 0.92);

    const segments = [];
    for (let index = 1; index < coords.length; index += 1) {
        const speed = speedForIndex(streams, index);
        const color = colorForSpeed(speed, minSpeed, maxSpeed);
        const previous = segments[segments.length - 1];
        if (previous && previous.color === color) {
            previous.points.push(coords[index]);
        } else {
            segments.push({
                points: [coords[index - 1], coords[index]],
                color
            });
        }
    }

    return { coords, segments };
}

function hasUsableGpsRoute(latlng) {
    return (latlng || []).filter(point => (
        Array.isArray(point) &&
        point.length === 2 &&
        Number.isFinite(Number(point[0])) &&
        Number.isFinite(Number(point[1]))
    )).length >= 2;
}

function mountRouteMap(container, streams) {
    const { coords, segments } = routeSpeedSegments(streams.latlng || [], streams);
    if (coords.length < 2) return;

    const map = L.map('stravaRouteMap', { scrollWheelZoom: false, zoomControl: true });
    L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>'
    }).addTo(map);

    const routeLayer = L.featureGroup().addTo(map);
    if (segments.length) {
        segments.forEach(segment => {
            L.polyline(segment.points, {
                color: segment.color,
                weight: 5,
                opacity: 0.95,
                lineCap: 'round',
                lineJoin: 'round'
            }).addTo(routeLayer);
        });
    } else {
        L.polyline(coords, { color: '#FC4C02', weight: 4, opacity: 0.95 }).addTo(routeLayer);
    }

    map.fitBounds(routeLayer.getBounds(), { padding: [20, 20] });
    L.circleMarker(coords[0], { radius: 5, color: '#10B981', fillColor: '#10B981' }).addTo(map);
    L.circleMarker(coords[coords.length - 1], { radius: 5, color: '#2563EB', fillColor: '#2563EB' }).addTo(map);
    container._leafletMap = map;
}

async function analyzeIpptPreview(activityId, button) {
    const area = document.getElementById('stravaIpptArea');
    if (!area) return;
    if (button) {
        button.disabled = true;
        button.textContent = 'Analysing...';
    }
    area.innerHTML = loadingCard('AI is analysing 2.4km');

    try {
        const data = await postActivityJson('/api/strava/ippt-24/preview', activityId);
        const r = data.result;
        const rec = data.recommendation || {};
        const statusClass = validityClass(r.status);
        area.innerHTML = `
            <div class="strava-analysis-card">
                <div class="strava-analysis-metrics">
                    <div class="strava-analysis-metric">
                        <span class="strava-analysis-icon"><img src="/static/icons/timer.png" alt=""></span>
                        <span class="strava-analysis-copy">
                            <span>2.4KM TIME</span>
                            <strong>${escapeHtml(r.official_time)}</strong>
                        </span>
                    </div>
                    <div class="strava-analysis-metric">
                        <span class="strava-analysis-icon ${statusClass}"><img src="/static/icons/checkmark.png" alt=""></span>
                        <span class="strava-analysis-copy">
                            <span>STATUS</span>
                            <strong class="strava-status-value"><span class="strava-status-pill ${statusClass}">${formatValidityStatus(r.status)}</span></strong>
                        </span>
                    </div>
                    <div class="strava-analysis-metric">
                        <span class="strava-analysis-icon"><img src="/static/icons/star.png" alt=""></span>
                        <span class="strava-analysis-copy">
                            <span>POINTS</span>
                            <strong>${escapeHtml(r.run_points)}</strong>
                        </span>
                    </div>
                </div>
                ${renderRunCoachCard(rec)}
            </div>
        `;
        const saveBtn = document.getElementById('stravaSaveBtn');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.style.display = '';
        }
        if (button) button.style.display = 'none';
    } catch (err) {
        const saveBtn = document.getElementById('stravaSaveBtn');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.style.display = 'none';
        }
        if (button) {
            button.disabled = false;
            button.textContent = 'Analyse';
        }
        area.innerHTML = `<div class="strava-import-status error">${escapeHtml(err.message)}</div>`;
    }
}

async function saveSession(activityId) {
    const saveBtn = document.getElementById('stravaSaveBtn');
    const calendarBtn = document.getElementById('stravaCalendarBtn');
    const resultArea = document.getElementById('stravaSaveResult');
    if (!saveBtn || !resultArea) return;

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    resultArea.innerHTML = '';

    try {
        const importData = await postActivityJson('/api/strava/ippt-24', activityId);
        resultArea.innerHTML = '';
        saveBtn.style.display = 'none';
        if (calendarBtn) {
            calendarBtn.href = calendarLinkFor(importData.log);
            calendarBtn.style.display = '';
        }
    } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save Session';
        if (calendarBtn) calendarBtn.style.display = 'none';
        resultArea.innerHTML = `<div class="strava-import-status error">${escapeHtml(err.message)}</div>`;
    }
}

async function loadPreview() {
    const config = window.FitLahStravaPreviewConfig || {};
    const activityId = config.activityId;
    const container = document.getElementById('stravaRunPreview');
    if (!container || !activityId) return;

    try {
        const data = await postActivityJson('/api/strava/activity-preview', activityId);
        const activity = data.activity;
        const streams = data.streams || {};
        const latlng = streams.latlng || [];
        const hasGps = hasUsableGpsRoute(latlng);

        container.innerHTML = `
            <div class="strava-preview-top">
                <div class="strava-preview-title">
                    <span>Run preview</span>
                    <strong>${escapeHtml(activity.name)}</strong>
                    <small>${escapeHtml(activity.date || '')}</small>
                </div>
                <div class="strava-preview-stats">
                    <div><span>Distance</span><strong>${Number(activity.distance || 0).toFixed(2)} km</strong></div>
                    <div><span>Time</span><strong>${escapeHtml(activity.time || '')}</strong></div>
                    <div><span>Pace</span><strong>${escapeHtml(activity.pace || '--/km')}</strong></div>
                </div>
            </div>
            ${hasGps ? `
                <div class="strava-route-map-wrap">
                    <div id="stravaRouteMap" class="strava-route-map"></div>
                    <div class="strava-speed-legend" aria-label="Route speed colour legend">
                        <span>Slower</span>
                        <i></i>
                        <span>Faster</span>
                    </div>
                </div>
            ` : '<div class="strava-empty-map">No GPS route available for this activity.</div>'}
            <div id="stravaIpptArea"></div>
            <div id="stravaSaveResult"></div>
            <div class="strava-preview-footer">
                <a class="strava-btn strava-btn-ghost" href="${escapeHtml(config.dashboardUrl || '/dashboard')}">Back</a>
                <button id="stravaAnalyzeBtn" class="strava-btn strava-btn-secondary" type="button">Analyse</button>
                <button id="stravaSaveBtn" class="strava-btn strava-btn-primary" type="button" disabled style="display:none">Save Session</button>
                <a id="stravaCalendarBtn" class="strava-calendar-btn" href="/calendar" style="display:none">View In Calendar</a>
            </div>
        `;

        if (hasGps && typeof L !== 'undefined') {
            mountRouteMap(container, streams);
        }

        document.getElementById('stravaAnalyzeBtn').addEventListener('click', async (event) => {
            await analyzeIpptPreview(activityId, event.currentTarget);
        });
        document.getElementById('stravaSaveBtn').addEventListener('click', async () => {
            await saveSession(activityId);
        });
    } catch (err) {
        container.innerHTML = `<div class="strava-import-status error">${escapeHtml(err.message)}</div>`;
    }
}

window.addEventListener('beforeunload', () => {
    const container = document.getElementById('stravaRunPreview');
    if (container && container._leafletMap) {
        try { container._leafletMap.remove(); } catch (e) {}
    }
});

document.addEventListener('DOMContentLoaded', loadPreview);
