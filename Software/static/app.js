/* ============================================================
   PORCH INTERCOM FRONTEND
   Python relay compatible

   Audio path matched to the known-good main(9).cpp / app(3).js:
   - raw PCM16 @ 16 kHz
   - no sequence header
   - 4096-sample ScriptProcessor microphone capture
   - scheduled playback using nextPlayTime
   ============================================================ */

const AUDIO_RATE = 16000;

const state = {
    ws: null,
    callActive: false,
    connecting: false,

    phoneMicEnabled: true,
    phoneSpeakerEnabled: true,

    audioContext: null,
    micStream: null,
    micSource: null,
    scriptProcessor: null,

    playbackGain: null,
    nextPlayTime: 0,

    txBytes: 0,
    rxBytes: 0,
    rxSamples: 0,

    callStartedAt: 0,
    callTimer: null
};

const $ = id => document.getElementById(id);


/* ============================================================
   LOGGING
   ============================================================ */

function log(tag, message) {
    const diagnostics = $("diagnostics");
    if (!diagnostics) return;

    const time = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    const line = document.createElement("div");

    line.className = "log-line";

    line.innerHTML =
        `<span class="log-tag">${time} [${tag}]</span> ${escapeHTML(message)}`;

    diagnostics.appendChild(line);

    while (diagnostics.children.length > 150) {
        diagnostics.removeChild(diagnostics.firstChild);
    }

    diagnostics.scrollTop = diagnostics.scrollHeight;
}


function escapeHTML(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}


function bytesText(n) {
    if (n < 1024) return `${n} B`;

    if (n < 1024 * 1024) {
        return `${(n / 1024).toFixed(1)} KB`;
    }

    return `${(n / 1024 / 1024).toFixed(2)} MB`;
}


/* ============================================================
   CAMERA
   ============================================================ */

function startCamera() {
    const camera = $("cameraStream");

    if (!camera) return;

    camera.src = "/video_feed";
}


/* ============================================================
   CONNECTION UI
   ============================================================ */

function setConnection(online, text) {
    const connection = $("connection");
    const label = $("connectionText");

    if (!connection || !label) return;

    connection.classList.toggle("online", online);
    label.textContent = text;
}


/* ============================================================
   CALL TIMER
   ============================================================ */

function startCallTimer() {
    state.callStartedAt = Date.now();

    updateCallTimer();

    state.callTimer =
        setInterval(updateCallTimer, 1000);
}


function updateCallTimer() {
    const elapsed =
        Math.floor(
            (Date.now() - state.callStartedAt) / 1000
        );

    const minutes =
        Math.floor(elapsed / 60);

    const seconds =
        elapsed % 60;

    $("callTime").textContent =
        `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}


function stopCallTimer() {
    if (state.callTimer) {
        clearInterval(state.callTimer);

        state.callTimer = null;
    }

    $("callTime").textContent = "00:00";
}


/* ============================================================
   CALL UI
   ============================================================ */

function showCallUI() {
    $("startCall").style.display = "none";

    $("callControls")
        .classList.add("visible");

    $("callState")
        .classList.add("visible");

    $("audioPanel")
        .classList.add("visible");
}


function hideCallUI() {
    $("startCall").style.display = "";

    $("callControls")
        .classList.remove("visible");

    $("callState")
        .classList.remove("visible");

    $("audioPanel")
        .classList.remove("visible");
}


/* ============================================================
   MICROPHONE UI
   ============================================================ */

function updateMicUI() {
    const button = $("micButton");
    const icon = $("micIcon");
    const stateText = $("micState");
    const route = $("phoneMicRoute");

    if (!button || !icon || !stateText || !route) {
        return;
    }

    if (state.phoneMicEnabled) {

        button.classList.add("mic-active");

        icon.className =
            "fa-solid fa-microphone";

        stateText.textContent = "ON";

        route.classList.add("active");

    } else {

        button.classList.remove("mic-active");

        icon.className =
            "fa-solid fa-microphone-slash";

        stateText.textContent = "MUTED";

        route.classList.remove("active");
    }
}


/* ============================================================
   SPEAKER UI
   ============================================================ */

function updateSpeakerUI() {
    const button = $("speakerButton");
    const icon = $("speakerIcon");
    const stateText = $("speakerState");
    const route = $("phoneSpeakerRoute");

    if (!button || !icon || !stateText || !route) {
        return;
    }

    if (state.phoneSpeakerEnabled) {

        button.classList.add("speaker-active");

        icon.className =
            "fa-solid fa-volume-high";

        stateText.textContent = "ON";

        route.classList.add("active");

    } else {

        button.classList.remove("speaker-active");

        icon.className =
            "fa-solid fa-volume-xmark";

        stateText.textContent = "MUTED";

        route.classList.remove("active");
    }

    if (state.playbackGain) {

        state.playbackGain.gain.value =
            state.phoneSpeakerEnabled ? 1.0 : 0.0;
    }
}


/* ============================================================
   AUDIO INITIALIZATION
   ============================================================ */

async function initAudio() {

    if (state.audioContext) {

        if (state.audioContext.state === "suspended") {
            await state.audioContext.resume();
        }

        return;
    }

    const AudioContext =
        window.AudioContext ||
        window.webkitAudioContext;

    if (!AudioContext) {
        throw new Error(
            "Web Audio is not supported."
        );
    }

    state.audioContext =
        new AudioContext();

    state.playbackGain =
        state.audioContext.createGain();

    state.playbackGain.gain.value =
        state.phoneSpeakerEnabled ? 1.0 : 0.0;

    state.playbackGain.connect(
        state.audioContext.destination
    );

    state.nextPlayTime =
        state.audioContext.currentTime;

    await state.audioContext.resume();

    log(
        "AUDIO",
        `Audio context initialized (${state.audioContext.sampleRate} Hz)`
    );
}


/* ============================================================
   PHONE MICROPHONE
   ============================================================

   This intentionally follows the older app(3).js processing:

   Browser microphone
          ↓
   MediaStream
          ↓
   ScriptProcessor 4096
          ↓
   downsample to 16 kHz
          ↓
   PCM16
          ↓
   WebSocket
          ↓
   Python relay
          ↓
   ESP32

   NO sequence number.
   NO custom packet header.
   ============================================================ */

async function startPhoneMicrophone() {

    if (state.micStream) {
        return;
    }

    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {
        throw new Error(
            "Microphone access requires a secure browser context."
        );
    }

    await initAudio();

    state.micStream =
        await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            },
            video: false
        });

    const ctx =
        state.audioContext;

    if (ctx.state === "suspended") {
        await ctx.resume();
    }

    state.micSource =
        ctx.createMediaStreamSource(
            state.micStream
        );

    /*
     * Match the older app(3).js.
     */
    state.scriptProcessor =
        ctx.createScriptProcessor(
            4096,
            1,
            1
        );

    state.scriptProcessor.onaudioprocess =
        event => {

            if (!state.phoneMicEnabled) {
                return;
            }

            if (
                !state.ws ||
                state.ws.readyState !== WebSocket.OPEN
            ) {
                return;
            }

            const input =
                event.inputBuffer
                    .getChannelData(0);

            const pcm =
                downsampleTo16k(
                    input,
                    ctx.sampleRate
                );

            if (!pcm.length) {
                return;
            }

            /*
             * IMPORTANT:
             *
             * Raw PCM16 only.
             *
             * No:
             *   sequence number
             *   packet header
             *   644-byte framing
             */
            state.ws.send(
                pcm.buffer
            );

            state.txBytes +=
                pcm.byteLength;

            const txMetric =
                $("txMetric");

            if (txMetric) {
                txMetric.textContent =
                    bytesText(state.txBytes);
            }
        };

    state.micSource.connect(
        state.scriptProcessor
    );

    /*
     * Keep ScriptProcessor alive without
     * feeding microphone audio back to
     * the phone speaker.
     */
    const silentGain =
        ctx.createGain();

    silentGain.gain.value = 0;

    state.scriptProcessor.connect(
        silentGain
    );

    silentGain.connect(
        ctx.destination
    );

    log(
        "MIC",
        `Microphone ready at ${ctx.sampleRate} Hz`
    );
}


/* ============================================================
   DOWNsample BROWSER AUDIO TO 16 kHz
   ============================================================ */

function downsampleTo16k(input, inputRate) {

    /*
     * Already 16 kHz.
     */
    if (inputRate === AUDIO_RATE) {

        const output =
            new Int16Array(
                input.length
            );

        for (
            let i = 0;
            i < input.length;
            i++
        ) {

            let s = input[i];

            if (s > 1) s = 1;
            if (s < -1) s = -1;

            output[i] =
                s < 0
                    ? s * 32768
                    : s * 32767;
        }

        return output;
    }


    /*
     * Browser normally runs at
     * 44.1 kHz or 48 kHz.
     */
    const ratio =
        inputRate / AUDIO_RATE;

    const outputLength =
        Math.floor(
            input.length / ratio
        );

    if (outputLength <= 0) {
        return new Int16Array(0);
    }

    const output =
        new Int16Array(
            outputLength
        );

    let inputIndex = 0;

    for (
        let i = 0;
        i < outputLength;
        i++
    ) {

        const nextIndex =
            Math.min(
                input.length,
                Math.floor(
                    (i + 1) * ratio
                )
            );

        let sum = 0;
        let count = 0;

        while (
            inputIndex < nextIndex
        ) {

            sum +=
                input[inputIndex++];

            count++;
        }

        let s =
            count
                ? sum / count
                : 0;

        if (s > 1) s = 1;
        if (s < -1) s = -1;

        output[i] =
            s < 0
                ? s * 32768
                : s * 32767;
    }

    return output;
}


/* ============================================================
   STOP PHONE MICROPHONE
   ============================================================ */

function stopPhoneMicrophone() {

    if (state.micStream) {

        state.micStream
            .getTracks()
            .forEach(
                track => track.stop()
            );

        state.micStream = null;
    }

    if (state.micSource) {

        try {
            state.micSource.disconnect();
        } catch {}

        state.micSource = null;
    }

    if (state.scriptProcessor) {

        try {
            state.scriptProcessor.disconnect();
        } catch {}

        state.scriptProcessor = null;
    }
}


/* ============================================================
   ESP32 MICROPHONE → BROWSER SPEAKER
   ============================================================

   This is intentionally the older raw PCM playback path.

   ESP32
      ↓
   raw PCM16 @ 16 kHz
      ↓
   WebSocket
      ↓
   Python relay
      ↓
   browser
      ↓
   AudioBuffer
      ↓
   nextPlayTime scheduler
      ↓
   speaker
   ============================================================ */

function handleIncomingAudio(data) {

    if (!(data instanceof ArrayBuffer)) {
        return;
    }

    if (data.byteLength < 2) {
        return;
    }

    state.rxBytes +=
        data.byteLength;

    state.rxSamples +=
        data.byteLength / 2;

    const rxMetric =
        $("rxMetric");

    if (rxMetric) {

        rxMetric.textContent =
            bytesText(state.rxBytes);
    }

    /*
     * Raw PCM16.
     */
    const samples =
        new Int16Array(data);


    /*
     * Signal meter.
     */
    let peak = 0;

    for (
        let i = 0;
        i < samples.length;
        i++
    ) {

        const amplitude =
            Math.abs(samples[i]);

        if (amplitude > peak) {
            peak = amplitude;
        }
    }

    const level =
        Math.min(
            100,
            Math.round(
                peak / 327.68
            )
        );

    updateSignalMeter(level);


    /*
     * Speaker muted?
     */
    if (!state.phoneSpeakerEnabled) {
        return;
    }

    playPCM16(samples);
}


/* ============================================================
   SIGNAL METER
   ============================================================ */

function updateSignalMeter(level) {

    const signalValue =
        $("signalValue");

    if (signalValue) {

        signalValue.textContent =
            level;
    }

    const bars =
        document.querySelectorAll(
            "#callControls .signal-bars span, " +
            "#inCallControls .signal-bars span"
        );

    const activeCount =
        Math.round(
            (level / 100) *
            bars.length
        );

    bars.forEach(
        (bar, i) => {

            const active =
                i < activeCount;

            bar.style.background =
                active
                    ? "var(--green)"
                    : "var(--border)";
        }
    );
}


/* ============================================================
   RAW PCM16 PLAYBACK
   ============================================================ */

function playPCM16(samples) {

    try {

        if (!state.audioContext) {
            return;
        }

        const ctx =
            state.audioContext;

        if (ctx.state === "suspended") {
            ctx.resume();
        }


        /*
         * Create a 16 kHz mono
         * AudioBuffer.
         */
        const audio =
            ctx.createBuffer(
                1,
                samples.length,
                AUDIO_RATE
            );

        const channel =
            audio.getChannelData(0);


        /*
         * Convert PCM16 → Float32.
         */
        for (
            let i = 0;
            i < samples.length;
            i++
        ) {

            channel[i] =
                samples[i] / 32768;
        }


        const source =
            ctx.createBufferSource();

        source.buffer =
            audio;

        source.connect(
            state.playbackGain
        );


        const duration =
            samples.length /
            AUDIO_RATE;

        const current =
            ctx.currentTime;


        /*
         * IMPORTANT JITTER CONTROL
         *
         * Don't play each WebSocket
         * packet immediately.
         *
         * Maintain a continuous
         * playback timeline.
         */
        if (
            state.nextPlayTime <
            current
        ) {

            state.nextPlayTime =
                current + 0.015;
        }


        source.start(
            state.nextPlayTime
        );


        state.nextPlayTime +=
            duration;


        const route =
            $("phoneSpeakerRoute");

        const espRoute =
            $("espMicRoute");

        if (route) {
            route.classList.add("active");
        }

        if (espRoute) {
            espRoute.classList.add("active");
        }

    } catch (err) {

        log(
            "AUDIO",
            `Playback error: ${err.message || err}`
        );
    }
}


/* ============================================================
   CONNECT CALL
   ============================================================ */

async function connectCall() {

    if (
        state.callActive ||
        state.connecting
    ) {
        return;
    }

    state.connecting = true;

    $("startCall").disabled =
        true;

    $("callStateText").textContent =
        "CONNECTING";

    $("callState")
        .classList.add("visible");


    try {

        await initAudio();


        /*
         * Current application uses
         * the Python relay on /ws/audio.
         */
        const protocol =
            location.protocol === "https:"
                ? "wss:"
                : "ws:";

        const wsUrl =
            `${protocol}//${location.host}/ws/audio`;

        log(
            "WSS",
            `Connecting to ${wsUrl}`
        );


        const ws =
            new WebSocket(wsUrl);

        state.ws = ws;

        ws.binaryType =
            "arraybuffer";


        /* ----------------------------------------------------
           OPEN
           ---------------------------------------------------- */

        ws.onopen =
            async () => {

                log(
                    "WSS",
                    "Connected to Python relay"
                );

                state.callActive =
                    true;

                state.connecting =
                    false;


                /*
                 * Start playback timeline
                 * cleanly at the beginning
                 * of each call.
                 */
                state.nextPlayTime =
                    state.audioContext
                        .currentTime;


                setConnection(
                    true,
                    "CONNECTED"
                );

                $("callStateText")
                    .textContent =
                    "IN CALL";

                showCallUI();

                startCallTimer();


                try {

                    await startPhoneMicrophone();

                    state.phoneMicEnabled =
                        true;

                    updateMicUI();

                } catch (err) {

                    state.phoneMicEnabled =
                        false;

                    updateMicUI();

                    log(
                        "MIC",
                        `Microphone error: ${err.message || err}`
                    );
                }

                updateSpeakerUI();
            };


        /* ----------------------------------------------------
           MESSAGE
           ---------------------------------------------------- */

        ws.onmessage =
            async event => {

                /*
                 * Text messages are ignored.
                 */
                if (
                    typeof event.data ===
                    "string"
                ) {
                    return;
                }


                /*
                 * Normal WebSocket
                 * ArrayBuffer.
                 */
                if (
                    event.data instanceof
                    ArrayBuffer
                ) {

                    handleIncomingAudio(
                        event.data
                    );

                    return;
                }


                /*
                 * Some browsers may provide
                 * a Blob.
                 */
                if (
                    event.data instanceof Blob
                ) {

                    const buffer =
                        await event.data.arrayBuffer();

                    handleIncomingAudio(
                        buffer
                    );
                }
            };


        /* ----------------------------------------------------
           ERROR
           ---------------------------------------------------- */

        ws.onerror =
            () => {

                log(
                    "WSS",
                    "WebSocket Error"
                );
            };


        /* ----------------------------------------------------
           CLOSE
           ---------------------------------------------------- */

        ws.onclose =
            () => {

                finishCall();
            };

    } catch (err) {

        state.connecting =
            false;

        $("startCall").disabled =
            false;

        $("callStateText")
            .textContent =
            "CONNECTION FAILED";

        log(
            "CALL",
            err.message ||
            String(err)
        );
    }
}


/* ============================================================
   END CALL
   ============================================================ */

function finishCall() {

    stopPhoneMicrophone();


    if (state.audioContext) {

        state.audioContext
            .suspend()
            .catch(() => {});
    }


    state.callActive =
        false;

    state.connecting =
        false;

    state.ws =
        null;


    setConnection(
        false,
        "OFFLINE"
    );

    stopCallTimer();


    $("callStateText")
        .textContent =
        "CONNECTED";


    hideCallUI();


    $("startCall").disabled =
        false;
}


/* ============================================================
   HANG UP
   ============================================================ */

function hangUp() {

    if (state.ws) {

        try {

            state.ws.close(
                1000,
                "User hangup"
            );

        } catch {}
    }

    finishCall();
}


/* ============================================================
   MICROPHONE TOGGLE
   ============================================================ */

function toggleMicrophone() {

    if (!state.callActive) {
        return;
    }

    state.phoneMicEnabled =
        !state.phoneMicEnabled;

    updateMicUI();
}


/* ============================================================
   SPEAKER TOGGLE
   ============================================================ */

function toggleSpeaker() {

    if (!state.callActive) {
        return;
    }

    state.phoneSpeakerEnabled =
        !state.phoneSpeakerEnabled;

    updateSpeakerUI();
}


/* ============================================================
   STARTUP
   ============================================================ */

$("startCall").addEventListener(
    "click",
    connectCall
);


$("hangupButton").addEventListener(
    "click",
    hangUp
);


$("micButton").addEventListener(
    "click",
    toggleMicrophone
);


$("speakerButton").addEventListener(
    "click",
    toggleSpeaker
);


$("diagnosticsToggle").addEventListener(
    "click",
    () => {

        $("diagnostics")
            .classList
            .toggle("open");
    }
);


startCamera();

setConnection(
    false,
    "OFFLINE"
);

updateMicUI();

updateSpeakerUI();

/* ============================================================
   RANGA NAVIGATION + RECORDINGS
   Additive UI layer. Existing camera/call/audio path above is
   intentionally left unchanged.
   ============================================================ */

const recordingUI = {
    selectedId: null
};

function activateTab(name) {
    document.querySelectorAll(".main-tab").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.tab === name);
    });
    document.querySelectorAll(".tab-panel").forEach(panel => {
        panel.classList.toggle("active", panel.dataset.panel === name);
    });

    if (name === "storage") {
        loadStorage();
        loadRecordings();
    }
}

document.querySelectorAll(".main-tab").forEach(btn => {
    btn.addEventListener("click", () => activateTab(btn.dataset.tab));
});

function formatRecordingTime(value) {
    if (!value) return "Unknown time";
    const d = new Date(value.endsWith("Z") ? value : value.replace(" ", "T") + "Z");
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString([], {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
}

function recordingDuration(started, ended) {
    const a = new Date((started || "").replace(" ", "T") + (String(started).endsWith("Z") ? "" : "Z"));
    const b = new Date((ended || "").replace(" ", "T") + (String(ended).endsWith("Z") ? "" : "Z"));
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "";
    const sec = Math.max(0, Math.round((b - a) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}h ${String(m).padStart(2,"0")}m` : `${m}m ${String(s).padStart(2,"0")}s`;
}

function storageBytesText(n) {
    n = Number(n || 0);
    if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function loadStorage() {
    try {
        const r = await fetch("/api/storage", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();

        $("storageUsed").textContent = storageBytesText(data.used_bytes);
        $("storageAvailable").textContent = storageBytesText(data.available_bytes);
        $("storageLimit").textContent = storageBytesText(data.limit_bytes);

        const pct = data.limit_bytes
            ? Math.min(100, (data.used_bytes / data.limit_bytes) * 100)
            : 0;
        $("storageBarFill").style.width = `${pct}%`;
    } catch (err) {
        $("storageUsed").textContent = "Unavailable";
        $("storageAvailable").textContent = "Unavailable";
        $("storageLimit").textContent = "Unavailable";
        log("STORAGE", `Storage API error: ${err.message || err}`);
    }
}

async function loadRecordings() {
    const list = $("recordingsList");
    if (!list) return;

    list.innerHTML = `<div class="loading-state"><i class="fa-solid fa-spinner fa-spin"></i> Loading recordings…</div>`;

    try {
        const r = await fetch("/api/recordings?limit=200", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();

        if (!Array.isArray(data.recordings) || !data.recordings.length) {
            list.innerHTML = `<div class="empty-state compact"><i class="fa-solid fa-video-slash"></i><h3>No recordings</h3><p>Continuous recordings will appear here after the MP4 recorder starts.</p></div>`;
            return;
        }

        list.innerHTML = "";

        for (const item of data.recordings) {
            const row = document.createElement("div");
            row.className = "recording-row";

            const protectedLabel = item.preserved
                ? `<span class="recording-lock"><i class="fa-solid fa-lock"></i> PRESERVED</span>`
                : "";

            row.innerHTML = `
                <div class="recording-icon"><i class="fa-solid fa-film"></i></div>
                <div class="recording-info">
                    <div class="recording-time">${escapeHTML(formatRecordingTime(item.started_at))}</div>
                    <div class="recording-meta">
                        ${escapeHTML(recordingDuration(item.started_at, item.ended_at))}
                        · ${escapeHTML(storageBytesText(item.file_size_bytes))}
                        ${protectedLabel}
                    </div>
                </div>
                <div class="recording-actions">
                    <button class="icon-button play-recording" title="Play"><i class="fa-solid fa-play"></i></button>
                    <a class="icon-button" title="Download" href="/recordings/${item.recording_id}/download"><i class="fa-solid fa-download"></i></a>
                </div>
            `;

            row.querySelector(".play-recording").addEventListener("click", () => openRecording(item));
            list.appendChild(row);
        }
    } catch (err) {
        list.innerHTML = `<div class="empty-state compact"><i class="fa-solid fa-triangle-exclamation"></i><h3>Recordings unavailable</h3><p>${escapeHTML(err.message || String(err))}</p></div>`;
        log("STORAGE", `Recording API error: ${err.message || err}`);
    }
}

function openRecording(item) {
    recordingUI.selectedId = item.recording_id;

    const wrap = $("recordingPlayerWrap");
    const player = $("recordingPlayer");
    const title = $("playerTitle");
    const download = $("downloadRecording");
    const preserve = $("preserveRecording");

    title.textContent = formatRecordingTime(item.started_at);
    player.src = `/recordings/${item.recording_id}/video`;
    download.href = `/recordings/${item.recording_id}/download`;
    download.download = "";
    preserve.disabled = !!item.preserved;
    preserve.innerHTML = item.preserved
        ? `<i class="fa-solid fa-lock"></i> Preserved`
        : `<i class="fa-solid fa-lock"></i> Preserve`;

    wrap.classList.remove("hidden");
    player.load();
    wrap.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("closePlayer")?.addEventListener("click", () => {
    const player = $("recordingPlayer");
    player.pause();
    player.removeAttribute("src");
    player.load();
    $("recordingPlayerWrap").classList.add("hidden");
    recordingUI.selectedId = null;
});

$("refreshRecordings")?.addEventListener("click", () => {
    loadStorage();
    loadRecordings();
});

$("preserveRecording")?.addEventListener("click", async () => {
    if (!recordingUI.selectedId) return;

    const button = $("preserveRecording");
    button.disabled = true;

    try {
        const r = await fetch(`/api/recordings/${recordingUI.selectedId}/preserve`, {
            method: "POST"
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        log("STORAGE", `Recording ${recordingUI.selectedId} preserved.`);
        await loadRecordings();
        button.innerHTML = `<i class="fa-solid fa-lock"></i> Preserved`;
    } catch (err) {
        button.disabled = false;
        log("STORAGE", `Preserve failed: ${err.message || err}`);
        alert(`Could not preserve recording: ${err.message || err}`);
    }
});

/* Load storage data quietly after the existing startup. */
setTimeout(() => {
    loadStorage();
}, 500);
