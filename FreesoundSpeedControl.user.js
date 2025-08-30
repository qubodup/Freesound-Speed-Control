// ==UserScript==
// @name         Freesound Speed Control
// @namespace    https://freesound.org/
// @version      2025-08-30
// @description  Quick speed buttons and custom playback rate input to Freesound players
// @author       Who me
// @match        *://*.freesound.org/*
// @icon         https://freesound.org/static/img/favicon.ico
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';
    const SPEEDS = [.25, .5, 1, 2, 3, 4, 8, 12, 16];
    const STORE_KEY = 'fs_speed';
    const MIN_RATE = 0.1;
    const MAX_RATE = 16; // more might not work

    GM_addStyle(`
.tm-speedbar.top-left {
  position: absolute;
  top: 4px;
  left: 4px;
  margin: 0;
  z-index: 1000;
  pointer-events: none; /* bar itself ignores clicks */
}
.tm-speedbar.top-left * {
  pointer-events: auto; /* children (buttons/inputs) still clickable */
}
    .tm-speedbar--fallback {
      position: relative;
      z-index: 1;
      display: inline-flex;
      margin: .4rem 0 .2rem;
    }
    .tm-speed-btn, .tm-speed-input {
      font: inherit;
      line-height: 1;
      padding: .05rem .05rem;
      border-radius: .2rem;
      border: 1px solid rgba(0,0,0,.2);
      background: rgba(255,255,255,.75);
      cursor: pointer;
    }
    .tm-speed-btn:hover { background: rgba(255,255,255,.95); }
    .tm-speed-btn.tm-active {
      border-color: #3a7afe;
    }
    .tm-speed-input {
      width: 3.5rem;
      text-align: center;
    }
    .tm-speed-label {
      opacity: .9;
      font-size: 0.8em;
      margin-right: .1rem;
      user-select: none;
    }
  `);

    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const saveRate = (rate) => localStorage.setItem(STORE_KEY, String(rate));
    const loadRate = () => {
        const v = parseFloat(localStorage.getItem(STORE_KEY) || '1');
        return Number.isFinite(v) ? clamp(v, MIN_RATE, MAX_RATE) : 1;
    };

    // INITIAL_RATE is the page-load default (read from storage once).
    // Changing a single player's rate will persist to storage for future reloads,
    // but won't change INITIAL_RATE for this session. GLOBAL_RATE (below)
    // is only set when Apply-to-all is used.
    const INITIAL_RATE = loadRate();
    let GLOBAL_RATE = null; // session-only override set only by Apply-to-all

    function getEffectiveRate() {
        return GLOBAL_RATE !== null ? GLOBAL_RATE : INITIAL_RATE;
    }

    function findAudio(root) {
        // Prefer an <audio> inside the player; fall back to sibling search
        let audio = root.querySelector('audio');
        if (!audio) {
            const maybe = root.nextElementSibling;
            if (maybe && maybe.tagName === 'AUDIO') audio = maybe;
        }
        return audio;
    }

    function makeButton(rate, apply) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tm-speed-btn';
        btn.textContent = `${rate}`;
        btn.dataset.rate = String(rate);
        btn.addEventListener('click', () => apply(rate));
        return btn;
    }

    function enhancePlayer(player) {
        if (!player || player.__tmEnhanced) return;
        const audio = findAudio(player);
        if (!audio) return; // nothing to do

        player.__tmEnhanced = true;

        // Try to insert alongside native controls
        const controlsBar =
              player.querySelector('.bw-player__controls') ||
              player.querySelector('.bw-player__controls--big');

        const bar = document.createElement('div');
        bar.className = 'tm-speedbar top-left';
        if (!controlsBar) bar.classList.add('tm-speedbar--fallback');

        // Insert it at the very beginning of the player container
        player.style.position = 'relative'; // ensure positioning context
        player.prepend(bar);

        const label = document.createElement('span');
        label.className = 'tm-speed-label';
        label.textContent = '';
        bar.appendChild(label);

        // We'll create rate buttons but the apply target (setRate) below
        // will only affect THIS player and won't change GLOBAL_RATE.
        const rateBtns = SPEEDS.map((r) => makeButton(r, setRate));
        rateBtns.forEach((b) => bar.appendChild(b));

        // Custom input
        const input = document.createElement('input');
        input.className = 'tm-speed-input';
        input.type = 'number';
        input.step = '0.1';
        input.min = String(MIN_RATE);
        input.max = String(MAX_RATE);
        input.placeholder = 'custom×';
        input.title = `Enter custom speed (${MIN_RATE}–${MAX_RATE})`;
        function handleInputEvent() {
            const val = clamp(parseFloat(input.value || 'NaN'), MIN_RATE, MAX_RATE);
            if (Number.isFinite(val)) setRate(val);
        }

        input.addEventListener('input', handleInputEvent);   // fires on every increment (live)
        input.addEventListener('change', handleInputEvent);  // safety for manual edits

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
        });
        bar.appendChild(input);

        // --- Reverse playback toggle button ---
        const reverseBtn = document.createElement('button');
        reverseBtn.type = 'button';
        reverseBtn.className = 'tm-speed-btn';
        reverseBtn.textContent = '⇋';
        reverseBtn.title = 'Toggle reverse playback';
        bar.appendChild(reverseBtn);

        let reverseCtx = null;
        let reverseSource = null;
        let reverseRAF = null;
        let reverseStartOffset = 0;
        let reverseDuration = 0;
        let reverseStartCtxTime = 0;

        // progress indicator + container
        const indicator = player.querySelector('.bw-player__progress-indicator');
        const indicatorContainer = player.querySelector('.bw-player__progress-indicator-container');

        function stopReverse(commitTime = false) {
            if (reverseSource) {
                try { reverseSource.stop(); } catch (_) {}
                try { reverseSource.disconnect(); } catch (_) {}
                reverseSource = null;
            }
            if (reverseRAF) {
                cancelAnimationFrame(reverseRAF);
                reverseRAF = null;
            }
            if (indicator) indicator.style.transform = '';

            if (commitTime && reverseDuration > 0) {
                const elapsed = (reverseCtx.currentTime - reverseStartCtxTime) * (audio.playbackRate || 1);
                const T = Math.max(0, reverseStartOffset - elapsed);
                audio.currentTime = T;
            }

            reverseBtn.classList.remove('tm-active');
        }

        reverseBtn.addEventListener('click', async () => {
            // If already reversing, stop and commit to forward audio
            if (reverseSource) {
                stopReverse(true);
                audio.play();
                return;
            }

            // Start reverse playback
            audio.pause();
            stopReverse();

            if (!reverseCtx) reverseCtx = new (window.AudioContext || window.webkitAudioContext)();

            try {
                // --- Cache reversed buffer per player ---
                if (!player.__tmReverseBuffer) {
                    const resp = await fetch(audio.currentSrc);
                    const ab = await resp.arrayBuffer();
                    const decoded = await reverseCtx.decodeAudioData(ab);

                    // Reverse PCM once
                    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
                        decoded.getChannelData(ch).reverse();
                    }
                    player.__tmReverseBuffer = decoded;
                }

                const decoded = player.__tmReverseBuffer;
                reverseDuration = decoded.duration;
                reverseStartOffset = audio.currentTime > 0 ? audio.currentTime : reverseDuration;
                const reversedOffset = reverseDuration - reverseStartOffset;

                reverseSource = reverseCtx.createBufferSource();
                reverseSource.buffer = decoded;
                reverseSource.playbackRate.value = audio.playbackRate || 1;
                reverseSource.loop = audio.loop; //mirror the loop state
                reverseSource.connect(reverseCtx.destination);

                // If not looping, start at reversedOffset as before
                reverseSource.start(0, reversedOffset);

                reverseStartCtxTime = reverseCtx.currentTime;
                reverseBtn.classList.add('tm-active');

                // Animate progress indicator backwards
                if (indicator && indicatorContainer) {
                    const width = indicatorContainer.offsetWidth || 0;
                    function step() {
                        if (!reverseSource) return;
                        const rate = audio.playbackRate || 1;
                        const elapsed = (reverseCtx.currentTime - reverseStartCtxTime) * rate;

                        let T;
                        if (reverseSource.loop) {
                            //Loop mode: wrap elapsed into duration
                            const cycleTime = (reverseStartOffset - elapsed) % reverseDuration;
                            T = (cycleTime <= 0 ? cycleTime + reverseDuration : cycleTime);
                        } else {
                            // Non-loop mode: clamp at 0
                            T = Math.max(0, reverseStartOffset - elapsed);
                        }

                        const percent = T / reverseDuration;
                        const x = -((1 - percent) * width);
                        indicator.style.transform = `translateX(${x}px)`;

                        if (!reverseSource.loop && T <= 0) {
                            stopReverse(true);
                            return;
                        }

                        reverseRAF = requestAnimationFrame(step);
                    }
                    reverseRAF = requestAnimationFrame(step);
                }

                // Clean up on end (non-looping)
                if (!reverseSource.loop) {
                    reverseSource.onended = () => stopReverse(true);
                } else {
                    reverseSource.onended = null;
                }

            } catch (err) {
                console.error('[FS Speed] Reverse playback failed:', err);
                stopReverse();
            }
        });

        // Stop reverse if forward play or Stop button pressed
        audio.addEventListener('play', () => stopReverse());
        const stopBtn = player.querySelector('.bw-icon-stop');
        if (stopBtn) stopBtn.closest('button')?.addEventListener('click', () => stopReverse());

        // If user changes speed mid-reverse, update rate
        audio.addEventListener('ratechange', () => {
            if (reverseSource) reverseSource.playbackRate.value = audio.playbackRate || 1;
        });

        // --- Stop button (local stop for this player) ---
        const stopLocalBtn = document.createElement('button');
        stopLocalBtn.type = 'button';
        stopLocalBtn.className = 'tm-speed-btn';
        stopLocalBtn.textContent = '⏹';
        stopLocalBtn.title = 'Stop playback for this player';
        bar.appendChild(stopLocalBtn);

        stopLocalBtn.addEventListener('click', () => {
            // stop reverse playback if active
            stopReverse();
            // stop forward playback
            try { audio.pause(); } catch(_) {}
            audio.currentTime = 0;
        });

        // --- Apply-to-all button ---
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'tm-speed-btn';
        applyBtn.textContent = '⇉';
        applyBtn.title = 'Apply current speed to all players on this page';
        bar.appendChild(applyBtn);

        applyBtn.addEventListener('click', () => {
            const rate = audio.playbackRate || 1;
            GLOBAL_RATE = rate;      // session override applied to all players
            saveRate(rate);          // also persist as the new default for reloads
            // Update the in-memory INITIAL_RATE? No — INITIAL_RATE should remain the page-load default,
            // but we persisted so reload will pick it up. For in-session new players we use GLOBAL_RATE.
            document.querySelectorAll('.bw-player').forEach((pl) => {
                if (pl === player) return;
                if (pl.__tmApplyRate) {
                    pl.__tmApplyRate(rate);
                } else {
                    const a = findAudio(pl);
                    if (a) {
                        try { a.playbackRate = rate; } catch(_) {}
                    }
                }
            });
        });

        // Initialize this player using session-global if set, otherwise the page-load initial rate
        applyRate(getEffectiveRate());

        // Re-apply rate when the <audio> element reloads or is recreated
        audio.addEventListener('loadedmetadata', () => {
            applyRate(getEffectiveRate());
        });
        audio.addEventListener('play', () => {
            const eff = getEffectiveRate();
            if (Math.abs(audio.playbackRate - eff) > 0.001) {
                applyRate(eff);
            }
        });

        // Keep UI in sync if something else changes the playbackRate
        audio.addEventListener('ratechange', syncUI);
        syncUI();

        // Optional: improve pitch handling (supported in most modern browsers)
        try {
            audio.preservesPitch = false;
            audio.mozPreservesPitch = false;
            audio.webkitPreservesPitch = false;
        } catch (_) { }

        // setRate: affects THIS player only. it persists the choice for future reloads,
        // but does NOT set GLOBAL_RATE (so it won't apply to other players right now).
        function setRate(v) {
            applyRate(v);
            saveRate(v); // persist so a page reload will use this new default
            // NOTE: we intentionally DO NOT set GLOBAL_RATE here.
        }

        function applyRate(v) {
            // Expose applyRate+syncUI so other players can be updated by Apply-to-all
            player.__tmApplyRate = applyRate;

            const rate = clamp(v, MIN_RATE, MAX_RATE);
            try {
                audio.playbackRate = rate;
            } catch (e) {
                console.warn('[FS Speed] Failed to set rate', e);
            }
            syncUI();
        }

        function syncUI() {
            const r = Math.round((audio.playbackRate || 1) * 100) / 100;
            rateBtns.forEach((b) => {
                const same = Math.abs(parseFloat(b.dataset.rate) - r) < 0.001;
                b.classList.toggle('tm-active', same);
            });
            input.value = String(r);
        }
    }

    // Enhance any existing players
    document.querySelectorAll('.bw-player').forEach(enhancePlayer);

    // Observe dynamically added players (Freesound loads content dynamically)
    const mo = new MutationObserver((muts) => {
        for (const m of muts) {
            m.addedNodes.forEach((n) => {
                if (!(n instanceof HTMLElement)) return;
                if (n.matches && n.matches('.bw-player')) enhancePlayer(n);
                n.querySelectorAll && n.querySelectorAll('.bw-player').forEach(enhancePlayer);
            });
        }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });

})();
