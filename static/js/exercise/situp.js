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
        SMOOTHING_ALPHA: 0.9,
        SIGNAL_ALPHA: 0.9,
        MIN_AMPLITUDE: 0.016,
        MIN_CONFIRMED_LIFT: 0.028,
        ADAPTIVE_AMPLITUDE_RATIO: 0.12,
        MAX_ADAPTIVE_AMPLITUDE_MULTIPLIER: 1.35,
        REVERSAL_RATIO: 0.14,
        RETURN_RATIO: 0.64,
        MIN_TORSO_ANGLE_CHANGE: 5,
        MIN_REP_PERIOD_S: 0.12,
        MAX_REP_PERIOD_S: 8,
        REP_COOLDOWN_S: 0.28,
        REPLAY_END_GUARD_S: 1.15,
        CALIBRATION_FRAMES: 4,
        ANALYZER_WINDOW_FRAMES: 7,
        ANALYZER_DIRECTION_FRAMES: 1,
        ANALYZER_NOISE_FLOOR: 0.0035,
        ANALYZER_NOISE_MULTIPLIER: 2.2,
        ANALYZER_MIN_TURN_DROP_RATIO: 0.28,
        MAX_INTERPOLATION_STEP_S: 1 / 18,
        GRAPH_SAMPLE_EVERY_FRAMES: 2,
        DROPOUT_BRIDGE_FRAMES: 6,
        MAX_MISSING_FRAMES: 8
    };

    const tracker = {
        state: STATE.NOT_READY,
        smoothedLandmarks: null,
        smoothedSignal: null,
        previousSignal: null,
        previousTime: null,
        liveStartedAtMs: null,
        lastLiveTime: 0,
        missingFrames: 0,
        framesSeen: 0,
        stage: 'SEEK_HIGH',
        low: null,
        lowTime: 0,
        lowTorsoAngle: null,
        high: null,
        highTime: 0,
        highTorsoAngle: null,
        currentTorsoAngle: null,
        analyzerSamples: [],
        analyzerDirection: 0,
        analyzerDirectionFrames: 0,
        analyzerHigh: null,
        analyzerLow: null,
        lastAnalyzerEvent: null,
        lastCountedAt: -Infinity,
        liftConfirmed: false,
        awaitingFreshLift: false,
        repLogs: [],
        repCount: 0,
        minValue: Infinity,
        maxValue: -Infinity,
        lastSignalSource: '',
        lastSignalConfidence: 0
    };

    function reset() {
        tracker.state = STATE.NOT_READY;
        tracker.smoothedLandmarks = null;
        tracker.smoothedSignal = null;
        tracker.previousSignal = null;
        tracker.previousTime = null;
        tracker.liveStartedAtMs = null;
        tracker.lastLiveTime = 0;
        tracker.missingFrames = 0;
        tracker.framesSeen = 0;
        tracker.stage = 'SEEK_HIGH';
        tracker.low = null;
        tracker.lowTime = 0;
        tracker.lowTorsoAngle = null;
        tracker.high = null;
        tracker.highTime = 0;
        tracker.highTorsoAngle = null;
        tracker.currentTorsoAngle = null;
        tracker.analyzerSamples = [];
        tracker.analyzerDirection = 0;
        tracker.analyzerDirectionFrames = 0;
        tracker.analyzerHigh = null;
        tracker.analyzerLow = null;
        tracker.lastAnalyzerEvent = null;
        tracker.lastCountedAt = -Infinity;
        tracker.liftConfirmed = false;
        tracker.awaitingFreshLift = false;
        tracker.repLogs = [];
        tracker.repCount = 0;
        tracker.minValue = Infinity;
        tracker.maxValue = -Infinity;
        tracker.lastSignalSource = '';
        tracker.lastSignalConfidence = 0;
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

    function averagedPoint(points, minVisibility = CONFIG.POSE_CONFIDENCE_MIN) {
        const visiblePoints = points.filter(point => visible(point, minVisibility));
        if (!visiblePoints.length) return null;
        const total = visiblePoints.reduce((sum, point) => ({
            x: sum.x + point.x,
            y: sum.y + point.y,
            z: sum.z + (point.z || 0),
            visibility: sum.visibility + (point.visibility || 0)
        }), { x: 0, y: 0, z: 0, visibility: 0 });
        return {
            point: {
                x: total.x / visiblePoints.length,
                y: total.y / visiblePoints.length,
                z: total.z / visiblePoints.length,
                visibility: total.visibility / visiblePoints.length
            },
            count: visiblePoints.length,
            confidence: total.visibility / visiblePoints.length
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
        const now = window.performance?.now ? window.performance.now() : Date.now();
        if (tracker.liveStartedAtMs === null) {
            tracker.liveStartedAtMs = now;
            tracker.lastLiveTime = 0;
            return 0;
        }
        const elapsed = Math.max(0, (now - tracker.liveStartedAtMs) / 1000);
        tracker.lastLiveTime = Math.max(tracker.lastLiveTime + 0.001, elapsed);
        return tracker.lastLiveTime;
    }

    function shoulderPoint(landmarks) {
        const left = landmarks[LANDMARK.LEFT_SHOULDER];
        const right = landmarks[LANDMARK.RIGHT_SHOULDER];
        if (visible(left) && visible(right)) return midpoint(left, right);
        if (visible(left)) return left;
        if (visible(right)) return right;
        return null;
    }

    function bodyPoint(landmarks, leftIndex, rightIndex, minVisibility = 0.08) {
        const left = landmarks[leftIndex];
        const right = landmarks[rightIndex];
        if (visible(left, minVisibility) && visible(right, minVisibility)) return midpoint(left, right);
        if (visible(left, minVisibility)) return left;
        if (visible(right, minVisibility)) return right;
        return null;
    }

    function situpTorsoAngle(landmarks, helpers) {
        const shoulder = shoulderPoint(landmarks);
        const hip = bodyPoint(landmarks, LANDMARK.LEFT_HIP, LANDMARK.RIGHT_HIP);
        const knee = bodyPoint(landmarks, LANDMARK.LEFT_KNEE, LANDMARK.RIGHT_KNEE);
        if (!shoulder || !hip || !knee) return null;
        return helpers.angle(shoulder, hip, knee);
    }

    function situpSignal(landmarks) {
        const shoulderInfo = averagedPoint([
            landmarks[LANDMARK.LEFT_SHOULDER],
            landmarks[LANDMARK.RIGHT_SHOULDER]
        ]);
        if (!shoulderInfo) return null;

        const hipInfo = averagedPoint([
            landmarks[LANDMARK.LEFT_HIP],
            landmarks[LANDMARK.RIGHT_HIP]
        ], 0.1);
        const kneeInfo = averagedPoint([
            landmarks[LANDMARK.LEFT_KNEE],
            landmarks[LANDMARK.RIGHT_KNEE]
        ], 0.1);

        const shoulder = shoulderInfo.point;
        let raw = -shoulder.y;
        let source = shoulderInfo.count > 1 ? 'shoulders' : 'single_shoulder';
        let confidence = shoulderInfo.confidence;

        if (hipInfo && kneeInfo) {
            const hip = hipInfo.point;
            const knee = kneeInfo.point;
            const torsoLength = Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
            const thighLength = Math.hypot(hip.x - knee.x, hip.y - knee.y);
            const bodyScale = Math.max(0.001, torsoLength + thighLength);
            raw = (hip.y - shoulder.y) / bodyScale;
            source = shoulderInfo.count > 1 ? 'torso_normalized' : 'single_shoulder_normalized';
            confidence = Math.min(shoulderInfo.confidence, hipInfo.confidence, kneeInfo.confidence);
        }

        tracker.smoothedSignal = tracker.smoothedSignal === null
            ? raw
            : tracker.smoothedSignal * (1 - CONFIG.SIGNAL_ALPHA) + raw * CONFIG.SIGNAL_ALPHA;
        tracker.lastSignalSource = source;
        tracker.lastSignalConfidence = confidence;
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

    function countRep(time, amplitude, helpers, periodStartTime = tracker.lowTime) {
        if (helpers.canCountReps && !helpers.canCountReps()) {
            helpers.setWarning(helpers.poseReadinessMessage ? helpers.poseReadinessMessage() : 'Hold position...');
            return false;
        }
        if (helpers.isReplayMode && (
            helpers.isReplayAnalysisEnding ||
            (helpers.replaySecondsRemaining && helpers.replaySecondsRemaining() <= CONFIG.REPLAY_END_GUARD_S)
        )) {
            return false;
        }
        if (time - tracker.lastCountedAt < CONFIG.REP_COOLDOWN_S) return false;
        const period = periodStartTime > 0 ? time - periodStartTime : CONFIG.MIN_REP_PERIOD_S;
        if (period < CONFIG.MIN_REP_PERIOD_S || period > CONFIG.MAX_REP_PERIOD_S) return false;

        tracker.repCount++;
        tracker.lastCountedAt = time;
        tracker.repLogs.push({
            rep: tracker.repCount,
            period_s: Number(period.toFixed(3)),
            amplitude: Number((amplitude * 100).toFixed(3)),
            amplitude_lift_pct: Number((amplitude * 100).toFixed(3)),
            signal_source: tracker.lastSignalSource,
            confidence: Number(tracker.lastSignalConfidence.toFixed(3)),
            time_s: Number(time.toFixed(3))
        });
        if (helpers.metrics && amplitude < CONFIG.MIN_CONFIRMED_LIFT * 1.25) {
            helpers.metrics.shallow_rep_signals = (helpers.metrics.shallow_rep_signals || 0) + 1;
            helpers.noteFormFlag('low_situp_lift');
        }
        tracker.state = STATE.REP_COUNTED;
        tracker.awaitingFreshLift = true;
        helpers.countValidRep(STATE.DOWN);
        helpers.setStage(STATE.REP_COUNTED);
        publishMetrics(helpers.metrics);
        return true;
    }

    function median(values) {
        if (!values.length) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length / 2)];
    }

    function resetAnalyzerCycle(value, time) {
        tracker.analyzerSamples = [];
        tracker.analyzerDirection = 0;
        tracker.analyzerDirectionFrames = 0;
        tracker.analyzerHigh = { value, time, torsoAngle: tracker.currentTorsoAngle };
        tracker.analyzerLow = { value, time, torsoAngle: tracker.currentTorsoAngle };
        tracker.lastAnalyzerEvent = null;
    }

    function torsoCorroborates(angleChange, amplitude) {
        const clearShoulderLift = amplitude >= CONFIG.MIN_CONFIRMED_LIFT * 1.1 &&
            tracker.lastSignalConfidence >= CONFIG.POSE_CONFIDENCE_MIN * 0.75;
        if (!Number.isFinite(angleChange)) return clearShoulderLift;
        return angleChange >= CONFIG.MIN_TORSO_ANGLE_CHANGE || clearShoulderLift;
    }

    function analyzeSignalSample(sample) {
        const previous = tracker.analyzerSamples.length
            ? tracker.analyzerSamples[tracker.analyzerSamples.length - 1]
            : null;
        tracker.analyzerSamples.push(sample);
        if (tracker.analyzerSamples.length > CONFIG.ANALYZER_WINDOW_FRAMES) {
            tracker.analyzerSamples.shift();
        }

        const deltas = [];
        for (let index = 1; index < tracker.analyzerSamples.length; index++) {
            deltas.push(Math.abs(tracker.analyzerSamples[index].value - tracker.analyzerSamples[index - 1].value));
        }
        const baseNoise = Math.max(
            CONFIG.ANALYZER_NOISE_FLOOR,
            median(deltas) * CONFIG.ANALYZER_NOISE_MULTIPLIER
        );
        const confidencePenalty = sample.confidence < CONFIG.POSE_CONFIDENCE_MIN
            ? 1.8
            : (sample.confidence < 0.3 ? 1.25 : 1);
        const noise = baseNoise * confidencePenalty;

        const delta = previous ? sample.value - previous.value : 0;
        let direction = 0;
        if (delta > noise * 0.45) direction = 1;
        if (delta < -noise * 0.45) direction = -1;

        const previousDirection = tracker.analyzerDirection;
        const previousHigh = tracker.analyzerHigh;
        const previousLow = tracker.analyzerLow;

        if (!tracker.analyzerHigh || sample.value >= tracker.analyzerHigh.value) {
            tracker.analyzerHigh = {
                value: sample.value,
                time: sample.time,
                torsoAngle: sample.torsoAngle
            };
        }
        if (!tracker.analyzerLow || sample.value <= tracker.analyzerLow.value) {
            tracker.analyzerLow = {
                value: sample.value,
                time: sample.time,
                torsoAngle: sample.torsoAngle
            };
        }

        if (direction === 0) {
            tracker.analyzerDirectionFrames = Math.max(0, tracker.analyzerDirectionFrames - 1);
        } else if (direction === previousDirection) {
            tracker.analyzerDirectionFrames++;
        } else {
            tracker.analyzerDirection = direction;
            tracker.analyzerDirectionFrames = 1;
        }

        const amplitude = tracker.analyzerHigh && tracker.analyzerLow
            ? tracker.analyzerHigh.value - tracker.analyzerLow.value
            : 0;
        const minTurnDrop = Math.max(noise, amplitude * CONFIG.ANALYZER_MIN_TURN_DROP_RATIO);
        const turnedDown = previousDirection > 0 &&
            tracker.analyzerDirection < 0 &&
            tracker.analyzerDirectionFrames >= CONFIG.ANALYZER_DIRECTION_FRAMES &&
            previousHigh &&
            previousHigh.value - sample.value >= minTurnDrop;
        const turnedUp = previousDirection < 0 &&
            tracker.analyzerDirection > 0 &&
            tracker.analyzerDirectionFrames >= CONFIG.ANALYZER_DIRECTION_FRAMES &&
            previousLow &&
            sample.value - previousLow.value >= minTurnDrop;

        const event = !sample.interpolated && turnedDown
            ? { type: 'peak', point: previousHigh, noise, amplitude }
            : (!sample.interpolated && turnedUp)
                ? { type: 'trough', point: previousLow, noise, amplitude }
                : null;
        if (event) tracker.lastAnalyzerEvent = event;

        return {
            direction: tracker.analyzerDirection,
            directionFrames: tracker.analyzerDirectionFrames,
            event,
            noise,
            amplitude,
            high: tracker.analyzerHigh,
            low: tracker.analyzerLow
        };
    }

    function processSignal(time, value, helpers, options = {}) {
        const cycleLowTime = tracker.lowTime;
        const cycleLowTorsoAngle = tracker.lowTorsoAngle;
        const signalInfo = analyzeSignalSample({
            time,
            value,
            torsoAngle: tracker.currentTorsoAngle,
            confidence: tracker.lastSignalConfidence,
            interpolated: Boolean(options.interpolated)
        });
        tracker.minValue = Math.min(tracker.minValue, value);
        tracker.maxValue = Math.max(tracker.maxValue, value);

        if (tracker.low === null || value < tracker.low) {
            tracker.low = value;
            tracker.lowTime = time;
            tracker.lowTorsoAngle = tracker.currentTorsoAngle;
        }
        if (tracker.high === null || value > tracker.high) {
            tracker.high = value;
            tracker.highTime = time;
            tracker.highTorsoAngle = tracker.currentTorsoAngle;
        }

        const dynamicRange = Math.max(CONFIG.MIN_AMPLITUDE, tracker.maxValue - tracker.minValue);
        const confirmedLift = Math.max(
            CONFIG.MIN_CONFIRMED_LIFT,
            Math.min(
                dynamicRange * CONFIG.ADAPTIVE_AMPLITUDE_RATIO,
                CONFIG.MIN_CONFIRMED_LIFT * CONFIG.MAX_ADAPTIVE_AMPLITUDE_MULTIPLIER
            )
        );
        const reversal = Math.max(
            CONFIG.MIN_AMPLITUDE * 0.45,
            dynamicRange * CONFIG.REVERSAL_RATIO,
            signalInfo.noise
        );

        if (tracker.stage === 'SEEK_HIGH') {
            if (value > tracker.high) {
                tracker.high = value;
                tracker.highTime = time;
                tracker.highTorsoAngle = tracker.currentTorsoAngle;
            }
            const lift = tracker.high - tracker.low;
            const torsoAngleChange = Number.isFinite(tracker.lowTorsoAngle) && Number.isFinite(tracker.highTorsoAngle)
                ? Math.abs(tracker.highTorsoAngle - tracker.lowTorsoAngle)
                : null;
            const torsoLiftCorroborated = torsoCorroborates(torsoAngleChange, lift);
            if (lift >= confirmedLift && torsoLiftCorroborated) {
                tracker.liftConfirmed = true;
                tracker.awaitingFreshLift = false;
            }
            const peakEvent = signalInfo.event && signalInfo.event.type === 'peak'
                ? signalInfo.event.point
                : null;
            const peakDrop = tracker.high - value;
            const peakConfirmed = peakEvent
                ? peakEvent.value >= tracker.low + confirmedLift * 0.75
                : false;
            const fallbackPeakConfirmed = peakDrop >= reversal &&
                value < tracker.high;
            if (tracker.liftConfirmed && (peakConfirmed || fallbackPeakConfirmed)) {
                const lateReturn = lift >= confirmedLift &&
                    value <= tracker.high - lift * CONFIG.RETURN_RATIO &&
                    !options.interpolated;
                if (lateReturn && countRep(time, lift, helpers, cycleLowTime)) {
                    tracker.stage = 'SEEK_HIGH';
                    tracker.low = value;
                    tracker.lowTime = time;
                    tracker.lowTorsoAngle = tracker.currentTorsoAngle;
                    tracker.high = value;
                    tracker.highTime = time;
                    tracker.highTorsoAngle = tracker.currentTorsoAngle;
                    tracker.liftConfirmed = false;
                    tracker.awaitingFreshLift = true;
                    resetAnalyzerCycle(value, time);
                    return;
                }
                tracker.stage = 'SEEK_LOW';
                tracker.state = STATE.UP;
                helpers.setStage(STATE.UP);
                helpers.setWarning('Good lift - return shoulders down.');
            } else {
                tracker.state = STATE.READY;
                helpers.setStage(STATE.READY);
                helpers.setWarning(tracker.awaitingFreshLift
                    ? 'Rep counted - lift again for the next sit-up.'
                    : (helpers.sessionStarted ? 'Recording - lift and return shoulders down.' : 'Ready - start sit-ups.'));
            }
            return;
        }

        if (value < tracker.low) {
            tracker.low = value;
            tracker.lowTime = time;
            tracker.lowTorsoAngle = tracker.currentTorsoAngle;
        }

        const amplitude = tracker.high - tracker.low;
        const returnedLowEnough = value <= tracker.high - amplitude * CONFIG.RETURN_RATIO;
        const countableReturn = returnedLowEnough &&
            !options.interpolated &&
            signalInfo.direction <= 0;
        if (tracker.liftConfirmed && amplitude >= confirmedLift && countableReturn) {
            const repTorsoAngleChange = Number.isFinite(cycleLowTorsoAngle) && Number.isFinite(tracker.highTorsoAngle)
                ? Math.abs(tracker.highTorsoAngle - cycleLowTorsoAngle)
                : null;
            const torsoRepCorroborated = torsoCorroborates(repTorsoAngleChange, amplitude);
            if (torsoRepCorroborated && countRep(time, amplitude, helpers, cycleLowTime)) {
                tracker.stage = 'SEEK_HIGH';
                tracker.low = value;
                tracker.lowTime = time;
                tracker.lowTorsoAngle = tracker.currentTorsoAngle;
                tracker.high = value;
                tracker.highTime = time;
                tracker.highTorsoAngle = tracker.currentTorsoAngle;
                tracker.liftConfirmed = false;
                tracker.awaitingFreshLift = true;
                resetAnalyzerCycle(value, time);
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
                        helpers,
                        { interpolated: true }
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
                torso_lift: Number(Math.max(0, liftPct).toFixed(3)),
                signal_source: tracker.lastSignalSource,
                signal_confidence: Number(tracker.lastSignalConfidence.toFixed(3))
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
        const time = timeSeconds(helpers);
        const signal = situpSignal(smoothed);
        tracker.currentTorsoAngle = situpTorsoAngle(smoothed, helpers);
        if (!Number.isFinite(signal)) {
            tracker.missingFrames++;
            if (tracker.missingFrames <= CONFIG.DROPOUT_BRIDGE_FRAMES && Number.isFinite(tracker.previousSignal)) {
                processWithGapFill(time, tracker.previousSignal, helpers);
                helpers.setPositionReady(true);
                return;
            }
            if (tracker.missingFrames > CONFIG.MAX_MISSING_FRAMES) {
                helpers.setStage(STATE.NOT_READY);
                helpers.setWarning('Keep at least one shoulder clearly visible.');
            }
            return;
        }

        tracker.missingFrames = 0;
        tracker.framesSeen++;
        helpers.setPositionReady(true);
        if (helpers.markPoseSignalStable && !helpers.markPoseSignalStable({
            signal,
            confidence: tracker.lastSignalConfidence
        })) {
            tracker.minValue = Math.min(tracker.minValue, signal);
            tracker.maxValue = Math.max(tracker.maxValue, signal);
            tracker.low = tracker.low === null ? signal : Math.min(tracker.low, signal);
            tracker.high = tracker.high === null ? signal : Math.max(tracker.high, signal);
            tracker.lowTime = time;
            tracker.highTime = time;
            tracker.lowTorsoAngle = tracker.currentTorsoAngle;
            tracker.highTorsoAngle = tracker.currentTorsoAngle;
            tracker.previousSignal = signal;
            tracker.previousTime = time;
            helpers.setStage(STATE.READY);
            return;
        }
        if (tracker.framesSeen <= CONFIG.CALIBRATION_FRAMES) {
            tracker.minValue = Math.min(tracker.minValue, signal);
            tracker.maxValue = Math.max(tracker.maxValue, signal);
            tracker.low = tracker.low === null ? signal : Math.min(tracker.low, signal);
            tracker.high = tracker.high === null ? signal : Math.max(tracker.high, signal);
            tracker.lowTime = time;
            tracker.highTime = time;
            tracker.lowTorsoAngle = tracker.currentTorsoAngle;
            tracker.highTorsoAngle = tracker.currentTorsoAngle;
            tracker.previousSignal = signal;
            tracker.previousTime = time;
            helpers.setStage(STATE.READY);
            helpers.setWarning('Calibrating shoulder height.');
            sampleMetrics(helpers.metrics, helpers, smoothed, signal);
            return;
        }
        processWithGapFill(time, signal, helpers);
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
