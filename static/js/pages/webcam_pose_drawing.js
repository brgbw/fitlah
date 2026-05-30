(function () {
    const BODY_CONNECTIONS = [
        [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
        [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
        [24, 26], [26, 28], [27, 29], [29, 31], [28, 30],
        [30, 32], [15, 17], [15, 19], [16, 18], [16, 20]
    ];
    const BODY_LANDMARK_INDICES = new Set(BODY_CONNECTIONS.flat());

    function drawBodySkeleton(ctx, canvas, landmarks) {
        ctx.save();

        for (const [aIdx, bIdx] of BODY_CONNECTIONS) {
            const a = landmarks[aIdx];
            const b = landmarks[bIdx];

            if ((a.visibility || 0) > 0.4 && (b.visibility || 0) > 0.4) {
                const x1 = a.x * canvas.width;
                const y1 = a.y * canvas.height;
                const x2 = b.x * canvas.width;
                const y2 = b.y * canvas.height;

                const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
                gradient.addColorStop(0, '#00FFFF');
                gradient.addColorStop(0.5, '#00FF88');
                gradient.addColorStop(1, '#7C3AED');

                ctx.shadowColor = '#00FFFF';
                ctx.shadowBlur = 20;
                ctx.strokeStyle = gradient;
                ctx.lineWidth = 6;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();

                ctx.shadowBlur = 0;
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();
            }
        }

        for (const idx of BODY_LANDMARK_INDICES) {
            const lm = landmarks[idx];
            if ((lm.visibility || 0) > 0.4) {
                const x = lm.x * canvas.width;
                const y = lm.y * canvas.height;

                ctx.shadowColor = '#00FFFF';
                ctx.shadowBlur = 25;

                ctx.beginPath();
                ctx.arc(x, y, 10, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0,255,255,0.15)';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(x, y, 5, 0, Math.PI * 2);
                ctx.fillStyle = '#00FFFF';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(x, y, 2, 0, Math.PI * 2);
                ctx.fillStyle = '#FFFFFF';
                ctx.fill();

                ctx.shadowBlur = 0;
                ctx.strokeStyle = '#00FFFF';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(x, y, 14, 0, Math.PI * 2);
                ctx.stroke();
            }
        }

        const leftShoulder = landmarks[11];
        const rightShoulder = landmarks[12];
        const leftHip = landmarks[23];
        const rightHip = landmarks[24];

        if (leftShoulder && rightShoulder && leftHip && rightHip) {
            ctx.beginPath();
            ctx.moveTo(leftShoulder.x * canvas.width, leftShoulder.y * canvas.height);
            ctx.lineTo(rightShoulder.x * canvas.width, rightShoulder.y * canvas.height);
            ctx.lineTo(rightHip.x * canvas.width, rightHip.y * canvas.height);
            ctx.lineTo(leftHip.x * canvas.width, leftHip.y * canvas.height);
            ctx.closePath();
            ctx.fillStyle = 'rgba(0,255,255,0.05)';
            ctx.fill();
        }

        ctx.restore();
    }

    function roundedRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    function drawHudOverlay(ctx, stats) {
        const x = 20;
        const y = 70;
        const w = 320;
        const h = 105;
        const r = 14;
        const colors = {
            panel: 'rgba(15, 23, 42, 0.70)',
            border: 'rgba(34, 211, 238, 0.55)',
            accent: '#22D3EE',
            text: 'rgba(248, 250, 252, 0.92)',
            subtext: 'rgba(148, 163, 184, 0.9)',
            good: '#4ADE80',
            bad: '#FB7185'
        };

        ctx.save();
        ctx.fillStyle = colors.panel;
        ctx.strokeStyle = colors.border;
        ctx.lineWidth = 1;
        roundedRect(ctx, x, y, w, h, r);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = colors.accent;
        ctx.font = '600 12px Segoe UI';
        ctx.textAlign = 'left';
        ctx.fillText('AI FITNESS TRACKER', x + 14, y + 20);

        ctx.font = '500 11px Segoe UI';
        ctx.fillStyle = colors.subtext;
        ctx.fillText('REPS', x + 14, y + 48);
        ctx.fillText('INVALID', x + 120, y + 48);
        ctx.fillText('STAGE', x + 230, y + 48);

        ctx.font = '600 18px Segoe UI';
        ctx.fillStyle = colors.good;
        ctx.fillText(String(stats.validReps), x + 14, y + 78);
        ctx.fillStyle = colors.bad;
        ctx.fillText(String(stats.invalidReps), x + 120, y + 78);
        ctx.fillStyle = colors.good;
        ctx.fillText((stats.stage || 'READY').toUpperCase(), x + 230, y + 78);

        const progress = Math.min(stats.validReps / 20, 1);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(x + 14, y + 90, w - 28, 5);

        const grad = ctx.createLinearGradient(x, 0, x + w, 0);
        grad.addColorStop(0, colors.accent);
        grad.addColorStop(1, colors.good);
        ctx.fillStyle = grad;
        ctx.fillRect(x + 14, y + 90, (w - 28) * progress, 5);

        if (stats.isRecording) {
            ctx.fillStyle = colors.bad;
            ctx.beginPath();
            ctx.arc(x + w - 14, y + 18, 4, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.restore();
    }

    window.FitLahPoseDrawing = {
        drawBodySkeleton,
        drawHudOverlay
    };
})();

