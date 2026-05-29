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
        // The first rep is armed only after a stable lying/down setup is held for 1 second.
        READY_HOLD_MS: 500,
        // MediaPipe visibility can flicker during floor exercises; low-confidence frames do not move states.
        POSE_CONFIDENCE_MIN: 0.2,
        // EMA smoothing reduces small landmark jitter while keeping transitions responsive.
        SMOOTHING_ALPHA: 0.45,
        // Bent knees are required for a proper sit-up setup; overly straight legs are rejected.
        KNEE_ANGLE_MIN: 20,
        KNEE_ANGLE_MAX: 178,
        KNEE_COLLAPSE_MAX_RATIO: 1.2,
        // Hip angle is used for torso ascent/descent: large means lying/down, small means seated/up.
        DOWN_HIP_ANGLE_MIN: 85,
        UP_HIP_ANGLE_MAX: 125,
        MIN_ASCENT_DELTA: 8,
        // Feet should remain near their calibrated down-position height; large upward movement is rejected.
        FOOT_LIFT_TOLERANCE: 0.18,
        // Side-on analysis expects overlapping shoulders/hips; wide spans imply twisting or camera distortion.
        CAMERA_WIDTH_MAX_RATIO: 1.2,
        TWIST_MAX_RATIO: 0.5,
        MIN_BODY_SPAN: 0.12,
        MIN_REP_DURATION_MS: 250,
        REP_COOLDOWN_MS: 250,
        STABLE_FRAMES_REQUIRED: 1
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
        downFrames: 0,
        upFrames: 0,
        ascendingFrames: 0,
        descendingFrames: 0
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
        tracker.downFrames = 0;
        tracker.upFrames = 0;
        tracker.ascendingFrames = 0;
        tracker.descendingFrames = 0;
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

        tracker.smoothedLandmarks = landmarks.map((point, idx) => {
            const previous = tracker.smoothedLandmarks[idx] || cloneLandmark(point);
            return {
                x: previous.x * (1 - CONFIG.SMOOTHING_ALPHA) + point.x * CONFIG.SMOOTHING_ALPHA,
                y: previous.y * (1 - CONFIG.SMOOTHING_ALPHA) + point.y * CONFIG.SMOOTHING_ALPHA,
                z: previous.z * (1 - CONFIG.SMOOTHING_ALPHA) + (point.z || 0) * CONFIG.SMOOTHING_ALPHA,
                visibility: previous.visibility * (1 - CONFIG.SMOOTHING_ALPHA) + (point.visibility || 0) * CONFIG.SMOOTHING_ALPHA
            };
        });
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

    function beginRep(helpers, now, validation) {
        tracker.state = STATE.ASCENDING;
        tracker.repStartedAt = now;
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
        helpers.setPositionReady(false);
        helpers.setStage(STATE.INVALID_FORM);
        helpers.markInvalid(message);
    }

    function sampleMetrics(metrics, helpers, validation) {
        if (!helpers.isRecording || !metrics) return;
        metrics.frames_sampled++;
        if (metrics.frames_sampled % 5 !== 0) return;

        if (!validation.ok) return;

        const hipAngle = validation.metrics.hipAngle;
        if (hipAngle >= CONFIG.DOWN_HIP_ANGLE_MIN) metrics.hip_down_angles.push(Math.round(hipAngle));
        if (hipAngle <= CONFIG.UP_HIP_ANGLE_MAX) metrics.hip_up_angles.push(Math.round(hipAngle));
        if (hipAngle < CONFIG.DOWN_HIP_ANGLE_MIN && hipAngle > CONFIG.UP_HIP_ANGLE_MAX) {
            helpers.noteFormFlag('partial sit-up depth detected');
        }
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
        // landmarks for 1 second. Hand-on-ear validation is intentionally not part of sit-up counting.
        if (!tracker.readyConfirmed) {
            setReadiness(downPosture, helpers, now);
            sampleMetrics(helpers.metrics, helpers, posture);
            return;
        }

        if (!posture.ok) {
            invalidateRep(helpers, posture.reason);
            sampleMetrics(helpers.metrics, helpers, posture);
            return;
        }

        const hipAngle = posture.metrics.hipAngle;
        const downAngle = tracker.downHipAngle || CONFIG.DOWN_HIP_ANGLE_MIN;
        const ascentDelta = downAngle - hipAngle;
        const isDown = downPosture.ok && hipAngle >= CONFIG.DOWN_HIP_ANGLE_MIN;
        const isUp = hipAngle <= CONFIG.UP_HIP_ANGLE_MAX && ascentDelta >= CONFIG.MIN_ASCENT_DELTA;
        const isAscending = ascentDelta >= 10 && !isUp;
        const isDescending = tracker.minHipAngleThisRep < 180 && hipAngle > tracker.minHipAngleThisRep + 8;
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
