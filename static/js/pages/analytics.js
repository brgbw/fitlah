(function () {
    const api = {
        activityRecords: '/api/activity-records'
    };

    const state = {
        logs: [],
        chartPoints: [],
        hoverPoint: null
    };

    function normaliseExercise(value) {
        const text = String(value || '').toLowerCase().replace(/[\s_-]/g, '');
        if (text.includes('pushup') || text.includes('pushups')) return 'pushup';
        if (text.includes('situp') || text.includes('situps')) return 'situp';
        return null;
    }

    function parseReps(log) {
        const direct = Number(log.valid_reps);
        if (Number.isFinite(direct) && direct >= 0) return direct;

        const scoreMatch = String(log.score || '').match(/\d+/);
        return scoreMatch ? Number(scoreMatch[0]) : 0;
    }

    function parseDuration(log) {
        const seconds = Number(log.duration_seconds);
        if (!Number.isFinite(seconds) || seconds <= 0) return '--';
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    function getExerciseLogs(rawLogs) {
        return rawLogs
            .map(log => {
                const exercise = normaliseExercise(log.exercise || log.name || log.event);
                if (!exercise) return null;
                return {
                    id: log.id,
                    date: log.date,
                    exercise,
                    reps: parseReps(log),
                    invalidReps: Number(log.invalid_reps || 0),
                    duration: parseDuration(log)
                };
            })
            .filter(Boolean)
            .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[char]));
    }

    function formatDateLabel(dateText) {
        if (!dateText) return '--';
        const date = new Date(`${dateText}T00:00:00`);
        if (Number.isNaN(date.getTime())) return dateText;
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function updateStats(logs) {
        const pushups = logs.filter(log => log.exercise === 'pushup');
        const situps = logs.filter(log => log.exercise === 'situp');
        const bestPushup = Math.max(...pushups.map(log => log.reps), 0);
        const bestSitup = Math.max(...situps.map(log => log.reps), 0);

        document.getElementById('pushupSessionCount').textContent = pushups.length;
        document.getElementById('situpSessionCount').textContent = situps.length;
        document.getElementById('bestPushup').innerHTML = `${bestPushup || '--'} <span>reps</span>`;
        document.getElementById('bestSitup').innerHTML = `${bestSitup || '--'} <span>reps</span>`;
    }

    function renderLatestRows(logs) {
        const tbody = document.getElementById('latestExerciseRows');
        const latest = logs.slice().sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id).slice(0, 8);

        if (!latest.length) {
            tbody.innerHTML = '<tr><td colspan="5">No push-up or sit-up logs found.</td></tr>';
            return;
        }

        tbody.innerHTML = latest.map(log => `
            <tr>
                <td>${escapeHtml(log.date)}</td>
                <td><span class="exercise-pill ${log.exercise}">${log.exercise === 'pushup' ? 'Push-up' : 'Sit-up'}</span></td>
                <td><strong>${log.reps}</strong></td>
                <td>${log.invalidReps}</td>
                <td>${escapeHtml(log.duration)}</td>
            </tr>
        `).join('');
    }

    function groupByDate(logs) {
        const byDate = new Map();
        logs.forEach(log => {
            if (!byDate.has(log.date)) {
                byDate.set(log.date, { date: log.date, pushup: null, situp: null });
            }
            const row = byDate.get(log.date);
            row[log.exercise] = Math.max(row[log.exercise] || 0, log.reps);
        });
        return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
    }

    function resizeCanvas(canvas) {
        const rect = canvas.getBoundingClientRect();
        const scale = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(rect.width * scale));
        canvas.height = Math.max(1, Math.floor(rect.height * scale));
        const ctx = canvas.getContext('2d');
        ctx.setTransform(scale, 0, 0, scale, 0, 0);
        return { ctx, width: rect.width, height: rect.height };
    }

    function drawGrid(ctx, width, height, plot, yTicks, maxY) {
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.font = '12px Segoe UI, Arial';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        yTicks.forEach(tick => {
            const y = plot.bottom - (tick / maxY) * plot.height;
            ctx.strokeStyle = '#E2E8F0';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(plot.left, y);
            ctx.lineTo(plot.right, y);
            ctx.stroke();

            ctx.fillStyle = '#64748B';
            ctx.fillText(String(tick), plot.left - 10, y);
        });

        ctx.strokeStyle = '#CBD5E1';
        ctx.beginPath();
        ctx.moveTo(plot.left, plot.top);
        ctx.lineTo(plot.left, plot.bottom);
        ctx.lineTo(plot.right, plot.bottom);
        ctx.stroke();
    }

    function exerciseLabel(exercise) {
        return exercise === 'pushup' ? 'Push-up' : 'Sit-up';
    }

    function drawSeries(ctx, data, plot, maxY, key, color) {
        const points = data
            .map((row, index) => {
                if (row[key] === null || row[key] === undefined) return null;
                const x = data.length === 1
                    ? plot.left + plot.width / 2
                    : plot.left + (index / (data.length - 1)) * plot.width;
                const y = plot.bottom - (row[key] / maxY) * plot.height;
                return {
                    x,
                    y,
                    color,
                    date: row.date,
                    exercise: key,
                    label: exerciseLabel(key),
                    value: row[key]
                };
            })
            .filter(Boolean);

        if (!points.length) return;

        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        points.forEach((point, index) => {
            if (index === 0) ctx.moveTo(point.x, point.y);
            else ctx.lineTo(point.x, point.y);
        });
        ctx.stroke();

        points.forEach(point => {
            ctx.fillStyle = '#FFFFFF';
            ctx.strokeStyle = color;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        });

        return points;
    }

    function drawHover(ctx, width, plot, point) {
        if (!point) return;

        ctx.save();
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.22)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 5]);
        ctx.beginPath();
        ctx.moveTo(point.x, plot.top);
        ctx.lineTo(point.x, plot.bottom);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = '#FFFFFF';
        ctx.strokeStyle = point.color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 8, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        const title = `${point.label}: ${point.value} reps`;
        const subtitle = formatDateLabel(point.date);
        ctx.font = '700 13px Segoe UI, Arial';
        const titleWidth = ctx.measureText(title).width;
        ctx.font = '12px Segoe UI, Arial';
        const subtitleWidth = ctx.measureText(subtitle).width;
        const tooltipWidth = Math.max(titleWidth, subtitleWidth) + 28;
        const tooltipHeight = 58;
        let tooltipX = point.x + 14;
        let tooltipY = point.y - tooltipHeight - 14;

        if (tooltipX + tooltipWidth > width - 8) {
            tooltipX = point.x - tooltipWidth - 14;
        }
        if (tooltipY < 8) {
            tooltipY = point.y + 18;
        }

        ctx.fillStyle = '#0F172A';
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(tooltipX, tooltipY, tooltipWidth, tooltipHeight, 8);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = point.color;
        ctx.beginPath();
        ctx.arc(tooltipX + 13, tooltipY + 18, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = '700 13px Segoe UI, Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(title, tooltipX + 24, tooltipY + 11);

        ctx.fillStyle = '#CBD5E1';
        ctx.font = '12px Segoe UI, Arial';
        ctx.fillText(subtitle, tooltipX + 24, tooltipY + 32);
        ctx.restore();
    }

    function matchingHoverPoint(points) {
        if (!state.hoverPoint) return null;
        return points.find(point =>
            point.date === state.hoverPoint.date &&
            point.exercise === state.hoverPoint.exercise
        ) || null;
    }

    function nearestChartPoint(mouseX, mouseY) {
        const maxDistance = 28;
        let nearest = null;
        let nearestDistance = Infinity;

        state.chartPoints.forEach(point => {
            const distance = Math.hypot(point.x - mouseX, point.y - mouseY);
            if (distance < nearestDistance) {
                nearest = point;
                nearestDistance = distance;
            }
        });

        return nearestDistance <= maxDistance ? nearest : null;
    }

    function drawXAxis(ctx, data, plot) {
        ctx.font = '12px Segoe UI, Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#64748B';

        data.forEach((row, index) => {
            const shouldShow = data.length <= 8 || index === 0 || index === data.length - 1 || index % Math.ceil(data.length / 6) === 0;
            if (!shouldShow) return;

            const x = data.length === 1
                ? plot.left + plot.width / 2
                : plot.left + (index / (data.length - 1)) * plot.width;
            ctx.fillText(formatDateLabel(row.date), x, plot.bottom + 12);
        });
    }

    function renderChart(logs) {
        const canvas = document.getElementById('exerciseTrendChart');
        const chartWrap = document.getElementById('chartWrap');
        const empty = document.getElementById('chartEmpty');
        const data = groupByDate(logs);

        if (!data.length) {
            chartWrap.style.display = 'none';
            empty.style.display = 'flex';
            return;
        }

        chartWrap.style.display = 'block';
        empty.style.display = 'none';

        const { ctx, width, height } = resizeCanvas(canvas);
        const plot = {
            left: 52,
            right: width - 22,
            top: 22,
            bottom: height - 44
        };
        plot.width = plot.right - plot.left;
        plot.height = plot.bottom - plot.top;

        const maxReps = Math.max(...data.flatMap(row => [row.pushup || 0, row.situp || 0]), 10);
        const maxY = Math.ceil(maxReps / 10) * 10;
        const yTicks = Array.from({ length: 6 }, (_, index) => Math.round((maxY / 5) * index));

        drawGrid(ctx, width, height, plot, yTicks, maxY);
        const pushupPoints = drawSeries(ctx, data, plot, maxY, 'pushup', '#00A86B') || [];
        const situpPoints = drawSeries(ctx, data, plot, maxY, 'situp', '#2563EB') || [];
        state.chartPoints = pushupPoints.concat(situpPoints);
        drawXAxis(ctx, data, plot);
        drawHover(ctx, width, plot, matchingHoverPoint(state.chartPoints));
    }

    function handleChartMouseMove(event) {
        const canvas = document.getElementById('exerciseTrendChart');
        const rect = canvas.getBoundingClientRect();
        const point = nearestChartPoint(event.clientX - rect.left, event.clientY - rect.top);
        canvas.style.cursor = point ? 'pointer' : 'default';

        const nextHover = point ? { date: point.date, exercise: point.exercise } : null;
        const previous = state.hoverPoint;
        const unchanged = previous && nextHover &&
            previous.date === nextHover.date &&
            previous.exercise === nextHover.exercise;

        if (unchanged || (!previous && !nextHover)) return;

        state.hoverPoint = nextHover;
        renderChart(state.logs);
    }

    function handleChartMouseLeave() {
        const canvas = document.getElementById('exerciseTrendChart');
        canvas.style.cursor = 'default';
        if (!state.hoverPoint) return;
        state.hoverPoint = null;
        renderChart(state.logs);
    }

    async function refreshAnalytics() {
        const tbody = document.getElementById('latestExerciseRows');
        tbody.innerHTML = '<tr><td colspan="5">Loading logs...</td></tr>';

        try {
            const response = await fetch(api.activityRecords);
            const data = await response.json();
            if (!data.success) {
                throw new Error(data.error || 'Could not load activity records.');
            }

            state.logs = getExerciseLogs(data.logs || []);
            updateStats(state.logs);
            renderChart(state.logs);
            renderLatestRows(state.logs);
        } catch (err) {
            console.error(err);
            tbody.innerHTML = `<tr><td colspan="5">${escapeHtml(err.message)}</td></tr>`;
        }
    }

    const chartCanvas = document.getElementById('exerciseTrendChart');
    chartCanvas.addEventListener('mousemove', handleChartMouseMove);
    chartCanvas.addEventListener('mouseleave', handleChartMouseLeave);

    window.addEventListener('resize', () => renderChart(state.logs));
    window.refreshAnalytics = refreshAnalytics;

    refreshAnalytics();
})();
