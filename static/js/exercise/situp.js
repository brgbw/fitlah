(function () {
    const STATE = {
        NOT_READY: 'not_ready',
        READY: 'ready',
        DOWN: 'down',
        ASCENDING: 'ascending',
        UP: 'up',
        DESCENDING: 'descending',
        REP_COUNTED: 'rep_counted',
        INVALID_FORM: 'invalid_form'
    };

    const LANDMARK = {
        LEFT_SHOULDER: 11,
        RIGHT_SHOULDER: 12,
        LEFT_HIP: 23,
        RIGHT_HIP: 24,
        LEFT_KNEE: 25,
        RIGHT_KNEE: 26,
        LEFT_ANKLE: 27,
        RIGHT_ANKLE: 28
    };

    const CONFIG = {
        // The first rep is armed after a brief stable lying/down setup hold.
        READY_HOLD_MS: 100,
        // MediaPipe visibility can flicker during floor exercises; low-confidence frames do not move states.
        POSE_CONFIDENCE_MIN: 0.2,
        // EMA smoothing reduces small landmark jitter while keeping transitions responsive.
        SMOOTHING_ALPHA: 0.6,
        // Sit-up counting is intentionally lenient: a rep is driven by shoulder height only.
        SHOULDER_LIFT_MIN: 0.020,
        SHOULDER_LIFT_RETURN_TOLERANCE: 0.045,
        SHOULDER_DESCENT_MIN: 0.006,
        STARTUP_RETURN_LIFT_MIN: 0.020,
        SHOULDER_BASELINE_ALPHA: 0.12,
        MIN_REP_DURATION_MS: 50,
        REP_COOLDOWN_MS: 50,
        STABLE_FRAMES_REQUIRED: 1,
        INVALID_POSE_GRACE_FRAMES: 5,
        GRAPH_SAMPLE_EVERY_FRAMES: 2
    };

    const tracker = {
        state: STATE.NOT_READY,
        readyStartedAt: null,
        readyConfirmed: false,
        smoothedLandmarks: null,
        downShoulderY: null,
        repStartedAt: 0,
        lastCountedAt: 0,
        maxShoulderLiftThisRep: 0,
        startupShoulderY: null,
        startupReturnCounted: false,
        invalidPostureFrames: 0,
        downFrames: 0,
        upFrames: 0,
        ascendingFrames: 0,
        descendingFrames: 0,
        repStartedAtSeconds: 0,
        repStartDownShoulderY: null
    };

    function reset() {
        tracker.state = STATE.NOT_READY;
        tracker.readyStartedAt = null;
        tracker.readyConfirmed = false;
        tracker.smoothedLandmarks = null;
        tracker.downShoulderY = null;
        tracker.repStartedAt = 0;
        tracker.lastCountedAt = 0;
        tracker.maxShoulderLiftThisRep = 0;
        tracker.startupShoulderY = null;
        tracker.startupReturnCounted = false;
        tracker.invalidPostureFrames = 0;
        tracker.downFrames = 0;
        tracker.upFrames = 0;
        tracker.ascendingFrames = 0;
        tracker.descendingFrames = 0;
        tracker.repStartedAtSeconds = 0;
        tracker.repStartDownShoulderY = null;
    }

    function visible(point, minVisibility) {
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

    function poseConfidence(landmarks) {
        return Math.max(
            landmarks[LANDMARK.LEFT_SHOULDER]?.visibility || 0,
            landmarks[LANDMARK.RIGHT_SHOULDER]?.visibility || 0
        );
    }

    function smoothLandmarks(landmarks) {
        if (!tracker.smoothedLandmarks) {
            tracker.smoothedLandmarks = landmarks.map(cloneLandmark);
            return tracker.smoothedLandmarks;
        }

        const inverseAlpha = 1 - CONFIG.SMOOTHING_ALPHA;
        for (let idx = 0; idx < landmarks.length; idx++) {
            const point = landmarks[idx];
            let previous = tracker.smoothedLandmarks[idx];
            if (!previous) {
                previous = cloneLandmark(point);
                tracker.smoothedLandmarks[idx] = previous;
                continue;
            }
            previous.x = previous.x * inverseAlpha + point.x * CONFIG.SMOOTHING_ALPHA;
            previous.y = previous.y * inverseAlpha + point.y * CONFIG.SMOOTHING_ALPHA;
            previous.z = previous.z * inverseAlpha + (point.z || 0) * CONFIG.SMOOTHING_ALPHA;
            previous.visibility = previous.visibility * inverseAlpha + (point.visibility || 0) * CONFIG.SMOOTHING_ALPHA;
        }
        tracker.smoothedLandmarks.length = landmarks.length;
        return tracker.smoothedLandmarks;
    }

    function drawHandsOnEarsGuide(landmarks, drawing) {
        // Hand-on-ear validation has been removed from sit-up counting, so this guide is intentionally empty.
    }

    function validateSitupPosture(landmarks, helpers, phase) {
        const leftShoulder = landmarks[LANDMARK.LEFT_SHOULDER];
        const rightShoulder = landmarks[LANDMARK.RIGHT_SHOULDER];
        const minVisibility = CONFIG.POSE_CONFIDENCE_MIN;

        let shoulderPoint = null;
        if (visible(leftShoulder, minVisibility) && visible(rightShoulder, minVisibility)) {
            shoulderPoint = midpoint(leftShoulder, rightShoulder);
        } else if (visible(leftShoulder, minVisibility)) {
            shoulderPoint = leftShoulder;
        } else if (visible(rightShoulder, minVisibility)) {
            shoulderPoint = rightShoulder;
        }

        if (!shoulderPoint) {
            return { ok: false, reason: 'Keep at least one shoulder clearly visible.' };
        }

        const shoulderY = shoulderPoint.y;
        const shoulderLift = tracker.downShoulderY === null
            ? 0
            : Math.max(0, tracker.downShoulderY - shoulderY);

        if (phase === 'down' &&
            tracker.downShoulderY !== null &&
            shoulderLift > CONFIG.SHOULDER_LIFT_RETURN_TOLERANCE) {
            return { ok: false, reason: 'Return your shoulders down before starting the next sit-up.' };
        }

        return {
            ok: true,
            reason: '',
            metrics: {
                shoulderY,
                shoulderLift,
                shoulderLiftPct: shoulderLift * 100
            }
        };
    }

    function setReadiness(validation, helpers, now) {
        if (!validation.ok) {
            tracker.readyStartedAt = null;
            tracker.readyConfirmed = false;
            tracker.state = STATE.NOT_READY;
            tracker.downFrames = 0;
            helpers.setPositionReady(false);
            helpers.setStage(STATE.NOT_READY);
            helpers.setWarning(validation.reason);
            return false;
        }

        if (tracker.readyStartedAt === null) {
            tracker.readyStartedAt = now;
        }

        const heldMs = helpers.isReplayMode ? CONFIG.READY_HOLD_MS : now - tracker.readyStartedAt;
        if (heldMs < CONFIG.READY_HOLD_MS) {
            const remaining = Math.max(0.1, (CONFIG.READY_HOLD_MS - heldMs) / 1000).toFixed(1);
            tracker.state = STATE.NOT_READY;
            helpers.setPositionReady(false);
            helpers.setStage(STATE.NOT_READY);
            helpers.setWarning(`Hold the sit-up down position for ${remaining}s.`);
            return false;
        }

        tracker.readyConfirmed = true;
        tracker.state = STATE.READY;
        if (tracker.startupShoulderY === null) {
            tracker.startupShoulderY = validation.metrics.shoulderY;
        }
        updateDownShoulderBaseline(validation.metrics.shoulderY);
        helpers.setPositionReady(true);
        helpers.setStage(STATE.READY);
        return true;
    }

    function updateStableFrames(isDown, isUp, isAscending, isDescending) {
        tracker.downFrames = isDown ? tracker.downFrames + 1 : 0;
        tracker.upFrames = isUp ? tracker.upFrames + 1 : 0;
        tracker.ascendingFrames = isAscending ? tracker.ascendingFrames + 1 : 0;
        tracker.descendingFrames = isDescending ? tracker.descendingFrames + 1 : 0;
    }

    function beginRep(helpers, now, validation) {
        tracker.state = validation.metrics.shoulderLift >= CONFIG.SHOULDER_LIFT_MIN
            ? STATE.UP
            : STATE.ASCENDING;
        tracker.repStartedAt = now;
        tracker.repStartedAtSeconds = helpers.sessionElapsedSeconds();
        tracker.repStartDownShoulderY = validation.metrics.shoulderY;
        tracker.maxShoulderLiftThisRep = validation.metrics.shoulderLift;
        helpers.setStage(tracker.state);
    }

    function invalidateRep(helpers, message) {
        tracker.state = STATE.INVALID_FORM;
        tracker.readyConfirmed = false;
        tracker.readyStartedAt = null;
        tracker.downFrames = 0;
        tracker.upFrames = 0;
        tracker.ascendingFrames = 0;
        tracker.descendingFrames = 0;
        tracker.repStartedAtSeconds = 0;
        tracker.repStartDownShoulderY = null;
        tracker.invalidPostureFrames = 0;
        helpers.setPositionReady(false);
        helpers.setStage(STATE.INVALID_FORM);
        helpers.markInvalid(message);
    }

    function updateDownShoulderBaseline(shoulderY) {
        if (!Number.isFinite(shoulderY)) return;
        if (tracker.downShoulderY === null) {
            tracker.downShoulderY = shoulderY;
            return;
        }
        if (shoulderY > tracker.downShoulderY) {
            tracker.downShoulderY = shoulderY;
            return;
        }
        tracker.downShoulderY = tracker.downShoulderY * (1 - CONFIG.SHOULDER_BASELINE_ALPHA) +
            shoulderY * CONFIG.SHOULDER_BASELINE_ALPHA;
    }

    function sampleMetrics(metrics, helpers, validation) {
        if (!helpers.isRecording || !metrics) return;
        metrics.frames_sampled++;

        if (!validation.ok) return;

        const shoulderLiftPct = validation.metrics.shoulderLiftPct;
        if (metrics.frames_sampled % CONFIG.GRAPH_SAMPLE_EVERY_FRAMES === 0) {
            metrics.movement_samples.push({
                time: helpers.sessionElapsedSeconds(),
                value: Number(shoulderLiftPct.toFixed(3)),
                torso_lift: Number(shoulderLiftPct.toFixed(3))
            });
            if (metrics.movement_samples.length > 900) {
                metrics.movement_samples.shift();
            }
        }
    }

    function repMetricsCsv(data) {
        const rows = (data || []).map((item, index) => {
            const rep = Number.isFinite(item.rep) ? item.rep : index + 1;
            const amplitude = Number.isFinite(item.amplitude_angle_deg) ? item.amplitude_angle_deg : item.amplitude;
            const period = item.period_s;
            return [
                rep,
                Number.isFinite(amplitude) ? Number(amplitude).toFixed(3) : '',
                Number.isFinite(period) ? Number(period).toFixed(3) : ''
            ].join(',');
        });
        return `rep,amplitude,period_s${rows.length ? `\n${rows.join('\n')}` : ''}`;
    }

    function recordRepMetrics(metrics, helpers, periodMs) {
        if (!helpers.isRecording || !metrics) return;
        const count = Array.isArray(metrics.rep_metrics) ? metrics.rep_metrics.length : 0;
        const periodFromVideo = helpers.sessionElapsedSeconds() - tracker.repStartedAtSeconds;
        const period = Number.isFinite(periodFromVideo) && periodFromVideo > 0
            ? periodFromVideo
            : periodMs / 1000;
        const amplitude = tracker.maxShoulderLiftThisRep * 100;
        if (!Array.isArray(metrics.rep_metrics)) metrics.rep_metrics = [];
        metrics.rep_metrics.push({
            rep: count + 1,
            period_s: Number(period.toFixed(3)),
            amplitude_lift_pct: Number(amplitude.toFixed(3)),
            amplitude: Number(amplitude.toFixed(3)),
            time_s: Number(helpers.sessionElapsedSeconds().toFixed(3))
        });
        metrics.rep_metrics_csv = repMetricsCsv(metrics.rep_metrics);
        metrics.rep_count_signal = metrics.rep_metrics.length;
    }

    function recoverStartupReturnRep(helpers, now, posture) {
        if (!helpers.isReplayMode ||
            tracker.startupReturnCounted ||
            tracker.startupShoulderY === null ||
            (helpers.validReps || 0) > 0) {
            return false;
        }

        const startupReturnLift = posture.metrics.shoulderY - tracker.startupShoulderY;
        if (startupReturnLift < CONFIG.STARTUP_RETURN_LIFT_MIN) return false;

        tracker.maxShoulderLiftThisRep = Math.max(tracker.maxShoulderLiftThisRep, startupReturnLift);
        tracker.repStartedAt = Math.max(0, now - CONFIG.MIN_REP_DURATION_MS);
        tracker.repStartedAtSeconds = Math.max(0, helpers.sessionElapsedSeconds() - CONFIG.MIN_REP_DURATION_MS / 1000);
        recordRepMetrics(helpers.metrics, helpers, CONFIG.MIN_REP_DURATION_MS);
        tracker.lastCountedAt = now;
        tracker.startupReturnCounted = true;
        tracker.state = STATE.REP_COUNTED;
        updateDownShoulderBaseline(posture.metrics.shoulderY);
        helpers.countValidRep(STATE.DOWN);
        helpers.setStage(STATE.REP_COUNTED);
        return true;
    }

    function analyze(landmarks, helpers) {
        const now = Date.now();

        if (poseConfidence(landmarks) < CONFIG.POSE_CONFIDENCE_MIN) {
            if (!helpers.sessionStarted) reset();
            helpers.setWarning('Pose confidence is low. Keep at least one shoulder clearly inside the frame.');
            return;
        }

        const smoothed = smoothLandmarks(landmarks);
        const posture = validateSitupPosture(smoothed, helpers, 'moving');
        const downPosture = validateSitupPosture(smoothed, helpers, 'down');

        // Ready validation calibrates the down shoulder height. Hand-on-ear validation is intentionally
        // not part of sit-up counting.
        if (!tracker.readyConfirmed) {
            setReadiness(downPosture, helpers, now);
            sampleMetrics(helpers.metrics, helpers, posture);
            return;
        }

        if (!posture.ok) {
            tracker.invalidPostureFrames++;
            helpers.setWarning(posture.reason);
            if (tracker.invalidPostureFrames >= CONFIG.INVALID_POSE_GRACE_FRAMES) {
                invalidateRep(helpers, posture.reason);
            }
            sampleMetrics(helpers.metrics, helpers, posture);
            return;
        }
        tracker.invalidPostureFrames = 0;

        const shoulderLift = posture.metrics.shoulderLift;
        const isDown = downPosture.ok;
        const isUp = shoulderLift >= CONFIG.SHOULDER_LIFT_MIN;
        const isAscending = shoulderLift >= CONFIG.SHOULDER_DESCENT_MIN && !isUp;
        const isDescending = tracker.maxShoulderLiftThisRep >= CONFIG.SHOULDER_LIFT_MIN &&
            shoulderLift <= tracker.maxShoulderLiftThisRep - CONFIG.SHOULDER_DESCENT_MIN;
        updateStableFrames(isDown, isUp, isAscending, isDescending);

        tracker.maxShoulderLiftThisRep = Math.max(tracker.maxShoulderLiftThisRep, shoulderLift);
        if (isDown && (tracker.state === STATE.READY || tracker.state === STATE.DOWN || tracker.state === STATE.REP_COUNTED)) {
            if (recoverStartupReturnRep(helpers, now, posture)) {
                sampleMetrics(helpers.metrics, helpers, posture);
                return;
            }
            updateDownShoulderBaseline(posture.metrics.shoulderY);
        }

        // Count only after the shoulder-lift cycle returns down, which prevents duplicate top counts.
        if (tracker.state === STATE.READY || tracker.state === STATE.DOWN) {
            helpers.setWarning(helpers.sessionStarted
                ? 'Recording - lift your shoulders, then return down.'
                : 'Ready confirmed - lift your shoulders, then return down.');
            helpers.setStage(tracker.state);

            if ((tracker.ascendingFrames >= CONFIG.STABLE_FRAMES_REQUIRED ||
                tracker.upFrames >= CONFIG.STABLE_FRAMES_REQUIRED) &&
                now - tracker.lastCountedAt >= CONFIG.REP_COOLDOWN_MS) {
                beginRep(helpers, now, posture);
            }
        } else if (tracker.state === STATE.ASCENDING) {
            helpers.setWarning('Lift your shoulders, then return down.');
            helpers.setStage(STATE.ASCENDING);
            if (tracker.upFrames >= CONFIG.STABLE_FRAMES_REQUIRED) {
                tracker.state = STATE.UP;
                helpers.setStage(STATE.UP);
            }
        } else if (tracker.state === STATE.UP) {
            helpers.setWarning('Good lift - return your shoulders down.');
            helpers.setStage(STATE.UP);
            if (tracker.descendingFrames >= CONFIG.STABLE_FRAMES_REQUIRED) {
                tracker.state = STATE.DESCENDING;
                helpers.setStage(STATE.DESCENDING);
            }
        } else if (tracker.state === STATE.DESCENDING) {
            helpers.setWarning('Return shoulders down to finish the rep.');
            helpers.setStage(STATE.DESCENDING);
            if (tracker.downFrames >= CONFIG.STABLE_FRAMES_REQUIRED) {
                const repDuration = now - tracker.repStartedAt;
                if (repDuration >= CONFIG.MIN_REP_DURATION_MS) {
                    recordRepMetrics(helpers.metrics, helpers, repDuration);
                    tracker.lastCountedAt = now;
                    tracker.state = STATE.REP_COUNTED;
                    updateDownShoulderBaseline(posture.metrics.shoulderY);
                    helpers.countValidRep(STATE.DOWN);
                    helpers.setStage(STATE.REP_COUNTED);
                } else {
                    invalidateRep(helpers, 'Control the lift without bouncing before the rep can count.');
                }
            }
        } else if (tracker.state === STATE.REP_COUNTED) {
            helpers.setStage(STATE.REP_COUNTED);
            if (now - tracker.lastCountedAt >= CONFIG.REP_COOLDOWN_MS && isDown) {
                tracker.state = STATE.DOWN;
                tracker.maxShoulderLiftThisRep = 0;
                helpers.setStage(STATE.DOWN);
            }
        } else if (tracker.state === STATE.INVALID_FORM) {
            setReadiness(downPosture, helpers, now);
        } else {
            tracker.state = STATE.DOWN;
            helpers.setStage(STATE.DOWN);
        }

        sampleMetrics(helpers.metrics, helpers, posture);
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
