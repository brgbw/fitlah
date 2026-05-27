let currentMode = 'pushup';
    let pushupUploaded = false;
    let situpUploaded = false;
    let stream = null;
    let pose = null;
    let detectLoopRunning = false;
    let mediaRecorder = null;
    let recordedChunks = [];
    let videoBlob = null;
    let timerInterval = null;
    let timeLeft = 60;
    let isRecording = false;
    let sessionArmed = false;
    let sessionStarted = false;
    let positionReady = false;
    let positionLockFrames = 0;
    let isReplayMode = false;
    let sessionStartedAt = null;
    let validReps = 0;
    let invalidReps = 0;
    let stage = null;
    let lastInvalidAt = 0;
    let lastRepAt = 0;
    let lastLandmarks = null;
    let handsOnEarsStreak = 0;
    let cvMetrics = null;
    let lastSessionMetrics = null;
    let lastSessionId = null;
    let lastSavedSessionId = null;
    let lastSavedExercise = null;
    let savedSessionIds = [];
    let videoObjectUrl = null;
    let discardRecordingOnStop = false;
    let aiRecoLoading = false;

    const sourceVideo = document.getElementById('sourceVideo');
    const poseCanvas = document.getElementById('poseCanvas');
    const ctx = poseCanvas.getContext('2d');
    const playbackVideo = document.getElementById('playbackVideo');
    const cameraPlaceholder = document.getElementById('cameraPlaceholder');
    const startCamBtn = document.getElementById('startCamBtn');
    const startRecBtn = document.getElementById('startRecBtn');
    const stopRecBtn = document.getElementById('stopRecBtn');
    const uploadBtn = document.getElementById('uploadBtn');
    const completeBtn = document.getElementById('completeBtn');
    const timerDisplay = document.getElementById('timerDisplay');
    const modePushupBtn = document.getElementById('modePushupBtn');
    const modeSitupBtn = document.getElementById('modeSitupBtn');
    const handsBadge = document.getElementById('handsBadge');
    const aiRecoStatus = document.getElementById('aiRecoStatus');
    const aiRecoSummary = document.getElementById('aiRecoSummary');
    const aiRecoColumns = document.getElementById('aiRecoColumns');
    const aiRecoDos = document.getElementById('aiRecoDos');
    const aiRecoDonts = document.getElementById('aiRecoDonts');
    const aiRecoFocus = document.getElementById('aiRecoFocus');
    const aiRecoFocusText = document.getElementById('aiRecoFocusText');

    const BODY_CONNECTIONS = [
        [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
        [11, 23], [12, 24], [23, 24], [23, 25], [25, 27],
        [24, 26], [26, 28], [27, 29], [29, 31], [28, 30],
        [30, 32], [15, 17], [15, 19], [16, 18], [16, 20]
    ];
    const BODY_LANDMARK_INDICES = new Set(BODY_CONNECTIONS.flat());

    function setExerciseMode(mode) {
        if (isRecording || sessionStarted) return;
        currentMode = mode;
        resetRepState();

        if (mode === 'pushup') {
            modePushupBtn.classList.add('mode-active');
            modeSitupBtn.classList.remove('mode-active');
            handsBadge.style.display = 'none';
            document.getElementById('stationHeader').innerText = 'Push-up Recording';
            document.getElementById('warningMessage').innerText = 'Place your camera side-on. Get into push-up position. Your first full rep will start the 1-minute timer.';
        } else {
            modeSitupBtn.classList.add('mode-active');
            modePushupBtn.classList.remove('mode-active');
            handsBadge.style.display = 'inline-block';
            document.getElementById('stationHeader').innerText = 'Sit-up Recording';
            document.getElementById('warningMessage').innerText = 'Hands on ears at all times. Lie back, then sit up. Your first valid rep starts the 1-minute timer.';
        }

        if (stream) {
            armSession();
            uploadBtn.style.display = 'none';
            playbackVideo.style.display = 'none';
            poseCanvas.style.display = 'block';
            isReplayMode = false;
            detectLoopRunning = true;
            runPoseLoop();
        }
    }

    async function startCamera() {
        try {
            if (!window.Pose) {
                alert('Pose model is still loading. Please try again in a moment.');
                return;
            }

            await initPose();
            stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 960, height: 540 },
                audio: false
            });
            sourceVideo.srcObject = stream;
            await sourceVideo.play();

            cameraPlaceholder.style.display = 'none';
            poseCanvas.style.display = 'block';
            playbackVideo.style.display = 'none';
            startCamBtn.style.display = 'none';
            startRecBtn.style.display = 'inline-block';
            detectLoopRunning = true;
            armSession();
            runPoseLoop();
        } catch (err) {
            alert('Could not access camera or pose model: ' + err.message);
        }
    }

    async function initPose() {
        if (pose) return;
        pose = new Pose({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}`
        });
        pose.setOptions({
            modelComplexity: 1,
            smoothLandmarks: true,
            enableSegmentation: false,
            minDetectionConfidence: 0.55,
            minTrackingConfidence: 0.55
        });
        pose.onResults(handlePoseResults);
    }

    async function runPoseLoop() {
        if (!detectLoopRunning || !pose) return;
        const imageSource = isReplayMode ? playbackVideo : sourceVideo;
        if (imageSource.readyState < 2) {
            requestAnimationFrame(runPoseLoop);
            return;
        }
        await pose.send({ image: imageSource });
        requestAnimationFrame(runPoseLoop);
    }

    function handlePoseResults(results) {
        ctx.save();
        ctx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
        ctx.drawImage(results.image, 0, 0, poseCanvas.width, poseCanvas.height);

        if (!results.poseLandmarks) {
            if (!isReplayMode) {
                setWarning('No body detected. Keep your full side profile inside the frame.');
            }
            ctx.restore();
            return;
        }

        const landmarks = results.poseLandmarks;
        lastLandmarks = landmarks;
        drawBodySkeleton(landmarks);
        if (currentMode === 'situp') {
            FitLahSitupExercise.drawHandsOnEarsGuide(landmarks, {
                ctx,
                width: poseCanvas.width,
                height: poseCanvas.height,
                helpers: exerciseHelpers()
            });
        }

        if (!isReplayMode) {
            if (currentMode === 'pushup') {
                FitLahPushupExercise.analyze(landmarks, exerciseHelpers());
            } else {
                FitLahSitupExercise.analyze(landmarks, exerciseHelpers());
            }
        }

        drawHudOverlay();
        ctx.restore();
    }

    function drawBodySkeleton(landmarks) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#00A86B';
        for (const [aIdx, bIdx] of BODY_CONNECTIONS) {
            const a = landmarks[aIdx];
            const b = landmarks[bIdx];
            if ((a.visibility || 0) > 0.4 && (b.visibility || 0) > 0.4) {
                ctx.beginPath();
                ctx.moveTo(a.x * poseCanvas.width, a.y * poseCanvas.height);
                ctx.lineTo(b.x * poseCanvas.width, b.y * poseCanvas.height);
                ctx.stroke();
            }
        }
        for (const idx of BODY_LANDMARK_INDICES) {
            const lm = landmarks[idx];
            if ((lm.visibility || 0) > 0.4) {
                ctx.beginPath();
                ctx.arc(lm.x * poseCanvas.width, lm.y * poseCanvas.height, 4, 0, 2 * Math.PI);
                ctx.fillStyle = '#F43F5E';
                ctx.fill();
                ctx.strokeStyle = '#FFFFFF';
                ctx.lineWidth = 1;
                ctx.stroke();
            }
        }
    }

    function bestSide(landmarks) {
        const left = [11, 13, 15, 23, 25, 27].reduce((sum, idx) => sum + (landmarks[idx].visibility || 0), 0);
        const right = [12, 14, 16, 24, 26, 28].reduce((sum, idx) => sum + (landmarks[idx].visibility || 0), 0);
        return left >= right
            ? { shoulder: landmarks[11], elbow: landmarks[13], wrist: landmarks[15], hip: landmarks[23], knee: landmarks[25], ankle: landmarks[27] }
            : { shoulder: landmarks[12], elbow: landmarks[14], wrist: landmarks[16], hip: landmarks[24], knee: landmarks[26], ankle: landmarks[28] };
    }

    function visibleLoose(point, minVis) {
        minVis = minVis === undefined ? 0.25 : minVis;
        return point && (point.visibility || 0) > minVis;
    }

    function updateHandsBadge(onEars) {
        if (currentMode !== 'situp') return;
        handsBadge.style.display = 'inline-block';
        if (onEars) {
            handsBadge.className = 'hands-ok-badge ok';
            handsBadge.textContent = '✓ Hands on ears';
        } else {
            handsBadge.className = 'hands-ok-badge bad';
            handsBadge.textContent = '✗ Hands must touch ears';
        }
    }

    function updatePositionLock(inPosition) {
        if (inPosition) {
            positionLockFrames++;
        } else {
            positionLockFrames = 0;
        }
        positionReady = positionLockFrames >= 5;
    }

    function exerciseHelpers() {
        return {
            angle,
            bestSide,
            countValidRep,
            distance,
            isRecording,
            markInvalid,
            metrics: cvMetrics,
            noteFormFlag,
            sessionStarted,
            setWarning,
            stage,
            updateHandsBadge,
            updatePositionLock,
            visibleLoose,
            handsOnEarsStreak,
            resetPositionLock() {
                positionLockFrames = 0;
                positionReady = false;
            },
            setHandsOnEarsStreak(value) {
                handsOnEarsStreak = value;
            },
            setPositionReady(value) {
                positionReady = value;
            },
            setStage(value) {
                stage = value;
            }
        };
    }

    function countValidRep(nextStage) {
        if (!sessionArmed && !sessionStarted) {
            stage = nextStage;
            updateCounters();
            return;
        }

        if (Date.now() - lastRepAt < 500) {
            stage = nextStage;
            return;
        }

        if (currentMode === 'situp' && lastLandmarks && !FitLahSitupExercise.handsOnEars(lastLandmarks, exerciseHelpers())) {
            markInvalid('Hands must touch ears at the top of each rep.');
            stage = nextStage;
            return;
        }

        lastRepAt = Date.now();

        if (!sessionStarted) {
            beginSessionRecording();
        }

        validReps++;
        stage = nextStage;
        updateCounters();
    }

    function markInvalid(message) {
        setWarning(message);
        if (isRecording && Date.now() - lastInvalidAt > 1400) {
            invalidReps++;
            lastInvalidAt = Date.now();
            updateCounters();
        }
    }

    function visible(...points) {
        return points.every(point => point && (point.visibility || 0) > 0.4);
    }

    function distance(a, b) {
        return Math.hypot(a.x - b.x, a.y - b.y);
    }

    function angle(a, b, c) {
        const ab = { x: a.x - b.x, y: a.y - b.y };
        const cb = { x: c.x - b.x, y: c.y - b.y };
        const dot = ab.x * cb.x + ab.y * cb.y;
        const mag = Math.hypot(ab.x, ab.y) * Math.hypot(cb.x, cb.y);
        if (!mag) return 180;
        return Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180 / Math.PI;
    }

    function drawHudOverlay() {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
        ctx.fillRect(16, 16, 250, 92);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '700 10px Segoe UI, Arial';
        ctx.fillText(`${currentMode === 'pushup' ? 'Push-Ups' : 'Sit-Ups'}: ${validReps}`, 32, 48);
        ctx.fillStyle = '#FCA5A5';
        ctx.fillText(`Invalid: ${invalidReps}`, 32, 76);
        ctx.fillStyle = '#BBF7D0';
        ctx.fillText(`Stage: ${stage || 'ready'}`, 142, 76);
        if (isRecording && timerDisplay.style.display !== 'none') {
            ctx.fillStyle = '#FDE68A';
            ctx.fillText(timerDisplay.textContent, 200, 48);
        }
    }

    function setWarning(text) {
        document.getElementById('warningMessage').innerText = text;
    }

    function initCvMetrics() {
        cvMetrics = {
            exercise: currentMode,
            frames_sampled: 0,
            elbow_down_angles: [],
            elbow_up_angles: [],
            hip_down_angles: [],
            hip_up_angles: [],
            hands_off_ears_samples: 0,
            hands_on_ears_samples: 0,
            shallow_rep_signals: 0,
            form_flags: []
        };
    }

    function noteFormFlag(flag) {
        if (!cvMetrics || !isRecording) return;
        if (!cvMetrics.form_flags.includes(flag)) {
            cvMetrics.form_flags.push(flag);
        }
    }

    function avgAngle(arr) {
        if (!arr || !arr.length) return null;
        return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length);
    }

    function finalizeSessionMetrics() {
        const duration = Math.max(1, 60 - timeLeft);
        const total = validReps + invalidReps;
        const m = cvMetrics || {};
        const payload = {
            exercise: currentMode,
            valid_reps: validReps,
            invalid_reps: invalidReps,
            duration_seconds: duration,
            reps_per_minute: Math.round((validReps / duration) * 60),
            invalid_rep_rate_pct: total ? Math.round((invalidReps / total) * 100) : 0,
            frames_analyzed: m.frames_sampled || 0,
            form_flags: m.form_flags ? m.form_flags.slice() : []
        };
        if (currentMode === 'pushup') {
            FitLahPushupExercise.enrichMetrics(payload, m, avgAngle);
        } else {
            FitLahSitupExercise.enrichMetrics(payload, m, avgAngle);
        }
        return payload;
    }

    function resetAiRecoPanel() {
        aiRecoStatus.className = 'ai-reco-status';
        aiRecoStatus.textContent = 'Complete a session and review your recording to receive tailored push-up or sit-up advice.';
        aiRecoSummary.style.display = 'none';
        aiRecoColumns.style.display = 'none';
        aiRecoFocus.style.display = 'none';
        aiRecoDos.innerHTML = '';
        aiRecoDonts.innerHTML = '';
    }

    function setAiRecoLoading(exerciseLabel) {
        aiRecoLoading = true;
        aiRecoStatus.className = 'ai-reco-status loading';
        aiRecoStatus.textContent = `Analysing your ${exerciseLabel} session metrics and building personalised tips…`;
        aiRecoSummary.style.display = 'none';
        aiRecoColumns.style.display = 'none';
        aiRecoFocus.style.display = 'none';
    }

    function renderAiRecommendation(data) {
        aiRecoLoading = false;
        aiRecoStatus.className = 'ai-reco-status';
        aiRecoStatus.textContent = 'Personalised feedback based on your computer-vision session data:';

        if (data.summary) {
            aiRecoSummary.textContent = data.summary;
            aiRecoSummary.style.display = 'block';
        }

        aiRecoDos.innerHTML = '';
        (data.dos || []).forEach(item => {
            const li = document.createElement('li');
            li.textContent = item;
            aiRecoDos.appendChild(li);
        });
        aiRecoDonts.innerHTML = '';
        (data.donts || []).forEach(item => {
            const li = document.createElement('li');
            li.textContent = item;
            aiRecoDonts.appendChild(li);
        });
        aiRecoColumns.style.display = (data.dos?.length || data.donts?.length) ? 'grid' : 'none';

        if (data.focus_areas && data.focus_areas.length) {
            aiRecoFocusText.textContent = data.focus_areas.join(' · ');
            aiRecoFocus.style.display = 'block';
        }
    }

    function renderAiRecoError(message) {
        aiRecoLoading = false;
        aiRecoStatus.className = 'ai-reco-status error';
        aiRecoStatus.textContent = message;
    }

    async function fetchAiRecommendation(metrics, force = false) {
        if (!metrics || (aiRecoLoading && !force)) return;
        const label = metrics.exercise === 'pushup' ? 'push-up' : 'sit-up';
        setAiRecoLoading(label);
        const payload = { ...metrics };
        if (lastSessionId) {
            payload.session_id = lastSessionId;
        }
        try {
            const response = await fetch('/api/ai-recommendation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            if (data.success) {
                renderAiRecommendation(data);
            } else {
                renderAiRecoError(data.error || 'Could not generate AI recommendation.');
            }
        } catch (err) {
            renderAiRecoError('AI coach unavailable: ' + err.message);
        }
    }

    function updateCounters() {
        document.getElementById('repCounter').innerHTML = `${validReps} <span>/ 60</span>`;
        document.getElementById('invalidRepCounter').innerHTML = `${invalidReps} <span>/ Warn</span>`;
        document.getElementById('stageDisplay').innerText = `Stage: ${stage || 'Ready'}`;
    }

    function resetRepState() {
        validReps = 0;
        invalidReps = 0;
        stage = null;
        lastInvalidAt = 0;
        lastRepAt = 0;
        positionLockFrames = 0;
        positionReady = false;
        sessionStarted = false;
        sessionStartedAt = null;
        isRecording = false;
        isReplayMode = false;
        videoBlob = null;
        recordedChunks = [];
        if (videoObjectUrl) {
            URL.revokeObjectURL(videoObjectUrl);
            videoObjectUrl = null;
        }
        lastSessionMetrics = null;
        lastSessionId = null;
        uploadBtn.innerText = 'Save Session';
        uploadBtn.style.pointerEvents = 'auto';
        handsOnEarsStreak = 0;
        cvMetrics = null;
        updateCounters();
    }

    function armSession() {
        if (isRecording || sessionStarted) return;
        sessionArmed = true;
        positionLockFrames = 0;
        positionReady = false;
        stage = null;
        validReps = 0;
        invalidReps = 0;
        updateCounters();
        startRecBtn.style.display = 'inline-block';
        stopRecBtn.style.display = 'none';
        uploadBtn.style.display = 'none';
        timerDisplay.style.display = 'none';
    }

    function updateTimer() {
        const mins = Math.floor(timeLeft / 60);
        const secs = timeLeft % 60;
        timerDisplay.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        if (isRecording) {
            timerDisplay.classList.add('timer-active');
        } else {
            timerDisplay.classList.remove('timer-active');
        }
    }

    function startRecording() {
        if (!stream) {
            alert('Start the camera first.');
            return;
        }
        armSession();
        if (currentMode === 'pushup') {
            setWarning('Get into push-up position. Your first full rep starts the 1-minute timer.');
        } else {
            setWarning('Lie back with knees bent. Your first full sit-up starts the 1-minute timer.');
        }
    }

    function beginSessionRecording() {
        if (!stream || sessionStarted || isRecording) return;
        sessionStarted = true;
        sessionStartedAt = new Date().toISOString();
        discardRecordingOnStop = false;
        initCvMetrics();
        recordedChunks = [];
        const canvasStream = poseCanvas.captureStream(30);
        const mimeType = ['video/webm;codecs=vp9', 'video/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
        mediaRecorder = mimeType
            ? new MediaRecorder(canvasStream, { mimeType })
            : new MediaRecorder(canvasStream);
        mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordedChunks.push(e.data);
        };
        mediaRecorder.onstop = () => {
            if (discardRecordingOnStop) {
                discardRecordingOnStop = false;
                recordedChunks = [];
                videoBlob = null;
                lastSessionMetrics = null;
                isRecording = false;
                sessionStarted = false;
                sessionArmed = false;
                return;
            }
            videoBlob = new Blob(recordedChunks, { type: 'video/webm' });
            lastSessionMetrics = finalizeSessionMetrics();
            if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
            videoObjectUrl = URL.createObjectURL(videoBlob);
            playbackVideo.src = videoObjectUrl;
            playbackVideo.muted = true;
            playbackVideo.style.display = 'none';
            poseCanvas.style.display = 'block';
            stopRecBtn.style.display = 'none';
            startRecBtn.style.display = 'none';
            timerDisplay.style.display = 'none';
            isRecording = false;
            sessionArmed = false;
            startPlaybackReplay();
        };

        isRecording = true;
        startRecBtn.style.display = 'none';
        stopRecBtn.style.display = 'inline-block';
        uploadBtn.style.display = 'none';
        timerDisplay.style.display = 'block';
        timeLeft = 60;
        updateTimer();
        clearInterval(timerInterval);
        timerInterval = setInterval(() => {
            timeLeft--;
            updateTimer();
            if (timeLeft <= 0) stopRecording();
        }, 1000);
        mediaRecorder.start(250);
        setWarning('Recording started — 1 minute on the clock!');
    }

    function startPlaybackReplay() {
        isReplayMode = true;
        detectLoopRunning = true;
        playbackVideo.style.display = 'none';
        poseCanvas.style.display = 'block';
        playbackVideo.currentTime = 0;
        const playReplay = () => playbackVideo.play().catch(() => {});
        if (playbackVideo.readyState >= 2) {
            playReplay();
        } else {
            playbackVideo.onloadeddata = playReplay;
        }
        setWarning('Playback with skeleton overlay — review your form, then upload to save.');

        playbackVideo.onended = () => {
            isReplayMode = false;
            detectLoopRunning = true;
            playbackVideo.style.display = 'none';
            poseCanvas.style.display = 'block';
            uploadBtn.style.display = 'inline-block';
            startRecBtn.style.display = 'inline-block';
            setWarning('Review complete. Save session, or switch exercise mode.');
            if (lastSessionMetrics) {
                fetchAiRecommendation(lastSessionMetrics);
            }
        };
        runPoseLoop();
    }

    function stopRecording() {
        clearInterval(timerInterval);
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        } else if (sessionStarted && !videoBlob) {
            uploadBtn.style.display = 'inline-block';
            stopRecBtn.style.display = 'none';
            timerDisplay.style.display = 'none';
            isRecording = false;
        }
    }

    function clearCurrentRecordingUi(message) {
        clearInterval(timerInterval);
        isRecording = false;
        sessionStarted = false;
        sessionArmed = false;
        isReplayMode = false;
        sessionStartedAt = null;
        timeLeft = 60;
        recordedChunks = [];
        videoBlob = null;
        lastSessionMetrics = null;
        lastSessionId = null;
        if (videoObjectUrl) {
            URL.revokeObjectURL(videoObjectUrl);
            videoObjectUrl = null;
        }
        playbackVideo.pause();
        playbackVideo.removeAttribute('src');
        playbackVideo.load();
        playbackVideo.onended = null;
        playbackVideo.style.display = 'none';
        poseCanvas.style.display = stream ? 'block' : 'none';
        stopRecBtn.style.display = 'none';
        uploadBtn.style.display = 'none';
        startRecBtn.style.display = stream ? 'inline-block' : 'none';
        timerDisplay.style.display = 'none';
        resetRepState();
        if (stream) {
            sessionArmed = true;
            detectLoopRunning = true;
            runPoseLoop();
        }
        resetAiRecoPanel();
        setWarning(message || 'Session stopped. The current recording was deleted.');
    }

    async function deleteSavedSession(sessionId) {
        const response = await fetch(`/api/workout-session/${sessionId}`, {
            method: 'DELETE'
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
            throw new Error(result.error || 'Could not delete saved session.');
        }
        return result;
    }

    async function stopSession() {
        if (!stream) return;

        const sessionsToDelete = savedSessionIds.length
            ? savedSessionIds.slice()
            : (lastSavedSessionId ? [{ id: lastSavedSessionId, exercise: lastSavedExercise }] : []);

        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            discardRecordingOnStop = true;
            mediaRecorder.stop();
        }

        try {
            if (sessionsToDelete.length) {
                for (const item of sessionsToDelete) {
                    await deleteSavedSession(item.id);
                    if (item.exercise === 'pushup') {
                        pushupUploaded = false;
                    } else if (item.exercise === 'situp') {
                        situpUploaded = false;
                    }
                }
                savedSessionIds = [];
                lastSavedSessionId = null;
                lastSavedExercise = null;
                checkCompletion();
                clearCurrentRecordingUi('Saved session stopped and deleted, including recorded data and video.');
            } else {
                clearCurrentRecordingUi('Session stopped. The current recording was deleted.');
            }
        } catch (err) {
            clearCurrentRecordingUi('Local session stopped. Saved session deletion failed: ' + err.message);
        }
    }

    async function uploadVideo() {
        if (!videoBlob) return;
        uploadBtn.innerText = 'Uploading...';
        uploadBtn.style.pointerEvents = 'none';

        const formData = new FormData();
        formData.append('video', videoBlob, 'recording.webm');
        formData.append('exercise', currentMode);
        formData.append('valid_reps', validReps);
        formData.append('invalid_reps', invalidReps);
        formData.append('duration_seconds', 60 - timeLeft);
        if (sessionStartedAt) {
            formData.append('started_at', sessionStartedAt);
            formData.append('ended_at', new Date().toISOString());
        }

        try {
            const response = await fetch('/api/upload-video', {
                method: 'POST',
                body: formData
            });
            const result = await response.json();
            if (result.success) {
                if (currentMode === 'pushup') {
                    pushupUploaded = true;
                } else {
                    situpUploaded = true;
                }
                if (result.session_id) {
                    lastSessionId = result.session_id;
                    lastSavedSessionId = result.session_id;
                    lastSavedExercise = currentMode;
                    savedSessionIds = savedSessionIds.filter(item => item.exercise !== currentMode);
                    savedSessionIds.push({ id: result.session_id, exercise: currentMode });
                }
                if (lastSessionMetrics) {
                    lastSessionMetrics.valid_reps = result.valid_reps;
                    lastSessionMetrics.invalid_reps = result.invalid_reps;
                    fetchAiRecommendation(lastSessionMetrics, true);
                }
                const label = currentMode === 'pushup' ? 'Push-up' : 'Sit-up';
                setWarning(`${label} saved — ${result.valid_reps} reps logged. Record another exercise or tap Done.`);
                resetRepState();
                armSession();
                detectLoopRunning = true;
                runPoseLoop();
                checkCompletion();
                uploadBtn.innerText = 'Saved ✓';
            } else {
                alert('Upload failed: ' + result.error);
                uploadBtn.innerText = 'Save Session';
                uploadBtn.style.pointerEvents = 'auto';
            }
        } catch (err) {
            alert('Upload error: ' + err.message);
            uploadBtn.innerText = 'Save Session';
            uploadBtn.style.pointerEvents = 'auto';
        }
    }

    function checkCompletion() {
        if (pushupUploaded || situpUploaded) {
            completeBtn.style.opacity = '1';
            completeBtn.style.pointerEvents = 'auto';
            completeBtn.style.backgroundColor = 'var(--primary)';
        } else {
            completeBtn.style.opacity = '0.5';
            completeBtn.style.pointerEvents = 'none';
            completeBtn.style.backgroundColor = 'var(--text-muted)';
        }
    }

    function saveAndReturn() {
        if (!pushupUploaded && !situpUploaded) {
            alert('Please complete and upload at least one exercise session first.');
            return;
        }
        if (stream) stream.getTracks().forEach(t => t.stop());
        window.location.href = "/";
    }

    window.addEventListener('DOMContentLoaded', () => {
        resetAiRecoPanel();
        setExerciseMode('pushup');
    });
