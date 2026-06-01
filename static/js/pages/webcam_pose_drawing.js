(function () {
    const BODY_CONNECTIONS = [
        [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
        [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
        [24, 26], [26, 28], [27, 29], [29, 31], [28, 30],
        [30, 32], [15, 17], [15, 19], [16, 18], [16, 20]
    ];
    const BODY_LANDMARK_INDICES = new Set(BODY_CONNECTIONS.flat());
    const TRACKING_BLUE = '#00D9FF';
    const TRACKING_BLUE_CORE = '#D8FAFF';
    const TRACKING_BLUE_SOFT = 'rgba(0, 217, 255, 0.42)';
    const TRACKING_BLUE_FAINT = 'rgba(0, 217, 255, 0.14)';

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

                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';

                ctx.shadowColor = TRACKING_BLUE;
                ctx.shadowBlur = 24;
                ctx.strokeStyle = TRACKING_BLUE_SOFT;
                ctx.lineWidth = 10;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();

                ctx.shadowBlur = 12;
                ctx.strokeStyle = TRACKING_BLUE;
                ctx.lineWidth = 3.8;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();

                ctx.shadowBlur = 0;
                ctx.strokeStyle = TRACKING_BLUE_CORE;
                ctx.lineWidth = 1.4;
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

                ctx.shadowColor = TRACKING_BLUE;
                ctx.shadowBlur = 24;

                ctx.beginPath();
                ctx.arc(x, y, 9.5, 0, Math.PI * 2);
                ctx.fillStyle = TRACKING_BLUE_SOFT;
                ctx.fill();

                ctx.shadowBlur = 10;
                ctx.strokeStyle = TRACKING_BLUE;
                ctx.lineWidth = 2.4;
                ctx.beginPath();
                ctx.arc(x, y, 6.8, 0, Math.PI * 2);
                ctx.stroke();

                ctx.shadowBlur = 0;
                ctx.beginPath();
                ctx.arc(x, y, 3.4, 0, Math.PI * 2);
                ctx.fillStyle = TRACKING_BLUE_CORE;
                ctx.fill();
            }
        }

        const leftShoulder = landmarks[11];
        const rightShoulder = landmarks[12];
        const leftHip = landmarks[23];
        const rightHip = landmarks[24];

        if (
            leftShoulder && rightShoulder && leftHip && rightHip &&
            (leftShoulder.visibility || 0) > 0.4 &&
            (rightShoulder.visibility || 0) > 0.4 &&
            (leftHip.visibility || 0) > 0.4 &&
            (rightHip.visibility || 0) > 0.4
        ) {
            ctx.beginPath();
            ctx.moveTo(leftShoulder.x * canvas.width, leftShoulder.y * canvas.height);
            ctx.lineTo(rightShoulder.x * canvas.width, rightShoulder.y * canvas.height);
            ctx.lineTo(rightHip.x * canvas.width, rightHip.y * canvas.height);
            ctx.lineTo(leftHip.x * canvas.width, leftHip.y * canvas.height);
            ctx.closePath();
            ctx.fillStyle = TRACKING_BLUE_FAINT;
            ctx.fill();
        }

        ctx.restore();
    }

    window.FitLahPoseDrawing = {
        drawBodySkeleton
    };
})();
