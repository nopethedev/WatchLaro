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
 *
 * UI skin: Netflix-style dark player. A real <video> element with NO native
 * controls is driven by the custom bottom bar (play/pause, -10s/+10s, volume,
 * blue scrubber, time-remaining, fullscreen). The backend contract above is
 * unchanged: same params, same endpoints, same postMessage API, same
 * download-then-poll-then-play flow.
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
    var IDLE_HIDE_MS = 3000;
    var SEEK_MAX = 1000;

    var GLYPH_PLAY = '\u25B6';          // ▶
    var GLYPH_PAUSE = '\u275A\u275A';   // ❚❚

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
        toast: document.getElementById('wl-toast'),
        back: document.getElementById('wl-back'),
        controls: document.getElementById('wl-controls'),
        seek: document.getElementById('wl-seek'),
        play: document.getElementById('wl-play'),
        back10: document.getElementById('wl-back10'),
        fwd10: document.getElementById('wl-fwd10'),
        mute: document.getElementById('wl-mute'),
        volume: document.getElementById('wl-volume'),
        ctitle: document.getElementById('wl-ctitle'),
        remaining: document.getElementById('wl-remaining'),
        next: document.getElementById('wl-next'),
        eps: document.getElementById('wl-eps'),
        subs: document.getElementById('wl-subs'),
        full: document.getElementById('wl-full')
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
    var idleTimer = null;
    var isScrubbing = false;
    var subtitleTracks = [];   // [{ name, lang }] from info.subtitles, attached at ready
    var subtitleIndex = -1;    // -1 = off, else index into subtitleTracks

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

    function subsUrl(id, season, episode, lang) {
        var url = API_BASE + '/stream/subs/' + buildPath(id, season, episode);
        if (lang) url += '?lang=' + encode(lang);
        return url;
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

    function pad2(n) {
        return (n < 10 ? '0' : '') + n;
    }

    /** 65 -> "1:05", 3665 -> "1:00:65"-style "1:01:05". Non-finite -> "--:--". */
    function formatClock(seconds) {
        var s = Math.floor(Number(seconds));
        if (!isFinite(s) || s < 0) return '--:--';
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        var rest = s % 60;
        return h > 0 ? h + ':' + pad2(m) + ':' + pad2(rest) : m + ':' + pad2(rest);
    }

    /** seconds -> "45 sec" | "3 min" | "2 h 14 min". Non-finite/negative -> ''. */
    function formatETA(seconds) {
        var s = Math.floor(Number(seconds));
        if (!isFinite(s) || s < 0) return '';
        if (s < 60) return s + ' sec';
        var h = Math.floor(s / 3600);
        var m = Math.floor((s % 3600) / 60);
        return h > 0 ? h + ' h ' + m + ' min' : m + ' min';
    }

    /** Remaining download seconds from a parseState info, or null when unknown. */
    function estimateSeconds(info) {
        var speed = Number(info.speed);
        var size = Number(info.size);
        var got = Number(info.downloaded);
        if (!isFinite(speed) || speed <= 0) return null;
        if (!isFinite(size) || size <= 0) return null;
        if (!isFinite(got) || got < 0) got = 0;
        if (got >= size) return 0;
        return (size - got) / speed;
    }

    function isEmbedded() {
        return readFlag('embed') === '1';
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
            size: data.size || data.total || null,
            subtitles: Array.isArray(data.subtitles)
                ? data.subtitles.filter(function (s) { return s && (s.name || s.lang); }).map(function (s) {
                    return { name: String(s.name || ''), lang: String(s.lang || 'unknown') };
                })
                : []
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

        // CSS draws the blue spinner; on error it becomes a static "!" marker.
        el.icon.textContent = opts.error ? '!' : '';
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
        showBars();
    }

    function hideOverlay() {
        setHidden(el.overlay, true);
        el.overlay.classList.remove('is-error');
        pokeBars();
    }

    /* ------------------------------------------------------------------ *
     * custom controls (video has no native controls)
     * ------------------------------------------------------------------ */

    function showBars() {
        if (!el.player) return;
        el.player.classList.remove('is-idle');
    }

    function pokeBars() {
        // Visible while paused, preparing, errored, or embedded; auto-hide
        // only when actually playing underneath.
        showBars();
        clearTimeout(idleTimer);
        idleTimer = null;
        if (isEmbedded()) return;
        var overlayOpen = el.overlay && !el.overlay.hidden;
        if (state === 'ready' && !overlayOpen && el.video && !el.video.paused && !el.video.ended) {
            idleTimer = setTimeout(function () {
                var stillPlaying = state === 'ready' && el.video && !el.video.paused && !el.video.ended;
                var overlayStillOpen = el.overlay && !el.overlay.hidden;
                if (stillPlaying && !overlayStillOpen && !isEmbedded()) {
                    el.player.classList.add('is-idle');
                }
            }, IDLE_HIDE_MS);
        }
    }

    function updatePlayIcon() {
        if (!el.play || !el.video) return;
        var paused = el.video.paused || el.video.ended;
        el.play.textContent = paused ? GLYPH_PLAY : GLYPH_PAUSE;
        el.play.setAttribute('aria-label', paused ? 'Play' : 'Pause');
    }

    function updateSeekUI() {
        if (!el.video) return;
        var duration = el.video.duration;
        var current = el.video.currentTime || 0;
        var ratio = (isFinite(duration) && duration > 0)
            ? Math.max(0, Math.min(1, current / duration))
            : 0;
        if (el.seek) {
            if (!isScrubbing) el.seek.value = String(Math.round(ratio * SEEK_MAX));
            el.seek.style.setProperty('--fill', (ratio * 100).toFixed(2) + '%');
        }
        if (el.remaining) {
            el.remaining.textContent = (isFinite(duration) && duration > 0)
                ? '-' + formatClock(duration - current)
                : '--:--';
        }
    }

    function updateVolumeUI() {
        if (!el.video) return;
        var level = el.video.muted ? 0 : (Number(el.video.volume) || 0);
        if (el.volume) {
            el.volume.value = String(Math.round(level * 100));
            el.volume.style.setProperty('--fill', Math.round(level * 100) + '%');
        }
        if (el.mute) el.mute.classList.toggle('is-muted', !!el.video.muted);
    }

    /* ---------------- subtitles ---------------- */

    var SUBTITLE_LABELS = {
        en: 'English', es: 'Spanish', fr: 'French', de: 'German',
        it: 'Italian', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish',
        ru: 'Russian', ar: 'Arabic', tr: 'Turkish', hi: 'Hindi',
        ja: 'Japanese', ko: 'Korean', zh: 'Chinese'
    };

    function subtitleLabel(track, index) {
        var lang = String(track.lang || '').toLowerCase();
        if (SUBTITLE_LABELS[lang]) return SUBTITLE_LABELS[lang];
        if (track.name) return String(track.name);
        return 'Subtitle ' + (index + 1);
    }

    /**
     * ?lang= value that resolves back to exactly this file. A known lang
     * code works when no other track shares it; otherwise the file name is
     * used, which the endpoint matches against the sidecar list.
     */
    function subtitleQuery(track) {
        var lang = String(track.lang || '').toLowerCase();
        var shared = subtitleTracks.filter(function (t) {
            return String(t.lang || '').toLowerCase() === lang;
        }).length;
        if (lang && lang !== 'unknown' && shared === 1) return lang;
        return track.name || lang || '';
    }

    function setTrackMode(index, mode) {
        try {
            var tracks = el.video ? el.video.textTracks : null;
            if (tracks && index >= 0 && index < tracks.length) tracks[index].mode = mode;
        } catch (e) { /* textTracks unavailable, the toast still tells the story */ }
    }

    /** Rebuild the <track> list from info.subtitles. Starts with all tracks off. */
    function attachSubtitles(list) {
        subtitleTracks = Array.isArray(list) ? list.slice(0) : [];
        subtitleIndex = -1;
        if (!el.video) return;
        var old = el.video.querySelectorAll('track');
        for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i]);
        subtitleTracks.forEach(function (track, index) {
            var node = document.createElement('track');
            node.kind = 'subtitles';
            node.label = subtitleLabel(track, index);
            node.srclang = String(track.lang || '');
            node.src = subsUrl(params.id, params.season, params.episode, subtitleQuery(track));
            el.video.appendChild(node);
            setTrackMode(index, 'disabled');
        });
    }

    /** CC button: off -> track 1 -> track 2 -> ... -> off, with a toast each step. */
    function cycleSubtitles() {
        if (!subtitleTracks.length) {
            showToast('No subtitles available');
            pokeBars();
            return;
        }
        setTrackMode(subtitleIndex, 'disabled');
        if (subtitleIndex < subtitleTracks.length - 1) {
            subtitleIndex += 1;
            setTrackMode(subtitleIndex, 'showing');
            showToast('Subtitles: ' + subtitleLabel(subtitleTracks[subtitleIndex], subtitleIndex));
        } else {
            subtitleIndex = -1;
            showToast('Subtitles off');
        }
        pokeBars();
    }

    function togglePlay() {
        if (!el.video || !params.id) return;
        if (state !== 'ready') return;
        if (!el.video.src) return;
        if (el.video.paused || el.video.ended) {
            var attempt = el.video.play();
            if (attempt && typeof attempt.catch === 'function') {
                attempt.catch(function () { /* browser blocked autoplay, fine */ });
            }
        } else {
            el.video.pause();
        }
    }

    function seekBy(seconds) {
        if (!el.video || state !== 'ready') return;
        var duration = el.video.duration;
        var target = (el.video.currentTime || 0) + seconds;
        if (isFinite(duration) && duration > 0) {
            target = Math.max(0, Math.min(duration, target));
        } else {
            target = Math.max(0, target);
        }
        try { el.video.currentTime = target; } catch (e) { /* not seekable yet */ }
        updateSeekUI();
        pokeBars();
    }

    function toggleMute() {
        if (!el.video) return;
        el.video.muted = !el.video.muted;
        updateVolumeUI();
        pokeBars();
    }

    function toggleFullscreen() {
        try {
            if (document.fullscreenElement) {
                if (document.exitFullscreen) document.exitFullscreen();
            } else if (el.player && el.player.requestFullscreen) {
                el.player.requestFullscreen();
            } else if (el.video && el.video.webkitEnterFullscreen) {
                el.video.webkitEnterFullscreen();
            }
        } catch (e) { /* fullscreen unavailable, fine */ }
        pokeBars();
    }

    function resetControlsUI() {
        if (el.seek) {
            el.seek.value = '0';
            el.seek.style.setProperty('--fill', '0%');
        }
        if (el.remaining) el.remaining.textContent = '--:--';
        updatePlayIcon();
        updateVolumeUI();
        showBars();
    }

    /* ------------------------------------------------------------------ *
     * the flow
     * ------------------------------------------------------------------ */

    function isSeries() {
        return !!(params.season && params.episode);
    }

    /**
     * Edge and Safari decode DDP5.1/EAC3 natively, so series can skip the
     * slow download+transcode path and play directly like movies do.
     * Everything else (Chrome, Firefox, ...) still needs the transcode.
     * Guarded for environments without navigator.userAgent (default: transcode).
     */
    function clientNeedsTranscode() {
        var ua = (typeof navigator !== 'undefined' && navigator.userAgent)
            ? String(navigator.userAgent)
            : '';
        if (!ua) return true;
        // Chromium Edge (desktop "Edg/", Android "EdgA/", iOS "EdgiOS/") + legacy EdgeHTML ("Edge/").
        if (/edg\//i.test(ua) || /edga\//i.test(ua) || /edgios\//i.test(ua) || /edge\//i.test(ua)) return false;
        // iOS webviews are WebKit under the hood (Chrome/Firefox/Edge on iOS).
        if (/crios|fxios|edgios/i.test(ua)) return false;
        // Safari UA contains "Safari"; Chrome's UA does too, so exclude Chrome/Chromium.
        if (/safari/i.test(ua) && !/chrome|chromium/i.test(ua)) return false;
        return true;
    }

    function applyTitle() {
        var text = params.title || '';
        if (text && isSeries()) text += ' \u00b7 S' + params.season + 'E' + params.episode;
        el.badge.textContent = text;
        el.badge.title = text;
        if (el.ctitle) {
            el.ctitle.textContent = text;
            el.ctitle.title = text;
        }
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

    function playVideo(subtitles) {
        state = 'ready';
        hideOverlay();

        if (Array.isArray(subtitles)) attachSubtitles(subtitles);

        if (!el.video.src || el.video.src.indexOf(streamUrl(params.id, params.season, params.episode)) === -1) {
            el.video.src = streamUrl(params.id, params.season, params.episode);
        }
        el.video.load();
        resetControlsUI();

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
                    playVideo(info.subtitles);
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
                if (info.status !== 'transcoding') {
                    var eta = estimateSeconds(info);
                    if (eta !== null) detail.push('~' + formatETA(eta) + ' left');
                }
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

    /* ---------------- heartbeat (auto while playing) ---------------- *
     * The backend deletes an abandoned torrent after its idle timeout, so a
     * playing stream pings every 60s to stay alive. ?heartbeat=1 forces it
     * on, ?heartbeat=0 forces it off.                                      */

    function sendHeartbeat() {
        if (readFlag('heartbeat') === '0') return;
        if (readFlag('heartbeat') !== '1' && (state !== 'ready' || el.video.paused)) return;
        if (!params.id) return;

        fetch(API_BASE + '/stream/heartbeat?id=' + encode(params.id)
            + (params.season ? '&season=' + encode(params.season) : '')
            + (params.episode ? '&episode=' + encode(params.episode) : ''),
        { method: 'POST', headers: { Accept: 'application/json' } })
            .then(function (r) {
                if (r.status === 404 || r.status === 405) stopHeartbeat();
            })
            .catch(function () { /* keep trying, network blips are fine */ });
    }

    function startHeartbeat() {
        stopHeartbeat();
        sendHeartbeat(); // ping immediately, don't wait up to 60s
        heartbeatTimer = setInterval(sendHeartbeat, 60000);
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
        attachSubtitles([]);
        resetControlsUI();

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

        var needsTranscode = clientNeedsTranscode();
        console.info('[WatchLaro] load: ' + (isSeries() ? 'series' : 'movie')
            + ' -> ' + (isSeries() && needsTranscode ? 'download+transcode path' : 'direct play path')
            + ' (UA: ' + ((typeof navigator !== 'undefined' && navigator.userAgent) || 'unknown') + ')');

        if (isSeries() && needsTranscode) {
            // Series go through the download+transcode path first, then play.
            // Edge/Safari skip this: they play DDP5.1/EAC3 natively. The manual
            // Download button stays as the fallback if direct play fails.
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
        attachSubtitles([]);
        state = 'idle';
        setDownloadButton('idle');
        resetControlsUI();
    }

    /* ------------------------------------------------------------------ *
     * wiring
     * ------------------------------------------------------------------ */

    // The custom bar drives the video; native controls stay off.
    el.video.controls = false;
    el.video.removeAttribute('controls');

    el.retry.addEventListener('click', function () { load({}); });
    el.reload.addEventListener('click', function () { load({}); });
    el.download.addEventListener('click', downloadNow);

    if (el.back) el.back.addEventListener('click', function () {
        if (window.history.length > 1) {
            window.history.back();
        } else if (document.referrer) {
            window.location.href = document.referrer;
        } else {
            window.location.href = '/';
        }
    });

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

    /* ---------------- custom-bar wiring ---------------- */

    if (el.play) el.play.addEventListener('click', togglePlay);
    if (el.back10) el.back10.addEventListener('click', function () { seekBy(-10); });
    if (el.fwd10) el.fwd10.addEventListener('click', function () { seekBy(10); });
    if (el.mute) el.mute.addEventListener('click', toggleMute);
    if (el.full) el.full.addEventListener('click', toggleFullscreen);

    // No dedicated backend for these; surface an honest toast instead of a
    // dead button so the bar matches the reference layout.
    if (el.next) el.next.addEventListener('click', function () {
        showToast('Next episode is not available for this title');
        pokeBars();
    });
    if (el.eps) el.eps.addEventListener('click', function () {
        showToast('Episodes list is not available here');
        pokeBars();
    });
    if (el.subs) el.subs.addEventListener('click', cycleSubtitles);

    if (el.seek) {
        el.seek.addEventListener('pointerdown', function () { isScrubbing = true; });
        el.seek.addEventListener('input', function () {
            isScrubbing = true;
            if (!el.video || state !== 'ready') return;
            var duration = el.video.duration;
            if (!isFinite(duration) || duration <= 0) return;
            var target = (Number(el.seek.value) / SEEK_MAX) * duration;
            try { el.video.currentTime = target; } catch (e) { /* not seekable yet */ }
            el.seek.style.setProperty('--fill', (Number(el.seek.value) / 10).toFixed(2) + '%');
            updateSeekUI();
        });
        ['change', 'pointerup'].forEach(function (name) {
            el.seek.addEventListener(name, function () {
                isScrubbing = false;
                updateSeekUI();
                pokeBars();
            });
        });
    }

    if (el.volume) {
        el.volume.addEventListener('input', function () {
            if (!el.video) return;
            var level = Math.max(0, Math.min(100, Number(el.volume.value) || 0)) / 100;
            el.video.volume = level;
            el.video.muted = level === 0 ? true : false;
            updateVolumeUI();
        });
        el.volume.addEventListener('change', pokeBars);
    }

    if (el.video) {
        el.video.addEventListener('click', function () {
            // Click-to-toggle only once playback is up; the loading overlay
            // covers the video before that anyway.
            if (state === 'ready' && el.overlay.hidden) togglePlay();
        });
        el.video.addEventListener('play', function () { updatePlayIcon(); pokeBars(); sendHeartbeat(); });
        el.video.addEventListener('pause', function () { updatePlayIcon(); pokeBars(); });
        el.video.addEventListener('ended', function () { updatePlayIcon(); pokeBars(); });
        el.video.addEventListener('timeupdate', updateSeekUI);
        el.video.addEventListener('loadedmetadata', updateSeekUI);
        el.video.addEventListener('durationchange', updateSeekUI);
        el.video.addEventListener('volumechange', updateVolumeUI);
    }

    // Netflix-style auto-hide: any activity shows the bars, idleness while
    // playing hides them again.
    if (el.player) {
        ['mousemove', 'touchstart', 'touchmove'].forEach(function (name) {
            el.player.addEventListener(name, pokeBars, { passive: true });
        });
        el.player.addEventListener('keydown', pokeBars);
        if (el.controls) {
            el.controls.addEventListener('focusin', showBars);
        }
    }
    document.addEventListener('keydown', function (e) {
        var tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (state !== 'ready') return;
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); togglePlay(); }
        else if (e.key === 'ArrowLeft') { seekBy(-10); }
        else if (e.key === 'ArrowRight') { seekBy(10); }
        else if (e.key === 'ArrowUp') {
            if (!el.video) return;
            e.preventDefault();
            el.video.muted = false;
            el.video.volume = Math.min(1, (Number(el.video.volume) || 0) + 0.1);
            updateVolumeUI();
        }
        else if (e.key === 'ArrowDown') {
            if (!el.video) return;
            e.preventDefault();
            el.video.volume = Math.max(0, (Number(el.video.volume) || 0) - 0.1);
            if (el.video.volume === 0) el.video.muted = true;
            updateVolumeUI();
        }
        else if (e.key === 'm') { toggleMute(); }
        else if (e.key === 'f') { toggleFullscreen(); }
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

    if (isEmbedded()) {
        el.topbar.classList.add('is-embedded');
        if (el.controls) el.controls.classList.add('is-embedded');
    }

    updatePlayIcon();
    updateVolumeUI();
    updateSeekUI();

    load({});
})();
