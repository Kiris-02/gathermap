/**
 * GatherMap API Client
 * Centralized HTTP request utility with timeouts, error handling, and JSON serialization.
 */
window.ApiClient = {
    async request(endpoint, options = {}) {
        const timeoutMs = options.timeoutMs || 12000;
        const controller = new AbortController();
        const externalSignal = options.signal;

        let combinedSignal = controller.signal;
        if (externalSignal) {
            if (externalSignal.aborted) {
                controller.abort();
            } else {
                externalSignal.addEventListener('abort', () => controller.abort());
            }
        }

        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const shareToken = options.shareToken || window._currentShareToken || (window.Alpine && window.Alpine.store ? window.Alpine.store('app')?.shareToken : '');

        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        };
        if (shareToken && !headers['x-share-token']) {
            headers['x-share-token'] = shareToken;
        }

        const config = {
            method: options.method || 'GET',
            headers,
            signal: combinedSignal
        };

        if (options.body && typeof options.body === 'object') {
            config.body = JSON.stringify(options.body);
        }

        try {
            const res = await fetch(endpoint, config);
            clearTimeout(timer);

            let data;
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                data = await res.json();
            } else {
                data = await res.text();
            }

            if (!res.ok) {
                const errorMessage = (data && (data.error || data.message)) 
                    ? (data.error || data.message) 
                    : `Request failed with HTTP ${res.status}`;
                const err = new Error(errorMessage);
                err.status = res.status;
                err.data = data;
                throw err;
            }

            return data;
        } catch (err) {
            clearTimeout(timer);
            if (err.name === 'AbortError') {
                const abortErr = new Error('Yêu cầu hết thời gian chờ (Timeout)');
                abortErr.name = 'TimeoutError';
                throw abortErr;
            }
            throw err;
        }
    },

    get(endpoint, options = {}) {
        return this.request(endpoint, { ...options, method: 'GET' });
    },

    post(endpoint, body, options = {}) {
        return this.request(endpoint, { ...options, method: 'POST', body });
    },

    put(endpoint, body, options = {}) {
        return this.request(endpoint, { ...options, method: 'PUT', body });
    }
};
