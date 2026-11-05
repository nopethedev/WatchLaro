/**
 * WatchLaro frontend media bridge.
 *
 * This module keeps the raw torrent stream untouched and builds a
 * browser-playable fragmented MP4 in the page:
 *
 *   MKV/MP4 over HTTP Range
 *     -> MediaBunny demux (no full download)
 *     -> WASM E-AC-3/DDP5 decoder when the browser has none
 *     -> AAC encoder (native WebCodecs or the WASM fallback)
 *     -> fragmented MP4 -> Media Source Extensions
 *
 * HLS and MPEG-TS are deliberately not used. The source is read lazily
 * through the existing /api/stream range endpoint, and the conversion is
 * throttled to a short look-ahead window so playback starts after the first
 * few seconds instead of after the whole episode.
 */

import {
    ALL_FORMATS,
    Input,
    UrlSource,
    Output,
    Mp4OutputFormat,
    StreamTarget,
    Conversion,
    Quality,
    canEncodeAudio,
} from 'mediabunny';

const INITIAL_SECONDS = 6;
const LOOKAHEAD_SECONDS = 90;
const MAX_SOURCE_CACHE = 32 * 1024 * 1024;
const START_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 25_000;

let ac3Registered = false;
let aacRegistered = false;

async function ensureAc3Decoder() {
    if (ac3Registered) return;
    const mod = await import('/vendor/mediabunny-ac3.esm.js');
    mod.registerAc3Decoder();
    ac3Registered = true;
}

async function ensureAacEncoder() {
    if (aacRegistered) return;
    const native = await canEncodeAudio('aac').catch(() => false);
    if (native) return;
    const mod = await import('/vendor/mediabunny-aac-encoder.esm.js');
    mod.registerAacEncoder();
    aacRegistered = true;
}

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
    if (!error) return 'The stream could not be prepared';
    return String(error.message || error);
}

function supportsMse(videoOnly) {
    try {
        if (typeof window === 'undefined' || !window.MediaSource) return false;
        const type = videoOnly
            ? 'video/mp4; codecs="avc1.42E01E"'
            : 'video/mp4; codecs="avc1.42E01E,mp4a.40.2"';
        return window.MediaSource.isTypeSupported(type);
    } catch {
        return false;
    }
}

class Session {
    constructor(options) {
        this.options = options || {};
        this.video = this.options.video;
        this.url = this.options.url;
        this.destroyed = false;
        this.ready = false;
        this.failed = false;
        this.mode = 'pending';
        this.objectUrl = null;
        this.input = null;
        this.output = null;
        this.conversion = null;
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.appendQueue = [];
        this.activeAppend = null;
        this.trimInFlight = false;
        this.duration = null;
        this.startTimer = null;
        this.readyTimer = null;
        this.pumpPromise = null;
        this.outputDone = false;
        this.eventCleanup = [];
    }

    notifyProgress(phase, processed, extra) {
        if (this.destroyed || typeof this.options.onProgress !== 'function') return;
        const duration = this.duration;
        const percent = isFiniteNumber(duration) && duration > 0
            ? Math.max(0, Math.min(100, (processed / duration) * 100))
            : null;
        try {
            this.options.onProgress({
                phase,
                processedTime: processed,
                duration,
                percent,
                ...(extra || {}),
            });
        } catch { /* UI callbacks must never break the media pipeline */ }
    }

    begin() {
        this.startTimer = setTimeout(() => {
            if (!this.ready && !this.destroyed) {
                this.fail(new Error('The stream did not start in time - try another server'));
            }
        }, START_TIMEOUT_MS);

        Promise.resolve()
            .then(() => this.open())
            .catch((error) => this.fail(error));
    }

    async open() {
        if (!this.video) throw new Error('No video element');

        this.notifyProgress('metadata', 0);
        this.input = new Input({
            formats: ALL_FORMATS,
            source: new UrlSource(this.url, {
                maxCacheSize: MAX_SOURCE_CACHE,
                parallelism: 2,
                getRetryDelay: (attempts) => attempts < 3 ? Math.min(2 ** attempts, 8) : null,
                handleUnhandledError: (error) => this.fail(error),
            }),
        });

        if (!(await this.input.canRead())) {
            throw new Error('The server did not return a readable media file');
        }

        const videoTrack = await this.input.getPrimaryVideoTrack();
        const audioTrack = await this.input.getPrimaryAudioTrack();
        if (!videoTrack && !audioTrack) throw new Error('No audio or video track was found');
        if (!videoTrack) throw new Error('This file has no video track');

        const inputMime = await this.input.getMimeType().catch(() => '');
        // MP4/QuickTime can go straight to the element when every codec is
        // native. Matroska containers are remuxed instead: Chrome may claim
        // "maybe" for MKV but then fail on the actual file.
        const containerIsMkv = /matroska/i.test(inputMime);
        const nativePlayable = inputMime && !containerIsMkv && this.video.canPlayType(inputMime) !== '';
        if (nativePlayable) {
            this.startDirect();
            return;
        }

        // Read the approximate duration from container metadata only. Never
        // force a full-file scan here; that would defeat the whole point.
        const metadataDuration = await this.input
            .getDurationFromMetadata()
            .catch(() => null);
        this.duration = isFiniteNumber(metadataDuration) && metadataDuration > 0
            ? metadataDuration
            : null;

        if (!(await videoTrack.canDecode().catch(() => false)) && (await videoTrack.getCodec()) !== 'avc') {
            // We can copy AVC without decoding it. Other codecs have to be
            // decoded/re-encoded and are better handled by the fallback.
            throw new Error('This video codec cannot be prepared live');
        }

        if (!supportsMse(!audioTrack)) {
            throw new Error('This browser cannot play the live fragmented MP4 stream');
        }

        const audioCodec = audioTrack ? await audioTrack.getCodec().catch(() => null) : null;
        if (audioTrack && !(await audioTrack.canDecode().catch(() => false))) {
            if (audioCodec === 'ac3' || audioCodec === 'eac3') {
                await ensureAc3Decoder();
            }
            if (!(await audioTrack.canDecode().catch(() => false))) {
                throw new Error('This browser cannot decode the source audio');
            }
        }

        if (audioTrack && audioCodec !== 'aac') await ensureAacEncoder();

        if (this.destroyed) return;
        await this.startTranscode(videoTrack, audioTrack, audioCodec);
    }

    startDirect() {
        this.mode = 'direct';
        this.notifyProgress('buffering', 0);
        const video = this.video;
        let settled = false;

        const cleanup = () => {
            video.removeEventListener('loadedmetadata', onReady);
            video.removeEventListener('error', onError);
        };
        const onReady = () => {
            if (settled || this.destroyed) return;
            settled = true;
            cleanup();
            this.duration = isFiniteNumber(video.duration) ? video.duration : null;
            this.markReady();
        };
        const onError = () => {
            if (settled || this.destroyed) return;
            settled = true;
            cleanup();
            this.fail(video.error || new Error('The browser could not play the stream'));
        };

        video.addEventListener('loadedmetadata', onReady);
        video.addEventListener('error', onError);
        this.eventCleanup.push(cleanup);
        video.src = this.url;
        video.load();
    }

    async startTranscode(videoTrack, audioTrack, audioCodec) {
        this.mode = 'transcode';
        this.notifyProgress('opening', 0);

        const mediaSource = new MediaSource();
        this.mediaSource = mediaSource;
        this.objectUrl = URL.createObjectURL(mediaSource);
        this.video.src = this.objectUrl;

        await new Promise((resolve, reject) => {
            if (mediaSource.readyState === 'open') return resolve();
            const onOpen = () => { cleanup(); resolve(); };
            const onError = () => { cleanup(); reject(new Error('The browser could not open MediaSource')); };
            const cleanup = () => {
                mediaSource.removeEventListener('sourceopen', onOpen);
                mediaSource.removeEventListener('sourceclose', onError);
            };
            mediaSource.addEventListener('sourceopen', onOpen);
            mediaSource.addEventListener('sourceclose', onError);
        });

        if (this.destroyed) return;
        if (isFiniteNumber(this.duration) && this.duration > 0) {
            try { mediaSource.duration = this.duration; } catch { /* duration can be set later */ }
        }

        const target = new StreamTarget(new WritableStream({
            write: (chunk) => this.writeChunk(chunk.data),
            close: () => { this.outputDone = true; this.flushEndOfStream(); },
            abort: (error) => this.fail(error),
        }));

        this.output = new Output({
            format: new Mp4OutputFormat({
                fastStart: 'fragmented',
                minimumFragmentDuration: 1,
            }),
            target,
        });

        const needsAudioTranscode = !!audioTrack && audioCodec !== 'aac';
        const audioChannels = needsAudioTranscode
            ? Math.min(2, (await audioTrack.getNumberOfChannels().catch(() => 2)) || 2)
            : null;
        const audioOptions = !audioTrack
            ? { discard: true }
            : needsAudioTranscode
                ? {
                    codec: 'aac',
                    numberOfChannels: audioChannels || 2,
                    quality: new Quality({ bitrate: audioChannels === 1 ? 96_000 : 192_000 }),
                }
                // Already AAC: let the muxer copy it instead of re-encoding.
                : { codec: 'aac' };

        this.conversion = await Conversion.init({
            input: this.input,
            output: this.output,
            tracks: 'primary',
            composable: true,
            video: { codec: 'avc' },
            audio: audioOptions,
            showWarnings: false,
        });

        if (!this.conversion.isValid) {
            const reasons = (this.conversion.discardedTracks || [])
                .map((item) => item && item.reason)
                .filter(Boolean);
            throw new Error('The browser cannot transcode this audio' + (reasons.length ? ': ' + reasons.join(', ') : ''));
        }

        // Enabling progress makes Conversion compute a duration. Only do that
        // when the container already exposed one; otherwise it could decide to
        // scan the whole remote file.
        if (isFiniteNumber(this.duration)) {
            this.conversion.onProgress = (progress, processedTime) => {
                this.notifyProgress('transcode', processedTime || 0);
            };
        }

        await this.output.start();
        if (this.destroyed) return;

        // Do not await output.getMimeType() here: it only resolves after the
        // first media data reaches the output, and awaiting it before that is
        // a documented deadlock. The video track is copied as AVC, so its
        // parameter string is the exact codec MSE needs.
        const videoCodec = await videoTrack.getCodecParameterString().catch(() => null);
        const codec = videoCodec && /^avc1\./i.test(videoCodec) ? videoCodec : 'avc1.42E01E';
        let outputMime = 'video/mp4; codecs="' + codec + (audioTrack ? ',mp4a.40.2' : '') + '"';

        try {
            if (!MediaSource.isTypeSupported(outputMime)) {
                const fallbackMime = 'video/mp4; codecs="avc1.42E01E' + (audioTrack ? ',mp4a.40.2' : '') + '"';
                if (!MediaSource.isTypeSupported(fallbackMime)) throw new Error('The browser cannot play the output codec');
                outputMime = fallbackMime;
            }
            this.sourceBuffer = mediaSource.addSourceBuffer(outputMime);
            this.sourceBuffer.addEventListener('updateend', () => this.onUpdateEnd());
            this.sourceBuffer.addEventListener('error', () => this.fail(new Error('The media buffer rejected the stream')));
            this.sourceBuffer.mode = 'segments';
        } catch (error) {
            throw new Error('The browser rejected the live MP4 stream: ' + errorMessage(error));
        }

        this.flushQueue();
        this.readyTimer = setTimeout(() => {
            if (!this.ready && !this.destroyed) {
                this.fail(new Error('Playback did not receive the first few seconds in time'));
            }
        }, READY_TIMEOUT_MS);

        this.pump();
    }

    writeChunk(data) {
        if (this.destroyed) return Promise.reject(new Error('Playback was stopped'));
        if (!this.sourceBuffer) {
            this.appendQueue.push({ data, resolve: null, reject: null });
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            this.appendQueue.push({ data, resolve, reject });
            this.drain();
        });
    }

    drain() {
        if (this.destroyed || !this.sourceBuffer || this.sourceBuffer.updating || this.trimInFlight) return;
        const item = this.appendQueue.shift();
        if (!item) return;
        this.activeAppend = item;
        try {
            this.sourceBuffer.appendBuffer(item.data);
        } catch (error) {
            this.activeAppend = null;
            if (item.reject) item.reject(error);
            this.fail(new Error('The media buffer is full: ' + errorMessage(error)));
        }
    }

    flushQueue() {
        if (this.destroyed) return;
        this.drain();
    }

    onUpdateEnd() {
        if (this.destroyed) return;
        const item = this.activeAppend;
        this.activeAppend = null;
        if (item && item.resolve) item.resolve();

        if (this.trimInFlight) {
            this.trimInFlight = false;
            this.drain();
            this.checkReady();
            this.flushEndOfStream();
            return;
        }

        this.checkReady();
        this.evictOldBuffer();
        this.drain();
        this.flushEndOfStream();
    }

    evictOldBuffer() {
        const sb = this.sourceBuffer;
        const video = this.video;
        if (!sb || !video || sb.updating || this.trimInFlight || !sb.buffered.length) return;
        const current = Number(video.currentTime) || 0;
        if (current < 60) return;
        const start = sb.buffered.start(0);
        if (start >= current - 45) return;
        if (this.appendQueue.length > 3) return;
        try {
            this.trimInFlight = true;
            sb.remove(start, Math.max(start + 1, current - 30));
        } catch {
            this.trimInFlight = false;
        }
    }

    checkReady() {
        if (this.ready || this.destroyed || !this.video) return;
        const buffered = this.video.buffered;
        if (!buffered.length) return;
        const end = buffered.end(buffered.length - 1);
        if (end < Math.min(1.5, this.duration || 1.5)) return;
        this.markReady();
    }

    markReady() {
        if (this.ready || this.destroyed) return;
        this.ready = true;
        clearTimeout(this.startTimer);
        clearTimeout(this.readyTimer);
        this.startTimer = null;
        this.readyTimer = null;
        try {
            if (typeof this.options.onDuration === 'function') this.options.onDuration(this.duration);
        } catch { /* UI callback */ }
        try {
            if (typeof this.options.onReady === 'function') {
                this.options.onReady({ mode: this.mode, duration: this.duration });
            }
        } catch (error) {
            this.fail(error);
        }
    }

    async pump() {
        if (this.pumpPromise) return this.pumpPromise;
        this.pumpPromise = (async () => {
            let lastUntil = INITIAL_SECONDS;
            try {
                await this.conversion.execute({
                    until: isFiniteNumber(this.duration)
                        ? Math.min(this.duration, INITIAL_SECONDS)
                        : INITIAL_SECONDS,
                });

                while (!this.destroyed && this.conversion.state !== 'done' && this.conversion.state !== 'canceled') {
                    const maximum = isFiniteNumber(this.duration) ? this.duration : Infinity;
                    const current = this.video ? (Number(this.video.currentTime) || 0) : 0;
                    // Stay about 90s ahead of the playhead, and never jump more
                    // than one window per execute. This keeps a seek or a paused
                    // player from triggering a whole-episode download.
                    const target = Math.min(
                        maximum,
                        Math.min(current + LOOKAHEAD_SECONDS, lastUntil + LOOKAHEAD_SECONDS),
                    );
                    if (target > lastUntil + 0.15) {
                        lastUntil = target;
                        await this.conversion.execute({ until: target });
                    } else {
                        await sleep(500);
                    }
                }

                if (this.destroyed || this.conversion.state === 'canceled') return;
                await this.output.finalize();
                this.outputDone = true;
                this.flushEndOfStream();
            } catch (error) {
                if (!this.destroyed) this.fail(error);
            }
        })();
        return this.pumpPromise;
    }

    flushEndOfStream() {
        if (this.destroyed || !this.outputDone || !this.sourceBuffer) return;
        if (this.sourceBuffer.updating || this.appendQueue.length || this.trimInFlight) return;
        if (this.mediaSource && this.mediaSource.readyState === 'open') {
            try { this.mediaSource.endOfStream(); } catch { /* already ended */ }
        }
    }

    fail(error) {
        if (this.destroyed || this.failed) return;
        this.failed = true;
        this.notifyProgress('error', 0, { message: errorMessage(error) });
        this.cleanup();
        try {
            if (typeof this.options.onError === 'function') this.options.onError(error);
        } catch { /* UI callback */ }
    }

    destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.cleanup();
    }

    cleanup() {
        clearTimeout(this.startTimer);
        clearTimeout(this.readyTimer);
        this.startTimer = null;
        this.readyTimer = null;

        for (const cleanup of this.eventCleanup.splice(0)) {
            try { cleanup(); } catch { /* already removed */ }
        }

        if (this.conversion) {
            try { this.conversion.cancel(); } catch { /* already finished */ }
        }
        if (this.output) {
            try { this.output.cancel(); } catch { /* already finalized */ }
        }
        if (this.input) {
            try { this.input.dispose(); } catch { /* already disposed */ }
        }

        this.appendQueue.length = 0;
        this.activeAppend = null;
        this.sourceBuffer = null;
        this.conversion = null;
        this.output = null;
        this.input = null;

        const objectUrl = this.objectUrl;
        this.objectUrl = null;
        if (this.video) {
            try {
                if (objectUrl && this.video.src && this.video.src.indexOf(objectUrl) === 0) {
                    this.video.pause();
                    this.video.removeAttribute('src');
                    this.video.load();
                }
            } catch { /* element may be gone */ }
        }
        if (objectUrl) {
            try { URL.revokeObjectURL(objectUrl); } catch { /* already revoked */ }
        }

        this.mediaSource = null;
        this.outputDone = false;
        this.trimInFlight = false;
    }
}

/**
 * Start frontend playback. Returns immediately with a controller; readiness
 * and errors are reported through callbacks so the existing player state
 * machine can stay in charge.
 */
export function start(options) {
    const session = new Session(options);
    session.begin();
    return {
        destroy: () => session.destroy(),
        get mode() { return session.mode; },
    };
}

export default { start };
