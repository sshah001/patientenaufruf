/* Aufnahme-Studio: nimmt die Sätze direkt als 22,05-kHz-Mono-WAV auf.
 *
 * Warum kein MediaRecorder? Der liefert WebM/Opus, das Piper-Training braucht
 * aber WAV. Statt auf dem Server mit ffmpeg umzuwandeln, wird hier direkt aus
 * dem AudioContext geschnitten und als WAV kodiert – kein zusätzliches
 * Programm auf dem Server nötig, und die Abtastrate stimmt von Anfang an.
 */
"use strict";

const { api, toast, el } = window.PA;

/** Piper-Modelle für deutsche Stimmen arbeiten üblicherweise mit 22050 Hz. */
const TARGET_RATE = 22050;

const dom = {
  counter: document.getElementById("counter"),
  prompt: document.getElementById("prompt"),
  recBtn: document.getElementById("recBtn"),
  recInfo: document.getElementById("recInfo"),
  meterBar: document.getElementById("meterBar"),
  playback: document.getElementById("playback"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  redoBtn: document.getElementById("redoBtn"),
  skipBtn: document.getElementById("skipBtn"),
  dots: document.getElementById("dots"),
  progressBar: document.getElementById("progressBar"),
  progressBadge: document.getElementById("progressBadge"),
  progressHint: document.getElementById("progressHint"),
  permissionNotice: document.getElementById("permissionNotice"),
  installResult: document.getElementById("installResult"),
};

const state = {
  items: [],
  index: 0,
  summary: { total: 0, recorded: 0, minutes: 0, targetMinutes: 20 },
  recording: false,
};

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let processorNode = null;
let chunks = [];
let peak = 0;
let recordStart = 0;
let levelTimer = null;

// ------------------------------------------------------------- WAV-Kodierung

/** Float32-Samples als 16-Bit-Mono-WAV verpacken. */
function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/**
 * Schneidet Stille am Anfang und Ende weg und lässt jeweils 150 ms stehen.
 * Saubere Ränder verbessern das Trainingsergebnis deutlich.
 */
function trimSilence(samples, sampleRate, threshold = 0.012) {
  let start = 0;
  let end = samples.length - 1;
  while (start < samples.length && Math.abs(samples[start]) < threshold) start += 1;
  while (end > start && Math.abs(samples[end]) < threshold) end -= 1;

  const pad = Math.round(0.15 * sampleRate);
  start = Math.max(0, start - pad);
  end = Math.min(samples.length - 1, end + pad);

  if (end - start < sampleRate * 0.2) return samples; // zu kurz – lieber unverändert lassen
  return samples.slice(start, end + 1);
}

// ------------------------------------------------------------ Mikrofonzugang

async function setupMicrophone() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Automatiken aus: sie verfälschen die Stimmcharakteristik,
        // die wir gerade abbilden wollen.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_RATE });
    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    // ScriptProcessor ist zwar als veraltet markiert, funktioniert aber in
    // allen hier relevanten Browsern zuverlässig – auch auf einem Pi.
    processorNode = audioContext.createScriptProcessor(4096, 1, 1);
    processorNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      let localPeak = 0;
      for (let i = 0; i < input.length; i += 1) {
        const v = Math.abs(input[i]);
        if (v > localPeak) localPeak = v;
      }
      peak = Math.max(peak * 0.86, localPeak);
      if (state.recording) chunks.push(new Float32Array(input));
    };

    sourceNode.connect(processorNode);
    // Ohne Verbindung zum Ziel läuft der Prozessor in manchen Browsern nicht;
    // die Verstärkung 0 verhindert eine Rückkopplung über die Lautsprecher.
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    processorNode.connect(silent);
    silent.connect(audioContext.destination);

    dom.recBtn.disabled = false;
    dom.recInfo.textContent = `Bereit. Aufnahme mit ${audioContext.sampleRate} Hz.`;
    dom.permissionNotice.hidden = true;

    levelTimer = setInterval(updateMeter, 60);
  } catch (err) {
    dom.permissionNotice.hidden = false;
    dom.permissionNotice.textContent =
      `Mikrofon nicht verfügbar: ${err.message}. Hinweis: Browser erlauben den Mikrofonzugriff nur über https oder über localhost.`;
    dom.recInfo.textContent = "Keine Aufnahme möglich.";
  }
}

function updateMeter() {
  const percent = Math.min(100, peak * 145);
  dom.meterBar.style.width = `${percent}%`;
  dom.meterBar.dataset.loud = peak > 0.92 ? "1" : "0";
  dom.meterBar.dataset.quiet = state.recording && peak < 0.06 ? "1" : "0";
}

// --------------------------------------------------------------- Aufnahme

function startRecording() {
  if (!audioContext) return;
  if (audioContext.state === "suspended") audioContext.resume();

  chunks = [];
  state.recording = true;
  recordStart = Date.now();
  dom.recBtn.dataset.rec = "1";
  dom.playback.hidden = true;
  dom.recInfo.textContent = "Aufnahme läuft… (Leertaste beendet)";
}

async function stopRecording() {
  state.recording = false;
  dom.recBtn.dataset.rec = "0";

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  if (totalLength === 0) {
    dom.recInfo.textContent = "Keine Aufnahme erfasst.";
    return;
  }

  const merged = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  chunks = [];

  const trimmed = trimSilence(merged, audioContext.sampleRate);
  const seconds = trimmed.length / audioContext.sampleRate;

  if (seconds < 0.5) {
    dom.recInfo.textContent = "Aufnahme zu kurz – bitte noch einmal.";
    return;
  }

  const blob = encodeWav(trimmed, audioContext.sampleRate);
  dom.playback.src = URL.createObjectURL(blob);
  dom.playback.hidden = false;
  dom.recInfo.textContent = `${seconds.toFixed(1)} s aufgenommen – wird gespeichert…`;

  try {
    const buffer = await blob.arrayBuffer();
    const result = await api(`/api/voice-studio/clip/${state.index}`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: buffer,
    });

    state.items[state.index].recorded = true;
    state.items[state.index].durationMs = result.durationMs;
    dom.recInfo.textContent = `Gespeichert: ${seconds.toFixed(1)} s.`;
    refreshSummary();
    renderDots();
    renderStage();

    // Automatisch weiter, damit man in einem Fluss durchsprechen kann.
    setTimeout(() => { if (state.index < state.items.length - 1) go(state.index + 1); }, 550);
  } catch (err) {
    dom.recInfo.textContent = `Speichern fehlgeschlagen: ${err.message}`;
    toast(err.message, "error");
  }
}

function toggleRecording() {
  if (state.recording) stopRecording();
  else startRecording();
}

dom.recBtn.addEventListener("click", toggleRecording);

// -------------------------------------------------------------- Navigation

function go(index) {
  if (state.recording) stopRecording();
  state.index = Math.max(0, Math.min(state.items.length - 1, index));
  renderStage();
  renderDots();
}

dom.prevBtn.addEventListener("click", () => go(state.index - 1));
dom.nextBtn.addEventListener("click", () => go(state.index + 1));
dom.skipBtn.addEventListener("click", () => go(state.index + 1));

dom.redoBtn.addEventListener("click", async () => {
  try {
    await api(`/api/voice-studio/clip/${state.index}`, { method: "DELETE" });
    state.items[state.index].recorded = false;
    state.items[state.index].durationMs = 0;
    refreshSummary();
    renderDots();
    renderStage();
    startRecording();
  } catch (err) {
    toast(err.message, "error");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, textarea")) return;
  if (event.code === "Space") { event.preventDefault(); toggleRecording(); }
  else if (event.key === "ArrowRight") go(state.index + 1);
  else if (event.key === "ArrowLeft") go(state.index - 1);
});

// ------------------------------------------------------------- Darstellung

function renderStage() {
  const item = state.items[state.index];
  if (!item) return;

  dom.counter.textContent = `Satz ${state.index + 1} von ${state.items.length}`;
  dom.prompt.textContent = item.text;
  dom.prevBtn.disabled = state.index === 0;
  dom.nextBtn.disabled = state.index === state.items.length - 1;
  dom.redoBtn.hidden = !item.recorded;

  if (item.recorded) {
    dom.playback.src = `/api/voice-studio/clip/${state.index}?t=${Date.now()}`;
    dom.playback.hidden = false;
    dom.recInfo.textContent = `Bereits aufgenommen (${(item.durationMs / 1000).toFixed(1)} s).`;
  } else {
    dom.playback.hidden = true;
    dom.recInfo.textContent = audioContext ? "Bereit zur Aufnahme." : "Mikrofon wird vorbereitet…";
  }
}

function renderDots() {
  dom.dots.replaceChildren();
  for (let i = 0; i < state.items.length; i += 1) {
    dom.dots.appendChild(el("button", {
      "data-done": state.items[i].recorded ? "1" : "0",
      "data-current": i === state.index ? "1" : "0",
      title: `${i + 1}. ${state.items[i].text.slice(0, 60)}`,
      text: String(i + 1),
      onclick: () => go(i),
    }));
  }
}

function refreshSummary() {
  const recorded = state.items.filter((i) => i.recorded);
  const minutes = recorded.reduce((sum, i) => sum + (i.durationMs || 0), 0) / 60000;
  state.summary.recorded = recorded.length;
  state.summary.minutes = Math.round(minutes * 10) / 10;

  const target = state.summary.targetMinutes;
  const percent = Math.min(100, Math.round((minutes / target) * 100));

  dom.progressBar.style.width = `${percent}%`;
  dom.progressBadge.textContent = `${recorded.length} / ${state.items.length}`;
  dom.progressBadge.className = `badge ${minutes >= target ? "ok" : ""}`;
  dom.progressHint.textContent =
    minutes >= target
      ? `${state.summary.minutes} Minuten aufgenommen – das reicht für ein Training. Mehr Material verbessert das Ergebnis weiter.`
      : `${state.summary.minutes} von etwa ${target} Minuten. Noch ${Math.max(0, Math.round((target - minutes) * 10) / 10)} Minuten bis zur empfohlenen Menge.`;
}

// ----------------------------------------------------------------- Aktionen

document.getElementById("exportBtn").addEventListener("click", () => {
  if (state.summary.recorded === 0) {
    return toast("Es wurden noch keine Sätze aufgenommen.", "warn");
  }
  window.location.href = "/api/voice-studio/export";
});

document.getElementById("checkBtn").addEventListener("click", async () => {
  try {
    const result = await api("/api/voice-studio/install");
    document.getElementById("voicesDir").textContent = result.voicesDir;
    dom.installResult.replaceChildren(el("div", {
      class: `notice ${result.customVoices.length ? "ok" : "warn"}`,
      text: result.hint,
    }));
  } catch (err) {
    toast(err.message, "error");
  }
});

// -------------------------------------------------------------------- Start

(async function boot() {
  try {
    const data = await api("/api/voice-studio/prompts");
    state.items = data.items;
    state.summary = { ...state.summary, ...data.summary };

    if (state.items.length === 0) {
      dom.prompt.textContent = "Keine Aufnahmesätze gefunden (tools/prompts-de.txt fehlt).";
      return;
    }

    // Beim ersten noch nicht aufgenommenen Satz beginnen.
    const firstOpen = state.items.findIndex((i) => !i.recorded);
    state.index = firstOpen === -1 ? 0 : firstOpen;

    renderStage();
    renderDots();
    refreshSummary();
    await setupMicrophone();
    renderStage();
  } catch (err) {
    toast(`Start fehlgeschlagen: ${err.message}`, "error", 9000);
  }
})();

window.addEventListener("beforeunload", () => {
  if (levelTimer) clearInterval(levelTimer);
  if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
  if (audioContext) audioContext.close().catch(() => {});
});
