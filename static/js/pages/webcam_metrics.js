(function () {
    const MOVEMENT_GRAPH_MAX_POINTS = 220;

    function createMetrics(exercise) {
        return {
            exercise,
            frames_sampled: 0,
            elbow_down_angles: [],
            elbow_up_angles: [],
            hip_down_angles: [],
            hip_up_angles: [],
            movement_samples: [],
            rep_metrics: [],
            rep_metrics_csv: '',
            rep_count_signal: 0,
            shallow_rep_signals: 0,
            form_flags: []
        };
    }

    function avgAngle(arr) {
        if (!arr || !arr.length) return null;
        return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    }

    function smoothMovementSamples(samples) {
        return samples.map((sample, index) => {
            const previous = samples[Math.max(0, index - 1)];
            const next = samples[Math.min(samples.length - 1, index + 1)];
            return {
                ...sample,
                value: Number(((previous.value + sample.value * 2 + next.value) / 4).toFixed(4))
            };
        });
    }

    function compactMovementSamples(samples, maxPoints = MOVEMENT_GRAPH_MAX_POINTS) {
        const validSamples = (samples || [])
            .filter(sample => Number.isFinite(sample.time) && Number.isFinite(sample.value))
            .map(sample => ({
                time: Number(sample.time.toFixed(2)),
                value: Number(sample.value.toFixed(4)),
                elbow_angle: Number.isFinite(sample.elbow_angle) ? sample.elbow_angle : null,
                hip_angle: Number.isFinite(sample.hip_angle) ? sample.hip_angle : null
            }));
        if (validSamples.length <= maxPoints) return smoothMovementSamples(validSamples);

        const step = Math.ceil(validSamples.length / maxPoints);
        return smoothMovementSamples(validSamples.filter((_, index) => index % step === 0).slice(0, maxPoints));
    }

    function buildMovementAnalysis(metrics, duration, exercise) {
        const samples = compactMovementSamples(metrics.movement_samples);
        if (!samples.length) return null;

        const values = samples.map(sample => sample.value);
        const maxValue = Math.max(...values);
        const minValue = Math.min(...values);
        const range = maxValue - minValue;

        return {
            type: exercise === 'pushup' ? 'shoulder_height' : 'hip_angle',
            label: exercise === 'pushup' ? 'Shoulder height' : 'Hip angle',
            unit: exercise === 'pushup' ? 'px' : 'degrees',
            duration_seconds: duration,
            samples,
            reps: Array.isArray(metrics.rep_metrics) ? metrics.rep_metrics.slice() : [],
            stats: {
                peak: Number(maxValue.toFixed(3)),
                range: Number(range.toFixed(3))
            }
        };
    }

    function repMetricsCsv(data) {
        const rows = (data || []).map((item, index) => {
            const rep = Number.isFinite(item.rep) ? item.rep : index + 1;
            const amplitude = Number.isFinite(item.amplitude_angle_deg)
                ? item.amplitude_angle_deg
                : (Number.isFinite(item.amplitude_px) ? item.amplitude_px : item.amplitude);
            const period = item.period_s;
            return [
                rep,
                Number.isFinite(amplitude) ? Number(amplitude).toFixed(3) : '',
                Number.isFinite(period) ? Number(period).toFixed(3) : ''
            ].join(',');
        });
        return `rep,amplitude,period_s${rows.length ? `\n${rows.join('\n')}` : ''}`;
    }

    function compactForAi(metrics) {
        const payload = { ...metrics };
        const reps = Array.isArray(payload.rep_metrics)
            ? payload.rep_metrics
            : (Array.isArray(payload.movement_analysis?.reps) ? payload.movement_analysis.reps : []);
        payload.rep_metrics_csv = reps.length
            ? repMetricsCsv(reps)
            : (payload.rep_metrics_csv || repMetricsCsv([]));
        delete payload.rep_metrics;
        if (payload.movement_analysis) {
            const { samples, reps: movementReps, ...analysisSummary } = payload.movement_analysis;
            payload.movement_analysis = analysisSummary;
        }
        return payload;
    }

    window.FitLahWebcamMetrics = {
        avgAngle,
        buildMovementAnalysis,
        compactForAi,
        createMetrics,
        repMetricsCsv
    };
})();
