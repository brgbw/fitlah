(function () {
    const DEFAULT_DELAY_MS = 55;
    const ITEM_PAUSE_MS = 90;

    function wordsFrom(text) {
        return String(text || '').trim().split(/\s+/).filter(Boolean).map(word => ({
            text: word,
            bold: false
        }));
    }

    function tokensFrom(text) {
        if (window.FitLahAiTextFormat) {
            return FitLahAiTextFormat.tokensFromMarkdown(text);
        }
        return wordsFrom(text);
    }

    function appendToken(element, token, needsSpace) {
        if (needsSpace) element.appendChild(document.createTextNode(' '));
        if (token.bold) {
            const strong = document.createElement('strong');
            strong.textContent = token.text;
            element.appendChild(strong);
            return;
        }
        element.appendChild(document.createTextNode(token.text));
    }

    function revealElement(element, options = {}) {
        if (!element || element.dataset.aiRevealDone === 'true') return Promise.resolve();

        const words = tokensFrom(element.dataset.aiRevealText || element.textContent);
        const delayMs = Number(options.delayMs || element.dataset.aiRevealDelay || DEFAULT_DELAY_MS);
        element.dataset.aiRevealDone = 'true';
        element.dataset.aiRevealText = words.map(word => word.text).join(' ');
        element.textContent = '';

        if (!words.length) return Promise.resolve();

        return new Promise(resolve => {
            let index = 0;

            function tick() {
                appendToken(element, words[index], index > 0);
                index += 1;

                if (index >= words.length) {
                    resolve();
                    return;
                }

                window.setTimeout(tick, delayMs);
            }

            tick();
        });
    }

    async function revealWithin(root, options = {}) {
        const scope = root || document;
        const selector = options.selector || '[data-ai-reveal]';
        const elements = Array.from(scope.querySelectorAll(selector))
            .filter(element => element.dataset.aiRevealDone !== 'true');

        for (const element of elements) {
            await revealElement(element, options);
            await new Promise(resolve => window.setTimeout(resolve, Number(options.itemPauseMs || ITEM_PAUSE_MS)));
        }
    }

    window.FitLahAiTextReveal = {
        revealElement,
        revealWithin
    };

    document.addEventListener('DOMContentLoaded', () => {
        revealWithin(document);
    });
})();
