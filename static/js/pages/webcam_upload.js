(function () {
    function uploadVideoForm(formData) {
        return new Promise((resolve, reject) => {
            const request = new XMLHttpRequest();
            request.open('POST', '/api/upload-video', true);
            request.responseType = 'text';
            request.timeout = 180000;

            request.onload = () => {
                let result = null;
                try {
                    result = request.responseText ? JSON.parse(request.responseText) : null;
                } catch (err) {
                    reject(new Error(`Upload returned an invalid response (${request.status}).`));
                    return;
                }

                if (request.status >= 200 && request.status < 300 && result) {
                    resolve(result);
                    return;
                }

                const detail = result?.error || `Server returned ${request.status}`;
                reject(new Error(detail));
            };

            request.onerror = () => {
                reject(new Error('Upload connection failed. Check that the app server is still running and try again.'));
            };
            request.ontimeout = () => {
                reject(new Error('Upload timed out. Try again with a shorter recording or a smaller attached video.'));
            };
            request.onabort = () => {
                reject(new Error('Upload was cancelled before it finished.'));
            };

            request.send(formData);
        });
    }

    window.FitLahWebcamUpload = {
        uploadVideoForm
    };
})();
