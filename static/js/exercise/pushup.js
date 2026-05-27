(function () {
    function isInStartZone(side, helpers) {
        if (!helpers.visibleLoose(side.shoulder) || !helpers.visibleLoose(side.hip)) return false;
        const notStandingUpright = Math.abs(side.shoulder.y - side.hip.y) < 0.45;
        const armsForward = helpers.visibleLoose(side.elbow) || helpers.visibleLoose(side.wrist);
        return notStandingUpright && armsForward;
    }

    function sampleMetrics(metrics, helpers, elbowAngle, inStartZone) {
        if (!helpers.isRecording || !metrics) return;
        metrics.frames_sampled++;
        if (metrics.frames_sampled % 5 !== 0) return;
        if (elbowAngle < 115) metrics.elbow_down_angles.push(Math.round(elbowAngle));
        if (elbowAngle > 130) metrics.elbow_up_angles.push(Math.round(elbowAngle));
        if (!inStartZone) helpers.noteFormFlag('torso alignment drifted from plank');
        if (elbowAngle > 95 && elbowAngle < 128) metrics.shallow_rep_signals++;
    }

    function analyze(landmarks, helpers) {
        const side = helpers.bestSide(landmarks);
        const hasCoreLandmarks = helpers.visibleLoose(side.shoulder) && helpers.visibleLoose(side.hip) &&
            (helpers.visibleLoose(side.elbow) || helpers.visibleLoose(side.wrist));

        if (!hasCoreLandmarks) {
            if (!helpers.sessionStarted) {
                helpers.resetPositionLock();
            }
            helpers.setWarning('Show your side profile - shoulder, hip, and arm in frame.');
            return;
        }

        const inStartZone = isInStartZone(side, helpers);
        if (!helpers.sessionStarted) {
            helpers.updatePositionLock(inStartZone);
        }

        const trunkLen = Math.max(helpers.distance(side.shoulder, side.hip), 0.08);
        let elbowAngle = 180;
        if (helpers.visibleLoose(side.elbow)) {
            const wrist = helpers.visibleLoose(side.wrist) ? side.wrist : side.elbow;
            elbowAngle = helpers.angle(side.shoulder, side.elbow, wrist);
        }

        const shoulderDrop = (side.shoulder.y - side.hip.y) / trunkLen;
        if (!helpers.sessionStarted && !inStartZone) {
            helpers.setWarning('Get into a push-up / plank position (side-on). First rep starts the timer.');
            return;
        }

        if (!helpers.sessionStarted) {
            if (inStartZone) helpers.setPositionReady(true);
            helpers.setWarning('Go down, then push back up - first full rep starts recording.');
        } else {
            helpers.setWarning('Recording - bend arms down, then push up.');
        }

        const isDown = elbowAngle < 115 || shoulderDrop > 0.08;
        const isUp = elbowAngle > 132 || shoulderDrop < 0.06;

        if (isDown) {
            helpers.setStage('down');
        } else if (isUp && helpers.stage === 'down') {
            helpers.countValidRep('up');
        }

        sampleMetrics(helpers.metrics, helpers, elbowAngle, inStartZone);
    }

    function enrichMetrics(payload, metrics, avgAngle) {
        payload.avg_elbow_angle_down = avgAngle(metrics.elbow_down_angles);
        payload.avg_elbow_angle_up = avgAngle(metrics.elbow_up_angles);
        payload.shallow_rep_signals = metrics.shallow_rep_signals || 0;
        if (payload.avg_elbow_angle_down && payload.avg_elbow_angle_down > 105) {
            payload.form_flags.push('limited push-up depth on several reps');
        }
    }

    window.FitLahPushupExercise = {
        analyze,
        enrichMetrics
    };
})();
