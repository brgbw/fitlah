(function () {
    const STATE = {
        NOT_READY: 'Waiting',
        READY: 'ready',
        UP: 'up',
        DOWN: 'down',
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
        // The first rep is armed after a brief valid straight-arm plank hold.
        READY_HOLD_MS: 450,
        // MediaPipe visibility is noisy in side view; this keeps low-confidence frames from moving states.
        POSE_CONFIDENCE_MIN: 0.25,
        // EMA smoothing absorbs small landmark jitter without adding visible lag to rep transitions.
        SMOOTHING_ALPHA: 0.4,
        // Straight arms define a valid push-up top position.
        UP_ELBOW_MIN_ANGLE: 100,
        // A rep must pass this elbow depth, or an equivalent shoulder drop, before it can count.
        DOWN_ELBOW_MAX_ANGLE: 160,
        MIN_SHOULDER_DROP: 0.012,
        BENCHMARK_ELBOW_MARGIN: 38,
        BENCHMARK_SHOULDER_DROP_RATIO: 0.55,
        BENCHMARK_BLEND_ALPHA: 0.18,
        MIN_ELBOW_BEND_DELTA: 8,
        // Prevent quick oscillations or single-frame flicker from becoming duplicate reps.
        MIN_REP_DURATION_MS: 300,
        REP_COOLDOWN_MS: 300,
        STABLE_FRAMES_REQUIRED: 2,
        INVALID_POSE_GRACE_FRAMES: 5,
        GRAPH_SAMPLE_EVERY_FRAMES: 2,
        // Full-body validation thresholds are normalized by body length so they scale with camera distance.
        BODY_STRAIGHTNESS_TOLERANCE: 0.45,
        HEAD_ALIGNMENT_TOLERANCE: 0.7,
        SHOULDER_SYMMETRY_TOLERANCE: 0.45,
        HIP_SYMMETRY_TOLERANCE: 0.45,
        MIN_HIP_ANGLE: 95,
        MIN_KNEE_ANGLE: 100,
        WRIST_SHOULDER_MAX_OFFSET: 2.6,
        WRIST_BELOW_SHOULDER_MIN: -0.08,
        CAMERA_WIDTH_MAX_RATIO: 1.2,
        MIN_BODY_LENGTH: 0.12,
        LEG_CONTACT_WARN_FRAMES: 6,
        LEG_CONTACT_CLEAR_FRAMES: 4,
        LEG_CONTACT_FLOOR_DISTANCE_RATIO: 0.095,
        LEG_CONTACT_FLOOR_Y_TOLERANCE_RATIO: 0.07,
        LEG_CONTACT_HIP_DISTANCE_RATIO: 0.12,
        LEG_CONTACT_KNEE_ANGLE_MAX: 165,
        LEG_CONTACT_MAX_COUNTED_REPS: 3,
        LEG_CONTACT_MIN_REPS_BEFORE_STOP: 3
    };

    const tracker = {
        state: STATE.NOT_READY,
        readyStartedAt: null,
        readyConfirmed: false,
        smoothedLandmarks: null,
        upShoulderY: null,
        downFrames: 0,
        upFrames: 0,
        repStartedAt: 0,
        lastCountedAt: 0,
        repInvalid: false,
        invalidPoseFrames: 0,
        firstRepBenchmark: null,
        rollingBenchmark: null,
        acceptedRepCount: 0,
        lastUpElbowAngle: null,
        currentRepMinElbowAngle: 180,
        currentRepMaxShoulderDrop: 0,
        legContactFrames: 0,
        legContactClearFrames: 0,
        legContactActive: false,
        legContactCountedReps: 0,
        legContactStopRequested: false
    };

    function reset() {
        tracker.state = STATE.NOT_READY;
        tracker.readyStartedAt = null;
        tracker.readyConfirmed = false;
        tracker.smoothedLandmarks = null;
        tracker.upShoulderY = null;
        tracker.downFrames = 0;
        tracker.upFrames = 0;
        tracker.repStartedAt = 0;
        tracker.lastCountedAt = 0;
        tracker.repInvalid = false;
        tracker.invalidPoseFrames = 0;
        tracker.firstRepBenchmark = null;
        tracker.rollingBenchmark = null;
        tracker.acceptedRepCount = 0;
        tracker.lastUpElbowAngle = null;
        tracker.currentRepMinElbowAngle = 180;
        tracker.currentRepMaxShoulderDrop = 0;
        tracker.legContactFrames = 0;
        tracker.legContactClearFrames = 0;
        tracker.legContactActive = false;
        tracker.legContactCountedReps = 0;
        tracker.legContactStopRequested = false;
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

    function pointLineOffset(point, lineStart, lineEnd) {
        const vx = lineEnd.x - lineStart.x;
        const vy = lineEnd.y - lineStart.y;
        const lenSq = vx * vx + vy * vy;
        if (!lenSq) return { distance: 0, yOffset: 0 };
        const t = ((point.x - lineStart.x) * vx + (point.y - lineStart.y) * vy) / lenSq;
        const closest = {
            x: lineStart.x + t * vx,
            y: lineStart.y + t * vy
        };
        return {
            distance: Math.hypot(point.x - closest.x, point.y - closest.y),
            yOffset: point.y - closest.y
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
            LANDMARK.NOSE,
            LANDMARK.LEFT_SHOULDER,
            LANDMARK.RIGHT_SHOULDER,
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

    function visibleSide(landmarks, left) {
        return left
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

    function bestTrackedSide(landmarks) {
        const leftScore = [
            LANDMARK.LEFT_SHOULDER,
            LANDMARK.LEFT_ELBOW,
            LANDMARK.LEFT_WRIST,
            LANDMARK.LEFT_HIP,
            LANDMARK.LEFT_KNEE,
            LANDMARK.LEFT_ANKLE
        ].reduce((sum, idx) => sum + (landmarks[idx]?.visibility || 0), 0);
        const rightScore = [
            LANDMARK.RIGHT_SHOULDER,
            LANDMARK.RIGHT_ELBOW,
            LANDMARK.RIGHT_WRIST,
            LANDMARK.RIGHT_HIP,
            LANDMARK.RIGHT_KNEE,
            LANDMARK.RIGHT_ANKLE
        ].reduce((sum, idx) => sum + (landmarks[idx]?.visibility || 0), 0);
        return visibleSide(landmarks, leftScore >= rightScore);
    }

    function validatePushupPose(landmarks, helpers, phase) {
        const side = bestTrackedSide(landmarks);
        const leftShoulder = landmarks[LANDMARK.LEFT_SHOULDER];
        const rightShoulder = landmarks[LANDMARK.RIGHT_SHOULDER];
        const leftHip = landmarks[LANDMARK.LEFT_HIP];
        const rightHip = landmarks[LANDMARK.RIGHT_HIP];
        const head = landmarks[LANDMARK.NOSE];
        const minVisibility = CONFIG.POSE_CONFIDENCE_MIN;

        const requiredVisible = [
            head,
            leftShoulder,
            rightShoulder,
            leftHip,
            rightHip,
            side.shoulder,
            side.elbow,
            side.wrist,
            side.hip,
            side.knee,
            side.ankle
        ].every(point => visible(point, minVisibility));

        if (!requiredVisible) {
            return { ok: false, reason: 'Keep your full body in frame - head, shoulders, hips, knees, ankles, and wrists must be visible.' };
        }

        const shoulderMid = midpoint(leftShoulder, rightShoulder);
        const hipMid = midpoint(leftHip, rightHip);
        const bodyLength = helpers.distance(side.shoulder, side.ankle);
        const trunkLength = Math.max(helpers.distance(side.shoulder, side.hip), 0.08);
        if (bodyLength < CONFIG.MIN_BODY_LENGTH) {
            return { ok: false, reason: 'Move closer or angle the camera so your full side profile is clear.' };
        }

        // Side-on push-ups should show overlapping shoulders/hips. A wide shoulder or hip span usually means
        // the user is facing the camera, rotating sideways, or the camera angle is too distorted for stable counts.
        const shoulderWidth = helpers.distance(leftShoulder, rightShoulder);
        const hipWidth = helpers.distance(leftHip, rightHip);
        if (Math.max(shoulderWidth, hipWidth) / bodyLength > CONFIG.CAMERA_WIDTH_MAX_RATIO) {
            return { ok: false, reason: 'Turn side-on to the camera; front-facing or angled views are not counted.' };
        }

        if (Math.abs(leftShoulder.y - rightShoulder.y) / bodyLength > CONFIG.SHOULDER_SYMMETRY_TOLERANCE) {
            return { ok: false, reason: 'Level your shoulders before starting the push-up.' };
        }

        if (Math.abs(leftHip.y - rightHip.y) / bodyLength > CONFIG.HIP_SYMMETRY_TOLERANCE) {
            return { ok: false, reason: 'Level your hips before starting the push-up.' };
        }

        const headOffset = pointLineOffset(head, shoulderMid, hipMid);
        if (headOffset.distance / bodyLength > CONFIG.HEAD_ALIGNMENT_TOLERANCE) {
            return { ok: false, reason: 'Keep your head neutral and aligned with your torso.' };
        }

        const hipOffset = pointLineOffset(side.hip, side.shoulder, side.ankle);
        const kneeOffset = pointLineOffset(side.knee, side.shoulder, side.ankle);
        const maxBodyOffset = Math.max(Math.abs(hipOffset.yOffset), kneeOffset.distance) / bodyLength;
        if (maxBodyOffset > CONFIG.BODY_STRAIGHTNESS_TOLERANCE) {
            if (hipOffset.yOffset < 0) {
                return { ok: false, reason: 'Lower your hips into a straight plank before counting reps.' };
            }
            return { ok: false, reason: 'Lift your hips and keep your body straight from shoulder to ankle.' };
        }

        const hipAngle = helpers.angle(side.shoulder, side.hip, side.knee);
        if (hipAngle < CONFIG.MIN_HIP_ANGLE) {
            return { ok: false, reason: 'Straighten your hips; bent hips are not counted.' };
        }

        const kneeAngle = helpers.angle(side.hip, side.knee, side.ankle);
        if (kneeAngle < CONFIG.MIN_KNEE_ANGLE) {
            return { ok: false, reason: 'Extend your legs fully and keep knees off the floor.' };
        }

        const wristShoulderOffset = Math.abs(side.wrist.x - side.shoulder.x) / trunkLength;
        if (wristShoulderOffset > CONFIG.WRIST_SHOULDER_MAX_OFFSET || side.wrist.y < side.shoulder.y + CONFIG.WRIST_BELOW_SHOULDER_MIN) {
            return { ok: false, reason: 'Place wrists under your shoulders before starting.' };
        }

        const elbowAngle = helpers.angle(side.shoulder, side.elbow, side.wrist);
        if (phase === 'up' && elbowAngle < CONFIG.UP_ELBOW_MIN_ANGLE) {
            return { ok: false, reason: 'Start from the top position with arms straight.' };
        }

        const kneeFloorOffset = pointLineOffset(side.knee, side.wrist, side.ankle);
        const hipFloorOffset = pointLineOffset(side.hip, side.wrist, side.ankle);

        return {
            ok: true,
            reason: '',
            side,
            metrics: {
                elbowAngle,
                hipAngle,
                kneeAngle,
                bodyLength,
                shoulderY: side.shoulder.y,
                shoulderDrop: tracker.upShoulderY === null ? 0 : side.shoulder.y - tracker.upShoulderY,
                kneeFloorDistanceRatio: kneeFloorOffset.distance / bodyLength,
                kneeFloorYOffsetRatio: kneeFloorOffset.yOffset / bodyLength,
                hipFloorDistanceRatio: hipFloorOffset.distance / bodyLength,
                hipFloorYOffsetRatio: hipFloorOffset.yOffset / bodyLength
            }
        };
    }

    function setReadiness(validUpPose, helpers, now, reason) {
        if (!validUpPose.ok) {
            tracker.readyStartedAt = null;
            tracker.readyConfirmed = false;
            tracker.state = STATE.NOT_READY;
            tracker.downFrames = 0;
            tracker.upFrames = 0;
            helpers.setPositionReady(false);
            helpers.setStage(STATE.NOT_READY);
            helpers.setWarning(reason || validUpPose.reason);
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
            helpers.setWarning(`Hold a straight push-up ready position for ${remaining}s.`);
            return false;
        }

        tracker.readyConfirmed = true;
        tracker.state = STATE.READY;
        tracker.upShoulderY = validUpPose.metrics.shoulderY;
        tracker.lastUpElbowAngle = validUpPose.metrics.elbowAngle;
        helpers.setPositionReady(true);
        helpers.setStage(STATE.READY);
        return true;
    }

    function updateStableFrames(isDown, isUp) {
        tracker.downFrames = isDown ? tracker.downFrames + 1 : 0;
        tracker.upFrames = isUp ? tracker.upFrames + 1 : 0;
    }

    function activeBenchmark() {
        return tracker.rollingBenchmark || tracker.firstRepBenchmark;
    }

    function benchmarkedDownThresholds() {
        const benchmark = activeBenchmark();
        if (!benchmark) {
            return {
                elbowMax: CONFIG.DOWN_ELBOW_MAX_ANGLE,
                shoulderDropMin: CONFIG.MIN_SHOULDER_DROP,
                minElbowBend: CONFIG.MIN_ELBOW_BEND_DELTA
            };
        }

        const first = tracker.firstRepBenchmark || benchmark;
        const elbowMax = Math.min(
            CONFIG.DOWN_ELBOW_MAX_ANGLE,
            Math.min(benchmark.elbowAngle, first.elbowAngle + 18) + CONFIG.BENCHMARK_ELBOW_MARGIN
        );
        const shoulderDropMin = benchmark.shoulderDrop > CONFIG.MIN_SHOULDER_DROP
            ? Math.max(CONFIG.MIN_SHOULDER_DROP, Math.min(0.045, benchmark.shoulderDrop * CONFIG.BENCHMARK_SHOULDER_DROP_RATIO))
            : CONFIG.MIN_SHOULDER_DROP;

        return {
            elbowMax: Math.max(138, elbowMax),
            shoulderDropMin,
            minElbowBend: Math.max(5, CONFIG.MIN_ELBOW_BEND_DELTA - Math.min(3, tracker.acceptedRepCount))
        };
    }

    function isDownPosition(validation) {
        if (!validation.ok) return false;
        const metrics = validation.metrics;
        const thresholds = benchmarkedDownThresholds();
        const elbowBend = tracker.lastUpElbowAngle === null
            ? thresholds.minElbowBend
            : Math.max(0, tracker.lastUpElbowAngle - metrics.elbowAngle);
        return (metrics.elbowAngle <= thresholds.elbowMax && elbowBend >= thresholds.minElbowBend) ||
            metrics.shoulderDrop >= thresholds.shoulderDropMin;
    }

    function isUpPosition(validation) {
        return validation.ok && validation.metrics.elbowAngle >= CONFIG.UP_ELBOW_MIN_ANGLE;
    }

    function startDownRep(helpers, now) {
        tracker.state = STATE.DOWN;
        tracker.repStartedAt = now;
        tracker.repInvalid = false;
        tracker.currentRepMinElbowAngle = 180;
        tracker.currentRepMaxShoulderDrop = 0;
        helpers.setStage(STATE.DOWN);
    }

    function updateCurrentRepBenchmark(validation) {
        if (!validation.ok || tracker.state !== STATE.DOWN) return;
        tracker.currentRepMinElbowAngle = Math.min(tracker.currentRepMinElbowAngle, validation.metrics.elbowAngle);
        tracker.currentRepMaxShoulderDrop = Math.max(tracker.currentRepMaxShoulderDrop, validation.metrics.shoulderDrop || 0);
    }

    function repSnapshot() {
        return {
            elbowAngle: tracker.currentRepMinElbowAngle,
            shoulderDrop: Math.max(0, tracker.currentRepMaxShoulderDrop)
        };
    }

    function captureOrUpdateBenchmark() {
        const snapshot = repSnapshot();
        if (!Number.isFinite(snapshot.elbowAngle) || snapshot.elbowAngle >= 180) return;

        if (!tracker.firstRepBenchmark) {
            tracker.firstRepBenchmark = snapshot;
            tracker.rollingBenchmark = { ...snapshot };
            tracker.acceptedRepCount = 1;
            return;
        }

        const alpha = CONFIG.BENCHMARK_BLEND_ALPHA;
        const blendedElbow = tracker.rollingBenchmark.elbowAngle * (1 - alpha) + snapshot.elbowAngle * alpha;
        const blendedDrop = tracker.rollingBenchmark.shoulderDrop * (1 - alpha) + snapshot.shoulderDrop * alpha;

        tracker.rollingBenchmark = {
            elbowAngle: Math.min(blendedElbow, tracker.firstRepBenchmark.elbowAngle + 18),
            shoulderDrop: Math.max(blendedDrop, tracker.firstRepBenchmark.shoulderDrop * 0.6)
        };
        tracker.acceptedRepCount++;
    }

    function detectLegFloorContact(validation) {
        if (!validation.ok) return false;
        const metrics = validation.metrics;
        const kneeNearFloor = metrics.kneeFloorDistanceRatio <= CONFIG.LEG_CONTACT_FLOOR_DISTANCE_RATIO &&
            metrics.kneeFloorYOffsetRatio >= -CONFIG.LEG_CONTACT_FLOOR_Y_TOLERANCE_RATIO &&
            metrics.kneeAngle <= CONFIG.LEG_CONTACT_KNEE_ANGLE_MAX;
        const hipNearFloor = metrics.hipFloorDistanceRatio <= CONFIG.LEG_CONTACT_HIP_DISTANCE_RATIO &&
            metrics.hipFloorYOffsetRatio >= -CONFIG.LEG_CONTACT_FLOOR_Y_TOLERANCE_RATIO &&
            metrics.hipAngle <= 135;

        return kneeNearFloor || hipNearFloor;
    }

    function updateLegContactState(validation, helpers) {
        if (detectLegFloorContact(validation)) {
            tracker.legContactFrames++;
            tracker.legContactClearFrames = 0;
        } else {
            tracker.legContactClearFrames++;
            if (tracker.legContactClearFrames >= CONFIG.LEG_CONTACT_CLEAR_FRAMES) {
                tracker.legContactFrames = 0;
                tracker.legContactActive = false;
                tracker.legContactCountedReps = 0;
            }
        }

        if (tracker.legContactFrames >= CONFIG.LEG_CONTACT_WARN_FRAMES) {
            tracker.legContactActive = true;
            helpers.noteFormFlag('knees or legs appeared close to the floor during push-ups');
        }
    }

    function showLegContactWarning(helpers) {
        if (!tracker.legContactActive) return;
        const message = tracker.legContactStopRequested
            ? 'Legs kept touching the floor, so FitLah stopped the recording and will show the analysis.'
            : 'Knees or legs look close to the floor. Lift them slightly to keep push-up reps clean.';
        helpers.setWarning(message);
    }

    function recordLegContactOnCount(helpers) {
        if (!tracker.legContactActive || !helpers.isRecording) return;
        tracker.legContactCountedReps++;
        helpers.noteFormFlag('push-up reps counted while lower body was close to the floor');

        if (!tracker.legContactStopRequested &&
            tracker.legContactCountedReps >= CONFIG.LEG_CONTACT_MAX_COUNTED_REPS &&
            helpers.validReps >= CONFIG.LEG_CONTACT_MIN_REPS_BEFORE_STOP &&
            helpers.requestStopRecording) {
            tracker.legContactStopRequested = true;
            helpers.requestStopRecording('Legs kept touching the floor, so FitLah stopped the recording and will show the analysis.');
        }
    }

    function rejectCurrentRep(helpers, message) {
        tracker.repInvalid = true;
        tracker.readyConfirmed = false;
        tracker.readyStartedAt = null;
        tracker.state = STATE.NOT_READY;
        tracker.downFrames = 0;
        tracker.upFrames = 0;
        tracker.invalidPoseFrames = 0;
        helpers.setPositionReady(false);
        helpers.setStage(STATE.NOT_READY);
        helpers.markInvalid(message);
    }

    function sampleMetrics(metrics, helpers, validation) {
        if (!helpers.isRecording || !metrics || !validation.ok) return;
        const elbowAngle = validation.metrics.elbowAngle;
        metrics.frames_sampled++;
        if (metrics.frames_sampled % CONFIG.GRAPH_SAMPLE_EVERY_FRAMES === 0) {
            metrics.movement_samples.push({
                time: helpers.sessionElapsedSeconds(),
                value: Number((validation.metrics.shoulderDrop || 0).toFixed(4)),
                elbow_angle: Math.round(elbowAngle)
            });
            if (metrics.movement_samples.length > 900) {
                metrics.movement_samples.shift();
            }
        }
        if (metrics.frames_sampled % 5 !== 0) return;
        if (elbowAngle <= benchmarkedDownThresholds().elbowMax) metrics.elbow_down_angles.push(Math.round(elbowAngle));
        if (elbowAngle >= CONFIG.UP_ELBOW_MIN_ANGLE) metrics.elbow_up_angles.push(Math.round(elbowAngle));
        if (validation.metrics.hipAngle < CONFIG.MIN_HIP_ANGLE + 5) helpers.noteFormFlag('hips drifted out of straight plank');
        if (elbowAngle > benchmarkedDownThresholds().elbowMax && validation.metrics.shoulderDrop < benchmarkedDownThresholds().shoulderDropMin) {
            metrics.shallow_rep_signals++;
        }
    }

    function analyze(landmarks, helpers) {
        const now = Date.now();

        if (poseConfidence(landmarks) < CONFIG.POSE_CONFIDENCE_MIN) {
            if (!helpers.sessionStarted) reset();
            helpers.setWarning('Pose confidence is low. Keep your full side profile clearly inside the frame.');
            return;
        }

        const smoothed = smoothLandmarks(landmarks);
        const movingPose = validatePushupPose(smoothed, helpers, 'moving');
        const upPose = validatePushupPose(smoothed, helpers, 'up');

        // Ready validation uses a full-body top-position plank. The brief hold prevents random arm bends,
        // standing poses, or partially visible bodies from arming the first rep.
        if (!tracker.readyConfirmed) {
            setReadiness(upPose, helpers, now, upPose.reason);
            sampleMetrics(helpers.metrics, helpers, movingPose);
            return;
        }

        if (!movingPose.ok) {
            tracker.invalidPoseFrames++;
            if (helpers.isRecording || tracker.state === STATE.DOWN) {
                helpers.setWarning(movingPose.reason);
                if (tracker.invalidPoseFrames >= CONFIG.INVALID_POSE_GRACE_FRAMES) {
                    rejectCurrentRep(helpers, movingPose.reason);
                }
            } else {
                reset();
                helpers.setStage(STATE.NOT_READY);
                helpers.setWarning(movingPose.reason);
            }
            sampleMetrics(helpers.metrics, helpers, movingPose);
            return;
        }
        tracker.invalidPoseFrames = 0;
        updateLegContactState(movingPose, helpers);

        const isDown = isDownPosition(movingPose);
        const isUp = isUpPosition(upPose);
        updateStableFrames(isDown, isUp);

        if (isUp) {
            tracker.upShoulderY = tracker.upShoulderY === null
                ? upPose.metrics.shoulderY
                : tracker.upShoulderY * 0.7 + upPose.metrics.shoulderY * 0.3;
            tracker.lastUpElbowAngle = upPose.metrics.elbowAngle;
        }

        // State transitions are intentionally conservative:
        // READY/UP can only enter DOWN after stable depth frames, and DOWN only counts after stable
        // straight-arm UP frames plus a minimum rep duration. This filters landmark jitter and bounce reps.
        if (tracker.state === STATE.READY || tracker.state === STATE.UP) {
            helpers.setWarning(helpers.sessionStarted
                ? 'Recording - lower under control, then return to a straight-arm plank.'
                : 'Ready confirmed - lower under control, then push back up.');
            helpers.setStage(tracker.state);

            if (tracker.downFrames >= CONFIG.STABLE_FRAMES_REQUIRED &&
                now - tracker.lastCountedAt >= CONFIG.REP_COOLDOWN_MS) {
                startDownRep(helpers, now);
            }
        } else if (tracker.state === STATE.DOWN) {
            updateCurrentRepBenchmark(movingPose);
            helpers.setWarning('Good depth - push back up to a straight-arm plank.');
            helpers.setStage(STATE.DOWN);

            if (tracker.upFrames >= CONFIG.STABLE_FRAMES_REQUIRED) {
                const repDuration = now - tracker.repStartedAt;
                if (!tracker.repInvalid && repDuration >= CONFIG.MIN_REP_DURATION_MS) {
                    captureOrUpdateBenchmark();
                    tracker.lastCountedAt = now;
                    tracker.state = STATE.REP_COUNTED;
                    helpers.countValidRep(STATE.UP);
                    recordLegContactOnCount(helpers);
                    helpers.setStage(STATE.REP_COUNTED);
                } else {
                    tracker.state = STATE.UP;
                    helpers.setStage(STATE.UP);
                    helpers.setWarning('Control the full down-up movement before the rep can count.');
                }
            }
        } else if (tracker.state === STATE.REP_COUNTED) {
            helpers.setStage(STATE.REP_COUNTED);
            if (now - tracker.lastCountedAt >= CONFIG.REP_COOLDOWN_MS && isUp) {
                tracker.state = STATE.UP;
                helpers.setStage(STATE.UP);
            }
        } else {
            tracker.state = STATE.UP;
            helpers.setStage(STATE.UP);
        }

        showLegContactWarning(helpers);
        sampleMetrics(helpers.metrics, helpers, movingPose);
    }

    function enrichMetrics(payload, metrics, avgAngle) {
        payload.avg_elbow_angle_down = avgAngle(metrics.elbow_down_angles);
        payload.avg_elbow_angle_up = avgAngle(metrics.elbow_up_angles);
        payload.shallow_rep_signals = metrics.shallow_rep_signals || 0;
        if (payload.avg_elbow_angle_down && payload.avg_elbow_angle_down > CONFIG.DOWN_ELBOW_MAX_ANGLE + 3) {
            payload.form_flags.push('limited push-up depth on several reps');
        }
    }

    window.FitLahPushupExercise = {
        analyze,
        enrichMetrics,
        reset,
        STATE,
        CONFIG
    };
})();
