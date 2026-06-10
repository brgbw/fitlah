(function () {
    const ITEM_PAUSE_MS = 90;

    function sleep(ms) {
        return new Promise(resolve => window.setTimeout(resolve, ms));
    }

    function formatAiDebug(debug) {
        if (!debug || typeof debug !== 'object') return '';
        const parts = [];
        if (debug.failure_stage) parts.push(`stage=${debug.failure_stage}`);
        if (debug.exception_type) parts.push(`type=${debug.exception_type}`);
        if (debug.exception_message) parts.push(`message=${debug.exception_message}`);
        if (debug.model) parts.push(`model=${debug.model}`);
        if (debug.api_key_present === false) parts.push('api_key=missing');
        if (debug.sdk_available === false) parts.push('sdk=missing');
        if (debug.database_save_failed) parts.push('database_save=failed');
        return parts.join('; ');
    }

    function revealInto(element, text) {
        if (!element) return Promise.resolve();
        if (window.FitLahAiTextReveal) {
            element.dataset.aiRevealDone = 'false';
            element.dataset.aiRevealText = text || '';
            return FitLahAiTextReveal.revealElement(element);
        }
        if (window.FitLahAiTextFormat) {
            FitLahAiTextFormat.setFormattedText(element, text || '');
        } else {
            element.textContent = text || '';
        }
        return Promise.resolve();
    }

    function createController(options) {
        let loading = false;
        let pending = Promise.resolve();
        let lastResult = null;
        const resultsBySession = new Map();

        function reset() {
            loading = false;
            lastResult = null;
            if (!options.panel) return;
            options.panel.style.display = 'none';
            if (options.status) {
                options.status.className = 'ai-reco-status';
                options.status.textContent = 'Complete a session to get personalised coaching.';
            }
            if (options.skeleton) options.skeleton.style.display = 'none';
            if (options.summary) options.summary.style.display = 'none';
            if (options.columns) options.columns.style.display = 'none';
            if (options.focus) options.focus.style.display = 'none';
            if (options.dos) options.dos.innerHTML = '';
            if (options.donts) options.donts.innerHTML = '';
            if (options.focusText) options.focusText.innerHTML = '';
        }

        function setLoading(exerciseLabel) {
            loading = true;
            lastResult = null;
            if (!options.panel) return;
            options.panel.style.display = 'block';
            if (options.status) {
                options.status.className = 'ai-reco-status loading';
                options.status.textContent = `Analysing your ${exerciseLabel} for personalised coaching...`;
            }
            if (options.skeleton) options.skeleton.style.display = 'grid';
            if (options.summary) options.summary.style.display = 'none';
            if (options.columns) options.columns.style.display = 'none';
            if (options.focus) options.focus.style.display = 'none';
        }

        async function revealItems(items, createElement) {
            for (const item of (items || []).filter(Boolean)) {
                const itemElement = createElement();
                await revealInto(itemElement, item);
                await sleep(ITEM_PAUSE_MS);
            }
        }

        function renderRecommendation(data) {
            loading = false;
            if (!options.panel) {
                console.info('AI recommendation generated after save', {
                    session_id: data.session_id,
                    saved_to_database: data.saved_to_database
                });
                return;
            }

            options.panel.style.display = 'block';
            if (options.status) options.status.className = 'ai-reco-status';
            if (options.skeleton) options.skeleton.style.display = 'none';

            if (data.ai_error) {
                const debugDetail = data.debug ? ` (${formatAiDebug(data.debug)})` : '';
                if (options.status) {
                    options.status.className = 'ai-reco-status error';
                    options.status.textContent = `AI recommendation failed: ${data.ai_error}${debugDetail}`;
                }
                console.error('AI recommendation failed', data);
            } else if (options.status) {
                options.status.textContent = 'AI personalised coaching';
            }

            const dos = (data.dos || []);
            const donts = (data.donts || []);
            const focusAreas = (data.focus_areas || []).slice(0, 1);
            if (options.dos) options.dos.innerHTML = '';
            if (options.donts) options.donts.innerHTML = '';
            if (options.focusText) options.focusText.innerHTML = '';
            if (options.summary) options.summary.style.display = data.summary ? 'block' : 'none';
            if (options.columns) options.columns.style.display = (dos.length || donts.length) ? 'grid' : 'none';
            if (options.focus) options.focus.style.display = focusAreas.length ? 'block' : 'none';

            (async () => {
                if (data.summary && options.summary) {
                    await revealInto(options.summary, data.summary);
                }
                await revealItems(dos, () => {
                    const li = document.createElement('li');
                    if (options.dos) options.dos.appendChild(li);
                    return li;
                });
                await revealItems(donts, () => {
                    const li = document.createElement('li');
                    if (options.donts) options.donts.appendChild(li);
                    return li;
                });
                await revealItems(focusAreas, () => {
                    const li = document.createElement('li');
                    if (options.focusText) options.focusText.appendChild(li);
                    return li;
                });
            })();
        }

        function renderError(message, debug) {
            loading = false;
            if (!options.panel) {
                console.error('AI recommendation failed after save', { message, debug });
                return;
            }
            options.panel.style.display = 'block';
            if (options.status) options.status.className = 'ai-reco-status error';
            if (options.skeleton) options.skeleton.style.display = 'none';
            const detail = formatAiDebug(debug);
            if (options.status) options.status.textContent = detail ? `${message} (${detail})` : message;
            console.error('AI recommendation failed', { message, debug });
        }

        async function fetchRecommendation(metrics, force = false, sessionIdOverride = null) {
            if (!metrics || (loading && !force)) return;
            const label = metrics.exercise === 'pushup' ? 'push-up' : 'sit-up';
            setLoading(label);
            const payload = options.compactMetricsForAi(metrics);
            const targetSessionId = sessionIdOverride || payload.session_id || options.getLastSessionId();
            if (targetSessionId) payload.session_id = targetSessionId;

            try {
                const response = await fetch('/api/ai-recommendation', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
                const data = await response.json();
                lastResult = data;
                if (targetSessionId) resultsBySession.set(String(targetSessionId), data);
                if (data.success) {
                    renderRecommendation(data);
                    return data;
                }
                renderError(data.error || 'AI recommendation could not be generated.', data.debug);
                return data;
            } catch (err) {
                lastResult = { success: false, error: err.message };
                if (targetSessionId) resultsBySession.set(String(targetSessionId), lastResult);
                renderError('AI recommendation failed: ' + err.message);
                return lastResult;
            }
        }

        function enqueue(metrics, force = false, sessionIdOverride = null) {
            pending = pending
                .catch(() => {})
                .then(() => fetchRecommendation(metrics, force, sessionIdOverride));
            return pending;
        }

        return {
            enqueue,
            isLoading: () => loading,
            lastResult: () => lastResult,
            reset,
            resultFor: sessionId => resultsBySession.get(String(sessionId)),
            wait: () => pending
        };
    }

    window.FitLahWebcamAiCoach = {
        createController,
        formatAiDebug
    };
})();
