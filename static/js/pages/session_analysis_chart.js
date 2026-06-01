(function () {
    function pointToCanvas(point, bounds) {
        const xRatio = (point.time - bounds.minTime) / bounds.timeRange;
        const yRatio = point.displayValue / 100;
        return {
            x: bounds.plot.left + xRatio * bounds.plot.width,
            y: bounds.plot.bottom - yRatio * bounds.plot.height
        };
    }

    function drawGrid(ctx, bounds) {
        const { plot } = bounds;
        ctx.strokeStyle = '#E2E8F0';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 3; i++) {
            const y = plot.top + (plot.height * i / 3);
            ctx.beginPath();
            ctx.moveTo(plot.left, y);
            ctx.lineTo(plot.right, y);
            ctx.stroke();
        }
        for (let i = 0; i <= 4; i++) {
            const x = plot.left + (plot.width * i / 4);
            ctx.beginPath();
            ctx.moveTo(x, plot.top);
            ctx.lineTo(x, plot.bottom);
            ctx.stroke();
        }

        ctx.strokeStyle = '#CBD5E1';
        ctx.beginPath();
        ctx.moveTo(plot.left, plot.top);
        ctx.lineTo(plot.left, plot.bottom);
        ctx.lineTo(plot.right, plot.bottom);
        ctx.stroke();
    }

    function drawSmoothLine(ctx, points) {
        ctx.strokeStyle = '#2563EB';
        ctx.lineWidth = 3.5;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();

        if (points.length === 1) {
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[0].x + 1, points[0].y);
        } else {
            ctx.moveTo(points[0].x, points[0].y);
            for (let index = 1; index < points.length - 1; index++) {
                const midpointX = (points[index].x + points[index + 1].x) / 2;
                const midpointY = (points[index].y + points[index + 1].y) / 2;
                ctx.quadraticCurveTo(points[index].x, points[index].y, midpointX, midpointY);
            }
            const lastPoint = points[points.length - 1];
            ctx.lineTo(lastPoint.x, lastPoint.y);
        }

        ctx.stroke();
    }

    function drawPointMarkers(ctx, points) {
        ctx.fillStyle = '#2563EB';
        points.forEach((point, index) => {
            if (index % Math.max(1, Math.floor(points.length / 10)) !== 0) return;
            ctx.beginPath();
            ctx.arc(point.x, point.y, 3, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    function drawAxisLabels(ctx, bounds, width, height) {
        ctx.fillStyle = '#64748B';
        ctx.font = '600 14px system-ui, sans-serif';

        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let i = 0; i <= 3; i++) {
            const value = 100 - (100 * i / 3);
            const y = bounds.plot.top + (bounds.plot.height * i / 3);
            ctx.fillText(`${Math.round(value)}%`, bounds.plot.left - 10, y);
        }

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i <= 4; i++) {
            const time = bounds.minTime + (bounds.timeRange * i / 4);
            const x = bounds.plot.left + (bounds.plot.width * i / 4);
            ctx.fillText(`${Math.round(time)}s`, x, bounds.plot.bottom + 10);
        }

        ctx.font = '700 15px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('Time into session (seconds)', bounds.plot.left, height - 18);
        ctx.save();
        ctx.translate(15, bounds.plot.top + bounds.plot.height / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.fillText(bounds.yLabel, 0, 0);
        ctx.restore();
    }

    function chartBounds(samples, analysis, width, height) {
        const pad = { top: 22, right: 22, bottom: 58, left: 76 };
        const plot = {
            left: pad.left,
            top: pad.top,
            right: width - pad.right,
            bottom: height - pad.bottom
        };
        plot.width = plot.right - plot.left;
        plot.height = plot.bottom - plot.top;

        const times = samples.map(point => point.time);
        const values = samples.map(point => point.value);
        const minTime = 0;
        const maxTime = Math.max(
            Number(analysis.duration_seconds) || 0,
            Math.max(...times),
            1
        );
        const rawMinValue = Math.min(...values);
        const rawMaxValue = Math.max(...values);
        const measuredRange = rawMaxValue - rawMinValue;
        const rawRange = Math.max(0.001, measuredRange);

        return {
            plot,
            minTime,
            maxTime,
            rawMinValue,
            rawMaxValue,
            rawRange,
            isFlat: measuredRange < 0.001,
            yLabel: analysis.type === 'shoulder_drop'
                ? 'Push-up depth (%)'
                : analysis.type === 'torso_lift'
                    ? 'Sit-up lift (%)'
                    : 'Relative movement (%)',
            timeRange: Math.max(0.001, maxTime - minTime)
        };
    }

    function normalizeSamples(samples, bounds) {
        return samples.map(point => ({
            ...point,
            displayValue: bounds.isFlat
                ? 50
                : Math.max(0, Math.min(100, ((point.value - bounds.rawMinValue) / bounds.rawRange) * 100))
        }));
    }

    function drawAnalysisCanvas(canvas) {
        const analysis = JSON.parse(canvas.dataset.analysis || '{}');
        const samples = Array.isArray(analysis.samples) ? analysis.samples : [];
        if (!samples.length) return;

        const ratio = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        const width = Math.max(320, Math.round(rect.width));
        const height = Math.max(160, Math.round(rect.height || 180));
        canvas.width = width * ratio;
        canvas.height = height * ratio;

        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.clearRect(0, 0, width, height);

        const bounds = chartBounds(samples, analysis, width, height);
        const displaySamples = normalizeSamples(samples, bounds);
        const points = displaySamples.map(point => pointToCanvas(point, bounds));

        drawGrid(ctx, bounds);
        drawSmoothLine(ctx, points);
        drawPointMarkers(ctx, points);
        drawAxisLabels(ctx, bounds, width, height);
    }

    function setupHelpButtons() {
        document.querySelectorAll('[data-analysis-help-toggle]').forEach(button => {
            button.addEventListener('click', () => {
                const panel = button.closest('.analysis-panel');
                const help = panel ? panel.querySelector('.analysis-help') : null;
                if (!help) return;
                const isOpen = help.hidden;
                help.hidden = !isOpen;
                button.setAttribute('aria-expanded', String(isOpen));
                button.textContent = isOpen ? 'Hide guide' : 'Guide';
            });
        });
    }

    function drawAll() {
        document.querySelectorAll('.analysis-canvas').forEach(drawAnalysisCanvas);
    }

    window.addEventListener('load', () => {
        setupHelpButtons();
        drawAll();
    });
    window.addEventListener('resize', drawAll);
})();
