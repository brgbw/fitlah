(function () {
    const STATE = {
        NOT_READY: 'waiting',
        READY: 'ready',
        DOWN: 'down',
        UP: 'up',
        REP_COUNTED: 'rep_counted'
    };

    const LANDMARK = {
        NOSE: 0,
        LEFT_SHOULDER: 11,
        RIGHT_SHOULDER: 12,
        LEFT_ELBOW: 13,
        RIGHT_ELBOW: 14,
        LEFT_WRIST: 15,
        RIGHT_WRIST: 16,
        LEFT_HIP: 23,
        RIGHT_HIP: 24,
        LEFT_KNEE: 25,
        RIGHT_KNEE: 26,
        LEFT_ANKLE: 27,
        RIGHT_ANKLE: 28
    };

    const CONFIG = {
        POSE_CONFIDENCE_MIN: 0.16,
        SMOOTHING_ALPHA: 0.82,
        SIGNAL_ALPHA: 0.82,
        MIN_AMPLITUDE: 0.018,
        REVERSAL_RATIO: 0.22,
        RETURN_RATIO: 0.45,
        MIN_REP_PERIOD_S: 0.22,
        MAX_REP_PERIOD_S: 8,
        REP_COOLDOWN_S: 0.14,
        MAX_INTERPOLATION_STEP_S: 1 / 18,
        GRAPH_SAMPLE_EVERY_FRAMES: 2,
        MAX_MISSING_FRAMES: 8
    };

    const tracker = {
        state: STATE.NOT_READY,
        smoothedLandmarks: null,
        smoothedSignal: null,
        previousSignal: null,
        previousTime: null,
        missingFrames: 0,
        framesSeen: 0,
        stage: 'SEEK_LOW',
        low: null,
        lowTime: 0,
        high: null,
        highTime: 0,
        lastCountedAt: -Infinity,
        repLogs: [],
        repCount: 0,
        minValue: Infinity,
        maxValue: -Infinity
    };

    function reset() {
        tracker.state = STATE.NOT_READY;
        tracker.smoothedLandmarks = null;
        tracker.smoothedSignal = null;
        tracker.previousSignal = null;
        tracker.previousTime = null;
        tracker.missingFrames = 0;
        tracker.framesSeen = 0;
        tracker.stage = 'SEEK_LOW';
        tracker.low = null;
        tracker.lowTime = 0;
        tracker.high = null;
        tracker.highTime = 0;
        tracker.lastCountedAt = -Infinity;
        tracker.repLogs = [];
        tracker.repCount = 0;
        tracker.minValue = Infinity;
        tracker.maxValue = -Infinity;
    }

    function visible(point, minVisibility = CONFIG.POSE_CONFIDENCE_MIN) {
        return point && (point.visibility || 0) >= minVisibility;
    }

    function midpoint(a, b) {
        return {
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
            z: ((a.z || 0) + (b.z || 0)) / 2,
            visibility: Math.min(a.visibility || 0, b.visibility || 0)
        };
    }

    function cloneLandmark(point) {
        return {
            x: point.x,
            y: point.y,
            z: point.z || 0,
            visibility: point.visibility || 0
        };
    }

    function smoothLandmarks(landmarks) {
        if (!tracker.smoothedLandmarks) {
            tracker.smoothedLandmarks = landmarks.map(cloneLandmark);
            return tracker.smoothedLandmarks;
        }

        const inverseAlpha = 1 - CONFIG.SMOOTHING_ALPHA;
        landmarks.forEach((point, index) => {
            let previous = tracker.smoothedLandmarks[index];
            if (!previous) {
                tracker.smoothedLandmarks[index] = cloneLandmark(point);
                return;
            }
            previous.x = previous.x * inverseAlpha + point.x * CONFIG.SMOOTHING_ALPHA;
            previous.y = previous.y * inverseAlpha + point.y * CONFIG.SMOOTHING_ALPHA;
            previous.z = previous.z * inverseAlpha + (point.z || 0) * CONFIG.SMOOTHING_ALPHA;
            previous.visibility = previous.visibility * inverseAlpha + (point.visibility || 0) * CONFIG.SMOOTHING_ALPHA;
        });
        tracker.smoothedLandmarks.length = landmarks.length;
        return tracker.smoothedLandmarks;
    }

    function timeSeconds(helpers) {
        if (helpers.isReplayMode) return helpers.sessionElapsedSeconds();
        if (tracker.previousTime === null) return 0;
        return tracker.previousTime + Math.max(0.001, 1 / 30);
    }

    function pointLineY(a, b, x) {
        const dx = b.x - a.x;
        if (Math.abs(dx) < 0.001) return Math.max(a.y, b.y);
        const t = Math.max(-0.5, Math.min(1.5, (x - a.x) / dx));
        return a.y + t * (b.y - a.y);
    }

    function bestSide(landmarks) {
        const left = [11, 13, 15, 23, 25, 27].reduce((sum, index) => sum + (landmarks[index]?.visibility || 0), 0);
        const right = [12, 14, 16, 24, 26, 28].reduce((sum, index) => sum + (landmarks[index]?.visibility || 0), 0);
        return left >= right
            ? {
                shoulder: landmarks[LANDMARK.LEFT_SHOULDER],
                elbow: landmarks[LANDMARK.LEFT_ELBOW],
                wrist: landmarks[LANDMARK.LEFT_WRIST],
                hip: landmarks[LANDMARK.LEFT_HIP],
                knee: landmarks[LANDMARK.LEFT_KNEE],
                ankle: landmarks[LANDMARK.LEFT_ANKLE]
            }
            : {
                shoulder: landmarks[LANDMARK.RIGHT_SHOULDER],
                elbow: landmarks[LANDMARK.RIGHT_ELBOW],
                wrist: landmarks[LANDMARK.RIGHT_WRIST],
                hip: landmarks[LANDMARK.RIGHT_HIP],
                knee: landmarks[LANDMARK.RIGHT_KNEE],
                ankle: landmarks[LANDMARK.RIGHT_ANKLE]
            };
    }

    function shoulderHeightSignal(landmarks) {
        const required = [
            landmarks[LANDMARK.LEFT_SHOULDER],
            landmarks[LANDMARK.RIGHT_SHOULDER],
            landmarks[LANDMARK.LEFT_WRIST],
            landmarks[LANDMARK.RIGHT_WRIST],
            landmarks[LANDMARK.LEFT_ANKLE],
            landmarks[LANDMARK.RIGHT_ANKLE]
        ];
        if (!required.every(point => visible(point))) return null;

        const shoulder = midpoint(landmarks[LANDMARK.LEFT_SHOULDER], landmarks[LANDMARK.RIGHT_SHOULDER]);
        const wrist = midpoint(landmarks[LANDMARK.LEFT_WRIST], landmarks[LANDMARK.RIGHT_WRIST]);
        const ankle = midpoint(landmarks[LANDMARK.LEFT_ANKLE], landmarks[LANDMARK.RIGHT_ANKLE]);
        const floorY = pointLineY(wrist, ankle, shoulder.x);
        const bodyLength = Math.max(0.001, Math.hypot(shoulder.x - ankle.x, shoulder.y - ankle.y));
        const raw = Math.max(0, (floorY - shoulder.y) / bodyLength);
        tracker.smoothedSignal = tracker.smoothedSignal === null
            ? raw
            : tracker.smoothedSignal * (1 - CONFIG.SIGNAL_ALPHA) + raw * CONFIG.SIGNAL_ALPHA;
        return tracker.smoothedSignal;
    }

    function repMetricsCsv(data) {
        const rows = (data || []).map((item, index) => {
            const rep = Number.isFinite(item.rep) ? item.rep : index + 1;
            const amplitude = Number.isFinite(item.amplitude) ? item.amplitude : item.amplitude_px;
            const period = item.period_s;
            return [
                rep,
                Number.isFinite(amplitude) ? Number(amplitude).toFixed(3) : '',
                Number.isFinite(period) ? Number(period).toFixed(3) : ''
            ].join(',');
        });
        return `rep,amplitude,period_s${rows.length ? `\n${rows.join('\n')}` : ''}`;
    }

    function publishMetrics(metrics) {
        if (!metrics) return;
        metrics.rep_metrics = tracker.repLogs.map(log => ({ ...log }));
        metrics.rep_count_signal = tracker.repCount;
        metrics.rep_metrics_csv = repMetricsCsv(metrics.rep_metrics);
    }

    function countRep(time, amplitude, helpers) {
        if (time - tracker.lastCountedAt < CONFIG.REP_COOLDOWN_S) return false;
        const period = tracker.lowTime > 0 ? time - tracker.lowTime : CONFIG.MIN_REP_PERIOD_S;
        if (period < CONFIG.MIN_REP_PERIOD_S || period > CONFIG.MAX_REP_PERIOD_S) return false;

        tracker.repCount++;
        tracker.lastCountedAt = time;
        tracker.repLogs.push({
            rep: tracker.repCount,
            period_s: Number(period.toFixed(3)),
            amplitude: Number(amplitude.toFixed(3)),
            amplitude_px: Number(amplitude.toFixed(3)),
            time_s: Number(time.toFixed(3))
        });
        tracker.state = STATE.REP_COUNTED;
        helpers.countValidRep(STATE.UP);
        helpers.setStage(STATE.REP_COUNTED);
        publishMetrics(helpers.metrics);
        return true;
    }

    function processSignal(time, value, helpers) {
        tracker.minValue = Math.min(tracker.minValue, value);
        tracker.maxValue = Math.max(tracker.maxValue, value);

        if (tracker.high === null || value > tracker.high) {
            tracker.high = value;
            tracker.highTime = time;
        }
        if (tracker.low === null || value < tracker.low) {
            tracker.low = value;
            tracker.lowTime = time;
        }

        const dynamicRange = Math.max(CONFIG.MIN_AMPLITUDE, tracker.maxValue - tracker.minValue);
        const reversal = Math.max(CONFIG.MIN_AMPLITUDE * 0.45, dynamicRange * CONFIG.REVERSAL_RATIO);

        if (tracker.stage === 'SEEK_LOW') {
            if (value < tracker.low) {
                tracker.low = value;
                tracker.lowTime = time;
            }
            const drop = tracker.high - tracker.low;
            if (drop >= CONFIG.MIN_AMPLITUDE && value >= tracker.low + drop * CONFIG.RETURN_RATIO) {
                if (countRep(time, drop, helpers)) {
                    tracker.stage = 'SEEK_LOW';
                    tracker.low = value;
                    tracker.lowTime = time;
                    tracker.high = value;
                    tracker.highTime = time;
                }
                return;
            }
            if (drop >= CONFIG.MIN_AMPLITUDE && value >= tracker.low + reversal) {
                if (time - tracker.lowTime >= CONFIG.MIN_REP_PERIOD_S) {
                    if (countRep(time, drop, helpers)) {
                        tracker.stage = 'SEEK_LOW';
                        tracker.low = value;
                        tracker.lowTime = time;
                        tracker.high = value;
                        tracker.highTime = time;
                    }
                    return;
                }
                tracker.state = STATE.DOWN;
                helpers.setStage(STATE.DOWN);
                helpers.setWarning('Lowered - keep pushing up.');
                return;
            }
            tracker.state = STATE.READY;
            helpers.setStage(STATE.READY);
            helpers.setWarning(helpers.sessionStarted ? 'Recording - keep moving smoothly.' : 'Ready - start push-ups.');
            return;
        }

        if (value > tracker.high) {
            tracker.high = value;
            tracker.highTime = time;
        }

        const rise = tracker.high - tracker.low;
        const returnedHighEnough = value >= tracker.low + rise * CONFIG.RETURN_RATIO;
        if (rise >= CONFIG.MIN_AMPLITUDE && returnedHighEnough) {
            countRep(time, rise, helpers);
            tracker.stage = 'SEEK_LOW';
            tracker.low = value;
            tracker.lowTime = time;
            tracker.high = value;
            tracker.highTime = time;
            return;
        }

        tracker.state = STATE.UP;
        helpers.setStage(STATE.UP);
        helpers.setWarning('Push back up to finish the rep.');
    }

    function processWithGapFill(time, value, helpers) {
        if (tracker.previousSignal !== null && tracker.previousTime !== null) {
            const gap = time - tracker.previousTime;
            if (gap > CONFIG.MAX_INTERPOLATION_STEP_S * 1.5 && gap < 0.8) {
                const steps = Math.min(8, Math.floor(gap / CONFIG.MAX_INTERPOLATION_STEP_S));
                for (let step = 1; step < steps; step++) {
                    const ratio = step / steps;
                    processSignal(
                        tracker.previousTime + gap * ratio,
                        tracker.previousSignal + (value - tracker.previousSignal) * ratio,
                        helpers
                    );
                }
            }
        }

        processSignal(time, value, helpers);
        tracker.previousSignal = value;
        tracker.previousTime = time;
    }

    function sampleMetrics(metrics, helpers, landmarks, signal) {
        if (!helpers.isRecording || !metrics) return;
        metrics.frames_sampled++;

        const side = bestSide(landmarks);
        const elbowAngle = visible(side.shoulder) && visible(side.elbow) && visible(side.wrist)
            ? helpers.angle(side.shoulder, side.elbow, side.wrist)
            : null;
        if (metrics.frames_sampled % CONFIG.GRAPH_SAMPLE_EVERY_FRAMES === 0) {
            metrics.movement_samples.push({
                time: helpers.sessionElapsedSeconds(),
                value: Number(signal.toFixed(4)),
                elbow_angle: Number.isFinite(elbowAngle) ? Math.round(elbowAngle) : null
            });
            if (metrics.movement_samples.length > 900) metrics.movement_samples.shift();
        }

        if (Number.isFinite(elbowAngle)) {
            if (elbowAngle < 150) metrics.elbow_down_angles.push(Math.round(elbowAngle));
            if (elbowAngle >= 150) metrics.elbow_up_angles.push(Math.round(elbowAngle));
        }
        publishMetrics(metrics);
    }

    function analyze(landmarks, helpers) {
        const smoothed = smoothLandmarks(landmarks);
        const signal = shoulderHeightSignal(smoothed);
        if (!Number.isFinite(signal)) {
            tracker.missingFrames++;
            if (tracker.missingFrames > CONFIG.MAX_MISSING_FRAMES) {
                helpers.setStage(STATE.NOT_READY);
                helpers.setWarning('Keep shoulders, wrists, and ankles visible.');
            }
            return;
        }

        tracker.missingFrames = 0;
        tracker.framesSeen++;
        helpers.setPositionReady(true);
        processWithGapFill(timeSeconds(helpers), signal, helpers);
        sampleMetrics(helpers.metrics, helpers, smoothed, signal);
    }

    function enrichMetrics(payload, metrics, avgAngle) {
        payload.avg_elbow_angle_down = avgAngle(metrics.elbow_down_angles);
        payload.avg_elbow_angle_up = avgAngle(metrics.elbow_up_angles);
        payload.shallow_rep_signals = metrics.shallow_rep_signals || 0;
        payload.rep_metrics = Array.isArray(metrics.rep_metrics) ? metrics.rep_metrics.slice() : [];
        payload.rep_metrics_csv = metrics.rep_metrics_csv || repMetricsCsv(payload.rep_metrics);
        payload.rep_count_signal = metrics.rep_count_signal || payload.rep_metrics.length;
    }

    window.FitLahPushupExercise = {
        analyze,
        enrichMetrics,
        reset,
        STATE,
        CONFIG
    };
})();
