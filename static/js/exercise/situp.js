(function () {
    function wristNearEar(wrist, ear, refLen, helpers) {
        if (!helpers.visibleLoose(wrist, 0.22) || !helpers.visibleLoose(ear, 0.22)) return null;
        const maxDist = Math.max(0.1, refLen * 0.8);
        return helpers.distance(wrist, ear) <= maxDist;
    }

    function handsOnEars(landmarks, helpers) {
        const lw = landmarks[15];
        const rw = landmarks[16];
        const le = landmarks[7];
        const re = landmarks[8];
        const ls = landmarks[11];
        const rs = landmarks[12];
        const leftRef = helpers.visibleLoose(ls) ? helpers.distance(ls, le) : 0.14;
        const rightRef = helpers.visibleLoose(rs) ? helpers.distance(rs, re) : 0.14;
        const left = wristNearEar(lw, le, leftRef, helpers);
        const right = wristNearEar(rw, re, rightRef, helpers);
        const leftKnown = left !== null;
        const rightKnown = right !== null;

        if (leftKnown && rightKnown) return left && right;
        if (leftKnown && helpers.visibleLoose(rw, 0.28)) return left && right === true;
        if (rightKnown && helpers.visibleLoose(lw, 0.28)) return right && left === true;
        if (leftKnown) return left;
        if (rightKnown) return right;
        return false;
    }

    function drawHandsOnEarsGuide(landmarks, drawing) {
        const pairs = [[15, 7], [16, 8]];
        const onEars = handsOnEars(landmarks, drawing.helpers);
        for (const [wIdx, eIdx] of pairs) {
            const w = landmarks[wIdx];
            const e = landmarks[eIdx];
            if ((w.visibility || 0) > 0.25 && (e.visibility || 0) > 0.25) {
                drawing.ctx.beginPath();
                drawing.ctx.moveTo(w.x * drawing.width, w.y * drawing.height);
                drawing.ctx.lineTo(e.x * drawing.width, e.y * drawing.height);
                drawing.ctx.strokeStyle = onEars ? '#22C55E' : '#F43F5E';
                drawing.ctx.lineWidth = 4;
                drawing.ctx.stroke();
            }
        }
    }

    function isInStartZone(side, helpers) {
        if (!helpers.visibleLoose(side.shoulder) || !helpers.visibleLoose(side.hip)) return false;
        const hipAngle = helpers.visibleLoose(side.knee)
            ? helpers.angle(side.shoulder, side.hip, side.knee)
            : 110;
        const kneeBent = !helpers.visibleLoose(side.knee) || !helpers.visibleLoose(side.ankle) ||
            helpers.angle(side.hip, side.knee, side.ankle) < 170;
        return kneeBent && hipAngle > 100;
    }

    function sampleMetrics(metrics, helpers, hipAngle, earsOk) {
        if (!helpers.isRecording || !metrics) return;
        metrics.frames_sampled++;
        if (metrics.frames_sampled % 5 !== 0) return;
        if (hipAngle > 115) metrics.hip_down_angles.push(Math.round(hipAngle));
        if (hipAngle < 112) metrics.hip_up_angles.push(Math.round(hipAngle));
        if (earsOk) metrics.hands_on_ears_samples++;
        else {
            metrics.hands_off_ears_samples++;
            helpers.noteFormFlag('hands left ears during session');
        }
        if (hipAngle > 105 && hipAngle < 118) helpers.noteFormFlag('partial sit-up depth detected');
    }

    function analyze(landmarks, helpers) {
        const side = helpers.bestSide(landmarks);
        const hasCore = helpers.visibleLoose(side.shoulder) && helpers.visibleLoose(side.hip);

        if (!hasCore) {
            if (!helpers.sessionStarted) {
                helpers.resetPositionLock();
            }
            helpers.updateHandsBadge(false);
            helpers.setWarning('Show your side profile - shoulders, hips, and head in frame.');
            return;
        }

        const hipAngle = helpers.visibleLoose(side.knee)
            ? helpers.angle(side.shoulder, side.hip, side.knee)
            : 110;
        const earsOk = handsOnEars(landmarks, helpers);
        helpers.updateHandsBadge(earsOk);

        if (!earsOk) {
            helpers.setHandsOnEarsStreak(0);
            if (helpers.isRecording) {
                sampleMetrics(helpers.metrics, helpers, hipAngle, false);
            }
            if (helpers.sessionStarted || helpers.isRecording) {
                helpers.markInvalid('Keep both hands touching your ears - reps will not count otherwise.');
            } else {
                helpers.setWarning('Place hands behind your head with wrists touching your ears before starting.');
            }
            return;
        }
        const nextHandsOnEarsStreak = helpers.handsOnEarsStreak + 1;
        helpers.setHandsOnEarsStreak(nextHandsOnEarsStreak);

        const inStartZone = isInStartZone(side, helpers);

        if (!helpers.sessionStarted && !inStartZone) {
            helpers.setWarning('Lie back with knees bent, hands on ears. First sit-up starts the timer.');
            return;
        }

        if (!helpers.sessionStarted) {
            if (inStartZone) helpers.setPositionReady(true);
            helpers.setWarning('Lie back, then sit up - keep hands on ears. First rep starts recording.');
        } else {
            helpers.setWarning('Recording - lie back, sit up, hands stay on ears.');
        }

        const isDown = hipAngle > 118;
        const isUp = hipAngle < 108;

        if (isDown && earsOk) {
            helpers.setStage('down');
        } else if (isUp && helpers.stage === 'down' && earsOk && nextHandsOnEarsStreak >= 2) {
            helpers.countValidRep('up');
        } else if (isUp && helpers.stage === 'down' && !earsOk) {
            helpers.markInvalid('Hands left your ears - rep not counted.');
            helpers.setStage(null);
        }
        sampleMetrics(helpers.metrics, helpers, hipAngle, earsOk);
    }

    function enrichMetrics(payload, metrics, avgAngle) {
        payload.avg_hip_angle_lying = avgAngle(metrics.hip_down_angles);
        payload.avg_hip_angle_sitting = avgAngle(metrics.hip_up_angles);
        const handsTotal = (metrics.hands_on_ears_samples || 0) + (metrics.hands_off_ears_samples || 0);
        payload.hands_on_ears_compliance_pct = handsTotal
            ? Math.round(((metrics.hands_on_ears_samples || 0) / handsTotal) * 100)
            : null;
        if (payload.hands_on_ears_compliance_pct !== null && payload.hands_on_ears_compliance_pct < 85) {
            payload.form_flags.push('hands frequently off ears');
        }
    }

    window.FitLahSitupExercise = {
        analyze,
        drawHandsOnEarsGuide,
        handsOnEars,
        enrichMetrics
    };
})();
