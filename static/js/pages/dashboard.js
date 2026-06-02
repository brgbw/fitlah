(function () {
    const dashboardConfig = window.FitLahDashboardConfig || {};

    function triggerWebcamStation() {
        window.location.href = dashboardConfig.exerciseSetupUrl;
    }

    function triggerStravaModal() {
        const connected = Boolean(dashboardConfig.stravaConnected);
        const authorizeUrl = dashboardConfig.stravaAuthorizeUrl;

        if (!connected) {
            window.location.href = authorizeUrl || dashboardConfig.stravaSyncUrl;
            return;
        }

        const preview = document.querySelector('.strava-sync-preview');
        if (!preview) {
            window.location.href = dashboardConfig.stravaSyncUrl;
            return;
        }
        preview.classList.add('visible');
        preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    window.triggerWebcamStation = triggerWebcamStation;
    window.triggerStravaModal = triggerStravaModal;
})();
