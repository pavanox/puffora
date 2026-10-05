// Resolves the backend base URL.
//
// In production this must be an absolute HTTPS URL, supplied at deploy time via
// window.PUFFORA_API_BASE (see DEPLOYMENT.md). With no override it falls back to
// a relative path, which is correct when the API is served from the same origin
// or behind a reverse proxy.
window.PufforaConfig = (function () {
    'use strict';

    function resolveApiBase() {
        var configured = window.PUFFORA_API_BASE;
        if (typeof configured === 'string' && configured.trim()) {
            return configured.trim().replace(/\/+$/, '');
        }

        return '';
    }

    return {
        apiBase: resolveApiBase(),

        // Builds an absolute API URL from a path such as '/api/orders'.
        url: function (path) {
            var base = resolveApiBase();
            if (base) {
                return base + path;
            }
            return path;
        }
    };
})();