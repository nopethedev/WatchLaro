import WebTorrent from 'webtorrent';
import TorrentSearchApi from 'torrent-search-api';
import nodeCache from 'node-cache';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';

import { pickPreferredVideoFile } from './quality.js';

// Automatically set binary paths for FFmpeg and FFprobe
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

/**
 * TorrentHelper - A lightweight wrapper module for searching, filtering,
 * downloading, and tracking WebTorrent downloads.
 */
export class TorrentHelper {
  constructor(options = {}) {
    this.client = new WebTorrent(options.webtorrent);
    this.activeDownloads = new Map();
    // Pending waitForDone finish callbacks per infoHash, used by requestSkip()
    this._waiters = new Map();
    // Cache search results for 12 hours (432000 seconds) by default
    this.cache = new nodeCache({ stdTTL: options.cacheTtl || 432000, checkperiod: 600 });

    // Enable default public providers if search api is available
    if (options.providers) {
      TorrentSearchApi.enableProviders(...options.providers);
    } else {
      TorrentSearchApi.enablePublicProviders();
    }
  }

  /**
   * Get list of currently active torrent search providers.
   * @returns {Array<Object>} List of active providers.
   */
  getActiveProviders() {
    return TorrentSearchApi.getActiveProviders();
  }

  /**
   * Search torrents using torrent-search-api with automatic result caching.
   * @param {string} query - Search query string.
   * @param {Object} [options] - Search options.
   * @param {string} [options.category='All'] - Search category (e.g., 'All', 'Movies', 'TV').
   * @param {number} [options.limit=20] - Max number of results.
   * @param {boolean} [options.getMagnets=true] - Whether to auto-fetch magnet links if missing.
   * @returns {Promise<Array<Object>>} List of normalized search results with magnet links.
   */
  async search(query, options = {}) {
    const category = options.category || 'All';
    const limit = options.limit || 20;
    const getMagnets = options.getMagnets !== false;

    // Composite cache key including query, category, limit, and getMagnets setting
    const cacheKey = `${query}:${category}:${limit}:${getMagnets}`;
    const cachedResults = this.cache.get(cacheKey);

    if (cachedResults) {
      return cachedResults;
    }

    const rawResults = await TorrentSearchApi.search(query, category, limit);

    const formattedResults = await Promise.all(
      rawResults.map(async (item) => {
        let magnet = item.magnet || item.link;

        // Auto-resolve magnet URI if not present directly in result
        if (getMagnets && (!magnet || !magnet.startsWith('magnet:')) && TorrentSearchApi.isProviderActive(item.provider)) {
          try {
            magnet = await TorrentSearchApi.getMagnet(item);
          } catch (err) {
            // Keep existing magnet/link if retrieval fails
          }
        }

        // If magnet link points to itorrents.net HTTP torrent file, convert infohash if present
        if (magnet && magnet.includes('itorrents.net/torrent/')) {
          const match = magnet.match(/\/torrent\/([A-Fa-f0-9]{40})\.torrent/i);
          if (match && match[1]) {
            magnet = `magnet:?xt=urn:btih:${match[1]}`;
          }
        }

        return {
          title: item.title,
          size: item.size,
          seeds: parseInt(item.seeds, 10) || 0,
          peers: parseInt(item.peers, 10) || 0,
          provider: item.provider,
          magnet: magnet || null,
          time: item.time || null
        };
      })
    );

    this.cache.set(cacheKey, formattedResults);
    return formattedResults;
  }

  /**
   * Filters and sorts search results by seeders, peers, or size.
   * @param {Array<Object>} results - Search results returned by search().
   * @param {Object} [filters] - Filter rules.
   * @param {number} [filters.minSeeders=0] - Minimum seeder count required.
   * @param {string} [filters.sortBy='seeds'] - Attribute to sort by ('seeds', 'peers').
   * @returns {Array<Object>} Filtered and sorted array.
   */
  filterResults(results = [], filters = {}) {
    const { minSeeders = 0, sortBy = 'seeds' } = filters;

    let filtered = results.filter((item) => item.seeds >= minSeeders && item.magnet);

    if (sortBy === 'seeds') {
      filtered.sort((a, b) => b.seeds - a.seeds);
    } else if (sortBy === 'peers') {
      filtered.sort((a, b) => b.peers - a.peers);
    }

    return filtered;
  }

  /**
   * Helper utility to check if a file name matches video extensions.
   * @param {string} filename - File name or path.
   * @returns {boolean} True if the file extension is a video format.
   */
  isVideoFile(filename) {
    return /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|3gp)$/i.test(filename);
  }

  /**
   * Starts downloading a torrent using magnet URI or Torrent file buffer/URL.
   * @param {string|Buffer} torrentId - Magnet URI, torrent file URL, or Buffer.
   * @param {Object} options - Download settings (e.g., path for Node.js, onlyVideo flag).
   * @param {Function} [onProgress] - Optional callback function for real-time progress updates.
   * @returns {Promise<Object>} Resolves with the WebTorrent torrent instance.
   */
  download(torrentId, options = {}, onProgress = null) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let metadataTimer = null;
      const metadataTimeoutMs = Number.isFinite(Number(options.metadataTimeoutMs))
        ? Number(options.metadataTimeoutMs)
        : Number(process.env.TORRENT_METADATA_TIMEOUT_MS) || 90_000;
      const signal = options.signal;

      const onAbort = () => settle(reject, new Error('Download cancelled'));
      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(metadataTimer);
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };

      // Delete can land before WebTorrent has even parsed the magnet.
      if (signal?.aborted) {
        settle(reject, new Error('Download cancelled'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      try {
        // Rename on destructure so the imported `path` module stays usable here
        const { onlyVideo = true, selectVideo, preferQuality, metadataTimeoutMs: _timeout, signal: _signal, path: downloadPath = path.join(process.cwd(), 'downloads'), ...webtorrentOpts } = options;

        const torrent = this.client.add(torrentId, { ...webtorrentOpts, path: downloadPath }, (addedTorrent) => {
          if (settled) return;
          this.activeDownloads.set(addedTorrent.infoHash, addedTorrent);

          // Prevent seeding: choke every peer so we never upload pieces to them,
          // both while downloading and after the torrent completes.
          const chokeWire = (wire) => wire.choke();
          addedTorrent.wires.forEach(chokeWire);
          addedTorrent.on('wire', chokeWire);

          // Select only video files if requested (deselects samples, NFOs, txt, extra junk)
          if (onlyVideo) {
            // Deselect junk first, then select video: a deselect that overlaps
            // a shared piece would otherwise drop the video's selection for it
            const videoFiles = [];
            addedTorrent.files.forEach((file) => {
              if (this.isVideoFile(file.name) && (!selectVideo || selectVideo(file.name))) {
                videoFiles.push(file);
              } else {
                file.deselect();
              }
            });
            addedTorrent.deselect(0, addedTorrent.pieces.length - 1, false);
            const selectedVideo = pickPreferredVideoFile(videoFiles, addedTorrent.name, preferQuality);
            addedTorrent._laroVideoFiles = selectedVideo ? [selectedVideo] : [];
            // A pause requested before metadata arrived stays paused once it does.
            if (!addedTorrent._laroPaused && selectedVideo) selectedVideo.select();
          }

          // Setup progress updates if listener callback provided
          if (typeof onProgress === 'function') {
            const progressHandler = () => {
              onProgress(this.getProgress(addedTorrent.infoHash));
            };

            addedTorrent.on('download', progressHandler);

            // Clean up listener when done
            addedTorrent.on('done', () => {
              addedTorrent.removeListener('download', progressHandler);
              onProgress(this.getProgress(addedTorrent.infoHash));
            });
          }

          settle(resolve, addedTorrent);
        });

        // Track the torrent immediately: pause/skip must work during the
        // metadata handshake, before WebTorrent has a file list (and before a
        // magnet has even parsed its infoHash).
        const requestedHash = typeof torrentId === 'string'
          ? (/btih:([a-z0-9]+)/i.exec(torrentId)?.[1] || '').toLowerCase()
          : '';
        if (requestedHash) this.activeDownloads.set(requestedHash, torrent);
        if (torrent.infoHash) this.activeDownloads.set(torrent.infoHash, torrent);

        torrent.once('error', (err) => settle(reject, err));
        // Removing the torrent during the metadata handshake does not emit an
        // error, so without this the download() promise waited for the timeout.
        torrent.once('close', () => settle(reject, new Error('Download cancelled')));

        // A dead magnet otherwise leaves the serial queue "downloading"
        // forever, with nothing the operator can pause or skip.
        if (!settled) {
          metadataTimer = setTimeout(() => {
            settle(reject, new Error('torrent metadata timed out - no peers found for this magnet'));
          }, metadataTimeoutMs);
          if (typeof metadataTimer.unref === 'function') metadataTimer.unref();
        }
      } catch (err) {
        settle(reject, err);
      }
    });
  }

  /**
   * Sync lookup inside the WebTorrent client by infohash.
   * NOTE: client.get() is async in WebTorrent v3 - it returns a Promise,
   * which is truthy and would pass null-guards, then die at torrent.once
   * ("torrent.once is not a function"). These sync call sites use the
   * client's torrent list directly instead.
   */
  findClientTorrent(infoHash) {
    const wanted = String(infoHash || '').toLowerCase();
    if (!wanted) return null;
    return (this.client.torrents || []).find((t) => t.infoHash === wanted) || null;
  }
  /**
   * Waits for a torrent's video files to finish downloading.
   * Note: WebTorrent's 'done' event only fires when EVERY file is complete,
   * including deselected junk files (samples, NFOs) that will never download.
   * So we resolve once all video files are done instead.
   * @param {string|Object} torrentOrHash - WebTorrent instance or infoHash string.
   * @returns {Promise<Object>} Resolves with the torrent instance when done.
   */
  waitForDone(torrentOrHash, options = {}) {
    const signal = options.signal;
    const torrent = typeof torrentOrHash === 'string'
      ? (this.activeDownloads.get(torrentOrHash) || this.findClientTorrent(torrentOrHash))
      : torrentOrHash;

    if (!torrent) {
      return Promise.reject(new Error('Torrent not found or not currently active.'));
    }

    const cancelled = () => Boolean(torrent._laroCancelled || torrent.destroyed || signal?.aborted);
    if (cancelled()) {
      return Promise.reject(new Error('Download cancelled'));
    }

    if (torrent.done) {
      return Promise.resolve(torrent);
    }

    const videoFiles = torrent._laroVideoFiles || (torrent.files || []).filter((file) => this.isVideoFile(file.name));
    const pending = videoFiles.filter((file) => !file.done);

    // All video files already completed
    if (videoFiles.length > 0 && pending.length === 0) {
      return Promise.resolve(torrent);
    }

    return new Promise((resolve, reject) => {
      let remaining = pending.length;
      let settled = false;

      const cleanup = () => {
        this._waiters.delete(torrent.infoHash);
        signal?.removeEventListener('abort', onAbort);
        torrent.removeListener('done', onTorrentDone);
        torrent.removeListener('error', onError);
        torrent.removeListener('close', onClose);
        pending.forEach((file) => file.removeListener('done', onFileDone));
      };
      const fail = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      const finish = () => {
        if (settled) return;
        if (cancelled()) return fail(new Error('Download cancelled'));
        settled = true;
        cleanup();
        resolve(torrent);
      };
      const onTorrentDone = () => finish();
      const onError = (err) => fail(err);
      const onClose = () => fail(new Error('Download cancelled'));
      const onAbort = () => fail(new Error('Download cancelled'));
      const onFileDone = () => {
        remaining -= 1;
        if (remaining <= 0) finish();
      };

      this._waiters.set(torrent.infoHash, finish);
      torrent.once('done', onTorrentDone);
      torrent.once('error', onError);
      torrent.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.forEach((file) => file.once('done', onFileDone));

      // The torrent may have been destroyed between the first check and the
      // listeners above. Its 'close' event is already gone, so settle now.
      if (cancelled()) fail(new Error('Download cancelled'));
    });
  }

  /**
   * Skips waiting for a torrent to finish downloading. The pending
   * downloadAndConvert job continues straight to conversion using the data
   * downloaded so far (useful when a download is stuck just below 100%).
   * @param {string} infoHash - Infohash of the torrent to skip.
   * @returns {boolean} True if a pending job was told to skip.
   */
  requestSkip(infoHash) {
    const torrent = this.findClientTorrent(infoHash) || this.activeDownloads.get(String(infoHash || '').toLowerCase());
    if (!torrent) return false;

    // Skipping before metadata arrives is allowed: the download wait is
    // skipped as soon as the file list is known. It is still a valid job,
    // unlike a magnet the server never started.
    torrent._laroSkipRequested = true;
    const finish = this._waiters.get(torrent.infoHash);
    if (finish) finish();
    return true;
  }

  /**
   * All-in-one function: Pass a magnet URI or torrent link. Downloads video files only,
   * waits for completion, locates the main video file, and optionally converts it.
   * @param {string|Buffer} torrentId - Magnet URI or torrent file link.
   * @param {Object} [options] - Options for download and FFmpeg conversion.
   * @param {string} [options.downloadDir='./downloads'] - Directory to store downloaded files.
   * @param {string} [options.outputPath] - Optional custom output file path.
   * @param {boolean} [options.onlyVideo=true] - Whether to download video files only.
   * @param {boolean} [options.convert=true] - Set to false to skip conversion and only download.
   * @param {string} [options.preferQuality] - Preferred resolution, e.g. 1080p.
   * @param {Function} [onProgress] - Unified progress callback (receives stage: 'download' | 'convert').
   * @returns {Promise<Object>} Object containing torrent info, main video file, and file paths.
   */
  async downloadAndConvert(torrentId, options = {}, onProgress = null) {
    const downloadDir = options.downloadDir || options.path || './downloads';
    const onlyVideo = options.onlyVideo !== false;
    const shouldConvert = options.convert !== false; // Enabled by default unless convert: false
    const signal = options.signal;

    // 1. Download torrent with video selection enabled
    const torrent = await this.download(
      torrentId,
      { path: downloadDir, onlyVideo, selectVideo: options.selectVideo, preferQuality: options.preferQuality, metadataTimeoutMs: options.metadataTimeoutMs, signal },
      (stats) => {
        if (typeof onProgress === 'function') {
          onProgress({ stage: 'download', ...stats });
        }
      }
    );

    const ensureNotCancelled = () => {
      if (signal?.aborted || torrent._laroCancelled || torrent.destroyed) {
        throw new Error('Download cancelled');
      }
    };
    ensureNotCancelled();

    // 2. Metadata is available as soon as the torrent is added — notify the
    // caller so it can persist the real name, path and infoHash.
    if (typeof options.onReady === 'function') {
      const readyVideoFile = torrent._laroVideoFiles?.[0]
        || pickPreferredVideoFile(
          torrent.files.filter((file) => this.isVideoFile(file.name) && (!options.selectVideo || options.selectVideo(file.name))),
          torrent.name,
          options.preferQuality
        )
        || torrent.files[0]
        || null;

      try {
        await options.onReady({
          torrent,
          videoFile: readyVideoFile,
          outputPath: readyVideoFile ? path.join(downloadDir, readyVideoFile.path) : downloadDir
        });
      } catch (err) {
        console.error('onReady handler failed:', err);
      }
    }

    // Deleting the media row aborts the pipeline while onReady was awaiting
    // its database write, so check again before waiting or transcoding.
    ensureNotCancelled();

    // 3. Wait until download is 100% complete (unless the operator asked to
    // convert what is already on disk).
    if (torrent._laroVideoFiles && !torrent._laroVideoFiles.length) throw new Error('No matching video file found in torrent.');
    if (!torrent.done && !torrent._laroSkipRequested) {
      await this.waitForDone(torrent, { signal });
    }
    ensureNotCancelled();

    // 4. Use the one quality-aware file selected when metadata arrived.
    const videoFiles = torrent._laroVideoFiles?.length
      ? torrent._laroVideoFiles
      : torrent.files.filter((file) => this.isVideoFile(file.name));

    if (videoFiles.length === 0) {
      throw new Error('No video files found in the downloaded torrent.');
    }

    const mainVideoFile = videoFiles[0];

    // 5. Resolve input file path
    const inputPath = path.join(downloadDir, mainVideoFile.path);

    // If conversion is disabled, return downloaded file path directly
    if (!shouldConvert) {
      return {
        torrent,
        videoFile: mainVideoFile,
        inputPath,
        outputPath: inputPath,
        converted: false
      };
    }

    const targetOutput = options.outputPath || path.join(downloadDir, `converted_${torrent.infoHash}_${path.parse(mainVideoFile.name).name}.mp4`);

    // 6. Smart conversion (probes codecs and transcodes only if required)
    ensureNotCancelled();
    const convertedPath = await this.convertAUTO(
      inputPath,
      targetOutput,
      options,
      (ffmpegStats) => {
        if (typeof onProgress === 'function') {
          onProgress({ stage: 'convert', ...ffmpegStats });
        }
      }
    );

    return {
      torrent,
      videoFile: mainVideoFile,
      inputPath,
      outputPath: convertedPath,
      converted: true
    };
  }

  /**
   * Retrieves current progress and speed stats for a download by infoHash.
   * @param {string} infoHash - Infohash of the torrent download.
   * @returns {Object|null} Formatted progress details or null if not found.
   */
  getProgress(infoHash) {
    const wanted = String(infoHash || '').toLowerCase();
    const torrent = this.activeDownloads.get(wanted) || this.findClientTorrent(wanted);

    if (!torrent) {
      return null;
    }

    // Measure progress over the video files only. torrent.progress includes
    // deselected junk files (samples, NFOs) that never download, which made
    // the UI stall just below 100%.
    const videoFiles = torrent._laroVideoFiles || (torrent.files || []).filter((file) => this.isVideoFile(file.name));
    const files = videoFiles.length > 0 ? videoFiles : (torrent.files || []);

    let progress = torrent.progress * 100;
    if (files.length > 0) {
      const totalBytes = files.reduce((sum, file) => sum + file.length, 0);
      const downloadedBytes = files.reduce((sum, file) => sum + file.downloaded, 0);
      progress = totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;
    }

    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      progress: Math.min(progress, 100).toFixed(2), // Percentage 0-100%
      downloadSpeed: torrent.downloadSpeed, // Bytes/sec
      uploadSpeed: torrent.uploadSpeed, // Bytes/sec
      numPeers: torrent.numPeers,
      downloaded: torrent.downloaded,
      total: torrent.length,
      timeRemaining: torrent.timeRemaining, // ms
      isDone: torrent.done || (videoFiles.length > 0 && videoFiles.every((file) => file.done))
    };
  }

  /**
   * Gets a list of all current active torrent downloads and their status.
   * @returns {Array<Object>} List of download status objects.
   */
  getAllProgress() {
    return Array.from(this.activeDownloads.keys()).map((hash) => this.getProgress(hash));
  }

  /**
   * Pauses an active download by deselecting its files, halting piece requests
   * without dropping the torrent from the client.
   * @param {string} infoHash - Infohash of the torrent to pause.
   * @returns {boolean} True if the torrent was found and paused.
   */
  pause(infoHash) {
    // activeDownloads is set as soon as the torrent is added, so this also
    // works while metadata is still being fetched (files are not known yet).
    const torrent = this.findClientTorrent(infoHash) || this.activeDownloads.get(String(infoHash || '').toLowerCase());
    if (!torrent) {
      return false;
    }

    torrent._laroPaused = true;
    if (Array.isArray(torrent.files) && torrent.files.length) {
      torrent.files.forEach((file) => file.deselect());
      if (typeof torrent.deselect === 'function' && torrent.pieces) {
        // Clear the whole-torrent selection added by WebTorrent on add()
        torrent.deselect(0, torrent.pieces.length - 1, false);
      }
    }
    return true;
  }

  /**
   * Resumes a paused download by re-selecting its video files.
   * @param {string} infoHash - Infohash of the torrent to resume.
   * @returns {boolean} True if the torrent was found and resumed.
   */
  resume(infoHash) {
    const torrent = this.findClientTorrent(infoHash) || this.activeDownloads.get(String(infoHash || '').toLowerCase());
    if (!torrent) {
      return false;
    }

    torrent._laroPaused = false;
    if (Array.isArray(torrent.files) && torrent.files.length) {
      const videos = torrent._laroVideoFiles || torrent.files.filter((file) => this.isVideoFile(file.name));
      videos.forEach((file) => file.select());
    }
    return true;
  }

  /**
   * Stops downloading and removes a torrent from the active downloads.
   * @param {string} infoHash - The torrent infoHash to remove.
   * @param {boolean} [destroyStore=false] - Whether to delete downloaded files from disk.
   * @returns {Promise<boolean>} True if removed successfully.
   */
  remove(infoHash, destroyStore = false, expectedPath = null) {
    return new Promise((resolve) => {
      const wanted = String(infoHash || '').toLowerCase();
      const expected = expectedPath ? path.resolve(expectedPath) : null;
      // A torrent may not have parsed its infoHash yet, so allow a path match
      // to identify it when the stored hash is the magnet's spelling.
      const matchesPath = (candidate) => !expected || !candidate?.path || path.resolve(candidate.path) === expected;

      let torrent = this.activeDownloads.get(wanted) || this.findClientTorrent(wanted);
      if (!torrent || !matchesPath(torrent)) {
        torrent = (this.client.torrents || []).find((candidate) => matchesPath(candidate)) || null;
      }
      if (!torrent || !matchesPath(torrent)) {
        return resolve(false);
      }

      // Another caller (the failed pipeline or the delete route) may already
      // have destroyed this torrent. WebTorrent then skips its destroy
      // callback entirely, which used to leave DELETE and the queue waiting
      // forever.
      const forget = () => {
        this.activeDownloads.delete(wanted);
        if (torrent.infoHash) this.activeDownloads.delete(torrent.infoHash);
      };
      if (torrent.destroyed) {
        forget();
        return resolve(true);
      }

      // Stop waitForDone/convert even when destroy's 'close' event is missed
      // by a listener that is being attached at this exact moment.
      torrent._laroCancelled = true;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        forget();
        resolve(true);
      };

      // 'close' fires synchronously once destroy starts, so it settles even if
      // a store/discovery teardown callback never comes back.
      torrent.once('close', finish);
      try {
        torrent.destroy({ destroyStore }, finish);
      } catch {
        finish();
      }
    });
  }

  /**
   * Destroys the WebTorrent client and stops all active downloads.
   */
  destroy() {
    this.activeDownloads.clear();
    this.client.destroy();
  }

  /**
   * Probes a media file to inspect container format and stream codecs (video & audio).
   * @param {string} filePath - Local file path of the downloaded media file.
   * @returns {Promise<Object>} Formatted stream info indicating if re-encoding is necessary.
   */
  probeMedia(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) return reject(err);

        const videoStream = (metadata.streams || []).find((s) => s.codec_type === 'video');
        const audioStream = (metadata.streams || []).find((s) => s.codec_type === 'audio');

        const videoCodec = videoStream ? videoStream.codec_name.toLowerCase() : null;
        const audioCodec = audioStream ? audioStream.codec_name.toLowerCase() : null;

        resolve({
          format: metadata.format ? metadata.format.format_name : 'unknown',
          duration: metadata.format ? metadata.format.duration : 0,
          videoCodec,
          audioCodec,
          // Checks if transcoding is needed to achieve H.264 / AAC compatibility
          needsVideoTranscode: videoCodec ? videoCodec !== 'h264' : false,
          needsAudioTranscode: audioCodec ? audioCodec !== 'aac' : false,
          raw: metadata
        });
      });
    });
  }

  /**
   * Converts the audio stream to AAC while preserving video (stream copy).
   * Automatically uses 'copy' mode if audio is already AAC to prevent redundant encoding.
   * @param {string} inputPath - Path to the input file.
   * @param {string} outputPath - Path to save output file.
   * @param {Function} [onProgress] - Optional progress callback.
   * @returns {Promise<string>} Resolves with output path on completion.
   */
  async convertAAC(inputPath, outputPath, onProgress = null) {
    const info = await this.probeMedia(inputPath);

    // Stream-copy audio if already AAC, otherwise encode to AAC
    const audioCodec = info.needsAudioTranscode ? 'aac' : 'copy';

    return this._runFfmpeg({
      inputPath,
      outputPath,
      videoCodec: 'copy', // Always keep video untouched
      audioCodec,
      onProgress
    });
  }

  /**
   * Smart automatic converter ("convertAUTO" / "convertFull").
   * Probes media codecs first:
   * - If video is already H.264, uses 'copy' (fast). Otherwise re-encodes to libx264.
   * - If audio is already AAC, uses 'copy' (fast). Otherwise re-encodes to aac.
   * @param {string} inputPath - Source file path.
   * @param {string} outputPath - Target file path (e.g. video.mp4).
   * @param {Object} [options] - Additional FFmpeg options (e.g. preset: 'fast').
   * @param {Function} [onProgress] - Progress callback function.
   * @returns {Promise<string>} Resolves with output path when finished.
   */
  async convertAUTO(inputPath, outputPath, options = {}, onProgress = null) {
    const info = await this.probeMedia(inputPath);

    // Determine codec strategy based on existing codecs
    const videoCodec = info.needsVideoTranscode ? (options.videoCodec || 'libx264') : 'copy';
    const audioCodec = info.needsAudioTranscode ? (options.audioCodec || 'aac') : 'copy';

    console.log(`[FFmpeg Probed] Video Codec: ${info.videoCodec} | Audio Codec: ${info.audioCodec}`);
    console.log(`[FFmpeg Strategy] Video Stream -> '${videoCodec}' | Audio Stream -> '${audioCodec}'`);

    return this._runFfmpeg({
      inputPath,
      outputPath,
      videoCodec,
      audioCodec,
      options,
      onProgress
    });
  }

  /**
   * Alias for convertAUTO to allow calling convertFull().
   */
  async convertFull(inputPath, outputPath, options = {}, onProgress = null) {
    return this.convertAUTO(inputPath, outputPath, options, onProgress);
  }

  /**
   * Internal wrapper for running FFmpeg commands with progress reporting.
   * @private
   */
  _runFfmpeg({ inputPath, outputPath, videoCodec, audioCodec, options = {}, onProgress }) {
    return new Promise((resolve, reject) => {
      const signal = options.signal;
      let command = ffmpeg(inputPath);
      let finished = false;
      const onAbort = () => {
        try { command.kill('SIGKILL'); } catch { /* not running yet */ }
        done(reject, new Error('Download cancelled'));
      };
      const done = (fn, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener('abort', onAbort);
        fn(value);
      };

      if (signal?.aborted) {
        done(reject, new Error('Download cancelled'));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });

      if (videoCodec) command = command.videoCodec(videoCodec);
      if (audioCodec) command = command.audioCodec(audioCodec);

      // Faststart flag allows web streaming before full download of file
      if (outputPath.endsWith('.mp4')) {
        // Subtitle tracks (e.g. PGS/ASS from MKV) are not muxable into MP4 and
        // would abort the whole job, so drop them; video/audio stay untouched.
        command = command.outputOptions(['-movflags +faststart', '-sn']);
      }

      if (options.preset) {
        command = command.outputOptions(`-preset ${options.preset}`);
      }

      command
        .on('progress', (progress) => {
          if (typeof onProgress === 'function') {
            onProgress({
              percent: progress.percent ? parseFloat(progress.percent.toFixed(2)) : 0,
              currentFps: progress.currentFps,
              targetSize: progress.targetSize,
              timemark: progress.timemark
            });
          }
        })
        .on('end', () => done(resolve, outputPath))
        .on('error', (err) => done(reject, err))
        .save(outputPath);
    });
  }
}

export default TorrentHelper;