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

const stravaPreviewCache = new Map();
const stravaAnalysisCache = new Map();

function postActivityJson(url, activityId) {
    return fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ activity_id: activityId })
    });
}

async function getActivityPreview(activityId) {
    if (!stravaPreviewCache.has(activityId)) {
        stravaPreviewCache.set(activityId, postActivityJson('/api/strava/activity-preview', activityId));
    }
    return stravaPreviewCache.get(activityId);
}

async function getIpptAnalysis(activityId) {
    if (!stravaAnalysisCache.has(activityId)) {
        stravaAnalysisCache.set(activityId, postActivityJson('/api/strava/ippt-24/preview', activityId));
    }
    return stravaAnalysisCache.get(activityId);
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

function formatValidityStatus(value) {
    return String(value || '').toLowerCase() === 'valid' ? 'Valid' : 'Invalid';
}

function calendarLinkFor(log) {
    const date = log && log.date ? encodeURIComponent(log.date) : '';
    return `/calendar${date ? `?date=${date}` : ''}`;
}

function setWebcamLaunchCardHidden(hidden) {
    const card = document.getElementById('webcamLaunchCard');
    if (!card) return;
    card.style.display = hidden ? 'none' : '';
    const actionStack = card.closest('.action-stack.single-action');
    if (actionStack) actionStack.style.display = hidden ? 'none' : '';
}

function setTemporaryDisplay(element, hidden) {
    if (!element) return;
    if (hidden) {
        if (!element.dataset.previousDisplay) {
            element.dataset.previousDisplay = element.style.display || '__empty__';
        }
        element.style.setProperty('display', 'none', 'important');
        return;
    }

    if (element.dataset.previousDisplay) {
        const previous = element.dataset.previousDisplay;
        element.style.removeProperty('display');
        if (previous !== '__empty__') element.style.display = previous;
        delete element.dataset.previousDisplay;
    } else {
        element.style.removeProperty('display');
    }
}

function setDashboardRunReviewMode(active) {
    const grid = document.querySelector('.dashboard-grid');
    const sideStack = document.querySelector('.side-stack');
    const previewPanel = document.querySelector('.strava-sync-preview');
    const trainingPanel = document.querySelector('.training-panel');
    const actionStack = document.querySelector('.training-panel .action-stack');
    const ipptPanel = document.querySelector('.ippt-panel');
    const recentPanel = document.querySelector('.recent-panel');

    if (grid) grid.classList.toggle('strava-review-active', active);
    if (sideStack) sideStack.classList.toggle('dashboard-review-hidden', active);
    if (grid) {
        if (active) {
            if (!grid.dataset.previousGridTemplateColumns) {
                grid.dataset.previousGridTemplateColumns = grid.style.gridTemplateColumns || '__empty__';
            }
            grid.style.setProperty('grid-template-columns', 'minmax(0, 1fr)', 'important');
        } else if (grid.dataset.previousGridTemplateColumns) {
            const previous = grid.dataset.previousGridTemplateColumns;
            grid.style.removeProperty('grid-template-columns');
            if (previous !== '__empty__') grid.style.gridTemplateColumns = previous;
            delete grid.dataset.previousGridTemplateColumns;
        }
    }
    if (trainingPanel) {
        trainingPanel.classList.toggle('strava-review-focused', active);
    }

    setTemporaryDisplay(sideStack, active);
    setTemporaryDisplay(ipptPanel, active);
    setTemporaryDisplay(recentPanel, active);
    setTemporaryDisplay(actionStack, active);
    if (trainingPanel && previewPanel) {
        Array.from(trainingPanel.children).forEach(child => {
            if (child !== previewPanel) setTemporaryDisplay(child, active);
        });
    }

    if (previewPanel && active) {
        previewPanel.classList.add('visible');
        previewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function renderRunCoachCard(rec) {
    if (!rec) return '';
    const recommendations = rec.recommendations || rec.dos || [];
    const avoid = [rec.weakness || (rec.donts || [])[0]].filter(Boolean);
    const focus = rec.safetyNote || (rec.focus_areas || []).join(' · ');

    if (!rec.summary && !recommendations.length && !avoid.length && !focus) return '';

    return `
        <div class="strava-coach-card">
            <h5>AI PERSONALISED COACH</h5>
            ${rec.summary ? `<div class="strava-coach-summary">${escapeHtml(rec.summary)}</div>` : ''}
            <div class="strava-coach-grid">
                ${recommendations.length ? `
                    <div class="strava-coach-list dos">
                        <h6>RECOMMENDED ACTIONS</h6>
                        <ul>${recommendations.slice(0, 3).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
                    </div>
                ` : ''}
                ${avoid.length ? `
                    <div class="strava-coach-list donts">
                        <h6>AVOID NEXT</h6>
                            <ul>${avoid.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
                    </div>
                ` : ''}
            </div>
            ${focus ? `<div class="strava-coach-focus"><strong>${rec.safetyNote ? 'Safety note' : 'Focus area'}:</strong> ${escapeHtml(focus)}</div>` : ''}
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

function createRunnerIcon() {
    return L.divIcon({
        className: 'strava-runner-marker',
        html: '<span class="strava-runner-head"></span><span class="strava-runner-body"></span><span class="strava-runner-leg front"></span><span class="strava-runner-leg back"></span>',
        iconSize: [34, 34],
        iconAnchor: [17, 17]
    });
}

function createRouteAnimator(map, coords) {
    if (!map || !coords || coords.length < 2 || typeof L === 'undefined') {
        return { stop() {} };
    }

    const segmentDistances = [];
    const cumulativeDistances = [0];
    let totalDistance = 0;

    for (let i = 1; i < coords.length; i++) {
        const from = L.latLng(coords[i - 1]);
        const to = L.latLng(coords[i]);
        const distance = from.distanceTo(to);
        segmentDistances.push(distance);
        totalDistance += distance;
        cumulativeDistances.push(totalDistance);
    }

    if (!totalDistance) return { stop() {} };

    const runner = L.marker(coords[0], {
        icon: createRunnerIcon(),
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000
    }).addTo(map);
    const travelled = L.polyline([coords[0]], {
        color: '#0F172A',
        weight: 5,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round'
    }).addTo(map);

    let frameId = null;
    let previousElapsed = 0;
    const startedAt = performance.now();
    const durationMs = Math.max(4500, Math.min(14000, coords.length * 70));

    function pointAt(distanceAlongRoute) {
        if (distanceAlongRoute <= 0) return coords[0];
        if (distanceAlongRoute >= totalDistance) return coords[coords.length - 1];

        let lo = 0;
        let hi = cumulativeDistances.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            if (cumulativeDistances[mid] < distanceAlongRoute) lo = mid + 1;
            else hi = mid;
        }

        const index = Math.max(1, lo);
        const segmentStart = cumulativeDistances[index - 1];
        const segmentLength = segmentDistances[index - 1] || 1;
        const ratio = Math.max(0, Math.min(1, (distanceAlongRoute - segmentStart) / segmentLength));
        const from = coords[index - 1];
        const to = coords[index];

        return [
            from[0] + (to[0] - from[0]) * ratio,
            from[1] + (to[1] - from[1]) * ratio
        ];
    }

    function travelledPath(distanceAlongRoute) {
        const path = [];
        for (let i = 0; i < coords.length && cumulativeDistances[i] <= distanceAlongRoute; i++) {
            path.push(coords[i]);
        }
        const current = pointAt(distanceAlongRoute);
        if (!path.length || path[path.length - 1][0] !== current[0] || path[path.length - 1][1] !== current[1]) {
            path.push(current);
        }
        return path;
    }

    function tick(now) {
        const elapsed = (now - startedAt) % durationMs;
        if (elapsed < previousElapsed) travelled.setLatLngs([coords[0]]);
        previousElapsed = elapsed;

        const progress = elapsed / durationMs;
        const eased = progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        const distanceAlongRoute = totalDistance * eased;

        runner.setLatLng(pointAt(distanceAlongRoute));
        travelled.setLatLngs(travelledPath(distanceAlongRoute));
        frameId = requestAnimationFrame(tick);
    }

    frameId = requestAnimationFrame(tick);

    return {
        stop() {
            if (frameId !== null) {
                cancelAnimationFrame(frameId);
                frameId = null;
            }
            try { map.removeLayer(runner); } catch (e) {}
            try { map.removeLayer(travelled); } catch (e) {}
        }
    };
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
    meta.className = 'strava-run-meta';
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
        }
    } catch (err) {
        list.innerHTML = `<div class="strava-preview-run"><div><strong style="color:#991B1B">Error</strong><span>${escapeHtml(err.message)}</span></div></div>`;
    }
}

async function previewActivityDashboard(activityId, activityMeta) {
    const preview = document.getElementById('dashboardStravaPreview');
    const list = document.getElementById('dashboardStravaList');
    if (list) list.style.display = 'none';
    setWebcamLaunchCardHidden(true);
    setDashboardRunReviewMode(true);
    if (preview._routeAnimator) { try { preview._routeAnimator.stop(); } catch (e) {} preview._routeAnimator = null; }
    if (preview._leafletMap) { try { preview._leafletMap.remove(); } catch (e) {} preview._leafletMap = null; }
    preview.style.display = 'block';
    preview.innerHTML = `<div style="padding:12px;border:1px solid #E2E8F0;border-radius:8px;background:#fff">Loading preview...</div>`;
    try {
        const data = await getActivityPreview(activityId);
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
                    <button id="dashboardSaveBtn" class="strava-btn strava-btn-primary" type="button" disabled style="display:none">Save session</button>
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
                preview._routeAnimator = createRouteAnimator(map, coords);
            } catch (e) {
                // fallback
            }
        }
        const backBtn = document.getElementById('dashboardPreviewBackBtn');
        if (backBtn) backBtn.addEventListener('click', () => {
            if (preview._routeAnimator) { try { preview._routeAnimator.stop(); } catch (e) {} preview._routeAnimator = null; }
            if (preview._leafletMap) { try { preview._leafletMap.remove(); } catch (e) {} preview._leafletMap = null; }
            preview.innerHTML = '';
            preview.style.display = 'none';
            setWebcamLaunchCardHidden(false);
            setDashboardRunReviewMode(false);
            if (list) list.style.display = '';
        });
        document.getElementById('dashboardAnalyzeBtn').addEventListener('click', async (event) => {
            await analyzeIpptPreviewDashboard(activityId, event.currentTarget);
        });
        document.getElementById('dashboardSaveBtn').addEventListener('click', async () => {
            await saveSessionDashboard(activityId);
        });
    } catch (err) {
        setWebcamLaunchCardHidden(false);
        setDashboardRunReviewMode(false);
        if (list) list.style.display = '';
        preview.innerHTML = `<div style="padding:12px;background:#FEE2E2;border:1px solid #FECACA;border-radius:8px;color:#991B1B">${escapeHtml(err.message)}</div>`;
    }
}

async function analyzeIpptPreviewDashboard(activityId, button) {
    const area = document.getElementById('dashboardIpptArea');
    if (button) {
        button.disabled = true;
        button.textContent = 'Analysing...';
    }
    area.innerHTML = '<div class="loading-spinner active"><div class="spinner"></div><p>Analysing 2.4km...</p></div>';
    try {
        const data = await getIpptAnalysis(activityId);
        const r = data.result;
        const rec = data.recommendation || {};
        area.innerHTML = `
            <div class="strava-analysis-card">
                <div class="strava-analysis-metrics">
                    <div><span>2.4km time</span><strong>${escapeHtml(r.official_time)}</strong></div>
                    <div><span>Status</span><strong>${formatValidityStatus(r.status)}</strong></div>
                    <div><span>Points</span><strong>${escapeHtml(r.run_points)}</strong></div>
                </div>
                ${renderRunCoachCard(rec)}
            </div>
        `;
        const saveBtn = document.getElementById('dashboardSaveBtn');
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.style.display = '';
        }
        if (button) {
            button.textContent = 'Analysed';
        }
    } catch (err) {
        const saveBtn = document.getElementById('dashboardSaveBtn');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.style.display = 'none';
        }
        if (button) {
            button.disabled = false;
            button.textContent = 'Analyse';
        }
        area.innerHTML = `<div style="padding:10px;background:#FEE2E2;border:1px solid #FECACA;border-radius:8px;color:#991B1B">${escapeHtml(err.message)}</div>`;
    }
}

async function saveSessionDashboard(activityId) {
    const saveBtn = document.getElementById('dashboardSaveBtn');
    if (!saveBtn) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
        const importData = await postActivityJson('/api/strava/ippt-24', activityId);
        await refreshIpptScore();
        // show simple success
        const preview = document.getElementById('dashboardStravaPreview');
        if (preview._routeAnimator) { try { preview._routeAnimator.stop(); } catch (e) {} preview._routeAnimator = null; }
        if (preview._leafletMap) { try { preview._leafletMap.remove(); } catch (e) {} preview._leafletMap = null; }
        preview.innerHTML = `
            <div class="strava-import-status strava-import-status-saved">
                <a class="strava-calendar-btn" href="${calendarLinkFor(importData.log)}">View In Calendar</a>
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
