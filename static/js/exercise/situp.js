(function () {
    function wristNearEar(wrist, ear, refLen, helpers) {
        if (!helpers.visibleLoose(wrist, 0.2) || !helpers.visibleLoose(ear, 0.2)) return null;
        // More lenient distance check - increased from 0.8 to 1.0 for side view
        const maxDist = Math.max(0.12, refLen * 1.0);
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

        // Accept if at least one hand is confirmed on ear or both are likely on ear
        if (leftKnown && rightKnown) {
            // Both visible - require at least one on ear
            return left || right;
        }
        // Only left visible - use left
        if (leftKnown && !rightKnown) return left;
        // Only right visible - use right
        if (rightKnown && !leftKnown) return right;
        // Neither clearly visible
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

        // Only enforce hands on ears when actively recording
        if (!earsOk && helpers.isRecording) {
            helpers.setHandsOnEarsStreak(0);
            sampleMetrics(helpers.metrics, helpers, hipAngle, false);
            helpers.markInvalid('Keep both hands touching your ears - reps will not count otherwise.');
            return;
        }

        if (!earsOk) {
            helpers.setHandsOnEarsStreak(0);
            if (helpers.sessionStarted) {
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
