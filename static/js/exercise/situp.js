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
        READY_HOLD_MS: 300,
        // MediaPipe visibility can flicker during floor exercises; low-confidence frames do not move states.
        POSE_CONFIDENCE_MIN: 0.2,
        // EMA smoothing reduces small landmark jitter while keeping transitions responsive.
        SMOOTHING_ALPHA: 0.4,
        // Bent knees are required for a proper sit-up setup; overly straight legs are rejected.
        KNEE_ANGLE_MIN: 20,
        KNEE_ANGLE_MAX: 182,
        KNEE_COLLAPSE_MAX_RATIO: 1.4,
        // Hip angle is used for torso ascent/descent: large means lying/down, small means seated/up.
        DOWN_HIP_ANGLE_MIN: 78,
        UP_HIP_ANGLE_MAX: 140,
        MIN_ASCENT_DELTA: 5,
        BENCHMARK_UP_HIP_MARGIN: 45,
        BENCHMARK_ASCENT_RATIO: 0.55,
        BENCHMARK_BLEND_ALPHA: 0.2,
        MIN_BENCHMARK_ASCENT_DELTA: 10,
        // Feet should remain near their calibrated down-position height; large upward movement is rejected.
        FOOT_LIFT_TOLERANCE: 0.24,
        // Side-on analysis expects overlapping shoulders/hips; wide spans imply twisting or camera distortion.
        CAMERA_WIDTH_MAX_RATIO: 1.45,
        TWIST_MAX_RATIO: 0.65,
        MIN_BODY_SPAN: 0.12,
        MIN_REP_DURATION_MS: 250,
        REP_COOLDOWN_MS: 250,
        STABLE_FRAMES_REQUIRED: 2,
        INVALID_POSE_GRACE_FRAMES: 5,
        GRAPH_SAMPLE_EVERY_FRAMES: 2
    };

    const tracker = {
        state: STATE.NOT_READY,
        readyStartedAt: null,
        readyConfirmed: false,
        smoothedLandmarks: null,
        downHipAngle: null,
        footGroundY: null,
        repStartedAt: 0,
        lastCountedAt: 0,
        minHipAngleThisRep: 180,
        firstRepBenchmark: null,
        rollingBenchmark: null,
        acceptedRepCount: 0,
        invalidPostureFrames: 0,
        downFrames: 0,
        upFrames: 0,
        ascendingFrames: 0,
        descendingFrames: 0,
        repStartedAtSeconds: 0,
        repStartDownHipAngle: null
    };

    function reset() {
        tracker.state = STATE.NOT_READY;
        tracker.readyStartedAt = null;
        tracker.readyConfirmed = false;
        tracker.smoothedLandmarks = null;
        tracker.downHipAngle = null;
        tracker.footGroundY = null;
        tracker.repStartedAt = 0;
        tracker.lastCountedAt = 0;
        tracker.minHipAngleThisRep = 180;
        tracker.firstRepBenchmark = null;
        tracker.rollingBenchmark = null;
        tracker.acceptedRepCount = 0;
        tracker.invalidPostureFrames = 0;
        tracker.downFrames = 0;
        tracker.upFrames = 0;
        tracker.ascendingFrames = 0;
        tracker.descendingFrames = 0;
        tracker.repStartedAtSeconds = 0;
        tracker.repStartDownHipAngle = null;
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
        const left = [
            LANDMARK.LEFT_SHOULDER,
            LANDMARK.LEFT_HIP,
            LANDMARK.LEFT_KNEE,
            LANDMARK.LEFT_ANKLE
        ];
        const right = [
            LANDMARK.RIGHT_SHOULDER,
            LANDMARK.RIGHT_HIP,
            LANDMARK.RIGHT_KNEE,
            LANDMARK.RIGHT_ANKLE
        ];
        const avg = indices => indices.reduce((sum, idx) => sum + (landmarks[idx]?.visibility || 0), 0) / indices.length;
        return Math.max(avg(left), avg(right));
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

    function sideScore(landmarks, left) {
        const indices = left
            ? [LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_HIP, LANDMARK.LEFT_KNEE, LANDMARK.LEFT_ANKLE]
            : [LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_HIP, LANDMARK.RIGHT_KNEE, LANDMARK.RIGHT_ANKLE];
        return indices.reduce((sum, idx) => sum + (landmarks[idx]?.visibility || 0), 0);
    }

    function bestSide(landmarks) {
        const left = sideScore(landmarks, true) >= sideScore(landmarks, false);
        return left
            ? {
                shoulder: landmarks[LANDMARK.LEFT_SHOULDER],
                hip: landmarks[LANDMARK.LEFT_HIP],
                knee: landmarks[LANDMARK.LEFT_KNEE],
                ankle: landmarks[LANDMARK.LEFT_ANKLE]
            }
            : {
                shoulder: landmarks[LANDMARK.RIGHT_SHOULDER],
                hip: landmarks[LANDMARK.RIGHT_HIP],
                knee: landmarks[LANDMARK.RIGHT_KNEE],
                ankle: landmarks[LANDMARK.RIGHT_ANKLE]
            };
    }

    function drawHandsOnEarsGuide(landmarks, drawing) {
        // Hand-on-ear validation has been removed from sit-up counting, so this guide is intentionally empty.
    }

    function validateSitupPosture(landmarks, helpers, phase) {
        const side = bestSide(landmarks);
        const leftShoulder = landmarks[LANDMARK.LEFT_SHOULDER];
        const rightShoulder = landmarks[LANDMARK.RIGHT_SHOULDER];
        const leftHip = landmarks[LANDMARK.LEFT_HIP];
        const rightHip = landmarks[LANDMARK.RIGHT_HIP];
        const leftKnee = landmarks[LANDMARK.LEFT_KNEE];
        const rightKnee = landmarks[LANDMARK.RIGHT_KNEE];
        const leftAnkle = landmarks[LANDMARK.LEFT_ANKLE];
        const rightAnkle = landmarks[LANDMARK.RIGHT_ANKLE];
        const minVisibility = CONFIG.POSE_CONFIDENCE_MIN;

        const requiredVisible = [
            side.shoulder,
            side.hip,
            side.knee,
            side.ankle
        ].every(point => visible(point, minVisibility));

        if (!requiredVisible) {
            return { ok: false, reason: 'Keep one clear side profile visible: shoulder, hip, knee, and foot.' };
        }

        const pairedCoreVisible = [
            leftShoulder,
            rightShoulder,
            leftHip,
            rightHip,
            leftKnee,
            rightKnee,
            leftAnkle,
            rightAnkle
        ].every(point => visible(point, minVisibility));

        const shoulderMid = pairedCoreVisible ? midpoint(leftShoulder, rightShoulder) : side.shoulder;
        const hipMid = pairedCoreVisible ? midpoint(leftHip, rightHip) : side.hip;
        const ankleMid = pairedCoreVisible ? midpoint(leftAnkle, rightAnkle) : side.ankle;
        const bodySpan = helpers.distance(shoulderMid, ankleMid);
        if (bodySpan < CONFIG.MIN_BODY_SPAN) {
            return { ok: false, reason: 'Move or angle the camera so the full sit-up posture is clear.' };
        }

        if (pairedCoreVisible) {
            // Side-on setup is preferred, but these gates are now soft enough that partially hidden far-side
            // landmarks do not stop otherwise valid sit-ups from counting.
            const shoulderWidth = helpers.distance(leftShoulder, rightShoulder);
            const hipWidth = helpers.distance(leftHip, rightHip);
            if (Math.max(shoulderWidth, hipWidth) / bodySpan > CONFIG.CAMERA_WIDTH_MAX_RATIO) {
                return { ok: false, reason: 'Turn more side-on to the camera for reliable sit-up counting.' };
            }

            const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y) / bodySpan;
            const hipTilt = Math.abs(leftHip.y - rightHip.y) / bodySpan;
            if (Math.max(shoulderTilt, hipTilt) > CONFIG.TWIST_MAX_RATIO) {
                return { ok: false, reason: 'Avoid twisting; keep shoulders and hips square during each sit-up.' };
            }

            if (Math.abs(leftKnee.x - rightKnee.x) / bodySpan > CONFIG.KNEE_COLLAPSE_MAX_RATIO) {
                return { ok: false, reason: 'Keep knees aligned during the sit-up.' };
            }
        }

        const kneeAngle = helpers.angle(side.hip, side.knee, side.ankle);
        if (kneeAngle < CONFIG.KNEE_ANGLE_MIN || kneeAngle > CONFIG.KNEE_ANGLE_MAX) {
            return { ok: false, reason: 'Bend your knees and keep feet planted before starting.' };
        }

        const hipAngle = helpers.angle(side.shoulder, side.hip, side.knee);
        const footY = pairedCoreVisible ? Math.max(leftAnkle.y, rightAnkle.y) : side.ankle.y;
        if (tracker.footGroundY !== null && footY < tracker.footGroundY - CONFIG.FOOT_LIFT_TOLERANCE) {
            return { ok: false, reason: 'Keep both feet grounded; lifted feet invalidate the rep.' };
        }

        if (phase === 'down' && hipAngle < CONFIG.DOWN_HIP_ANGLE_MIN) {
            return { ok: false, reason: 'Return fully to the down position before starting the next sit-up.' };
        }

        return {
            ok: true,
            reason: '',
            side,
            metrics: {
                hipAngle,
                kneeAngle,
                footY,
                bodySpan
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

        const heldMs = now - tracker.readyStartedAt;
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
        tracker.downHipAngle = validation.metrics.hipAngle;
        tracker.footGroundY = validation.metrics.footY;
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

    function activeBenchmark() {
        return tracker.rollingBenchmark || tracker.firstRepBenchmark;
    }

    function benchmarkedUpThresholds(downAngle) {
        const benchmark = activeBenchmark();
        if (!benchmark) {
            return {
                upHipMax: CONFIG.UP_HIP_ANGLE_MAX,
                minAscentDelta: CONFIG.MIN_ASCENT_DELTA
            };
        }

        const first = tracker.firstRepBenchmark || benchmark;
        const benchmarkDelta = Math.max(CONFIG.MIN_BENCHMARK_ASCENT_DELTA, benchmark.downHipAngle - benchmark.upHipAngle);
        const firstAnchoredUpAngle = Math.min(benchmark.upHipAngle, first.upHipAngle + 18);
        return {
            upHipMax: Math.min(CONFIG.UP_HIP_ANGLE_MAX, firstAnchoredUpAngle + CONFIG.BENCHMARK_UP_HIP_MARGIN),
            minAscentDelta: Math.max(CONFIG.MIN_ASCENT_DELTA, Math.min(24, benchmarkDelta * CONFIG.BENCHMARK_ASCENT_RATIO, downAngle * 0.2))
        };
    }

    function beginRep(helpers, now, validation) {
        tracker.state = STATE.ASCENDING;
        tracker.repStartedAt = now;
        tracker.repStartedAtSeconds = helpers.sessionElapsedSeconds();
        tracker.repStartDownHipAngle = validation.metrics.hipAngle;
        tracker.minHipAngleThisRep = validation.metrics.hipAngle;
        helpers.setStage(STATE.ASCENDING);
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
        tracker.repStartDownHipAngle = null;
        tracker.invalidPostureFrames = 0;
        helpers.setPositionReady(false);
        helpers.setStage(STATE.INVALID_FORM);
        helpers.markInvalid(message);
    }

    function repSnapshot(downAngle) {
        return {
            downHipAngle: downAngle,
            upHipAngle: tracker.minHipAngleThisRep
        };
    }

    function captureOrUpdateBenchmark(downAngle) {
        const snapshot = repSnapshot(downAngle);
        if (!Number.isFinite(snapshot.upHipAngle) || snapshot.upHipAngle >= 180) return;

        if (!tracker.firstRepBenchmark) {
            tracker.firstRepBenchmark = snapshot;
            tracker.rollingBenchmark = { ...snapshot };
            tracker.acceptedRepCount = 1;
            return;
        }

        const alpha = CONFIG.BENCHMARK_BLEND_ALPHA;
        const blendedDown = tracker.rollingBenchmark.downHipAngle * (1 - alpha) + snapshot.downHipAngle * alpha;
        const blendedUp = tracker.rollingBenchmark.upHipAngle * (1 - alpha) + snapshot.upHipAngle * alpha;

        tracker.rollingBenchmark = {
            downHipAngle: Math.max(blendedDown, tracker.firstRepBenchmark.downHipAngle * 0.9),
            upHipAngle: Math.min(blendedUp, tracker.firstRepBenchmark.upHipAngle + 18)
        };
        tracker.acceptedRepCount++;
    }

    function sampleMetrics(metrics, helpers, validation) {
        if (!helpers.isRecording || !metrics) return;
        metrics.frames_sampled++;

        if (!validation.ok) return;

        const hipAngle = validation.metrics.hipAngle;
        if (metrics.frames_sampled % CONFIG.GRAPH_SAMPLE_EVERY_FRAMES === 0) {
            metrics.movement_samples.push({
                time: helpers.sessionElapsedSeconds(),
                value: Number(hipAngle.toFixed(2)),
                hip_angle: Math.round(hipAngle)
            });
            if (metrics.movement_samples.length > 900) {
                metrics.movement_samples.shift();
            }
        }

        if (metrics.frames_sampled % 5 !== 0) return;
        if (hipAngle >= CONFIG.DOWN_HIP_ANGLE_MIN) metrics.hip_down_angles.push(Math.round(hipAngle));
        if (hipAngle <= CONFIG.UP_HIP_ANGLE_MAX) metrics.hip_up_angles.push(Math.round(hipAngle));
        if (hipAngle < CONFIG.DOWN_HIP_ANGLE_MIN && hipAngle > CONFIG.UP_HIP_ANGLE_MAX) {
            helpers.noteFormFlag('partial sit-up depth detected');
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

    function recordRepMetrics(metrics, helpers, downAngle, periodMs) {
        if (!helpers.isRecording || !metrics) return;
        const count = Array.isArray(metrics.rep_metrics) ? metrics.rep_metrics.length : 0;
        const periodFromVideo = helpers.sessionElapsedSeconds() - tracker.repStartedAtSeconds;
        const period = Number.isFinite(periodFromVideo) && periodFromVideo > 0
            ? periodFromVideo
            : periodMs / 1000;
        const startAngle = Math.max(
            tracker.repStartDownHipAngle || 0,
            downAngle || 0
        );
        const amplitude = Math.max(0, startAngle - tracker.minHipAngleThisRep);
        if (!Array.isArray(metrics.rep_metrics)) metrics.rep_metrics = [];
        metrics.rep_metrics.push({
            rep: count + 1,
            period_s: Number(period.toFixed(3)),
            amplitude_angle_deg: Number(amplitude.toFixed(3)),
            time_s: Number(helpers.sessionElapsedSeconds().toFixed(3))
        });
        metrics.rep_metrics_csv = repMetricsCsv(metrics.rep_metrics);
        metrics.rep_count_signal = metrics.rep_metrics.length;
    }

    function analyze(landmarks, helpers) {
        const now = Date.now();

        if (poseConfidence(landmarks) < CONFIG.POSE_CONFIDENCE_MIN) {
            if (!helpers.sessionStarted) reset();
            helpers.setWarning('Pose confidence is low. Keep your full body clearly inside the frame.');
            return;
        }

        const smoothed = smoothLandmarks(landmarks);
        const posture = validateSitupPosture(smoothed, helpers, 'moving');
        const downPosture = validateSitupPosture(smoothed, helpers, 'down');

        // Ready validation requires the full down posture, bent knees, visible grounded feet, and stable body
        // landmarks for a brief hold. Hand-on-ear validation is intentionally not part of sit-up counting.
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

        const hipAngle = posture.metrics.hipAngle;
        const downAngle = tracker.downHipAngle || CONFIG.DOWN_HIP_ANGLE_MIN;
        const ascentDelta = downAngle - hipAngle;
        const upThresholds = benchmarkedUpThresholds(downAngle);
        const isDown = downPosture.ok && hipAngle >= CONFIG.DOWN_HIP_ANGLE_MIN;
        const isUp = hipAngle <= upThresholds.upHipMax && ascentDelta >= upThresholds.minAscentDelta;
        const isAscending = ascentDelta >= CONFIG.MIN_ASCENT_DELTA && !isUp;
        const isDescending = tracker.minHipAngleThisRep < 180 && hipAngle > tracker.minHipAngleThisRep + 6;
        updateStableFrames(isDown, isUp, isAscending, isDescending);

        tracker.minHipAngleThisRep = Math.min(tracker.minHipAngleThisRep, hipAngle);

        // Transition sequence is strict: validated DOWN -> ASCENDING -> UP -> DESCENDING -> validated DOWN.
        // Counting at the final DOWN position prevents partial sit-ups, bounce reps, and duplicate top counts.
        if (tracker.state === STATE.READY || tracker.state === STATE.DOWN) {
            helpers.setWarning(helpers.sessionStarted
                ? 'Recording - sit up fully, then return to the down position.'
                : 'Ready confirmed - sit up fully, then return down.');
            helpers.setStage(tracker.state);

            if ((tracker.ascendingFrames >= CONFIG.STABLE_FRAMES_REQUIRED ||
                tracker.upFrames >= CONFIG.STABLE_FRAMES_REQUIRED) &&
                now - tracker.lastCountedAt >= CONFIG.REP_COOLDOWN_MS) {
                beginRep(helpers, now, posture);
            }
        } else if (tracker.state === STATE.ASCENDING) {
            helpers.setWarning('Sit up fully, then return down.');
            helpers.setStage(STATE.ASCENDING);
            if (tracker.upFrames >= CONFIG.STABLE_FRAMES_REQUIRED) {
                tracker.state = STATE.UP;
                helpers.setStage(STATE.UP);
            }
        } else if (tracker.state === STATE.UP) {
            helpers.setWarning('Good height - return fully to the down position.');
            helpers.setStage(STATE.UP);
            if (tracker.descendingFrames >= CONFIG.STABLE_FRAMES_REQUIRED) {
                tracker.state = STATE.DESCENDING;
                helpers.setStage(STATE.DESCENDING);
            }
        } else if (tracker.state === STATE.DESCENDING) {
            helpers.setWarning('Return shoulders down under control to finish the rep.');
            helpers.setStage(STATE.DESCENDING);
            if (tracker.downFrames >= CONFIG.STABLE_FRAMES_REQUIRED) {
                const repDuration = now - tracker.repStartedAt;
                if (repDuration >= CONFIG.MIN_REP_DURATION_MS) {
                    captureOrUpdateBenchmark(Math.max(downAngle, hipAngle));
                    recordRepMetrics(helpers.metrics, helpers, Math.max(downAngle, hipAngle), repDuration);
                    tracker.lastCountedAt = now;
                    tracker.state = STATE.REP_COUNTED;
                    tracker.downHipAngle = hipAngle;
                    tracker.footGroundY = posture.metrics.footY;
                    helpers.countValidRep(STATE.DOWN);
                    helpers.setStage(STATE.REP_COUNTED);
                } else {
                    invalidateRep(helpers, 'Control the full sit-up without bouncing before the rep can count.');
                }
            }
        } else if (tracker.state === STATE.REP_COUNTED) {
            helpers.setStage(STATE.REP_COUNTED);
            if (now - tracker.lastCountedAt >= CONFIG.REP_COOLDOWN_MS && isDown) {
                tracker.state = STATE.DOWN;
                tracker.minHipAngleThisRep = 180;
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
        payload.rep_metrics = Array.isArray(metrics.rep_metrics) ? metrics.rep_metrics.slice() : [];
        payload.rep_metrics_csv = metrics.rep_metrics_csv || repMetricsCsv(payload.rep_metrics);
        payload.rep_count_signal = metrics.rep_count_signal || payload.rep_metrics.length;
        if (payload.avg_hip_angle_sitting && payload.avg_hip_angle_sitting > CONFIG.UP_HIP_ANGLE_MAX + 8) {
            payload.form_flags.push('limited sit-up height on several reps');
        }
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
