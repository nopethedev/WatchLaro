/* ==========================================================================
   WatchLaro TV UI - shared script
   Remote-friendly navigation: every page is a stack of "rows"
   ([data-tv-row]) containing focusable items ([data-tv-item]).
   Left/right walks inside the current row, up/down jumps to the nearest row
   and restores the item you were last on. Enter/OK activates as usual.
   Works with TV remotes (arrow keys + enter), gamepads-as-keys and keyboards.
   ========================================================================== */

(function () {
    "use strict";

    var IMG_BASE = "https://image.tmdb.org/t/p/";
    var PLACEHOLDER = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="342" height="513"><rect width="342" height="513" fill="#1b1b23"/></svg>'
    );

    /* Row element -> last focused item, so up/down returns where you left. */
    var rowMemory = new WeakMap();

    var ARROW_KEYS = {
        ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down",
        Left: "left", Right: "right", Up: "up", Down: "down"
    };
    var ARROW_CODES = { 37: "left", 38: "up", 39: "right", 40: "down" };

    /* ------------------------------------------------------------------ *
     * Geometry helpers
     * ------------------------------------------------------------------ */

    function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        if (el.closest("[hidden]")) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 4 && rect.height > 4;
    }

    /**
     * The nav is position:fixed, so its viewport top is always 0 - which would
     * make it outrank the billboard as soon as the page is scrolled. Marked
     * rows sit above everything instead, whatever the scroll position.
     */
    function isFixedRow(el) {
        return Boolean(el && el.closest && el.closest("[data-tv-fixed]"));
    }

    /**
     * Row position in the document, so a fixed header stays the top edge of
     * the page no matter how far down the list the viewer is. Comparing
     * viewport tops put the header level with the last row instead.
     */
    function docTop(el) {
        if (isFixedRow(el)) return 0;
        var offset = window.pageYOffset || document.documentElement.scrollTop || 0;
        return el.getBoundingClientRect().top + offset;
    }

    function allRows() {
        var containers = document.querySelectorAll("[data-tv-row]");
        var list = [];

        Array.prototype.forEach.call(containers, function (row) {
            if (!isVisible(row)) return;
            var items = Array.prototype.filter.call(row.querySelectorAll("[data-tv-item]"), function (item) {
                return isVisible(item);
            });
            if (!items.length) return;

            items.sort(function (a, b) {
                var ra = a.getBoundingClientRect();
                var rb = b.getBoundingClientRect();
                return ra.left - rb.left || ra.top - rb.top;
            });
            list.push({ el: row, items: items });
        });

        list.sort(function (a, b) { return docTop(a.el) - docTop(b.el); });
        return list;
    }

    function currentRow(list) {
        var active = document.activeElement;
        for (var i = 0; i < list.length; i++) {
            if (active && list[i].el.contains(active)) {
                return { row: list[i], index: list[i].items.indexOf(active) };
            }
        }
        return null;
    }

    function nearestItem(items, from) {
        if (!items || !items.length) return null;
        if (!from) return items[0];

        var fr = from.getBoundingClientRect();
        var fromCenter = (fr.left + fr.right) / 2;
        var best = null;
        var bestScore = Infinity;

        items.forEach(function (item) {
            var r = item.getBoundingClientRect();
            var center = (r.left + r.right) / 2;
            var overlap = Math.min(fr.right, r.right) - Math.max(fr.left, r.left);
            var score = Math.abs(center - fromCenter) - (overlap > 0 ? 80 : 0);
            if (score < bestScore) {
                bestScore = score;
                best = item;
            }
        });
        return best;
    }

    function focusItem(item, row) {
        if (!item) return;
        item.focus({ preventScroll: true });
        if (row && row.el) rowMemory.set(row.el, item);

        // The billboard is laid out for a full screen; when focus comes back
        // up to it, scroll all the way home so the title and buttons are
        // fully visible instead of sliding under the fixed nav.
        if (item.closest && item.closest(".tv-hero, .tv-info-hero")) {
            try {
                window.scrollTo({ top: 0, behavior: "smooth" });
            } catch (err) {
                window.scrollTo(0, 0);
            }
            return;
        }

        // The fixed nav is always on screen; scrolling it into view would
        // just nudge the page around.
        if (isFixedRow(item)) return;

        try {
            item.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
        } catch (err) {
            item.scrollIntoView(false);
        }
    }

    function focusFirst() {
        var explicit = document.querySelector("[data-tv-autofocus]");
        if (explicit && isVisible(explicit)) {
            focusItem(explicit);
            return;
        }
        var list = allRows();
        if (!list.length) {
            var firstItem = document.querySelector("[data-tv-item]");
            if (firstItem && isVisible(firstItem)) focusItem(firstItem);
            return;
        }
        focusItem(list[0].items[0], list[0]);
    }

    function moveHorizontal(list, direction) {
        var current = currentRow(list);
        if (!current) {
            focusFirst();
            return;
        }
        var next = current.index + (direction === "right" ? 1 : -1);
        if (next < 0 || next >= current.row.items.length) return;
        focusItem(current.row.items[next], current.row);
    }

    function moveVertical(list, direction) {
        var current = currentRow(list);
        if (!current) {
            focusFirst();
            return;
        }

        var activeRowTop = docTop(current.row.el);
        var candidates = list.filter(function (row) {
            var top = docTop(row.el);
            return direction === "down" ? top > activeRowTop + 4 : top < activeRowTop - 4;
        });
        if (!candidates.length) return;

        candidates.sort(function (a, b) {
            var ta = docTop(a.el);
            var tb = docTop(b.el);
            return direction === "down" ? ta - tb : tb - ta;
        });

        var target = candidates[0];
        var from = current.row.items[current.index] || document.activeElement;
        var remembered = rowMemory.get(target.el);
        var item = (remembered && target.items.indexOf(remembered) !== -1 && isVisible(remembered))
            ? remembered
            : nearestItem(target.items, from);

        focusItem(item, target);
    }

    /*
     * Free-form/spatial movement for pages that are not simple stacks of rows
     * (the search screen: on-screen keyboard, suggestions and a results grid).
     * Pick the nearest item in the requested direction, favouring items that
     * line up with the current one.
     */
    function overlapX(a, b) {
        return Math.min(a.right, b.right) - Math.max(a.left, b.left);
    }

    function overlapY(a, b) {
        return Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    }

    function moveSpatial(direction) {
        var current = document.activeElement;
        var candidates = Array.prototype.filter.call(document.querySelectorAll("[data-tv-item]"), isVisible);

        if (!current || candidates.indexOf(current) === -1) {
            focusFirst();
            return;
        }

        var cr = current.getBoundingClientRect();
        var cx = (cr.left + cr.right) / 2;
        var cy = (cr.top + cr.bottom) / 2;
        var best = null;
        var bestScore = Infinity;

        candidates.forEach(function (el) {
            if (el === current) return;
            var r = el.getBoundingClientRect();
            var x = (r.left + r.right) / 2;
            var y = (r.top + r.bottom) / 2;
            var forward;
            var perp;
            var overlap;

            if (direction === "left") {
                forward = cx - x;
                perp = Math.abs(cy - y);
                overlap = overlapY(cr, r);
            } else if (direction === "right") {
                forward = x - cx;
                perp = Math.abs(cy - y);
                overlap = overlapY(cr, r);
            } else if (direction === "up") {
                // The candidate has to sit on a row above this one. Comparing
                // centres let cards in the same grid row (their text wraps to
                // different heights) count as "above", so down moved sideways.
                if (r.bottom > cr.top + 6) return;
                forward = cy - y;
                perp = Math.abs(cx - x);
                overlap = overlapX(cr, r);
            } else {
                if (r.top < cr.bottom - 6) return;
                forward = y - cy;
                perp = Math.abs(cx - x);
                overlap = overlapX(cr, r);
            }

            if (forward <= 8) return;
            // Straight lines beat diagonal jumps across the screen.
            var score = forward + perp * (overlap > 0 ? 0.35 : 2);
            if (score < bestScore) {
                bestScore = score;
                best = el;
            }
        });

        if (best) focusItem(best);
    }

    /* ------------------------------------------------------------------ *
     * Back handling
     * ------------------------------------------------------------------ */

    function goBack() {
        var fallback = document.body.getAttribute("data-tv-back") || "/tvui/home";
        var referring = document.referrer || "";
        if (referring.indexOf(window.location.origin) === 0 && window.history.length > 1) {
            window.history.back();
        } else {
            window.location.href = fallback;
        }
    }

    function isBackKey(event) {
        return event.key === "Escape"
            || event.key === "Backspace"
            || event.key === "BrowserBack"
            || event.key === "GoBack"
            || event.keyCode === 8
            || event.keyCode === 27
            || event.keyCode === 461;
    }

    /* ------------------------------------------------------------------ *
     * Remote / keyboard listener
     * ------------------------------------------------------------------ */

    function installNavigation() {
        var spatial = document.body.getAttribute("data-tv-nav") === "spatial";

        function move(direction) {
            if (spatial) {
                moveSpatial(direction);
                return;
            }
            var list = allRows();
            if (!list.length) return;
            if (direction === "left" || direction === "right") moveHorizontal(list, direction);
            else moveVertical(list, direction);
        }

        document.addEventListener("keydown", function (event) {
            if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

            var target = event.target;
            var tag = (target && target.tagName || "").toLowerCase();
            var editing = tag === "input" || tag === "textarea" || tag === "select";

            var direction = ARROW_KEYS[event.key] || ARROW_CODES[event.keyCode];
            if (direction) {
                // Text fields keep left/right for the caret; up/down still leave them.
                if (editing && (direction === "left" || direction === "right")) return;
                event.preventDefault();
                move(direction);
                return;
            }

            if (isBackKey(event)) {
                if (editing) return; // backspace while typing should edit, not navigate
                event.preventDefault();
                goBack();
            }
        });

        // Browsers sometimes fire navigation keys on the window instead of the
        // document (old smart-TV browsers). Catch those too.
        window.addEventListener("keydown", function (event) {
            if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
            var direction = ARROW_KEYS[event.key] || ARROW_CODES[event.keyCode];
            if (!direction) return;
            var active = document.activeElement;
            var tag = (active && active.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || tag === "select") {
                if (direction === "left" || direction === "right") return;
            }
            event.preventDefault();
            move(direction);
        });
    }

    /* ------------------------------------------------------------------ *
     * API / image helpers
     * ------------------------------------------------------------------ */

    function image(path, size) {
        if (!path) return PLACEHOLDER;
        return IMG_BASE + (size || "w342") + path;
    }

    function fetchJSON(url, options) {
        var opts = options || {};
        opts.headers = Object.assign({ Accept: "application/json" }, opts.headers || {});
        return fetch(url, opts).then(function (response) {
            if (!response.ok) throw new Error("HTTP " + response.status);
            return response.json();
        });
    }

    function loadFeed(type) {
        return fetchJSON("/api/tvui/feed?type=" + encodeURIComponent(type || "all"));
    }

    function postJSON(url, body) {
        return fetchJSON(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
    }

    function infoUrl(item) {
        return "/tvui/info/" + item.type + "/" + item.id;
    }

    function watchUrl(options) {
        var params = new URLSearchParams();
        params.set("type", options.type);
        params.set("id", String(options.id));
        if (options.season) params.set("season", String(options.season));
        if (options.episode) params.set("episode", String(options.episode));
        if (options.title) params.set("title", options.title);
        if (options.episodeTitle) params.set("episodeTitle", options.episodeTitle);
        return "/tvui/watch?" + params.toString();
    }

    /* ------------------------------------------------------------------ *
     * Trailers
     * ------------------------------------------------------------------ */

    var trailerCache = {};

    function trailerUrl(key) {
        var params = new URLSearchParams({
            autoplay: "1",
            mute: "1",
            controls: "0",
            modestbranding: "1",
            rel: "0",
            playsinline: "1",
            loop: "1",
            playlist: key,
            iv_load_policy: "3",
            disablekb: "1",
            fs: "0",
            enablejsapi: "1",
            origin: location.origin
        });
        return "https://www.youtube-nocookie.com/embed/" + key + "?" + params.toString();
    }

    /** YouTube's postMessage control channel (needs enablejsapi=1 in the URL). */
    function youtubeCommand(frame, func, args) {
        try {
            frame.contentWindow.postMessage(JSON.stringify({
                event: "command",
                func: func,
                args: args || []
            }), "*");
        } catch (err) { /* blocked embed */ }
    }

    /* ------------------------------------------------------------------ *
     * Trailer audio
     * ------------------------------------------------------------------ */

    var trailerAudioUnlocked = false;

    /**
     * The embed often ignores commands until its player has booted, so send
     * the same command a few times instead of trusting a single postMessage.
     */
    function applyTrailerAudio(frame) {
        [0, 600, 1600].forEach(function (delay) {
            window.setTimeout(function () {
                if (!frame || !frame.parentNode) return;
                youtubeCommand(frame, "unMute");
                youtubeCommand(frame, "setVolume", [100]);
                youtubeCommand(frame, "playVideo");
            }, delay);
        });
    }

    /**
     * Browsers only allow audible autoplay after a user gesture. A key press
     * from the remote (or a click) is one, so the first interaction unmutes
     * whichever trailer is mounted. Until then the trailer is muted rather
     * than blocked.
     */
    function unlockTrailerAudio() {
        if (trailerAudioUnlocked) return;
        trailerAudioUnlocked = true;

        var frames = document.querySelectorAll("iframe.tv-hero-video");
        Array.prototype.forEach.call(frames, applyTrailerAudio);
    }

    document.addEventListener("keydown", unlockTrailerAudio, true);
    document.addEventListener("pointerdown", unlockTrailerAudio, true);

    function loadTrailer(type, id) {
        var cacheKey = type + ":" + id;
        if (Object.prototype.hasOwnProperty.call(trailerCache, cacheKey)) {
            return Promise.resolve(trailerCache[cacheKey]);
        }
        return fetchJSON("/api/tvui/videos/" + type + "/" + id)
            .then(function (data) {
                var key = data && data.trailer ? data.trailer.key : null;
                trailerCache[cacheKey] = key;
                return key;
            })
            .catch(function () {
                trailerCache[cacheKey] = null;
                return null;
            });
    }

    /** Remove the hero trailer iframe, if one is mounted. */
    function clearTrailer(container) {
        if (!container) return;
        var frame = container.querySelector(".tv-hero-video");
        if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    }

    /**
     * Mount a muted, looping YouTube trailer over the banner. The banner stays
     * underneath, so a blocked/unavailable video simply falls back to it.
     */
    function mountTrailer(container, key) {
        clearTrailer(container);
        if (!container || !key) return;

        var frame = document.createElement("iframe");
        frame.className = "tv-hero-video";
        frame.src = trailerUrl(key);
        frame.title = "Trailer";
        frame.setAttribute("aria-hidden", "true");
        frame.setAttribute("tabindex", "-1");
        frame.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
        frame.setAttribute("frameborder", "0");

        var settled = false;
        var timer = window.setTimeout(function () {
            if (settled) return;
            settled = true;
            if (frame.parentNode) frame.parentNode.removeChild(frame);
        }, 8000);

        frame.addEventListener("load", function () {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            frame.classList.add("is-ready");
            // Sound needs a gesture first; if one already happened, unmute now,
            // otherwise the global key/click handler does it.
            youtubeCommand(frame, "playVideo");
            if (trailerAudioUnlocked) applyTrailerAudio(frame);
        });

        container.appendChild(frame);
    }

    /* ------------------------------------------------------------------ *
     * Cards / rows
     * ------------------------------------------------------------------ */

    function createCard(item, options) {
        var opts = options || {};
        var card = document.createElement("div");
        card.className = "tv-card" + (opts.className ? " " + opts.className : "");
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("data-tv-item", "");
        card.setAttribute("aria-label", item.title);
        card.__tvItem = item;

        var media = document.createElement("span");
        media.className = "tv-card-media";

        var poster = document.createElement("img");
        poster.className = "tv-card-poster";
        poster.alt = "";
        poster.decoding = "async";
        poster.loading = "lazy";
        poster.src = image(item.poster, "w342");
        media.appendChild(poster);

        // Backdrops are only fetched once the card is expanded (see bootBrowse),
        // otherwise every card in every row would download a second image.
        if (item.backdrop) {
            var backdrop = document.createElement("img");
            backdrop.className = "tv-card-backdrop";
            backdrop.alt = "";
            backdrop.decoding = "async";
            backdrop.loading = "lazy";
            media.appendChild(backdrop);
        }

        var info = document.createElement("span");
        info.className = "tv-card-info";

        var kicker = document.createElement("span");
        kicker.className = "tv-card-info-kicker";
        kicker.textContent = "WatchLaro " + (item.type === "tv" ? "Series" : "Film");
        info.appendChild(kicker);

        var infoTitle = document.createElement("span");
        infoTitle.className = "tv-card-info-title";
        infoTitle.textContent = item.title;
        info.appendChild(infoTitle);

        var bits = [];
        if (item.rating) bits.push("★ " + item.rating.toFixed(1));
        if (item.year) bits.push(item.year);
        bits.push("HD");
        var infoMeta = document.createElement("span");
        infoMeta.className = "tv-card-info-meta";
        infoMeta.textContent = bits.join(" · ");
        info.appendChild(infoMeta);

        media.appendChild(info);
        card.appendChild(media);

        var title = document.createElement("span");
        title.className = "tv-card-title";
        title.textContent = item.title;
        card.appendChild(title);

        function open() {
            window.location.href = infoUrl(item);
        }

        card.addEventListener("click", open);
        card.addEventListener("keydown", function (event) {
            if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
                event.preventDefault();
                open();
            }
        });

        return card;
    }

    function createEpisodeCard(seriesId, seasonNumber, episode, seriesTitle) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "tv-card tv-episode-card";
        button.setAttribute("data-tv-item", "");
        button.setAttribute("aria-label", "Episode " + episode.episode_number + ": " + (episode.name || "Untitled"));

        var img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        img.loading = "lazy";
        img.src = image(episode.still_path, "w300");
        button.appendChild(img);

        var number = document.createElement("span");
        number.className = "tv-ep-number";
        number.textContent = "S" + seasonNumber + " · E" + episode.episode_number;
        button.appendChild(number);

        var name = document.createElement("span");
        name.className = "tv-card-title";
        name.textContent = episode.name || "Untitled";
        button.appendChild(name);

        button.addEventListener("click", function () {
            window.location.href = watchUrl({
                type: "tv",
                id: seriesId,
                season: seasonNumber,
                episode: episode.episode_number,
                title: seriesTitle,
                episodeTitle: episode.name || ""
            });
        });
        return button;
    }

    function createRow(title, items, options) {
        var opts = options || {};
        var section = document.createElement("section");
        section.className = "tv-row";

        if (title) {
            var heading = document.createElement("h2");
            heading.className = "tv-row-title";
            heading.textContent = title;
            section.appendChild(heading);
        }

        var track = document.createElement("div");
        track.className = "tv-row-track" + (opts.trackClass ? " " + opts.trackClass : "");
        track.setAttribute("data-tv-row", "");
        items.forEach(function (item) {
            track.appendChild(opts.render ? opts.render(item) : createCard(item));
        });
        section.appendChild(track);

        // Details for whichever card in this row is expanded. Hidden until the
        // row has focus, so the page stays compact while browsing vertically.
        var focusPanel = document.createElement("div");
        focusPanel.className = "tv-row-focus";
        var focusMeta = document.createElement("div");
        focusMeta.className = "tv-row-focus-meta";
        var focusOverview = document.createElement("p");
        focusOverview.className = "tv-row-focus-overview";
        focusPanel.appendChild(focusMeta);
        focusPanel.appendChild(focusOverview);
        section.appendChild(focusPanel);

        return section;
    }

    function skeletonRows(host, rowCount) {
        if (!host) return;
        host.innerHTML = "";
        for (var row = 0; row < (rowCount || 2); row++) {
            var section = document.createElement("section");
            section.className = "tv-row";
            var track = document.createElement("div");
            track.className = "tv-skeleton-row";
            for (var i = 0; i < 8; i++) {
                var card = document.createElement("div");
                card.className = "tv-skeleton-card";
                track.appendChild(card);
            }
            section.appendChild(track);
            host.appendChild(section);
        }
    }

    function setStatus(node, text) {
        if (node) node.textContent = text || "";
    }

    function startClock() {
        var node = document.getElementById("tv-clock");
        if (!node) return;
        var paint = function () {
            var now = new Date();
            var hours = now.getHours();
            var minutes = now.getMinutes();
            node.textContent = (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes;
        };
        paint();
        window.setInterval(paint, 20000);
    }

    function metaLine(items) {
        var fragment = document.createDocumentFragment();
        items.filter(Boolean).forEach(function (entry, index) {
            if (index > 0) {
                var dot = document.createElement("span");
                dot.className = "tv-dot";
                dot.textContent = "•";
                fragment.appendChild(dot);
            }
            var span = document.createElement("span");
            if (entry.className) span.className = entry.className;
            span.textContent = entry.text;
            fragment.appendChild(span);
        });
        return fragment;
    }

    /* ------------------------------------------------------------------ *
     * Home / browse page
     * ------------------------------------------------------------------ */

    function bootBrowse() {
        startClock();

        var body = document.body;
        var mode = body.getAttribute("data-tv-mode") || "all";
        var rowsHost = document.getElementById("rows");
        var heroMedia = document.querySelector(".tv-hero-media");
        var heroImg = document.getElementById("hero-img");
        var heroTitle = document.getElementById("hero-title");
        var heroKicker = document.getElementById("hero-kicker");
        var heroMeta = document.getElementById("hero-meta");
        var heroOverview = document.getElementById("hero-overview");
        var playButton = document.getElementById("hero-play");
        var infoButton = document.getElementById("hero-info");
        var heroItem = null;
        var heroPool = [];
        var heroRotation = null;
        var trailerToken = 0;
        var activeCard = null;
        var cardTrailerToken = 0;

        focusFirst();
        skeletonRows(rowsHost, 2);

        playButton.addEventListener("click", function () {
            if (!heroItem) return;
            window.location.href = heroItem.type === "tv"
                ? infoUrl(heroItem)
                : watchUrl({ type: "movie", id: heroItem.id, title: heroItem.title });
        });

        infoButton.addEventListener("click", function () {
            if (!heroItem) return;
            window.location.href = infoUrl(heroItem);
        });

        function paintHero(item) {
            if (!item) {
                clearTrailer(heroMedia);
                heroItem = null;
                heroTitle.textContent = "WatchLaro";
                heroKicker.textContent = "WatchLaro";
                heroOverview.textContent = "Nothing in the catalogue right now. Check the server connection and try again.";
                heroMeta.textContent = "";
                playButton.disabled = true;
                infoButton.disabled = true;
                return;
            }

            heroItem = item;
            if (item.backdrop) {
                heroImg.src = image(item.backdrop, "w1280");
                heroImg.alt = "";
            } else if (item.poster) {
                // Posters do not exist at backdrop sizes on the TMDB CDN.
                heroImg.src = image(item.poster, "w780");
                heroImg.alt = "";
            }
            heroTitle.textContent = item.title;
            heroKicker.textContent = "WatchLaro " + (item.type === "tv" ? "Series" : "Film");

            var meta = [];
            if (item.rating) meta.push({ text: "★ " + item.rating.toFixed(1), className: "tv-match" });
            if (item.year) meta.push({ text: item.year });
            meta.push({ text: "HD", className: "tv-chip" });
            meta.push({ text: item.type === "tv" ? "Series" : "Film" });
            heroMeta.innerHTML = "";
            heroMeta.appendChild(metaLine(meta));

            heroOverview.textContent = item.overview || "No overview yet.";
            playButton.disabled = false;
            infoButton.disabled = false;
        }

        function metaText(item) {
            var parts = [];
            if (item.rating) parts.push("★ " + item.rating.toFixed(1));
            if (item.year) parts.push(item.year);
            parts.push(item.type === "tv" ? "Series" : "Film");
            return parts.join(" · ");
        }

        /** Play the billboard's trailer, unless a row card is already previewing. */
        function playHeroTrailer(item) {
            if (!item || activeCard) return;
            var token = ++trailerToken;
            var type = item.type;
            var id = item.id;
            loadTrailer(type, id).then(function (key) {
                if (!key || token !== trailerToken || activeCard) return;
                if (!heroItem || heroItem.type !== type || heroItem.id !== id) return;
                mountTrailer(heroMedia, key);
            });
        }

        /** Paint the billboard; the banner stays if there is no playable trailer. */
        function selectHero(item) {
            if (!item) {
                paintHero(null);
                return;
            }
            trailerToken++;
            clearTrailer(heroMedia);
            paintHero(item);
            playHeroTrailer(item);
        }

        function pickRandomHero(exclude) {
            var pool = heroPool.filter(function (item) {
                return !exclude || item.type !== exclude.type || item.id !== exclude.id;
            });
            if (!pool.length) return heroPool[0] || null;
            return pool[Math.floor(Math.random() * pool.length)];
        }

        function startRotation() {
            window.clearInterval(heroRotation);
            heroRotation = window.setInterval(function () {
                if (document.hidden) return;
                var next = pickRandomHero(heroItem);
                if (!next) return;
                if (heroItem && next.type === heroItem.type && next.id === heroItem.id) return;
                selectHero(next);
            }, 30000);
        }

        /** Bring the billboard preview back after the row preview stops. */
        function scheduleHeroPreview() {
            window.setTimeout(function () {
                if (!activeCard && heroItem) playHeroTrailer(heroItem);
            }, 450);
        }

        function collapseActiveCard() {
            if (!activeCard) return;
            var card = activeCard;
            activeCard = null;
            cardTrailerToken++;
            card.classList.remove("is-expanded");
            clearTrailer(card.querySelector(".tv-card-media"));
            var section = card.closest(".tv-row");
            var panel = section && section.querySelector(".tv-row-focus");
            if (panel) panel.classList.remove("is-visible");
            scheduleHeroPreview();
        }

        /** Expand the focused poster into the in-row billboard card. */
        function expandCard(card) {
            if (!card || card === activeCard) return;
            if (activeCard) collapseActiveCard();
            activeCard = card;

            var item = card.__tvItem;
            card.classList.add("is-expanded");
            cardTrailerToken++;
            trailerToken++;
            clearTrailer(heroMedia);

            if (item && item.backdrop) {
                var art = card.querySelector(".tv-card-backdrop");
                if (art) {
                    if (!art.getAttribute("src")) {
                        art.addEventListener("load", function () {
                            card.classList.add("has-backdrop");
                        }, { once: true });
                        art.src = image(item.backdrop, "w780");
                    } else if (art.complete && art.naturalWidth) {
                        card.classList.add("has-backdrop");
                    }
                }
            }

            var section = card.closest(".tv-row");
            var panel = section && section.querySelector(".tv-row-focus");
            if (panel && item) {
                panel.querySelector(".tv-row-focus-meta").textContent = metaText(item);
                panel.querySelector(".tv-row-focus-overview").textContent = item.overview || "";
                panel.classList.add("is-visible");
            }

            // The card just got much wider; keep it fully on screen.
            window.setTimeout(function () {
                if (activeCard !== card) return;
                try {
                    card.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
                } catch (err) { /* older TV browsers */ }
            }, 320);

            var token = ++cardTrailerToken;
            window.setTimeout(function () {
                if (token !== cardTrailerToken || activeCard !== card || !item) return;
                loadTrailer(item.type, item.id).then(function (key) {
                    if (!key || token !== cardTrailerToken || activeCard !== card) return;
                    var media = card.querySelector(".tv-card-media");
                    if (media) mountTrailer(media, key);
                });
            }, 700);
        }

        document.addEventListener("focusin", function (event) {
            var target = event.target;
            var card = target && target.closest ? target.closest(".tv-card") : null;
            if (!card || !rowsHost.contains(card) || !card.closest(".tv-row-track")) {
                collapseActiveCard();
                return;
            }
            expandCard(card);
        });

        function render(feed) {
            rowsHost.innerHTML = "";
            (feed.rows || []).forEach(function (row) {
                rowsHost.appendChild(createRow(row.title, row.items));
            });

            if (!rowsHost.children.length) {
                var empty = document.createElement("p");
                empty.className = "tv-empty";
                empty.textContent = "Nothing in the catalogue right now.";
                rowsHost.appendChild(empty);
            }

            heroPool = (feed.hero || []).filter(function (item) { return item && item.backdrop; });
            var first = pickRandomHero(null);
            if (first) {
                selectHero(first);
                startRotation();
            } else {
                paintHero(null);
            }
        }

        loadFeed(mode).then(render).catch(function (err) {
            if (window.console) console.error("[tvui] feed failed", err);
            paintHero(null);
            rowsHost.innerHTML = "";
            var message = document.createElement("p");
            message.className = "tv-empty";
            message.textContent = "Could not load the catalogue. Check the server connection and try again.";
            rowsHost.appendChild(message);
        });
    }

    /* ------------------------------------------------------------------ *
     * Search page
     * ------------------------------------------------------------------ */

    var SEARCH_KEY_ROWS = ["abcdef", "ghijkl", "mnopqr", "stuvwx", "yz1234", "567890"];
    var SEARCH_SUGGESTIONS = [
        "Action", "Comedy", "Sci-Fi", "Anime",
        "Documentaries", "Korean dramas", "Marvel", "Star Wars"
    ];

    function buildKeyboard(input, onType) {
        var host = document.getElementById("tv-keyboard");
        if (!host) return;

        function makeKey(label, className) {
            var key = document.createElement("button");
            key.type = "button";
            key.className = "tv-key" + (className ? " " + className : "");
            key.setAttribute("data-tv-item", "");
            key.textContent = label;
            return key;
        }

        SEARCH_KEY_ROWS.forEach(function (letters) {
            var row = document.createElement("div");
            row.className = "tv-key-row";
            letters.split("").forEach(function (letter) {
                var key = makeKey(letter);
                key.setAttribute("aria-label", letter);
                key.addEventListener("click", function () { onType(letter); });
                row.appendChild(key);
            });
            host.appendChild(row);
        });

        var actions = document.createElement("div");
        actions.className = "tv-key-row";

        var space = makeKey("Space", "tv-key-space");
        space.addEventListener("click", function () { onType(" "); });
        actions.appendChild(space);

        var backspace = makeKey("⌫", "tv-key-action");
        backspace.setAttribute("aria-label", "Backspace");
        backspace.addEventListener("click", function () {
            input.value = input.value.slice(0, -1);
            input.dispatchEvent(new Event("input"));
        });
        actions.appendChild(backspace);

        var clear = makeKey("Clear", "tv-key-action");
        clear.addEventListener("click", function () {
            input.value = "";
            input.dispatchEvent(new Event("input"));
        });
        actions.appendChild(clear);

        host.appendChild(actions);
    }

    function buildSuggestions(input, onPick) {
        var host = document.getElementById("tv-suggestions");
        if (!host) return;

        SEARCH_SUGGESTIONS.forEach(function (term) {
            var button = document.createElement("button");
            button.type = "button";
            button.className = "tv-suggestion";
            button.setAttribute("data-tv-item", "");
            button.textContent = term;
            button.addEventListener("click", function () {
                input.value = term;
                onPick(term);
            });
            host.appendChild(button);
        });
    }

    function bootSearch() {
        startClock();

        var input = document.getElementById("tv-search-input");
        var grid = document.getElementById("search-grid");
        var status = document.getElementById("tv-search-status");
        var queryLabel = document.getElementById("tv-search-query");
        var trending = null;
        var timer = null;
        var requestToken = 0;


        function appendToQuery(text) {
            input.value += text;
            input.dispatchEvent(new Event("input"));
        }

        /** The query typed so far, shown above the back button. */
        function setQueryLabel(query) {
            if (!queryLabel) return;
            var text = query ? "Results for \u201C" + query + "\u201D" : "";
            queryLabel.textContent = text;
            queryLabel.hidden = !text;
        }

        function renderGrid(title, items) {
            var hadFocus = grid.contains(document.activeElement);
            grid.innerHTML = "";

            if (title) {
                var heading = document.createElement("h2");
                heading.className = "tv-grid-title";
                heading.textContent = title;
                grid.appendChild(heading);
            }

            var wrap = document.createElement("div");
            wrap.className = "tv-result-grid-inner";
            items.forEach(function (item) {
                wrap.appendChild(createCard(item));
            });
            grid.appendChild(wrap);

            if (hadFocus) {
                var first = wrap.querySelector("[data-tv-item]");
                if (first) focusItem(first);
            }
        }

        function renderTrending() {
            setStatus(status, "");
            setQueryLabel("");
            if (!trending) {
                grid.innerHTML = "";
                setStatus(status, "Loading the catalogue…");
                return;
            }
            renderGrid(trending.title || "Trending Now", trending.items || []);
        }

        function runSearch(query, focusResults) {
            var token = ++requestToken;
            setQueryLabel(query);
            setStatus(status, "Searching for \u201C" + query + "\u201D\u2026");

            fetchJSON("/api/tvui/search?q=" + encodeURIComponent(query))
                .then(function (data) {
                    if (token !== requestToken) return;
                    var items = data.items || [];
                    setStatus(status, items.length ? "" : "No movies or shows found for \u201C" + query + "\u201D.");
                    renderGrid("", items);
                    if (focusResults) {
                        var firstCard = grid.querySelector("[data-tv-item]");
                        if (firstCard) focusItem(firstCard);
                    }
                })
                .catch(function (err) {
                    if (token !== requestToken) return;
                    if (window.console) console.error("[tvui] search failed", err);
                    grid.innerHTML = "";
                    setStatus(status, "Search is unavailable right now. Try again in a moment.");
                });
        }

        if (input) {
            input.addEventListener("input", function () {
                var query = input.value.trim();
                window.clearTimeout(timer);
                if (!query) {
                    requestToken++;
                    renderTrending();
                    return;
                }
                setQueryLabel(query);
                timer = window.setTimeout(function () { runSearch(query, false); }, 420);
            });

            input.addEventListener("keydown", function (event) {
                if (event.key !== "Enter") return;
                event.preventDefault();
                window.clearTimeout(timer);
                var query = input.value.trim();
                if (!query) {
                    // OK on an empty field is the natural "start typing" action
                    // on a TV, so hand focus to the on-screen keyboard.
                    renderTrending();
                    var firstKey = document.querySelector("#tv-keyboard [data-tv-item]");
                    if (firstKey) focusItem(firstKey);
                    return;
                }
                input.blur();
                runSearch(query, true);
            });

            buildKeyboard(input, appendToQuery);
            buildSuggestions(input, function (term) {
                window.clearTimeout(timer);
                runSearch(term, false);
            });
        }

        // Start on the first letter of the on-screen keyboard: on a TV that is
        // the quickest way in, and Up still reaches the query field and the nav.
        var startKey = document.querySelector("#tv-keyboard [data-tv-item]");
        if (startKey && isVisible(startKey)) focusItem(startKey);
        else if (input) focusItem(input);
        else focusFirst();

        loadFeed("all").then(function (feed) {
            trending = feed.rows && feed.rows[0];
            if (!input || !input.value.trim()) renderTrending();
        }).catch(function () {
            if (!input || !input.value.trim()) renderTrending();
        });
    }

    /* ------------------------------------------------------------------ *
     * Info page
     * ------------------------------------------------------------------ */

    function bootInfo() {
        startClock();
        focusFirst();

        var body = document.body;
        var type = body.getAttribute("data-tv-type");
        var id = body.getAttribute("data-tv-id");
        var params = new URLSearchParams(window.location.search);

        var img = document.getElementById("info-img");
        var title = document.getElementById("info-title");
        var meta = document.getElementById("info-meta");
        var overview = document.getElementById("info-overview");
        var playButton = document.getElementById("info-play");
        var playLabel = document.getElementById("info-play-label");
        var episodesSection = document.getElementById("tv-episodes");
        var seasonTrack = document.getElementById("season-track");
        var episodeTrack = document.getElementById("episode-track");
        var episodesTitle = document.getElementById("episodes-title");
        var backButton = document.getElementById("info-back");

        if (backButton) backButton.addEventListener("click", goBack);

        var seriesTitle = "";
        var seasons = [];
        var currentSeason = null;
        var firstEpisode = null;
        var seasonToken = 0;

        function fillHero(data) {
            var name = type === "tv" ? data.name : data.title;
            seriesTitle = name || "Untitled";
            document.title = seriesTitle + " \u2014 WatchLaro";
            title.textContent = seriesTitle;

            if (data.backdrop_path) {
                img.src = image(data.backdrop_path, "w1280");
                img.alt = "";
            }
            overview.textContent = data.overview || "No overview yet.";

            var bits = [];
            if (typeof data.vote_average === "number" && data.vote_average > 0) {
                bits.push({ text: "★ " + data.vote_average.toFixed(1), className: "tv-match" });
            }
            var date = type === "tv" ? data.first_air_date : data.release_date;
            if (date) bits.push({ text: String(date).slice(0, 4) });
            if (type === "tv" && data.number_of_seasons) {
                bits.push({ text: data.number_of_seasons + (data.number_of_seasons === 1 ? " season" : " seasons") });
            }
            if (type === "movie" && data.runtime) bits.push({ text: data.runtime + " min" });
            bits.push({ text: "HD", className: "tv-chip" });
            (data.genres || []).slice(0, 3).forEach(function (genre) {
                bits.push({ text: genre.name });
            });

            meta.innerHTML = "";
            meta.appendChild(metaLine(bits));
        }

        function renderMovie(data) {
            fillHero(data);
            episodesSection.hidden = true;
            playButton.addEventListener("click", function () {
                window.location.href = watchUrl({ type: "movie", id: id, title: seriesTitle });
            });
        }

        function markSeason(number) {
            Array.prototype.forEach.call(seasonTrack.querySelectorAll("[data-tv-item]"), function (pill) {
                pill.classList.toggle("is-active", Number(pill.getAttribute("data-season")) === number);
                pill.setAttribute("aria-pressed", String(Number(pill.getAttribute("data-season")) === number));
            });
        }

        function loadSeason(number, focusEpisodes) {
            var token = ++seasonToken;
            currentSeason = number;
            markSeason(number);
            firstEpisode = null;
            episodeTrack.innerHTML = "";
            episodesTitle.textContent = "Loading episodes\u2026";

            postJSON("/api/tv/season/info", { q: id, season: number })
                .then(function (data) {
                    if (token !== seasonToken) return;
                    var episodes = data.episodes || [];
                    episodesTitle.textContent = data.name || "Season " + number;

                    if (!episodes.length) {
                        var empty = document.createElement("p");
                        empty.className = "tv-empty";
                        empty.textContent = "No episodes for this season yet.";
                        episodeTrack.appendChild(empty);
                        return;
                    }

                    firstEpisode = episodes[0];
                    episodes.forEach(function (episode) {
                        episodeTrack.appendChild(createEpisodeCard(id, number, episode, seriesTitle));
                    });

                    playLabel.textContent = "Play S" + number + " E" + firstEpisode.episode_number;
                    if (focusEpisodes) {
                        var first = episodeTrack.querySelector("[data-tv-item]");
                        if (first) focusItem(first);
                    }
                })
                .catch(function (err) {
                    if (token !== seasonToken) return;
                    if (window.console) console.error("[tvui] season failed", err);
                    episodesTitle.textContent = "Episodes";
                    var message = document.createElement("p");
                    message.className = "tv-empty";
                    message.textContent = "Could not load the episodes for this season.";
                    episodeTrack.appendChild(message);
                });
        }

        function renderSeries(data) {
            fillHero(data);
            seasons = (data.seasons || []).filter(function (season) {
                return season.season_number !== undefined;
            });

            if (!seasons.length) {
                episodesSection.hidden = true;
                playButton.disabled = true;
                return;
            }

            episodesSection.hidden = false;
            seasonTrack.innerHTML = "";
            seasons.forEach(function (season) {
                var pill = document.createElement("button");
                pill.type = "button";
                pill.className = "tv-pill";
                pill.setAttribute("data-tv-item", "");
                pill.setAttribute("data-season", String(season.season_number));
                pill.setAttribute("aria-pressed", "false");
                pill.textContent = season.season_number === 0
                    ? "Specials"
                    : "Season " + season.season_number;
                pill.addEventListener("click", function () {
                    if (currentSeason === season.season_number) return;
                    loadSeason(season.season_number, true);
                });
                seasonTrack.appendChild(pill);
            });

            var requested = Number(params.get("season"));
            var defaultSeason = seasons.find(function (season) {
                return season.season_number === requested;
            }) || seasons.find(function (season) {
                return season.season_number === 1;
            }) || seasons[0];

            loadSeason(defaultSeason.season_number, false);

            playButton.addEventListener("click", function () {
                if (!firstEpisode) return;
                window.location.href = watchUrl({
                    type: "tv",
                    id: id,
                    season: currentSeason,
                    episode: firstEpisode.episode_number,
                    title: seriesTitle
                });
            });
        }

        var endpoint = type === "tv" ? "/api/tv/info" : "/api/movies/info";
        postJSON(endpoint, { q: id })
            .then(function (data) {
                if (type === "tv") renderSeries(data);
                else renderMovie(data);

                // Preview the title in the hero: trailer when TMDB has one,
                // otherwise the backdrop stays as the banner.
                var media = document.querySelector(".tv-info-media");
                loadTrailer(type, id).then(function (key) {
                    if (key) mountTrailer(media, key);
                });
            })
            .catch(function (err) {
                if (window.console) console.error("[tvui] info failed", err);
                title.textContent = "Something went wrong";
                overview.textContent = "We could not load this title. Press Back to keep browsing.";
                meta.innerHTML = "";
                episodesSection.hidden = true;
            });
    }

    /* ------------------------------------------------------------------ *
     * Watch page
     * ------------------------------------------------------------------ */

    function bootWatch() {
        var iframe = document.getElementById("tv-player");
        var back = document.body.getAttribute("data-tv-back") || "/tvui/home";

        function leave() {
            window.location.href = back;
        }

        function wirePlayer() {
            try {
                var doc = iframe.contentDocument;
                if (!doc || doc.__wlTvWired) return;
                doc.__wlTvWired = true;

                // Remote back (Esc / Backspace / LG's 461) returns to the TV UI.
                doc.addEventListener("keydown", function (event) {
                    var key = event.key;
                    if (key === "Escape" || key === "Backspace" || key === "BrowserBack" || event.keyCode === 8 || event.keyCode === 27 || event.keyCode === 461) {
                        event.preventDefault();
                        leave();
                        return;
                    }
                    // TVs usually send Enter for the OK button; the player's own
                    // shortcuts use Space, so map Enter to play/pause.
                    if (key === "Enter" || event.keyCode === 13) {
                        var playButton = doc.getElementById("wl-play");
                        if (playButton) {
                            event.preventDefault();
                            playButton.click();
                        }
                    }
                });

                // The player's back arrow would reload the embed inside itself;
                // send it to the TV info page instead.
                var backButton = doc.getElementById("wl-back");
                if (backButton) {
                    backButton.addEventListener("click", function (event) {
                        event.preventDefault();
                        event.stopPropagation();
                        leave();
                    }, true);
                }
            } catch (err) {
                /* cross-origin embed: the parent listener below still works */
            }
        }

        if (!iframe) return;
        iframe.addEventListener("load", wirePlayer);
        wirePlayer();

        try { iframe.focus(); } catch (err) { /* ignore */ }

        document.addEventListener("keydown", function (event) {
            if (isBackKey(event)) {
                event.preventDefault();
                leave();
            }
        });
    }

    /* ------------------------------------------------------------------ *
     * Profile selector
     * ------------------------------------------------------------------ */

    function bootProfiles() {
        focusFirst();

        loadFeed("all").then(function (feed) {
            var pick = (feed.hero || []).filter(function (item) { return item.backdrop; })[0];
            var background = document.getElementById("profiles-bg");
            if (pick && background) {
                background.style.backgroundImage = "url('" + image(pick.backdrop, "original") + "')";
            }
        }).catch(function () { /* gradient background is fine */ });
    }

    /* ------------------------------------------------------------------ *
     * Bootstrap
     * ------------------------------------------------------------------ */

    document.addEventListener("DOMContentLoaded", function () {
        startClock();
        installNavigation();

        var page = document.body.getAttribute("data-tv-page");
        if (page === "browse") bootBrowse();
        else if (page === "search") bootSearch();
        else if (page === "info") bootInfo();
        else if (page === "watch") bootWatch();
        else if (page === "profiles") bootProfiles();
    });

    // Small public surface for page-specific scripts, if one is ever needed.
    window.TVUI = {
        image: image,
        loadFeed: loadFeed,
        focusFirst: focusFirst,
        goBack: goBack
    };
})();
