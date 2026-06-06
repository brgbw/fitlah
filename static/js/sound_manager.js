(function () {
    // Sound manager for rep counting and feedback
    let audioContext = null;

    function initAudioContext() {
        if (!audioContext) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn('AudioContext not supported:', e);
            }
        }
        return audioContext;
    }

    function playTone(frequency = 800, duration = 100, type = 'sine') {
        const ctx = initAudioContext();
        if (!ctx) return;

        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        oscillator.frequency.value = frequency;
        oscillator.type = type;

        gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration / 1000);

        oscillator.start(ctx.currentTime);
        oscillator.stop(ctx.currentTime + duration / 1000);
    }

    function playRepSound(count) {
        // Two-tone beep for successful rep
        playTone(800, 100);
        setTimeout(() => playTone(1200, 100), 120);

        // Speak the count
        if (count !== undefined && window.speechSynthesis) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(count.toString());
            utterance.rate = 1.3;
            window.speechSynthesis.speak(utterance);
        }
    }

    function playErrorSound() {
        // Lower tone for invalid rep
        playTone(400, 200, 'sine');
    }

    function playCountdownSound() {
        // Quick tick for countdown
        playTone(600, 80);
    }

    function playCountdownWarning(secondsLeft) {
        // Warning tone (sharp beep)
        playTone(900, 150, 'sine');

        // Speak the remaining seconds
        if (secondsLeft !== undefined && window.speechSynthesis) {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(secondsLeft.toString());
            utterance.rate = 1.4;
            window.speechSynthesis.speak(utterance);
        }
    }

    function playSessionStartSound() {
        // Three ascending tones for session start
        playTone(600, 80);
        setTimeout(() => playTone(800, 80), 100);
        setTimeout(() => playTone(1000, 80), 200);
    }

    function playSessionEndSound() {
        // Two descending tones for session end
        playTone(1000, 150);
        setTimeout(() => playTone(600, 150), 160);
    }

    window.SoundManager = {
        playRepSound,
        playErrorSound,
        playCountdownSound,
        playSessionStartSound,
        playSessionEndSound,
        playCountdownWarning,
        playTone
    };
})();
