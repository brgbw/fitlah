async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

const stravaPreviewCache = new Map();

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

function el(tag, cls) {
    const d = document.createElement(tag);
    if (cls) d.className = cls;
    return d;
}

function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
}

function renderMiniRoute(svgEl, latlng) {
    if (!svgEl || !latlng || !latlng.length) return;
    const w = svgEl.viewBox.baseVal.width || svgEl.clientWidth || 160;
    const h = svgEl.viewBox.baseVal.height || svgEl.clientHeight || 90;
    const lats = latlng.map(p => p[0]);
    const lons = latlng.map(p => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const latRange = maxLat - minLat || 1e-6;
    const lonRange = maxLon - minLon || 1e-6;
    const points = latlng.map(p => {
        const x = ((p[1] - minLon) / lonRange) * (w - 8) + 4;
        const y = h - (((p[0] - minLat) / latRange) * (h - 8) + 4);
        return [x, y];
    });
    const pathD = points.map((pt, i) => (i === 0 ? `M ${pt[0]} ${pt[1]}` : `L ${pt[0]} ${pt[1]}`)).join(' ');
    svgEl.innerHTML = `<path d="${pathD}" stroke="#FC4C02" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"></path>`;
}

function previewUrlFor(activityId) {
    const base = (window.FitLahDashboardConfig || {}).stravaPreviewRunUrl || '/previewstravarun';
    return `${base}?activity_id=${encodeURIComponent(activityId)}`;
}

function makeMiniCard(activity) {
    const id = activity.id;
    const card = el('div', 'strava-preview-run');
    card.dataset.activityId = id;
    card.setAttribute('role', 'link');
    card.tabIndex = 0;
    card.setAttribute('aria-label', `Review ${activity.name || 'Strava run'}`);
    const openReview = () => {
        window.location.href = previewUrlFor(activity.id);
    };
    card.addEventListener('click', openReview);
    card.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openReview();
        }
    });

    const left = el('div', 'strava-run-copy');
    const name = document.createElement('strong');
    name.textContent = activity.name;
    const meta = el('div', 'strava-run-meta');
    meta.textContent = `${Number(activity.distance_km || 0).toFixed(2)} km - ${activity.time || ''} - ${activity.date || ''}`;
    left.append(name, meta);

    const mini = el('div', 'strava-route-mini');
    mini.innerHTML = `<svg id="routeMini-${id}" width="160" height="90" viewBox="0 0 160 90" preserveAspectRatio="xMidYMid meet"></svg>`;

    card.append(left, mini);
    return card;
}

async function drawMiniRoute(activityId) {
    try {
        const data = await getActivityPreview(activityId);
        const latlng = (data.streams || {}).latlng || [];
        renderMiniRoute(document.getElementById(`routeMini-${activityId}`), latlng);
    } catch (err) {
        const svg = document.getElementById(`routeMini-${activityId}`);
        if (svg) svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#94A3B8" font-size="11">No route</text>';
    }
}

async function loadDashboardStrava() {
    const list = document.getElementById('dashboardStravaList');
    if (!list) return;

    list.innerHTML = '<div class="strava-preview-run is-static"><div><strong>Loading Strava activities...</strong><span>Fetching your latest runs from Strava</span></div></div>';

    try {
        const data = await fetchJson('/api/strava/activities');
        const activities = (data.activities || []).slice(0, 3);
        if (!activities.length) {
            list.innerHTML = '<div class="empty-recent">No recent Strava runs found.</div>';
            return;
        }

        list.innerHTML = '';
        for (const activity of activities) {
            list.append(makeMiniCard(activity));
            drawMiniRoute(activity.id);
        }
    } catch (err) {
        list.innerHTML = `<div class="strava-preview-run is-static"><div><strong style="color:#991B1B">Error</strong><span>${escapeHtml(err.message)}</span></div></div>`;
    }
}

document.addEventListener('DOMContentLoaded', loadDashboardStrava);
