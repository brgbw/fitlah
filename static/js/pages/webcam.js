let currentMode = 'pushup';
    let pushupUploaded = false;
    let situpUploaded = false;
    let stream = null;
    let pose = null;
    let poseInitPromise = null;
    let detectLoopRunning = false;
    const POSE_TARGET_FPS = 20;
    const POSE_MIN_FRAME_MS = 1000 / POSE_TARGET_FPS;
    const WARNING_VOICE_COOLDOWN_MS = 4500;
    let poseLoopRequestId = null;
    let poseInFlight = false;
    let lastPoseSentAt = 0;
    let cachedExerciseHelpers = null;
    let lastWarningText = '';
    let lastCounterSignature = '';
    let mediaRecorder = null;
    let recordedChunks = [];
    let videoBlob = null;
    let timerInterval = null;
    let timeLeft = 60;
    let isRecording = false;
    let sessionArmed = false;
    let sessionStarted = false;
    let analyzeReplayMode = false;
    let attachedVideoFile = null;
    let positionReady = false;
    let positionLockFrames = 0;
    let isReplayMode = false;
    let sessionStartedAt = null;
    let validReps = 0;
    let stage = null;
    let lastRepAt = 0;
    let lastLandmarks = null;
    let cvMetrics = null;
    let lastSessionMetrics = null;
    let lastSessionId = null;
    let lastSavedSessionId = null;
    let lastSavedExercise = null;
    let savedSessionIds = [];
    let videoObjectUrl = null;
    let discardRecordingOnStop = false;
    let lastAnalyzedVideoTime = -1;
    let lastWarningSpokenAt = 0;

    const sourceVideo = document.getElementById('sourceVideo');
    const poseCanvas = document.getElementById('poseCanvas');
    const ctx = poseCanvas.getContext('2d');
    const playbackVideo = document.getElementById('playbackVideo');
    const cameraPlaceholder = document.getElementById('cameraPlaceholder');
    const startCamBtn = document.getElementById('startCamBtn');
    const attachVideoBtn = document.getElementById('attachVideoBtn');
    const videoAttachmentInput = document.getElementById('videoAttachmentInput');
    const startRecBtn = document.getElementById('startRecBtn');
    const stopRecBtn = document.getElementById('stopRecBtn');
    const uploadBtn = document.getElementById('uploadBtn');
    const completeBtn = document.getElementById('completeBtn');
    const timerDisplay = document.getElementById('timerDisplay');
    const modePushupBtn = document.getElementById('modePushupBtn');
    const modeSitupBtn = document.getElementById('modeSitupBtn');
    const repCounter = document.getElementById('repCounter');
    const stationHeader = document.getElementById('stationHeader');
    const handsBadge = document.getElementById('handsBadge');
    const aiRecoPanel = document.getElementById('aiRecoPanel');
    const aiRecoStatus = document.getElementById('aiRecoStatus');
    const aiRecoSkeleton = document.getElementById('aiRecoSkeleton');
    const aiRecoSummary = document.getElementById('aiRecoSummary');
    const aiRecoColumns = document.getElementById('aiRecoColumns');
    const aiRecoDos = document.getElementById('aiRecoDos');
    const aiRecoDonts = document.getElementById('aiRecoDonts');
    const aiRecoFocus = document.getElementById('aiRecoFocus');
    const aiRecoFocusText = document.getElementById('aiRecoFocusText');
    const webcamMetrics = window.FitLahWebcamMetrics;
    const webcamUploader = window.FitLahWebcamUpload;
    const aiCoach = window.FitLahWebcamAiCoach.createController({
        panel: aiRecoPanel,
        status: aiRecoStatus,
        skeleton: aiRecoSkeleton,
        summary: aiRecoSummary,
        columns: aiRecoColumns,
        dos: aiRecoDos,
        donts: aiRecoDonts,
        focus: aiRecoFocus,
        focusText: aiRecoFocusText,
        compactMetricsForAi: webcamMetrics.compactForAi,
        getLastSessionId: () => lastSessionId
    });

    function lockEntryMode(mode) {
        if (mode === 'camera') {
            attachVideoBtn.style.display = 'none';
            startCamBtn.style.display = 'none';
        } else if (mode === 'attachment') {
            startCamBtn.style.display = 'none';
        }
    }

    function unlockEntryMode() {
        startCamBtn.style.display = '';
        startCamBtn.disabled = false;
        startCamBtn.textContent = 'Start Camera';
        attachVideoBtn.style.display = '';
    }

    function setExerciseMode(mode) {
        if (isRecording || sessionStarted) return;
        currentMode = mode;
        resetRepState();

        if (mode === 'pushup') {
            modePushupBtn.classList.add('mode-active');
            modeSitupBtn.classList.remove('mode-active');
            if (handsBadge) handsBadge.style.display = 'none';
            if (stationHeader) stationHeader.innerText = 'Push-up Recording';
            setWarning('Place your camera side-on. Get into push-up position. Your first full rep will start the 1-minute timer.');
        } else {
            modeSitupBtn.classList.add('mode-active');
            modePushupBtn.classList.remove('mode-active');
            if (handsBadge) handsBadge.style.display = 'none';
            if (stationHeader) stationHeader.innerText = 'Sit-up Recording';
            setWarning('Lie back, then sit up. Your first valid rep starts the 1-minute timer.');
        }

        if (stream) {
            armSession();
            uploadBtn.style.display = 'none';
            playbackVideo.style.display = 'none';
            poseCanvas.style.display = 'block';
            isReplayMode = false;
            startPoseLoop();
        }
    }

    async function startCamera() {
        if (stream) return;
        startCamBtn.disabled = true;
        startCamBtn.textContent = 'Starting...';
        try {
            if (!window.Pose) {
                alert('Pose model is still loading. Please try again in a moment.');
                startCamBtn.disabled = false;
                startCamBtn.textContent = 'Start Camera';
                return;
            }

            await initPose();
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 640 },
                    height: { ideal: 360 },
                    frameRate: { ideal: 24, max: 30 },
                    facingMode: 'user'
                },
                audio: false
            });
            sourceVideo.srcObject = stream;
            await sourceVideo.play();

            cameraPlaceholder.style.display = 'none';
            poseCanvas.style.display = 'block';
            playbackVideo.style.display = 'none';
            lockEntryMode('camera');
            startRecBtn.style.display = 'inline-block';
            armSession();
            startPoseLoop();
        } catch (err) {
            alert('Could not access camera or pose model: ' + err.message);
            startCamBtn.disabled = false;
            startCamBtn.textContent = 'Start Camera';
        }
    }

    async function initPose() {
        if (poseInitPromise) return poseInitPromise;

        poseInitPromise = (async () => {
            pose = new Pose({
                locateFile: (file) => `/static/mediapipe/pose/${file}`
            });
            pose.setOptions({
                modelComplexity: 0,
                smoothLandmarks: true,
                enableSegmentation: false,
                minDetectionConfidence: 0.5,
                minTrackingConfidence: 0.5
            });
            pose.onResults(handlePoseResults);
            await pose.initialize();
        })().catch((err) => {
            pose = null;
            poseInitPromise = null;
            throw err;
        });

        return poseInitPromise;
    }

    function startPoseLoop() {
        if (poseLoopRequestId !== null) return;
        detectLoopRunning = true;
        poseLoopRequestId = requestAnimationFrame(runPoseLoop);
    }

    function stopPoseLoop() {
        detectLoopRunning = false;
        if (poseLoopRequestId !== null) {
            cancelAnimationFrame(poseLoopRequestId);
            poseLoopRequestId = null;
        }
        poseInFlight = false;
    }

    async function runPoseLoop(timestamp = performance.now()) {
        if (!detectLoopRunning || !pose) {
            poseLoopRequestId = null;
            return;
        }

        const imageSource = isReplayMode ? playbackVideo : sourceVideo;
        const replayIsPaused = isReplayMode && playbackVideo.paused;

        if (imageSource.readyState >= 2 &&
            !poseInFlight &&
            !replayIsPaused &&
            timestamp - lastPoseSentAt >= POSE_MIN_FRAME_MS) {
            poseInFlight = true;
            lastPoseSentAt = timestamp;
            try {
                await pose.send({ image: imageSource });
            } catch (err) {
                console.warn('Pose frame skipped:', err);
            } finally {
                poseInFlight = false;
            }
        }

        poseLoopRequestId = requestAnimationFrame(runPoseLoop);
    }

    function handlePoseResults(results) {
        ctx.save();
        ctx.clearRect(0, 0, poseCanvas.width, poseCanvas.height);
        ctx.drawImage(results.image, 0, 0, poseCanvas.width, poseCanvas.height);

        if (!results.poseLandmarks) {
            if (!isReplayMode) {
                if (currentMode === 'pushup' && window.FitLahPushupExercise) {
                    FitLahPushupExercise.reset();
                } else if (currentMode === 'situp' && window.FitLahSitupExercise) {
                    FitLahSitupExercise.reset();
                }
                setWarning('No body detected. Keep your full side profile inside the frame.');
            }
            ctx.restore();
            return;
        }

        const landmarks = results.poseLandmarks;
        const helpers = exerciseHelpers();
        lastLandmarks = landmarks;
        drawBodySkeleton(landmarks);
        if (currentMode === 'situp') {
            FitLahSitupExercise.drawHandsOnEarsGuide(landmarks, {
                ctx,
                width: poseCanvas.width,
                height: poseCanvas.height,
                helpers
            });
        }

        const replayFrameAdvanced = !isReplayMode ||
            (analyzeReplayMode && !playbackVideo.paused && playbackVideo.currentTime !== lastAnalyzedVideoTime);

        if (replayFrameAdvanced) {
            if (isReplayMode) {
                lastAnalyzedVideoTime = playbackVideo.currentTime;
            }
            if (currentMode === 'pushup') {
                FitLahPushupExercise.analyze(landmarks, helpers);
            } else {
                FitLahSitupExercise.analyze(landmarks, helpers);
            }
        }

        ctx.restore();
    }

    function drawBodySkeleton(landmarks) {
        FitLahPoseDrawing.drawBodySkeleton(ctx, poseCanvas, landmarks);
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

    function updatePositionLock(inPosition) {
        if (inPosition) {
            positionLockFrames++;
        } else {
            positionLockFrames = 0;
        }
        positionReady = positionLockFrames >= 5;
    }

    function exerciseHelpers() {
        if (cachedExerciseHelpers) return cachedExerciseHelpers;

        cachedExerciseHelpers = {
            angle,
            bestSide,
            countValidRep,
            distance,
            get isRecording() {
                return isRecording;
            },
            get isReplayMode() {
                return isReplayMode;
            },
            get frameWidth() {
                return poseCanvas.width || sourceVideo.videoWidth || playbackVideo.videoWidth || 640;
            },
            get frameHeight() {
                return poseCanvas.height || sourceVideo.videoHeight || playbackVideo.videoHeight || 360;
            },
            markInvalid,
            get metrics() {
                return cvMetrics;
            },
            noteFormFlag,
            requestStopRecording,
            sessionElapsedSeconds,
            get validReps() {
                return validReps;
            },
            get sessionStarted() {
                return sessionStarted;
            },
            setWarning,
            get stage() {
                return stage;
            },
            updatePositionLock,
            visibleLoose,
            resetPositionLock() {
                positionLockFrames = 0;
                positionReady = false;
            },
            setPositionReady(value) {
                positionReady = value;
            },
            setStage(value) {
                stage = value;
            }
        };
        return cachedExerciseHelpers;
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

        lastRepAt = Date.now();

        if (!sessionStarted) {
            beginSessionRecording();
        }

        validReps++;
        stage = nextStage;
        
        // Play rep counting sound
        if (window.SoundManager) {
            SoundManager.playRepSound(validReps);
        }
        
        updateCounters();
    }

    function markInvalid(message) {
        setWarning(message);
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

    function setWarning(text) {
        if (!text) return;

        const now = performance.now();
        if (text === lastWarningText && now - lastWarningSpokenAt < WARNING_VOICE_COOLDOWN_MS) return;
        if (lastWarningSpokenAt && now - lastWarningSpokenAt < WARNING_VOICE_COOLDOWN_MS) {
            lastWarningText = text;
            return;
        }

        lastWarningText = text;
        lastWarningSpokenAt = now;
        if (window.SoundManager && typeof SoundManager.speakWarning === 'function') {
            SoundManager.speakWarning(text);
        }
    }

    function requestStopRecording(message) {
        if (message) setWarning(message);
        if (!isRecording && !sessionStarted) return false;
        if (attachedVideoFile && analyzeReplayMode && Number.isFinite(playbackVideo.duration)) {
            playbackVideo.currentTime = Math.max(0, playbackVideo.duration - 0.1);
            playbackVideo.play().catch(() => {});
            return true;
        }
        setTimeout(() => stopRecording(), 0);
        return true;
    }

    function initCvMetrics() {
        cvMetrics = webcamMetrics.createMetrics(currentMode);
    }

    function metadataOnlyUploads() {
        return window.FitLahRuntime?.metadataOnlyUploads !== false;
    }

    function noteFormFlag(flag) {
        if (!cvMetrics || !isRecording) return;
        if (!cvMetrics.form_flags.includes(flag)) {
            cvMetrics.form_flags.push(flag);
        }
    }

    function sessionElapsedSeconds() {
        if (attachedVideoFile && isReplayMode) {
            return Math.max(0, Number(playbackVideo.currentTime || 0));
        }
        if (!sessionStartedAt) return 0;
        return Math.max(0, (Date.now() - Date.parse(sessionStartedAt)) / 1000);
    }

    function finalizeSessionMetrics() {
        const duration = Math.max(1, sessionDurationSeconds());
        const m = cvMetrics || {};
        const payload = {
            exercise: currentMode,
            valid_reps: validReps,
            duration_seconds: duration,
            reps_per_minute: Math.round((validReps / duration) * 60),
            frames_analyzed: m.frames_sampled || 0,
            form_flags: m.form_flags ? m.form_flags.slice() : []
        };
        if (currentMode === 'pushup') {
            FitLahPushupExercise.enrichMetrics(payload, m, webcamMetrics.avgAngle);
        } else {
            FitLahSitupExercise.enrichMetrics(payload, m, webcamMetrics.avgAngle);
        }
        payload.rep_metrics_csv = webcamMetrics.repMetricsCsv(payload.rep_metrics || m.rep_metrics || []);
        payload.movement_analysis = webcamMetrics.buildMovementAnalysis(m, duration, currentMode);
        return payload;
    }

    function updateCounters() {
        const nextStage = stage || 'Ready';
        const signature = `${validReps}|${nextStage}`;
        if (signature === lastCounterSignature) return;
        lastCounterSignature = signature;
        if (repCounter) repCounter.textContent = String(validReps);
    }

    function resetRepState() {
        validReps = 0;
        stage = null;
        lastRepAt = 0;
        lastCounterSignature = '';
        positionLockFrames = 0;
        positionReady = false;
        sessionStarted = false;
        sessionStartedAt = null;
        isRecording = false;
        isReplayMode = false;
        analyzeReplayMode = false;
        attachedVideoFile = null;
        videoBlob = null;
        recordedChunks = [];
        if (videoObjectUrl) {
            URL.revokeObjectURL(videoObjectUrl);
            videoObjectUrl = null;
        }
        lastAnalyzedVideoTime = -1;
        lastSessionMetrics = null;
        lastSessionId = null;
        uploadBtn.innerText = 'Save Session';
        uploadBtn.style.pointerEvents = 'auto';
        cvMetrics = null;
        if (window.FitLahPushupExercise) {
            FitLahPushupExercise.reset();
        }
        if (window.FitLahSitupExercise) {
            FitLahSitupExercise.reset();
        }
        updateCounters();
    }

    function sessionDurationSeconds() {
        if (attachedVideoFile && Number.isFinite(playbackVideo.duration)) {
            return Math.round(playbackVideo.duration || playbackVideo.currentTime || 1);
        }
        return 60 - timeLeft;
    }

    function armSession() {
        if (isRecording || sessionStarted) return;
        sessionArmed = true;
        positionLockFrames = 0;
        positionReady = false;
        stage = null;
        lastCounterSignature = '';
        validReps = 0;
        if (window.FitLahPushupExercise) {
            FitLahPushupExercise.reset();
        }
        if (window.FitLahSitupExercise) {
            FitLahSitupExercise.reset();
        }
        updateCounters();
        startRecBtn.style.display = 'inline-block';
        startRecBtn.textContent = 'Stop Session';
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
        
        // Play session start sound
        if (window.SoundManager) {
            SoundManager.playSessionStartSound();
        }
        
        if (!metadataOnlyUploads()) {
            const canvasStream = poseCanvas.captureStream(POSE_TARGET_FPS);
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

                if (window.SoundManager) {
                    SoundManager.playSessionEndSound();
                }

                startPlaybackReplay({ analyze: false });
            };
        } else {
            mediaRecorder = null;
        }

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
            if (timeLeft <= 3 && timeLeft > 0) {
                if (window.SoundManager) {
                    SoundManager.playCountdownWarning(timeLeft);
                }
            }
            if (timeLeft <= 0) stopRecording();
        }, 1000);
        if (mediaRecorder) {
            mediaRecorder.start(250);
        }
        setWarning('Recording started. 1 minute on the clock!');
    }

    function startPlaybackReplay(options = {}) {
        isReplayMode = true;
        analyzeReplayMode = Boolean(options.analyze);
        playbackVideo.style.display = 'none';
        poseCanvas.style.display = 'block';
        playbackVideo.currentTime = 0;
        lastAnalyzedVideoTime = -1;
        const playReplay = () => playbackVideo.play().catch(() => {});
        if (playbackVideo.readyState >= 2) {
            playReplay();
        } else {
            playbackVideo.onloadeddata = playReplay;
        }
        setWarning(analyzeReplayMode
            ? 'Analysing attached video.'
            : 'Playback complete. Save the session when ready.');

        playbackVideo.onended = () => {
            const wasAnalyzingAttachment = analyzeReplayMode;
            analyzeReplayMode = false;
            playbackVideo.style.display = 'none';
            poseCanvas.style.display = 'block';
            uploadBtn.style.display = 'inline-block';
            startRecBtn.style.display = 'inline-block';
            startRecBtn.style.display = stream ? 'inline-block' : 'none';
            isRecording = false;
            sessionStarted = false;
            sessionArmed = false;
            if (wasAnalyzingAttachment) {
                lastSessionMetrics = finalizeSessionMetrics();
                setWarning('Attached video analysis complete. Save the session.');
            } else {
                setWarning('Playback complete');
            }
        };
        startPoseLoop();
    }

    function selectRecordedVideo() {
        if (isRecording) {
            alert('Stop the current session before attaching a video.');
            return;
        }
        lockEntryMode('attachment');
        videoAttachmentInput.click();
    }

    async function loadRecordedVideo(file) {
        if (!file) return;
        if (!window.Pose) {
            alert('Pose model is still loading. Please try again in a moment.');
            return;
        }

        await initPose();
        clearCurrentRecordingUi('Loading attached video...');
        attachedVideoFile = file;
        videoBlob = file;
        sessionStartedAt = new Date().toISOString();
        sessionStarted = true;
        sessionArmed = false;
        isRecording = true;
        isReplayMode = true;
        analyzeReplayMode = true;
        initCvMetrics();

        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }

        if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
        videoObjectUrl = URL.createObjectURL(file);
        playbackVideo.src = videoObjectUrl;
        playbackVideo.muted = true;
        playbackVideo.controls = false;
        sourceVideo.style.display = 'none';
        cameraPlaceholder.style.display = 'none';
        poseCanvas.style.display = 'block';
        lockEntryMode('attachment');
        startRecBtn.style.display = 'none';
        stopRecBtn.style.display = 'inline-block';
        uploadBtn.style.display = 'none';
        timerDisplay.style.display = 'none';
        aiCoach.reset();
        updateCounters();

        playbackVideo.onloadedmetadata = () => {
            startPlaybackReplay({ analyze: true });
        };
        if (playbackVideo.readyState >= 1) {
            startPlaybackReplay({ analyze: true });
        }
    }

    function stopRecording() {
        clearInterval(timerInterval);
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            mediaRecorder.stop();
        } else if (sessionStarted) {
            if (discardRecordingOnStop) {
                discardRecordingOnStop = false;
                videoBlob = null;
                lastSessionMetrics = null;
                isRecording = false;
                sessionStarted = false;
                sessionArmed = false;
                return;
            }
            if (!videoBlob) {
                videoBlob = new Blob([], { type: 'application/octet-stream' });
            }
            lastSessionMetrics = finalizeSessionMetrics();
            uploadBtn.style.display = 'inline-block';
            startRecBtn.style.display = 'none';
            stopRecBtn.style.display = 'none';
            timerDisplay.style.display = 'none';
            isRecording = false;
            sessionStarted = false;
            sessionArmed = false;
            if (window.SoundManager) {
                SoundManager.playSessionEndSound();
            }
            setWarning('Session complete. Save the session when ready.');
        }
    }

    function clearCurrentRecordingUi(message) {
        clearInterval(timerInterval);
        isRecording = false;
        sessionStarted = false;
        sessionArmed = false;
        isReplayMode = false;
        attachedVideoFile = null;
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
        startRecBtn.textContent = 'Stop Session';
        timerDisplay.style.display = 'none';
        resetRepState();
        if (stream) {
            sessionArmed = true;
            startPoseLoop();
        } else {
            stopPoseLoop();
            unlockEntryMode();
            cameraPlaceholder.style.display = 'block';
        }
        aiCoach.reset();
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
        if (!stream && !videoBlob && !attachedVideoFile) return;

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
        if (metadataOnlyUploads()) {
            formData.append('metadata_only', 'true');
            formData.append('video_name', attachedVideoFile?.name || 'recording.webm');
            formData.append('video_type', videoBlob.type || attachedVideoFile?.type || '');
            formData.append('video_size', String(videoBlob.size || attachedVideoFile?.size || 0));
        } else {
            formData.append('video', videoBlob, attachedVideoFile?.name || 'recording.webm');
        }
        formData.append('exercise', currentMode);
        formData.append('valid_reps', validReps);
        formData.append('duration_seconds', lastSessionMetrics?.duration_seconds || sessionDurationSeconds());
        if (lastSessionMetrics?.movement_analysis) {
            formData.append('movement_analysis', JSON.stringify(lastSessionMetrics.movement_analysis));
        }
        if (sessionStartedAt) {
            formData.append('started_at', sessionStartedAt);
            formData.append('ended_at', new Date().toISOString());
        }

        try {
            const result = await webcamUploader.uploadVideoForm(formData);
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
                    savedSessionIds.push({
                        id: result.session_id,
                        exercise: currentMode,
                        analysisId: result.analysis_id || null
                    });
                }
                const metricsForAi = lastSessionMetrics
                    ? {
                        ...lastSessionMetrics,
                        valid_reps: result.valid_reps,
                        session_id: result.session_id
                    }
                    : null;
                if (metricsForAi) {
                    aiCoach.enqueue(metricsForAi, true, result.session_id);
                }
                const label = currentMode === 'pushup' ? 'Push-up' : 'Sit-up';
                setWarning(`${label} saved. ${result.valid_reps} reps logged. Record another exercise or tap Done.`);
                resetRepState();
                if (stream) {
                    armSession();
                    startPoseLoop();
                } else {
                    cameraPlaceholder.style.display = 'block';
                    cameraPlaceholder.textContent = 'Attach another video or return when done';
                    poseCanvas.style.display = 'none';
                    startRecBtn.style.display = 'none';
                    stopRecBtn.style.display = 'none';
                    uploadBtn.style.display = 'none';
                    stopPoseLoop();
                }
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

    async function saveAndReturn() {
        if (!pushupUploaded && !situpUploaded) {
            alert('Please complete and upload at least one exercise session first.');
            return;
        }
        completeBtn.textContent = 'Opening analysis...';
        completeBtn.style.pointerEvents = 'none';
        if (aiCoach.isLoading()) {
            completeBtn.textContent = 'Waiting for AI...';
        }
        try {
            await aiCoach.wait();
        } catch (err) {
            console.error('AI recommendation did not finish before navigation', err);
        }
        const failedAiSession = savedSessionIds.find(item => {
            const result = aiCoach.resultFor(item.id);
            return !result || !result.success || result.saved_to_database !== true;
        });
        if (failedAiSession) {
            const result = aiCoach.resultFor(failedAiSession.id);
            completeBtn.textContent = 'Done';
            completeBtn.style.pointerEvents = 'auto';
            alert(result?.error || 'AI recommendation was not saved. Please try Save Session again.');
            return;
        }
        stopPoseLoop();
        if (stream) stream.getTracks().forEach(t => t.stop());
        const ids = savedSessionIds.map(item => item.id).join(',');
        const analysisIds = savedSessionIds.map(item => item.analysisId).filter(Boolean).join(',');
        const params = new URLSearchParams();
        if (ids) params.set('session_ids', ids);
        if (analysisIds) params.set('analysis_ids', analysisIds);
        const query = params.toString();
        window.location.href = query ? `/training-insights?${query}` : "/training-insights";
    }

    videoAttachmentInput.addEventListener('change', (event) => {
        const file = event.target.files && event.target.files[0];
        loadRecordedVideo(file);
        event.target.value = '';
    });

    window.addEventListener('DOMContentLoaded', () => {
        aiCoach.reset();
        setExerciseMode('pushup');
    });

    window.selectRecordedVideo = selectRecordedVideo;
    window.startRecording = startRecording;
