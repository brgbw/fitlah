(function () {
    function pointToCanvas(point, bounds) {
        return {
            x: bounds.plot.left + ((point.time - bounds.minTime) / bounds.timeRange) * bounds.plot.width,
            y: bounds.plot.top + ((point.value - bounds.minValue) / bounds.valueRange) * bounds.plot.height
        };
    }

    function drawGrid(ctx, plot) {
        ctx.strokeStyle = '#E2E8F0';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 3; i++) {
            const y = plot.top + (plot.height * i / 3);
            ctx.beginPath();
            ctx.moveTo(plot.left, y);
            ctx.lineTo(plot.right, y);
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
        ctx.lineWidth = 2.5;
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
            ctx.arc(point.x, point.y, 2.2, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    function drawAxisLabels(ctx, bounds, width, height) {
        ctx.fillStyle = '#64748B';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(bounds.minValue.toFixed(2), 8, bounds.plot.top + 4);
        ctx.fillText(bounds.maxValue.toFixed(2), 8, bounds.plot.bottom);
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round(bounds.minTime)}s`, bounds.plot.left, height - 8);
        ctx.fillText(`${Math.round(bounds.maxTime)}s`, bounds.plot.right, height - 8);
    }

    function chartBounds(samples, width, height) {
        const pad = { top: 18, right: 16, bottom: 28, left: 38 };
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
        const minTime = Math.min(...times);
        const maxTime = Math.max(...times);
        const minValue = Math.min(...values);
        const maxValue = Math.max(...values);

        return {
            plot,
            minTime,
            maxTime,
            minValue,
            maxValue,
            valueRange: Math.max(0.001, maxValue - minValue),
            timeRange: Math.max(0.001, maxTime - minTime)
        };
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

        const bounds = chartBounds(samples, width, height);
        const points = samples.map(point => pointToCanvas(point, bounds));

        drawGrid(ctx, bounds.plot);
        drawSmoothLine(ctx, points);
        drawPointMarkers(ctx, points);
        drawAxisLabels(ctx, bounds, width, height);
    }

    function drawAll() {
        document.querySelectorAll('.analysis-canvas').forEach(drawAnalysisCanvas);
    }

    window.addEventListener('load', drawAll);
    window.addEventListener('resize', drawAll);
})();
