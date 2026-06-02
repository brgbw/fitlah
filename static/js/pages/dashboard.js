(function () {
    const dashboardConfig = window.FitLahDashboardConfig || {};


        function triggerWebcamStation() {
            window.location.href = dashboardConfig.exerciseSetupUrl;
        }

        function triggerStravaModal() {
            const connected = Boolean(dashboardConfig.stravaConnected);
        const authorizeUrl = dashboardConfig.stravaAuthorizeUrl;

        if (!connected) {
            window.location.href = authorizeUrl || dashboardConfig.stravaSyncUrl;
            return;
        }

            const preview = document.querySelector('.strava-sync-preview');
            if (!preview) {
                window.location.href = dashboardConfig.stravaSyncUrl;
                return;
            }
            preview.classList.add('visible');
            preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

        function renderStravaAi(ai) {
            const card = document.getElementById('stravaAiCard');
            const summary = document.getElementById('stravaAiSummary');
            const dos = document.getElementById('stravaAiDos');
            const donts = document.getElementById('stravaAiDonts');
            const focus = document.getElementById('stravaAiFocus');

            summary.innerHTML = aiTextHtml(ai.summary || '');
            
            const recommendations = ai.recommendations || ai.dos || [];
            const avoid = uniqueAiItems([ai.weakness, ...(ai.donts || [])]);
            
            dos.innerHTML = recommendations.map(item => `<li>${aiTextHtml(item)}</li>`).join('');
            donts.innerHTML = avoid.map(item => `<li>${aiTextHtml(item)}</li>`).join('');
            
            const focusText = ai.safetyNote
                ? `Safety note: ${ai.safetyNote}`
                : (ai.focus_areas || []).length
                ? `Focus area: ${ai.focus_areas.join(' | ')}`
                : (ai.strength ? `Strength: ${ai.strength}` : '');
            focus.innerHTML = aiTextHtml(focusText);
                
            card.classList.add('compact');
            card.style.display = 'block';
        }

        function escapeHtml(value) {
            return String(value || '').replace(/[&<>"']/g, char => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                '"': '&quot;',
                "'": '&#039;'
            }[char]));
        }

        function formatValidityStatus(value) {
            return String(value || '').toLowerCase() === 'valid' ? 'Valid' : 'Invalid';
        }

        function renderIpptResult(result) {
            const container = document.getElementById('stravaIpptResult');
            if (!container || !result) return;

            const splits = result.splits || [];
            container.className = 'strava-ippt-result';
            container.innerHTML = `
                <div class="strava-ippt-metrics">
                    <div><span>Official 2.4km</span><strong>${escapeHtml(result.official_time)}</strong></div>
                    <div><span>Run points</span><strong>${Number(result.run_points || 0)}</strong></div>
                    <div><span>Validity</span><strong>${Number(result.validity_score || 0)}/100 ${formatValidityStatus(result.status)}</strong></div>
                    <div><span>Ignored</span><strong>${Number(result.extra_distance_m || 0).toFixed(0)} m</strong></div>
                </div>
                <ul class="strava-split-list">
                    ${splits.map(split => `
                        <li>
                            <span>${Number(split.distance_m)} m</span>
                            <strong>${escapeHtml(split.time)}</strong>
                        </li>
                    `).join('')}
                </ul>
            `;
            container.style.display = 'block';
        }

        async function readJsonResponse(response, fallbackMessage) {
            const contentType = response.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                return response.json();
            }
            const text = await response.text();
            if (text.toLowerCase().includes('<!doctype') || text.toLowerCase().includes('<html')) {
                throw new Error(fallbackMessage || 'Server returned an HTML error page. Refresh and try again.');
            }
            throw new Error(text || fallbackMessage || 'Unexpected server response.');
        }

        function renderStravaMessage(title, message, actionLabel, actionUrl) {
            const list = document.getElementById('stravaRunChoices');
            if (!list) return;

            list.innerHTML = '';
            const row = document.createElement('div');
            row.className = 'strava-preview-run';

            const copy = document.createElement('div');
            const strong = document.createElement('strong');
            const span = document.createElement('span');
            strong.textContent = title;
            span.textContent = message;
            copy.append(strong, span);
            row.append(copy);

            if (actionLabel && actionUrl) {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = actionLabel;
                button.addEventListener('click', () => {
                    window.location.href = actionUrl;
                });
                row.append(button);
            }

            list.append(row);
        }

        async function refreshIpptScore() {
            const response = await fetch('/api/ippt-score');
            const data = await response.json();
            if (!response.ok || !data.success) return;

            const score = data.score;
            const award = document.getElementById('ipptAward');
            document.getElementById('ipptTotalPoints').textContent = score.total_points;
            document.getElementById('ipptScoreHero').style.setProperty('--score-percent', score.total_points);
            document.getElementById('ipptPushups').textContent = `${score.pushups} reps`;
            document.getElementById('ipptSitups').textContent = `${score.situps} reps`;
            document.getElementById('ipptRunTime').textContent = score.run_time;
            document.getElementById('ipptPushupPoints').textContent = score.pushup_points;
            document.getElementById('ipptSitupPoints').textContent = score.situp_points;
            document.getElementById('ipptRunPoints').textContent = score.run_points;
            document.getElementById('ipptScoreNote').textContent = score.complete
                ? ''
                : 'Add all three stations to complete your score.';
            award.textContent = score.award.label;
            award.className = `award-pill ${score.award.code}`;

            const scoreHero = document.getElementById('ipptScoreHero');
            scoreHero.className = `score-hero award-${score.award.code}`;
        }

        window.refreshIpptScore = refreshIpptScore;

        function renderStravaActivities(activities) {
            const list = document.getElementById('stravaRunChoices');
            if (!list) return;

            if (!activities.length) {
                renderStravaMessage(
                    'No recent runs found',
                    'Strava returned no running activities for this account.'
                );
                return;
            }

            list.innerHTML = '';
            activities.forEach(activity => {
                const row = document.createElement('div');
                row.className = 'strava-preview-run';
                row.dataset.activityId = activity.id;

                const details = document.createElement('div');
                const name = document.createElement('strong');
                const meta = document.createElement('span');
                name.textContent = activity.name;
                meta.textContent = `${activity.distance_km.toFixed(2)} km · ${activity.time} · ${activity.pace} · ${activity.date}`;
                details.append(name, meta);

                const actions = document.createElement('div');
                actions.className = 'strava-preview-actions';

                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = 'Import';
                button.addEventListener('click', () => importStravaRun(activity.id, button));

                const ipptButton = document.createElement('button');
                ipptButton.type = 'button';
                ipptButton.textContent = '2.4km';
                ipptButton.addEventListener('click', () => calculateStravaIppt(activity.id, ipptButton));

                const coachButton = document.createElement('button');
                coachButton.type = 'button';
                coachButton.className = 'secondary';
                coachButton.textContent = 'Coach';
                coachButton.disabled = true;
                coachButton.addEventListener('click', () => generateRunCoach(activity.id, coachButton));

                actions.append(button, ipptButton, coachButton);
                row.append(details, actions);
                list.append(row);
            });
        }

        async function loadStravaActivities() {
            const list = document.getElementById('stravaRunChoices');
            if (!list || "{{ 'true' if strava_connected else 'false' }}" !== "true") return;

            try {
                const response = await fetch('/api/strava/activities');
                const data = await readJsonResponse(response, 'Could not fetch Strava activities.');
                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Could not fetch Strava activities.');
                }
                renderStravaActivities(data.activities || []);
            } catch (error) {
                renderStravaMessage(
                    'Strava sync needs attention',
                    error.message,
                    "{{ 'Reconnect' if strava_authorize_url else '' }}",
                    "{{ strava_authorize_url }}"
                );
            }
        }

        async function importStravaRun(activityId, button) {
            const result = document.getElementById('stravaImportResult');
            const status = document.getElementById('stravaImportStatus');
            const allRuns = document.querySelectorAll('.strava-preview-run');
            const allButtons = document.querySelectorAll('.strava-preview-run button');

            result.style.display = 'block';
            status.className = 'strava-import-status';
            status.textContent = 'Importing selected Strava run into Calendar...';
            document.getElementById('stravaAiCard').style.display = 'none';
            document.getElementById('stravaIpptResult').style.display = 'none';
            allButtons.forEach(btn => btn.disabled = true);

            try {
                const response = await fetch('/api/strava/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ activity_id: activityId })
                });
                const data = await readJsonResponse(response, 'Could not import Strava run.');

                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Could not import Strava run.');
                }

                allRuns.forEach(row => row.classList.toggle('selected', row.dataset.activityId === String(activityId)));
                status.textContent = `${data.log.name} imported to Calendar and activity records.`;
                renderStravaAi(data.ai_recommendation || {});
                refreshIpptScore();
                button.textContent = 'Imported';
            } catch (error) {
                status.className = 'strava-import-status error';
                status.textContent = error.message;
            } finally {
                restoreStravaButtons();
            }
        }

        function restoreStravaButtons() {
            document.querySelectorAll('.strava-preview-run button').forEach(btn => {
                if (btn.textContent === 'Imported') return;
                if (btn.classList.contains('secondary')) {
                    const row = btn.closest('.strava-preview-run');
                    btn.disabled = !row || row.dataset.ipptReady !== 'true';
                    return;
                }
                btn.disabled = false;
            });
        }

        async function calculateStravaIppt(activityId, button) {
            const result = document.getElementById('stravaImportResult');
            const status = document.getElementById('stravaImportStatus');
            const allRuns = document.querySelectorAll('.strava-preview-run');
            const allButtons = document.querySelectorAll('.strava-preview-run button');

            result.style.display = 'block';
            status.className = 'strava-import-status';
            status.textContent = 'Calculating 2.4km...';
            document.getElementById('stravaAiCard').style.display = 'none';
            document.getElementById('stravaIpptResult').style.display = 'none';
            allButtons.forEach(btn => btn.disabled = true);

            try {
                const response = await fetch('/api/strava/ippt-24', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ activity_id: activityId })
                });
                const data = await readJsonResponse(response, 'Could not calculate IPPT 2.4km result.');

                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Could not calculate IPPT 2.4km result.');
                }

                allRuns.forEach(row => row.classList.toggle('selected', row.dataset.activityId === String(activityId)));
                status.textContent = `Saved: ${data.result.official_time}`;
                renderIpptResult(data.result);
                refreshIpptScore();
                button.textContent = 'Recalc';
                const row = button.closest('.strava-preview-run');
                if (row) row.dataset.ipptReady = 'true';
                const coachButton = row ? row.querySelector('button.secondary') : null;
                if (coachButton) coachButton.disabled = false;
            } catch (error) {
                status.className = 'strava-import-status error';
                status.textContent = error.message;
            } finally {
                restoreStravaButtons();
            }
        }

        async function generateRunCoach(activityId, button) {
            const result = document.getElementById('stravaImportResult');
            const status = document.getElementById('stravaImportStatus');
            const allButtons = document.querySelectorAll('.strava-preview-run button');

            result.style.display = 'block';
            status.className = 'strava-import-status';
            status.textContent = 'Coach is thinking...';
            allButtons.forEach(btn => btn.disabled = true);

            try {
                const response = await fetch('/api/strava/ippt-24/recommendation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ activity_id: activityId })
                });
                const data = await readJsonResponse(response, 'Could not generate coach recommendation.');

                if (!response.ok || !data.success) {
                    throw new Error(data.error || 'Could not generate coach recommendation.');
                }

                status.textContent = 'Coach ready.';
                renderIpptResult(data.result);
                renderStravaAi(data.ai_recommendation || {});
            } catch (error) {
                status.className = 'strava-import-status error';
                status.textContent = error.message;
            } finally {
                restoreStravaButtons();
            }
        }

        document.addEventListener('DOMContentLoaded', loadStravaActivities);

    window.triggerWebcamStation = triggerWebcamStation;
    window.triggerStravaModal = triggerStravaModal;
    window.importStravaRun = importStravaRun;
    window.calculateStravaIppt = calculateStravaIppt;
    window.generateRunCoach = generateRunCoach;
})();
