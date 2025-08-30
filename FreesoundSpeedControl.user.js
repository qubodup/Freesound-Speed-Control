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
  pointer-events: none;
}
.tm-speedbar.top-left * { pointer-events: auto; }
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
.tm-speed-btn.tm-active { border-color: #3a7afe; }
.tm-speed-input { width: 3.5rem; text-align: center; }
.tm-speed-label { opacity: .9; font-size: 0.8em; margin-right: .1rem; user-select: none; }
  `);

    const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
    const saveRate = (rate) => localStorage.setItem(STORE_KEY, String(rate));
    const loadRate = () => {
        const v = parseFloat(localStorage.getItem(STORE_KEY) || '1');
        return Number.isFinite(v) ? clamp(v, MIN_RATE, MAX_RATE) : 1;
    };

    // Session-global override set ONLY by "Apply-to-all"
    let GLOBAL_RATE = null;

    function findAudio(root) {
        let audio = root.querySelector('audio');
        if (!audio) {
            const maybe = root.nextElementSibling;
            if (maybe && maybe.tagName === 'AUDIO') audio = maybe;
        }
        return audio;
    }

    // NOTE: makeButton no longer tries to touch any input directly (prevents cross-player bleed).
    function makeButton(rate, apply) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tm-speed-btn';
        btn.textContent = `${rate}`;
        btn.dataset.rate = String(rate);
        btn.addEventListener('click', () => apply(rate));
        return btn;
    }

    // Only the first enhanced player should auto-load the saved/default rate
    let appliedInitialOnce = false;

    function enhancePlayer(player) {
        if (!player || player.__tmEnhanced) return;
        const audio = findAudio(player);
        if (!audio) return;

        player.__tmEnhanced = true;

        const controlsBar =
              player.querySelector('.bw-player__controls') ||
              player.querySelector('.bw-player__controls--big');

        const bar = document.createElement('div');
        bar.className = 'tm-speedbar top-left';
        if (!controlsBar) bar.classList.add('tm-speedbar--fallback');

        player.style.position = 'relative';
        player.prepend(bar);

        const label = document.createElement('span');
        label.className = 'tm-speed-label';
        label.textContent = '';
        bar.appendChild(label);

        // Create custom input first so inner closures can reference it safely
        const input = document.createElement('input');
        input.className = 'tm-speed-input';
        input.type = 'number';
        input.step = '0.1';
        input.min = String(MIN_RATE);
        input.max = String(MAX_RATE);
        input.placeholder = 'custom×';
        input.title = `Enter custom speed (${MIN_RATE}–${MAX_RATE})`;
        bar.appendChild(input);

        // Buttons (they call setRate; setRate/applyRate/syncUI update input & highlight)
        const rateBtns = SPEEDS.map((r) => makeButton(r, setRate));
        rateBtns.forEach((b) => bar.appendChild(b));

        function handleInputEvent() {
            const val = clamp(parseFloat(input.value || 'NaN'), MIN_RATE, MAX_RATE);
            if (Number.isFinite(val)) setRate(val);
        }
        input.addEventListener('input', handleInputEvent);
        input.addEventListener('change', handleInputEvent);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });

        // --- Reverse playback toggle (unchanged logic) ---
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

            if (commitTime && reverseDuration > 0 && reverseCtx) {
                const elapsed = (reverseCtx.currentTime - reverseStartCtxTime) * (audio.playbackRate || 1);
                const T = Math.max(0, reverseStartOffset - elapsed);
                audio.currentTime = T;
            }

            reverseBtn.classList.remove('tm-active');
        }

        reverseBtn.addEventListener('click', async () => {
            if (reverseSource) {
                stopReverse(true);
                audio.play();
                return;
            }
            audio.pause();
            stopReverse();

            if (!reverseCtx) reverseCtx = new (window.AudioContext || window.webkitAudioContext)();
            try {
                if (!player.__tmReverseBuffer) {
                    const resp = await fetch(audio.currentSrc);
                    const ab = await resp.arrayBuffer();
                    const decoded = await reverseCtx.decodeAudioData(ab);
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
                reverseSource.loop = audio.loop;
                reverseSource.connect(reverseCtx.destination);
                reverseSource.start(0, reversedOffset);

                reverseStartCtxTime = reverseCtx.currentTime;
                reverseBtn.classList.add('tm-active');

                if (indicator && indicatorContainer) {
                    const width = indicatorContainer.offsetWidth || 0;
                    const step = () => {
                        if (!reverseSource) return;
                        const rate = audio.playbackRate || 1;
                        const elapsed = (reverseCtx.currentTime - reverseStartCtxTime) * rate;

                        let T;
                        if (reverseSource.loop) {
                            const cycleTime = (reverseStartOffset - elapsed) % reverseDuration;
                            T = (cycleTime <= 0 ? cycleTime + reverseDuration : cycleTime);
                        } else {
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
                    };
                    reverseRAF = requestAnimationFrame(step);
                }

                reverseSource.onended = reverseSource.loop ? null : () => stopReverse(true);
            } catch (err) {
                console.error('[FS Speed] Reverse playback failed:', err);
                stopReverse();
            }
        });

        audio.addEventListener('play', () => stopReverse());
        const stopBtn = player.querySelector('.bw-icon-stop');
        if (stopBtn) stopBtn.closest('button')?.addEventListener('click', () => stopReverse());

        audio.addEventListener('ratechange', () => {
            if (reverseSource) reverseSource.playbackRate.value = audio.playbackRate || 1;
        });

        // Local stop
        const stopLocalBtn = document.createElement('button');
        stopLocalBtn.type = 'button';
        stopLocalBtn.className = 'tm-speed-btn';
        stopLocalBtn.textContent = '⏹';
        stopLocalBtn.title = 'Stop playback for this player';
        bar.appendChild(stopLocalBtn);
        stopLocalBtn.addEventListener('click', () => {
            stopReverse();
            try { audio.pause(); } catch(_) {}
            audio.currentTime = 0;
        });

        // Apply-to-all
        const applyBtn = document.createElement('button');
        applyBtn.type = 'button';
        applyBtn.className = 'tm-speed-btn';
        applyBtn.textContent = '⇉';
        applyBtn.title = 'Apply current speed to all players on this page';
        bar.appendChild(applyBtn);

        applyBtn.addEventListener('click', () => {
            const rate = audio.playbackRate || 1;
            GLOBAL_RATE = rate;   // session override
            saveRate(rate);       // persist for reloads

            // Update every player on the page now
            document.querySelectorAll('.bw-player').forEach((pl) => {
                if (pl === player) return;
                if (pl.__tmApplyRate) {
                    pl.__tmApplyRate(rate); // will sync buttons + inputs
                } else {
                    const a = findAudio(pl);
                    if (a) {
                        try { a.playbackRate = rate; } catch(_) {}
                    }
                }
            });
        });

        // --- Core rule: PLAY uses what's in THIS player's input field ---
        audio.addEventListener('play', () => {
            const val = clamp(parseFloat(input.value || 'NaN'), MIN_RATE, MAX_RATE);
            if (Number.isFinite(val)) {
                applyRate(val);
            } else {
                // if input is empty/invalid, fall back to session-global (if set) or current audio rate
                const eff = GLOBAL_RATE !== null ? GLOBAL_RATE : (audio.playbackRate || 1);
                applyRate(eff);
            }
        });

        // Keep UI in sync if something else changes the playbackRate
        audio.addEventListener('ratechange', syncUI);

        // Optional: improve pitch handling
        try {
            audio.preservesPitch = false;
            audio.mozPreservesPitch = false;
            audio.webkitPreservesPitch = false;
        } catch (_) {}

        function setRate(v) {
            const rate = clamp(v, MIN_RATE, MAX_RATE);
            applyRate(rate);
            saveRate(rate); // for next page load
        }

        function applyRate(v) {
            player.__tmApplyRate = applyRate;
            const rate = clamp(v, MIN_RATE, MAX_RATE);
            try { audio.playbackRate = rate; } catch (e) {
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

        // --- Initial per-player setup ---
        const initRate = (GLOBAL_RATE !== null ? GLOBAL_RATE : loadRate());
        applyRate(initRate);
    }

    // Enhance existing players
    document.querySelectorAll('.bw-player').forEach(enhancePlayer);

    // Enhance dynamically added players
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
