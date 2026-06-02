(function () {
    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    function tokensFromMarkdown(value) {
        const text = value == null ? '' : String(value);
        const tokens = [];
        const pattern = /\*\*([^*]+?)\*\*/g;
        let cursor = 0;
        let match;

        function pushWords(segment, bold) {
            String(segment || '').trim().split(/\s+/).filter(Boolean).forEach(word => {
                tokens.push({ text: word, bold });
            });
        }

        while ((match = pattern.exec(text)) !== null) {
            pushWords(text.slice(cursor, match.index), false);
            pushWords(match[1], true);
            cursor = match.index + match[0].length;
        }
        pushWords(text.slice(cursor), false);
        return tokens;
    }

    function boldToHtml(value) {
        const text = value == null ? '' : String(value);
        const pattern = /\*\*([^*]+?)\*\*/g;
        let cursor = 0;
        let html = '';
        let match;

        while ((match = pattern.exec(text)) !== null) {
            html += escapeHtml(text.slice(cursor, match.index));
            html += `<strong>${escapeHtml(match[1].trim())}</strong>`;
            cursor = match.index + match[0].length;
        }
        html += escapeHtml(text.slice(cursor));
        return html;
    }

    function setFormattedText(element, value) {
        if (!element) return;
        element.innerHTML = boldToHtml(value);
    }

    window.FitLahAiTextFormat = {
        boldToHtml,
        escapeHtml,
        setFormattedText,
        tokensFromMarkdown
    };
})();
