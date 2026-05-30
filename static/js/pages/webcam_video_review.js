(function () {
    function formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '00:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    function createController(options) {
        const video = options.video;
        const seek = options.seek;
        const current = options.current;
        const duration = options.duration;
        const speed = options.speed;
        const timeInput = options.timeInput;

        function refresh() {
            const total = video.duration || 0;
            seek.max = total || 0;
            seek.value = video.currentTime || 0;
            current.textContent = formatTime(video.currentTime || 0);
            duration.textContent = formatTime(total);
        }

        function seekBy(deltaSeconds) {
            if (!Number.isFinite(video.duration)) return;
            video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + deltaSeconds));
            refresh();
        }

        function seekTo(seconds) {
            if (!Number.isFinite(video.duration)) return;
            video.currentTime = Math.max(0, Math.min(video.duration, Number(seconds) || 0));
            refresh();
        }

        function setSpeed(value) {
            video.playbackRate = Number(value) || 1;
            speed.value = String(video.playbackRate);
        }

        function bind() {
            video.addEventListener('loadedmetadata', refresh);
            video.addEventListener('timeupdate', refresh);
            seek.addEventListener('input', () => seekTo(seek.value));
            speed.addEventListener('change', () => setSpeed(speed.value));
            timeInput.addEventListener('change', () => seekTo(timeInput.value));
            refresh();
        }

        bind();

        return {
            formatTime,
            refresh,
            seekBy,
            seekTo,
            setSpeed
        };
    }

    window.FitLahVideoReview = {
        createController,
        formatTime
    };
})();

