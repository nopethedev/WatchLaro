/**
 * WatchLaro embeddable player
 * ---------------------------------------------------------------------------
 * Drop it in an iframe (or open it directly) and drive it with query params
 * (a #hash form works too):
 *
 *   player.html?id=603&season=1&episode=2&title=Prison%20Break
 *   player.html#id=603&season=1&episode=2
 *   player.html?id=27205                       (movie, no season/episode)
 *
 *   id       required, tmdb id
 *   season   optional
 *   episode  optional
 *   title    optional, shown in the top bar
 *   auto     optional, "1" to autoplay once ready
 *   embed    optional, "1" to keep the top bar visible (iframe default)
 *   api      optional, override the API base (default "/api")
 *
 * Endpoints it expects (all built from one helper at the top of the file, so
 * you only ever change the shapes in one place):
 *
 *   GET  {api}/stream/{id}[/{season}/{episode}]          video, range requests
 *   POST {api}/stream/download/{id}[/{season}/{episode}] start the download
 *   GET  {api}/stream/progress?id=&season=&episode=      { status, progress, ... }
 *
 * A parent page can also drive it over postMessage:
 *   { type: 'wl:play', id, season, episode, title }
 *   { type: 'wl:download' }
 *   { type: 'wl:stop' }
 */

(function () {
    'use strict';

    /* ------------------------------------------------------------------ *
     * configuration
     * ------------------------------------------------------------------ */

    var API_BASE = '/api';
    var POLL_INTERVAL_MS = 1500;
    var POLL_MAX_BACKOFF_MS = 6000;
    var MAX_CONSECUTIVE_ERRORS = 8;
    var TOAST_MS = 3500;

    var el = {
        player: document.getElementById('wl-player'),
        video: document.getElementById('wl-video'),
        overlay: document.getElementById('wl-overlay'),
        topbar: document.getElementById('wl-topbar'),
        icon: document.getElementById('wl-popcorn'),
        heading: document.getElementById('wl-heading'),
        sub: document.getElementById('wl-sub'),
        bar: document.getElementById('wl-bar'),
        stage: document.getElementById('wl-stage'),
        pct: document.getElementById('wl-pct'),
        retry: document.getElementById('wl-retry'),
        download: document.getElementById('wl-download'),
        reload: document.getElementById('wl-reload'),
        badge: document.getElementById('wl-badge'),
        toast: document.getElementById('wl-toast')
    };

    var params = { id: null, season: null, episode: null, title: '' };
    var state = 'idle';           // idle | preparing | ready | error
    var pollTimer = null;
    var pollFailures = 0;
    var pollDelay = POLL_INTERVAL_MS;
    var inflight = null;          // AbortController for the poll loop
    var downloading = false;      // true while we know a download job is running
    var heartbeatTimer = null;
    var toastTimer = null;

    /* ------------------------------------------------------------------ *
     * helpers
     * ------------------------------------------------------------------ */

    function parseParams() {
        var found = {};

        function absorb(raw) {
            // Strip the leading "?" from location.search and the "#" from
            // location.hash so both forms parse to the same keys.
            String(raw || '').replace(/^[#?]+/, '').split('&').forEach(function (pair) {
                if (!pair) return;
                var bits = pair.split('=');
                var key = decodeURIComponent(bits[0]).toLowerCase();
                var value = decodeURIComponent(bits.slice(1).join('=').replace(/\+/g, ' '));
                if (key) found[key] = value;
            });
        }

        absorb(location.search);
        absorb(location.hash);

        return found;
    }

    function clean(value) {
        if (value === undefined || value === null) return null;
        var trimmed = String(value).trim();
        if (!trimmed || trimmed === 'null' || trimmed === 'undefined') return null;
        return trimmed;
    }

    function encode(value) {
        return encodeURIComponent(String(value));
    }

    /** id first, then season/episode only when we have them. */
    function buildPath(id, season, episode) {
        var parts = [encode(id)];
        if (season && episode) parts.push(encode(season), encode(episode));
        return parts.join('/');
    }

    function streamUrl(id, season, episode) {
        return API_BASE + '/stream/' + buildPath(id, season, episode);
    }

    function downloadUrl(id, season, episode) {
        return API_BASE + '/stream/download/' + buildPath(id, season, episode);
    }

    function progressUrl(id, season, episode) {
        var qs = ['id=' + encode(id)];
        if (season) qs.push('season=' + encode(season));
        if (episode) qs.push('episode=' + encode(episode));
        return API_BASE + '/stream/progress?' + qs.join('&');
    }

    function showToast(message) {
        if (!el.toast) return;
        el.toast.textContent = message;
        el.toast.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.toast.hidden = true; }, TOAST_MS);
    }

    function setHidden(node, hidden) {
        if (node) node.hidden = hidden;
    }

    function formatBytes(bytes) {
        var n = Number(bytes);
        if (!isFinite(n) || n <= 0) return '';
        var units = ['B', 'KB', 'MB', 'GB', 'TB'];
        var i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return (n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)) + ' ' + units[i];
    }

    /* ------------------------------------------------------------------ *
     * response parsing - tolerant, since the API shape is yours to define
     * ------------------------------------------------------------------ */

    /** Some endpoints wrap the payload: { data }, { job }, { progress: {...} }. */
    function unwrap(payload) {
        var current = payload;
        for (var depth = 0; depth < 4; depth++) {
            if (!current || typeof current !== 'object') return current || {};
            var keys = Object.keys(current);
            var isFlat = keys.some(function (k) {
                return ['status', 'progress', 'percent', 'done', 'ready', 'error'].indexOf(k) !== -1;
            });
            if (isFlat) return current;
            var next = current.data || current.job || current.result || current.progress;
            if (!next || typeof next !== 'object') return current;
            current = next;
        }
        return current || {};
    }

    function parseState(payload) {
        var data = unwrap(payload);
        var status = String(data.status || data.state || '').toLowerCase();
        var done = data.done === true || data.complete === true || data.completed === true;
        var error = clean(data.error || data.message);
        var file = clean(data.file || data.fileName || data.outputFile || data.filename || data.name);

        var ready = done
            || data.ready === true
            || status === 'ready'
            || status === 'done'
            || status === 'complete'
            || status === 'complete-download';

        // status "idle" only means finished once there is actually a file -
        // an unknown job also reports idle with nothing behind it.
        if (!ready && status === 'idle' && file) ready = true;

        var raw = data.progress;
        if (typeof raw !== 'number') raw = data.percent;
        if (typeof raw !== 'number') raw = data.downloadProgress;
        if (typeof raw !== 'number' && status === 'transcoding') raw = data.transcodeProgress;
        var percent = typeof raw === 'number' && isFinite(raw) ? Math.max(0, Math.min(100, raw)) : null;

        return {
            status: status,
            done: done,
            ready: ready,
            failed: status === 'error' || data.error === true || (!!error && !ready),
            error: error,
            file: file,
            percent: percent,
            speed: data.speed || data.downloadSpeed || null,
            downloaded: data.downloaded || null,
            size: data.size || data.total || null
        };
    }

    /* ------------------------------------------------------------------ *
     * overlay
     * ------------------------------------------------------------------ */

    var STAGE_TEXT = {
        downloading: 'Downloading',
        transcoding: 'Transcoding',
        seeking: 'Buffering',
        metadata: 'Reading details',
        idle: 'Waiting for the server'
    };

    function showOverlay(options) {
        var opts = options || {};
        el.overlay.classList.toggle('is-error', !!opts.error);
        setHidden(el.overlay, false);

        el.icon.innerHTML = opts.error ? '&#9888;' : '&#127871;';
        el.heading.textContent = opts.error
            ? 'Something went wrong'
            : (opts.heading || 'Grabbing popcorn\u2026');
        el.sub.textContent = opts.error
            ? (opts.error || 'We could not prepare this title.')
            : (opts.sub || 'We\u2019re preparing your show');

        var percent = typeof opts.percent === 'number' ? opts.percent : null;
        el.stage.textContent = opts.error ? 'Stopped' : (opts.stage || 'Connecting\u2026');
        el.pct.textContent = percent === null ? '' : Math.round(percent) + '%';

        if (percent === null) {
            // Unknown total - sweep instead of drawing a bar we cannot trust
            el.bar.style.width = '';
            el.bar.classList.add('is-indeterminate');
        } else {
            el.bar.classList.remove('is-indeterminate');
            el.bar.style.width = Math.max(2, percent) + '%';
        }

        setHidden(el.retry, !opts.error);
    }

    function hideOverlay() {
        setHidden(el.overlay, true);
        el.overlay.classList.remove('is-error');
    }

    /* ------------------------------------------------------------------ *
     * the flow
     * ------------------------------------------------------------------ */

    function isSeries() {
        return !!(params.season && params.episode);
    }

    function applyTitle() {
        var text = params.title || '';
        if (text && isSeries()) text += ' \u00b7 S' + params.season + 'E' + params.episode;
        el.badge.textContent = text;
        el.badge.title = text;
        document.title = text || 'Player';
    }

    function setDownloadButton(mode) {
        // mode: 'idle' | 'busy' | 'done'
        if (mode === 'busy') {
            el.download.disabled = true;
            el.download.textContent = 'Downloading\u2026';
        } else if (mode === 'done') {
            el.download.disabled = true;
            el.download.textContent = 'Downloaded';
        } else {
            el.download.disabled = false;
            el.download.textContent = 'Download';
        }
    }

    function playVideo() {
        state = 'ready';
        hideOverlay();

        if (!el.video.src || el.video.src.indexOf(streamUrl(params.id, params.season, params.episode)) === -1) {
            el.video.src = streamUrl(params.id, params.season, params.episode);
        }
        el.video.load();

        if (opts_autoplay()) {
            var attempt = el.video.play();
            if (attempt && typeof attempt.catch === 'function') {
                attempt.catch(function () { /* browser blocked autoplay, fine */ });
            }
        }
        startHeartbeat();
    }

    function opts_autoplay() {
        return readFlag('auto') === '1' || readFlag('autoplay') === '1';
    }

    function readFlag(name) {
        var p = parseParams();
        return clean(p[name]) || '';
    }

    function fail(message) {
        state = 'error';
        stopPolling();
        showOverlay({ error: message });
    }

    /* ---------------- polling ---------------- */

    function stopPolling() {
        clearTimeout(pollTimer);
        pollTimer = null;
        pollFailures = 0;
        pollDelay = POLL_INTERVAL_MS;
        if (inflight) {
            try { inflight.abort(); } catch (e) { /* noop */ }
            inflight = null;
        }
        downloading = false;
    }

    function schedulePoll() {
        clearTimeout(pollTimer);
        pollTimer = setTimeout(pollOnce, pollDelay);
    }

    function pollOnce() {
        if (!downloading) return;
        if (window.AbortController) inflight = new AbortController();

        var options = { method: 'GET', headers: { Accept: 'application/json' } };
        if (inflight) options.signal = inflight.signal;

        fetch(progressUrl(params.id, params.season, params.episode), options)
            .then(function (response) {
                if (!response.ok) throw new Error('progress request failed: ' + response.status);
                return response.json();
            })
            .then(function (payload) {
                var info = parseState(payload);
                pollFailures = 0;
                pollDelay = POLL_INTERVAL_MS;

                if (info.failed && info.error) {
                    downloading = false;
                    fail(info.error);
                    return;
                }
                if (info.ready) {
                    downloading = false;
                    setDownloadButton('done');
                    playVideo();
                    return;
                }

                var stage = STAGE_TEXT[info.status] || 'Preparing';
                showOverlay({
                    heading: 'Grabbing popcorn\u2026',
                    sub: 'We\u2019re preparing your show',
                    stage: stage,
                    percent: info.percent
                });

                var detail = [];
                if (info.speed) detail.push(formatBytes(info.speed) + '/s');
                if (info.percent !== null) detail.push(Math.round(info.percent) + '%');
                el.pct.textContent = detail.join(' \u00b7 ');

                schedulePoll();
            })
            .catch(function (err) {
                if (inflight && err && err.name === 'AbortError') return;

                pollFailures += 1;
                if (pollFailures >= MAX_CONSECUTIVE_ERRORS) {
                    // The progress endpoint may not be wired up yet. Play anyway
                    // rather than leaving the user staring at popcorn.
                    downloading = false;
                    showToast('Progress unavailable, starting playback anyway');
                    playVideo();
                    return;
                }
                pollDelay = Math.min(pollDelay * 1.6, POLL_MAX_BACKOFF_MS);
                showOverlay({
                    heading: 'Grabbing popcorn\u2026',
                    sub: 'We\u2019re preparing your show',
                    stage: 'Waiting for the server\u2026',
                    percent: null
                });
                schedulePoll();
            });
    }

    /* ---------------- download ---------------- */

    function startDownload() {
        if (!params.id) return Promise.resolve(false);

        downloading = true;
        setDownloadButton('busy');

        var options = { method: 'POST', headers: { Accept: 'application/json' } };
        if (window.AbortController) options.signal = (inflight = new AbortController()).signal;

        return fetch(downloadUrl(params.id, params.season, params.episode), options)
            .then(function (response) {
                if (response.ok) return true;
                // 405 means the endpoint only answers GET - fall back once.
                if (response.status === 405 || response.status === 404) {
                    return fetch(downloadUrl(params.id, params.season, params.episode), {
                        method: 'GET', headers: { Accept: 'application/json' }
                    }).then(function (r) { return r.ok; });
                }
                return false;
            })
            .catch(function () { return false; })
            .then(function (started) {
                if (!started) {
                    downloading = false;
                    setDownloadButton('idle');
                    return false;
                }
                schedulePoll();
                return true;
            });
    }

    /* ---------------- optional heartbeat ---------------- *
     * The backend deletes an abandoned torrent after its idle timeout, so a
     * long stream wants a ping. Off unless you pass ?heartbeat=1.           */

    function startHeartbeat() {
        if (readFlag('heartbeat') !== '1') return;
        stopHeartbeat();

        heartbeatTimer = setInterval(function () {
            fetch(API_BASE + '/stream/heartbeat?id=' + encode(params.id)
                + (params.season ? '&season=' + encode(params.season) : '')
                + (params.episode ? '&episode=' + encode(params.episode) : ''),
            { method: 'POST', headers: { Accept: 'application/json' } })
                .then(function (r) {
                    if (r.status === 404 || r.status === 405) {
                        stopHeartbeat();
                        showToast('Heartbeat endpoint not available, disabled');
                    }
                })
                .catch(function () { /* keep trying, network blips are fine */ });
        }, 60000);
    }

    function stopHeartbeat() {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    /* ------------------------------------------------------------------ *
     * public control surface
     * ------------------------------------------------------------------ */

    function load(next) {
        var p = parseParams();
        params = {
            id: clean(next.id || p.id),
            season: clean(next.season !== undefined ? next.season : p.season),
            episode: clean(next.episode !== undefined ? next.episode : p.episode),
            title: clean(next.title !== undefined ? next.title : p.title) || ''
        };

        stopPolling();
        stopHeartbeat();
        setDownloadButton('idle');
        el.video.removeAttribute('src');
        el.video.load();

        if (!params.id) {
            showOverlay({ error: 'No id was given. Try player.html?id=12345' });
            state = 'error';
            return;
        }

        applyTitle();

        var apiOverride = clean(next.api || p.api);
        if (apiOverride) API_BASE = apiOverride.replace(/\/$/, '');

        showOverlay({
            heading: 'Grabbing popcorn\u2026',
            sub: 'We\u2019re preparing your show',
            stage: 'Finding your title\u2026',
            percent: null
        });
        state = 'preparing';

        if (isSeries()) {
            // Series go through the download+transcode path first, then play.
            startDownload().then(function (started) {
                if (!started) playVideo();
            });
        } else {
            playVideo();
        }
    }

    function downloadNow() {
        if (!params.id) return;
        setDownloadButton('busy');
        startDownload().then(function (started) {
            if (!started) {
                setDownloadButton('idle');
                showToast('Could not start the download');
            } else {
                showToast('Download started');
            }
        });
    }

    function stop() {
        stopPolling();
        stopHeartbeat();
        el.video.pause();
        el.video.removeAttribute('src');
        el.video.load();
        state = 'idle';
        setDownloadButton('idle');
    }

    /* ------------------------------------------------------------------ *
     * wiring
     * ------------------------------------------------------------------ */

    el.retry.addEventListener('click', function () { load({}); });
    el.reload.addEventListener('click', function () { load({}); });
    el.download.addEventListener('click', downloadNow);

    // Buffering spinner, only while the video itself is waiting on data.
    el.video.addEventListener('waiting', function () {
        if (state !== 'ready' || el.video.readyState >= 3) return;

        var duration = el.video.duration;
        var buffered = el.video.buffered.length
            && isFinite(duration) && duration > 0
            ? (el.video.buffered.end(el.video.buffered.length - 1) / duration) * 100
            : null;

        showOverlay({
            heading: 'Buffering\u2026',
            sub: 'Fetching the next few seconds',
            stage: 'Buffering',
            percent: buffered
        });
    });
    ['playing', 'canplay', 'seeked', 'timeupdate'].forEach(function (name) {
        el.video.addEventListener(name, function () {
            if (state === 'ready' && el.video.readyState >= 3) hideOverlay();
        });
    });

    el.video.addEventListener('error', function () {
        var code = el.video.error ? el.video.error.code : 0;
        if (code === 0) return; // cleared source, not a real failure
        var messages = {
            1: 'Playback was aborted.',
            2: 'A network error interrupted the stream.',
            3: 'Could not decode this file \u2014 try the download button instead.',
            4: 'This file is not supported by your browser.'
        };
        fail(messages[code] || 'The stream could not be played.');
    });

    window.addEventListener('message', function (event) {
        if (event.origin && event.origin !== location.origin) return;
        var data = event.data;
        if (!data || typeof data !== 'object') return;

        if (data.type === 'wl:play') load(data);
        else if (data.type === 'wl:download') downloadNow();
        else if (data.type === 'wl:stop') stop();
    });

    window.addEventListener('beforeunload', function () {
        stopPolling();
        stopHeartbeat();
    });

    // Handy when the player is included as a script rather than an iframe.
    window.WLPlayer = { load: load, download: downloadNow, stop: stop, api: streamUrl };

    if (readFlag('embed') === '1') el.topbar.classList.add('is-embedded');

    load({});
})();