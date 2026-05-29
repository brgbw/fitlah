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
        LEFT_EAR: 7,
        RIGHT_EAR: 8,
        LEFT_SHOULDER: 11,
        RIGHT_SHOULDER: 12,
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
        // The first rep is armed only after a stable lying/down setup is held for 1 second.
        READY_HOLD_MS: 1000,
        // MediaPipe visibility can flicker during floor exercises; low-confidence frames do not move states.
        POSE_CONFIDENCE_MIN: 0.32,
        // EMA smoothing reduces small landmark jitter while keeping transitions responsive.
        SMOOTHING_ALPHA: 0.45,
        // Hands must stay close to the ears/head. These are intentionally lenient for side-view tracking,
        // where wrists and ears often overlap or flicker, while still rejecting clear arm swing.
        HAND_VISIBILITY_MIN: 0.16,
        WRIST_EAR_MAX_RATIO: 2.2,
        WRIST_EAR_MIN_DISTANCE: 0.26,
        // If the hand covers the ear, MediaPipe may lower the ear confidence. In that case, accept a wrist
        // that remains in the head/shoulder zone instead of failing the hand check immediately.
        HAND_OCCLUDED_VISIBILITY_MIN: 0.12,
        WRIST_HEAD_ZONE_MIN_DISTANCE: 0.34,
        WRIST_HEAD_ZONE_MAX_RATIO: 3.2,
        // Forward wrist travel catches arm-swing momentum even if the wrist remains near the head vertically.
        WRIST_FORWARD_MAX_RATIO: 2.0,
        // Bent knees are required for a proper sit-up setup; overly straight legs are rejected.
        KNEE_ANGLE_MIN: 40,
        KNEE_ANGLE_MAX: 165,
        KNEE_COLLAPSE_MAX_RATIO: 0.85,
        // Hip angle is used for torso ascent/descent: large means lying/down, small means seated/up.
        DOWN_HIP_ANGLE_MIN: 100,
        UP_HIP_ANGLE_MAX: 105,
        MIN_ASCENT_DELTA: 18,
        // Feet should remain near their calibrated down-position height; large upward movement is rejected.
        FOOT_LIFT_TOLERANCE: 0.09,
        // Side-on analysis expects overlapping shoulders/hips; wide spans imply twisting or camera distortion.
        CAMERA_WIDTH_MAX_RATIO: 0.75,
        TWIST_MAX_RATIO: 0.28,
        MIN_BODY_SPAN: 0.2,
        MIN_REP_DURATION_MS: 550,
        REP_COOLDOWN_MS: 450,
        STABLE_FRAMES_REQUIRED: 2
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
        handsValidDuringRep: true,
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
        tracker.handsValidDuringRep = true;
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
        const required = [
            LANDMARK.LEFT_EAR,
            LANDMARK.RIGHT_EAR,
            LANDMARK.LEFT_SHOULDER,
            LANDMARK.RIGHT_SHOULDER,
            LANDMARK.LEFT_WRIST,
            LANDMARK.RIGHT_WRIST,
            LANDMARK.LEFT_HIP,
            LANDMARK.RIGHT_HIP,
            LANDMARK.LEFT_KNEE,
            LANDMARK.RIGHT_KNEE,
            LANDMARK.LEFT_ANKLE,
            LANDMARK.RIGHT_ANKLE
        ];
        const total = required.reduce((sum, idx) => sum + (landmarks[idx]?.visibility || 0), 0);
        return total / required.length;
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
            ? [LANDMARK.LEFT_EAR, LANDMARK.LEFT_SHOULDER, LANDMARK.LEFT_HIP, LANDMARK.LEFT_KNEE, LANDMARK.LEFT_ANKLE]
            : [LANDMARK.RIGHT_EAR, LANDMARK.RIGHT_SHOULDER, LANDMARK.RIGHT_HIP, LANDMARK.RIGHT_KNEE, LANDMARK.RIGHT_ANKLE];
        return indices.reduce((sum, idx) => sum + (landmarks[idx]?.visibility || 0), 0);
    }

    function bestSide(landmarks) {
        const left = sideScore(landmarks, true) >= sideScore(landmarks, false);
        return left
            ? {
                ear: landmarks[LANDMARK.LEFT_EAR],
                shoulder: landmarks[LANDMARK.LEFT_SHOULDER],
                wrist: landmarks[LANDMARK.LEFT_WRIST],
                hip: landmarks[LANDMARK.LEFT_HIP],
                knee: landmarks[LANDMARK.LEFT_KNEE],
                ankle: landmarks[LANDMARK.LEFT_ANKLE]
            }
            : {
                ear: landmarks[LANDMARK.RIGHT_EAR],
                shoulder: landmarks[LANDMARK.RIGHT_SHOULDER],
                wrist: landmarks[LANDMARK.RIGHT_WRIST],
                hip: landmarks[LANDMARK.RIGHT_HIP],
                knee: landmarks[LANDMARK.RIGHT_KNEE],
                ankle: landmarks[LANDMARK.RIGHT_ANKLE]
            };
    }

    function wristNearEar(wrist, ear, shoulder, helpers) {
        if (!visible(wrist, CONFIG.HAND_VISIBILITY_MIN) ||
            !visible(shoulder, CONFIG.HAND_VISIBILITY_MIN)) {
            return false;
        }

        const earVisible = visible(ear, CONFIG.HAND_VISIBILITY_MIN);
        const refLen = earVisible ? Math.max(helpers.distance(shoulder, ear), 0.1) : 0.12;
        if (!earVisible && !visible(ear, CONFIG.HAND_OCCLUDED_VISIBILITY_MIN)) {
            const maxHeadZoneDistance = Math.max(CONFIG.WRIST_HEAD_ZONE_MIN_DISTANCE, refLen * CONFIG.WRIST_HEAD_ZONE_MAX_RATIO);
            return helpers.distance(wrist, shoulder) <= maxHeadZoneDistance &&
                wrist.y <= shoulder.y + maxHeadZoneDistance * 0.85;
        }

        const maxDistance = Math.max(CONFIG.WRIST_EAR_MIN_DISTANCE, refLen * CONFIG.WRIST_EAR_MAX_RATIO);
        const wristDistance = helpers.distance(wrist, ear);
        const forwardTravel = Math.abs(wrist.x - ear.x) / refLen;

        // Hand validation uses both distance and forward travel. The low-confidence fallback covers the common
        // valid case where the hand is physically covering the ear and the ear landmark becomes unreliable.
        if (wristDistance <= maxDistance && forwardTravel <= CONFIG.WRIST_FORWARD_MAX_RATIO) {
            return true;
        }

        if (visible(ear, CONFIG.HAND_OCCLUDED_VISIBILITY_MIN)) {
            const headZoneDistance = Math.max(CONFIG.WRIST_HEAD_ZONE_MIN_DISTANCE, refLen * CONFIG.WRIST_HEAD_ZONE_MAX_RATIO);
            return wristDistance <= headZoneDistance && forwardTravel <= CONFIG.WRIST_FORWARD_MAX_RATIO * 1.45;
        }

        return false;
    }

    function handPlacementDetails(landmarks, helpers) {
        const leftWrist = landmarks[LANDMARK.LEFT_WRIST];
        const rightWrist = landmarks[LANDMARK.RIGHT_WRIST];
        const leftEar = landmarks[LANDMARK.LEFT_EAR];
        const rightEar = landmarks[LANDMARK.RIGHT_EAR];

        // For side-on sit-ups, MediaPipe can swap or compress left/right head landmarks. Treat a hand as valid
        // if it is near either ear/head landmark, but still require both wrists to stay near the head area.
        const leftOk = wristNearEar(leftWrist, leftEar, landmarks[LANDMARK.LEFT_SHOULDER], helpers) ||
            wristNearEar(leftWrist, rightEar, landmarks[LANDMARK.RIGHT_SHOULDER], helpers);
        const rightOk = wristNearEar(rightWrist, rightEar, landmarks[LANDMARK.RIGHT_SHOULDER], helpers) ||
            wristNearEar(rightWrist, leftEar, landmarks[LANDMARK.LEFT_SHOULDER], helpers);
        return {
            ok: leftOk && rightOk,
            leftOk,
            rightOk
        };
    }

    function handsOnEars(landmarks, helpers) {
        return handPlacementDetails(landmarks, helpers).ok;
    }

    function drawHandsOnEarsGuide(landmarks, drawing) {
        const details = handPlacementDetails(landmarks, drawing.helpers);
        const pairs = [
            [LANDMARK.LEFT_WRIST, LANDMARK.LEFT_EAR, details.leftOk],
            [LANDMARK.RIGHT_WRIST, LANDMARK.RIGHT_EAR, details.rightOk]
        ];
        for (const [wIdx, eIdx, ok] of pairs) {
            const wrist = landmarks[wIdx];
            const ear = landmarks[eIdx];
            if ((wrist.visibility || 0) > 0.25 && (ear.visibility || 0) > 0.25) {
                drawing.ctx.beginPath();
                drawing.ctx.moveTo(wrist.x * drawing.width, wrist.y * drawing.height);
                drawing.ctx.lineTo(ear.x * drawing.width, ear.y * drawing.height);
                drawing.ctx.strokeStyle = ok ? '#22C55E' : '#F43F5E';
                drawing.ctx.lineWidth = 4;
                drawing.ctx.stroke();
            }
        }
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
            leftShoulder,
            rightShoulder,
            leftHip,
            rightHip,
            leftKnee,
            rightKnee,
            leftAnkle,
            rightAnkle
        ].every(point => visible(point, minVisibility));

        if (!requiredVisible) {
            return { ok: false, reason: 'Keep your shoulders, hips, knees, and both feet visible in frame.' };
        }

        const shoulderMid = midpoint(leftShoulder, rightShoulder);
        const hipMid = midpoint(leftHip, rightHip);
        const kneeMid = midpoint(leftKnee, rightKnee);
        const ankleMid = midpoint(leftAnkle, rightAnkle);
        const bodySpan = helpers.distance(shoulderMid, ankleMid);
        if (bodySpan < CONFIG.MIN_BODY_SPAN) {
            return { ok: false, reason: 'Move or angle the camera so the full sit-up posture is clear.' };
        }

        // Side-on setup is required. Large left/right spans or uneven shoulders/hips usually indicate twisting,
        // a front-facing camera angle, or perspective distortion that makes hip-angle reps unreliable.
        const shoulderWidth = helpers.distance(leftShoulder, rightShoulder);
        const hipWidth = helpers.distance(leftHip, rightHip);
        if (Math.max(shoulderWidth, hipWidth) / bodySpan > CONFIG.CAMERA_WIDTH_MAX_RATIO) {
            return { ok: false, reason: 'Turn side-on to the camera for reliable sit-up counting.' };
        }

        const shoulderTilt = Math.abs(leftShoulder.y - rightShoulder.y) / bodySpan;
        const hipTilt = Math.abs(leftHip.y - rightHip.y) / bodySpan;
        if (Math.max(shoulderTilt, hipTilt) > CONFIG.TWIST_MAX_RATIO) {
            return { ok: false, reason: 'Avoid twisting; keep shoulders and hips square during each sit-up.' };
        }

        const leftKneeAngle = helpers.angle(leftHip, leftKnee, leftAnkle);
        const rightKneeAngle = helpers.angle(rightHip, rightKnee, rightAnkle);
        const kneeAngle = (leftKneeAngle + rightKneeAngle) / 2;
        if (kneeAngle < CONFIG.KNEE_ANGLE_MIN || kneeAngle > CONFIG.KNEE_ANGLE_MAX) {
            return { ok: false, reason: 'Bend your knees and keep feet planted before starting.' };
        }

        if (Math.abs(leftKnee.x - rightKnee.x) / bodySpan > CONFIG.KNEE_COLLAPSE_MAX_RATIO) {
            return { ok: false, reason: 'Keep knees aligned; do not let them collapse or flare during the sit-up.' };
        }

        const handDetails = handPlacementDetails(landmarks, helpers);
        if (!handDetails.ok) {
            return { ok: false, reason: 'Keep both hands touching your ears or head area throughout the rep.' };
        }

        const hipAngle = helpers.angle(side.shoulder, side.hip, side.knee);
        const footY = Math.max(leftAnkle.y, rightAnkle.y);
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
                bodySpan,
                handDetails
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
            helpers.setWarning(`Hold the sit-up down position with hands on ears for ${remaining}s.`);
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
        tracker.handsValidDuringRep = validation.metrics.handDetails.ok;
        tracker.minHipAngleThisRep = validation.metrics.hipAngle;
        helpers.setStage(STATE.ASCENDING);
    }

    function invalidateRep(helpers, message) {
        tracker.state = STATE.INVALID_FORM;
        tracker.readyConfirmed = false;
        tracker.readyStartedAt = null;
        tracker.handsValidDuringRep = false;
        tracker.downFrames = 0;
        tracker.upFrames = 0;
        tracker.ascendingFrames = 0;
        tracker.descendingFrames = 0;
        helpers.setPositionReady(false);
        helpers.setHandsOnEarsStreak(0);
        helpers.setStage(STATE.INVALID_FORM);
        helpers.markInvalid(message);
    }

    function sampleMetrics(metrics, helpers, validation) {
        if (!helpers.isRecording || !metrics) return;
        metrics.frames_sampled++;
        if (metrics.frames_sampled % 5 !== 0) return;

        if (!validation.ok) {
            metrics.hands_off_ears_samples++;
            helpers.noteFormFlag(validation.reason);
            return;
        }

        const hipAngle = validation.metrics.hipAngle;
        if (hipAngle >= CONFIG.DOWN_HIP_ANGLE_MIN) metrics.hip_down_angles.push(Math.round(hipAngle));
        if (hipAngle <= CONFIG.UP_HIP_ANGLE_MAX) metrics.hip_up_angles.push(Math.round(hipAngle));
        if (validation.metrics.handDetails.ok) metrics.hands_on_ears_samples++;
        else {
            metrics.hands_off_ears_samples++;
            helpers.noteFormFlag('hands left ears during session');
        }
        if (hipAngle < CONFIG.DOWN_HIP_ANGLE_MIN && hipAngle > CONFIG.UP_HIP_ANGLE_MAX) {
            helpers.noteFormFlag('partial sit-up depth detected');
        }
    }

    function analyze(landmarks, helpers) {
        const now = Date.now();

        if (poseConfidence(landmarks) < CONFIG.POSE_CONFIDENCE_MIN) {
            if (!helpers.sessionStarted) reset();
            helpers.updateHandsBadge(false);
            helpers.setWarning('Pose confidence is low. Keep your full body clearly inside the frame.');
            return;
        }

        const smoothed = smoothLandmarks(landmarks);
        const posture = validateSitupPosture(smoothed, helpers, 'moving');
        const downPosture = validateSitupPosture(smoothed, helpers, 'down');
        const earsOk = posture.ok && posture.metrics.handDetails.ok;
        helpers.updateHandsBadge(earsOk);

        // Ready validation requires the full down posture, bent knees, visible grounded feet, and both hands
        // near the ears/head for 1 second. This blocks false positives from partial visibility or random torso motion.
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

        if (!earsOk) {
            invalidateRep(helpers, 'Hands left the ears/head area - sit-up rep rejected.');
            sampleMetrics(helpers.metrics, helpers, posture);
            return;
        }

        tracker.handsValidDuringRep = tracker.handsValidDuringRep && earsOk;
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
            helpers.setWarning('Keep hands on ears and sit up fully.');
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
                if (tracker.handsValidDuringRep && repDuration >= CONFIG.MIN_REP_DURATION_MS) {
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
        const handsTotal = (metrics.hands_on_ears_samples || 0) + (metrics.hands_off_ears_samples || 0);
        payload.hands_on_ears_compliance_pct = handsTotal
            ? Math.round(((metrics.hands_on_ears_samples || 0) / handsTotal) * 100)
            : null;
        if (payload.hands_on_ears_compliance_pct !== null && payload.hands_on_ears_compliance_pct < 95) {
            payload.form_flags.push('hands frequently off ears');
        }
        if (payload.avg_hip_angle_sitting && payload.avg_hip_angle_sitting > CONFIG.UP_HIP_ANGLE_MAX + 8) {
            payload.form_flags.push('limited sit-up height on several reps');
        }
    }

    window.FitLahSitupExercise = {
        analyze,
        drawHandsOnEarsGuide,
        handsOnEars,
        enrichMetrics,
        reset,
        STATE,
        CONFIG
    };
})();
