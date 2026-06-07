(function () {
    const STATE = {
        NOT_READY: 'not_ready',
        READY: 'ready',
        UP: 'up',
        DOWN: 'down',
        DESCENDING: 'descending',
        REP_COUNTED: 'rep_counted'
    };

    const LANDMARK = {
        LEFT_SHOULDER: 11,
        RIGHT_SHOULDER: 12,
        LEFT_HIP: 23,
        RIGHT_HIP: 24,
        LEFT_KNEE: 25,
        RIGHT_KNEE: 26
    };

    const CONFIG = {
        POSE_CONFIDENCE_MIN: 0.16,
        SMOOTHING_ALPHA: 0.82,
        SIGNAL_ALPHA: 0.82,
        MIN_AMPLITUDE: 0.025,
        REVERSAL_RATIO: 0.2,
        RETURN_RATIO: 0.78,
        MIN_REP_PERIOD_S: 0.32,
        MAX_REP_PERIOD_S: 8,
        REP_COOLDOWN_S: 0.38,
        CALIBRATION_FRAMES: 4,
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
        stage: 'SEEK_HIGH',
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
        tracker.stage = 'SEEK_HIGH';
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

    function shoulderPoint(landmarks) {
        const left = landmarks[LANDMARK.LEFT_SHOULDER];
        const right = landmarks[LANDMARK.RIGHT_SHOULDER];
        if (visible(left) && visible(right)) return midpoint(left, right);
        if (visible(left)) return left;
        if (visible(right)) return right;
        return null;
    }

    function situpSignal(landmarks) {
        const shoulder = shoulderPoint(landmarks);
        if (!shoulder) return null;
        const raw = -shoulder.y;
        tracker.smoothedSignal = tracker.smoothedSignal === null
            ? raw
            : tracker.smoothedSignal * (1 - CONFIG.SIGNAL_ALPHA) + raw * CONFIG.SIGNAL_ALPHA;
        return tracker.smoothedSignal;
    }

    function repMetricsCsv(data) {
        const rows = (data || []).map((item, index) => {
            const rep = Number.isFinite(item.rep) ? item.rep : index + 1;
            const amplitude = Number.isFinite(item.amplitude) ? item.amplitude : item.amplitude_lift_pct;
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
            amplitude: Number((amplitude * 100).toFixed(3)),
            amplitude_lift_pct: Number((amplitude * 100).toFixed(3)),
            time_s: Number(time.toFixed(3))
        });
        tracker.state = STATE.REP_COUNTED;
        helpers.countValidRep(STATE.DOWN);
        helpers.setStage(STATE.REP_COUNTED);
        publishMetrics(helpers.metrics);
        return true;
    }

    function processSignal(time, value, helpers) {
        tracker.minValue = Math.min(tracker.minValue, value);
        tracker.maxValue = Math.max(tracker.maxValue, value);

        if (tracker.low === null || value < tracker.low) {
            tracker.low = value;
            tracker.lowTime = time;
        }
        if (tracker.high === null || value > tracker.high) {
            tracker.high = value;
            tracker.highTime = time;
        }

        const dynamicRange = Math.max(CONFIG.MIN_AMPLITUDE, tracker.maxValue - tracker.minValue);
        const reversal = Math.max(CONFIG.MIN_AMPLITUDE * 0.45, dynamicRange * CONFIG.REVERSAL_RATIO);

        if (tracker.stage === 'SEEK_HIGH') {
            if (value > tracker.high) {
                tracker.high = value;
                tracker.highTime = time;
            }
            const lift = tracker.high - tracker.low;
            if (lift >= CONFIG.MIN_AMPLITUDE && value <= tracker.high - reversal) {
                tracker.stage = 'SEEK_LOW';
                tracker.state = STATE.UP;
                helpers.setStage(STATE.UP);
                helpers.setWarning('Good lift - return shoulders down.');
            } else {
                tracker.state = STATE.READY;
                helpers.setStage(STATE.READY);
                helpers.setWarning(helpers.sessionStarted ? 'Recording - lift and return shoulders down.' : 'Ready - start sit-ups.');
            }
            return;
        }

        if (value < tracker.low) {
            tracker.low = value;
            tracker.lowTime = time;
        }

        const amplitude = tracker.high - tracker.low;
        const returnedLowEnough = value <= tracker.high - amplitude * CONFIG.RETURN_RATIO;
        if (amplitude >= CONFIG.MIN_AMPLITUDE && returnedLowEnough) {
            if (countRep(time, amplitude, helpers)) {
                tracker.stage = 'SEEK_HIGH';
                tracker.low = value;
                tracker.lowTime = time;
                tracker.high = value;
                tracker.highTime = time;
            }
            return;
        }

        tracker.state = STATE.DESCENDING;
        helpers.setStage(STATE.DESCENDING);
        helpers.setWarning('Return shoulders down to finish the rep.');
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
        const shoulder = shoulderPoint(landmarks);
        const liftPct = (signal - tracker.minValue) * 100;
        if (metrics.frames_sampled % CONFIG.GRAPH_SAMPLE_EVERY_FRAMES === 0) {
            metrics.movement_samples.push({
                time: helpers.sessionElapsedSeconds(),
                value: Number(Math.max(0, liftPct).toFixed(3)),
                torso_lift: Number(Math.max(0, liftPct).toFixed(3))
            });
            if (metrics.movement_samples.length > 900) metrics.movement_samples.shift();
        }

        if (shoulder) {
            const leftHip = landmarks[LANDMARK.LEFT_HIP];
            const rightHip = landmarks[LANDMARK.RIGHT_HIP];
            const leftKnee = landmarks[LANDMARK.LEFT_KNEE];
            const rightKnee = landmarks[LANDMARK.RIGHT_KNEE];
            const hip = visible(leftHip) && visible(rightHip) ? midpoint(leftHip, rightHip) : (visible(leftHip) ? leftHip : rightHip);
            const knee = visible(leftKnee) && visible(rightKnee) ? midpoint(leftKnee, rightKnee) : (visible(leftKnee) ? leftKnee : rightKnee);
            if (visible(hip, 0.08) && visible(knee, 0.08)) {
                const hipAngle = helpers.angle(shoulder, hip, knee);
                if (signal <= tracker.low + CONFIG.MIN_AMPLITUDE) metrics.hip_down_angles.push(Math.round(hipAngle));
                if (signal >= tracker.high - CONFIG.MIN_AMPLITUDE) metrics.hip_up_angles.push(Math.round(hipAngle));
            }
        }
        publishMetrics(metrics);
    }

    function analyze(landmarks, helpers) {
        const smoothed = smoothLandmarks(landmarks);
        const signal = situpSignal(smoothed);
        if (!Number.isFinite(signal)) {
            tracker.missingFrames++;
            if (tracker.missingFrames > CONFIG.MAX_MISSING_FRAMES) {
                helpers.setStage(STATE.NOT_READY);
                helpers.setWarning('Keep at least one shoulder clearly visible.');
            }
            return;
        }

        tracker.missingFrames = 0;
        tracker.framesSeen++;
        helpers.setPositionReady(true);
        if (tracker.framesSeen <= CONFIG.CALIBRATION_FRAMES) {
            tracker.minValue = Math.min(tracker.minValue, signal);
            tracker.maxValue = Math.max(tracker.maxValue, signal);
            tracker.low = tracker.low === null ? signal : Math.min(tracker.low, signal);
            tracker.high = tracker.high === null ? signal : Math.max(tracker.high, signal);
            tracker.lowTime = timeSeconds(helpers);
            tracker.highTime = timeSeconds(helpers);
            tracker.previousSignal = signal;
            tracker.previousTime = timeSeconds(helpers);
            helpers.setStage(STATE.READY);
            helpers.setWarning('Calibrating shoulder height.');
            sampleMetrics(helpers.metrics, helpers, smoothed, signal);
            return;
        }
        processWithGapFill(timeSeconds(helpers), signal, helpers);
        sampleMetrics(helpers.metrics, helpers, smoothed, signal);
    }

    function drawHandsOnEarsGuide(landmarks, drawing) {
    }

    function enrichMetrics(payload, metrics, avgAngle) {
        payload.avg_hip_angle_lying = avgAngle(metrics.hip_down_angles);
        payload.avg_hip_angle_sitting = avgAngle(metrics.hip_up_angles);
        const liftValues = (metrics.movement_samples || [])
            .map(sample => sample.value)
            .filter(Number.isFinite);
        payload.avg_situp_lift_pct = liftValues.length
            ? Number((liftValues.reduce((sum, value) => sum + value, 0) / liftValues.length).toFixed(3))
            : null;
        payload.rep_metrics = Array.isArray(metrics.rep_metrics) ? metrics.rep_metrics.slice() : [];
        payload.rep_metrics_csv = metrics.rep_metrics_csv || repMetricsCsv(payload.rep_metrics);
        payload.rep_count_signal = metrics.rep_count_signal || payload.rep_metrics.length;
    }

    window.FitLahSitupExercise = {
        analyze,
        drawHandsOnEarsGuide,
        enrichMetrics,
        reset,
        STATE,
        CONFIG
    };
})();
