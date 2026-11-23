/* Diagnose- und Systemseite. */
"use strict";

const { api, toast, timeOf, el, confirmDialog } = window.PA;

const dom = {
  selftest: document.getElementById("selftest"),
  stats: document.getElementById("stats"),
  voices: document.getElementById("voices"),
  signage: document.getElementById("signage"),
  probeResult: document.getElementById("probeResult"),
  player: document.getElementById("player"),
  ttsResult: document.getElementById("ttsResult"),
  calllog: document.getElementById("calllog"),
  healthDot: document.getElementById("healthDot"),
};

// ------------------------------------------------------------- Selbsttest

document.getElementById("selftestBtn").addEventListener("click", runSelftest);

async function runSelftest() {
  dom.selftest.replaceChildren(el("p", { class: "muted", text: "Prüfung läuft…" }));
  try {
    const result = await api("/api/diagnostics/selftest");
    dom.selftest.replaceChildren();

    for (const check of result.checks) {
      dom.selftest.appendChild(el("div", { class: "check" }, [
        el("span", { class: `icon ${check.ok ? "ok" : "bad"}`, text: check.ok ? "✓" : "!" }),
        el("div", { class: "body" }, [
          el("div", { class: "name", text: check.name }),
          check.detail ? el("div", { class: "detail", text: check.detail }) : null,
          !check.ok && check.hint ? el("div", { class: "hint", text: check.hint }) : null,
        ]),
      ]));
    }

    dom.healthDot.dataset.state = result.ok ? "on" : "off";
    toast(result.ok ? "Alle Prüfungen bestanden." : "Es gibt Beanstandungen.", result.ok ? "ok" : "warn");
  } catch (err) {
    dom.selftest.replaceChildren(el("div", { class: "notice error", text: err.message }));
  }
}

// ----------------------------------------------------------------- Zustand

function statRow(label, value, kind) {
  return el("div", { class: "stat" }, [
    el("span", { text: label }),
    el("span", { class: kind ? `badge ${kind}` : "v", text: String(value) }),
  ]);
}

async function loadStatus() {
  try {
    const s = await api("/api/status");

    dom.stats.replaceChildren(
      statRow("Version", s.app.version),
      statRow("Laufzeit", formatUptime(s.app.uptimeSec)),
      statRow("Node / Plattform", `${s.app.node} · ${s.app.platform}`),
      statRow("Speicher", `${s.app.memoryMb} MB`),
      statRow("Datenbank", s.database.state, s.database.ok ? "ok" : "error"),
      statRow("Wartend / Aufgerufen", `${s.patients.waiting} / ${s.patients.called}`),
      statRow("Mopidy", s.mopidy.ok ? `verbunden (${s.mopidy.version})` : "keine Verbindung", s.mopidy.ok ? "ok" : "error"),
      statRow("Piper", s.tts.engine.available ? `Version ${s.tts.engine.version}` : "nicht gefunden", s.tts.engine.available ? "ok" : "error"),
      statRow("Audio-Zwischenspeicher", `${s.tts.cache.files} Dateien · ${s.tts.cache.megabytes} MB`),
      statRow("Angemeldete Geräte", `${s.clients.staff} Bedienung · ${s.clients.display} Anzeige`),
      statRow("Warteschlange", s.queue.running ? `läuft (${s.queue.queued} wartend)` : "leer")
    );

    if (s.configuration.warnings.length) {
      for (const warning of s.configuration.warnings) {
        dom.stats.appendChild(el("div", { class: "notice warn", style: "margin-top:10px", text: warning }));
      }
    }

    dom.signage.replaceChildren(
      statRow("Betriebsart", s.signage.mode),
      statRow("Gerät", `${s.signage.host}:${s.signage.port}`),
      statRow("Aktiviert", s.signage.enabled ? "ja" : "nein", s.signage.enabled ? "ok" : "warn"),
      statRow("TV-Adresse", s.signage.tvUrl),
      statRow("Letzter Aufruf", s.signage.lastCall ? `${s.signage.lastCall.headline} → ${s.signage.lastCall.room}` : "–")
    );

    dom.healthDot.dataset.state = s.configuration.ok ? "on" : "off";
  } catch (err) {
    dom.stats.replaceChildren(el("div", { class: "notice error", text: err.message }));
  }
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} T ${hours} Std`;
  if (hours) return `${hours} Std ${minutes} Min`;
  return `${minutes} Min`;
}

// ------------------------------------------------------------------ Stimmen

async function loadVoices() {
  try {
    const data = await api("/api/voices");
    dom.voices.replaceChildren();

    if (data.voices.length === 0) {
      dom.voices.appendChild(el("div", { class: "notice warn", text:
        `Keine Stimmmodelle in ${data.voicesDir} gefunden. Dort .onnx- und .onnx.json-Dateien ablegen.` }));
      return;
    }

    for (const voice of data.voices) {
      const isActive = data.active && data.active.id === voice.id;
      dom.voices.appendChild(el("div", { class: "voicerow", "data-active": isActive ? "1" : "0" }, [
        el("div", { class: "meta" }, [
          el("div", {}, [
            document.createTextNode(voice.label),
            voice.isCustom ? el("span", { class: "badge ok", style: "margin-left:8px", text: "eigene Stimme" }) : null,
            isActive ? el("span", { class: "badge called", style: "margin-left:8px", text: "aktiv" }) : null,
          ]),
          el("div", { class: "id", text: `${voice.id} · ${voice.language} · ${voice.sizeMb} MB` }),
        ]),
        el("button", { class: "small", text: "Anhören", onclick: () => testVoice(voice.id) }),
      ]));
    }
  } catch (err) {
    dom.voices.replaceChildren(el("div", { class: "notice error", text: err.message }));
  }
}

async function testVoice(voiceId) {
  const text = document.getElementById("testText").value;
  dom.ttsResult.replaceChildren(el("p", { class: "muted", text: "Ansage wird erzeugt…" }));
  try {
    const result = await api("/api/voices/test", { method: "POST", body: { text, voiceId } });
    dom.player.src = result.url;
    dom.player.hidden = false;
    dom.player.play().catch(() => {});
    dom.ttsResult.replaceChildren(el("p", { class: "hint", text:
      `${result.voice} · ${Math.round(result.durationMs / 100) / 10} s · ${result.cached ? "aus dem Zwischenspeicher" : "neu erzeugt"}` }));
  } catch (err) {
    dom.ttsResult.replaceChildren(el("div", { class: "notice error", text: err.message }));
  }
}

document.getElementById("ttsBtn").addEventListener("click", () => testVoice(undefined));

document.getElementById("playBtn").addEventListener("click", async () => {
  const text = document.getElementById("testText").value;
  dom.ttsResult.replaceChildren(el("p", { class: "muted", text: "Wird über die Lautsprecher ausgegeben…" }));
  try {
    const result = await api("/api/voices/play", { method: "POST", body: { text } });
    dom.ttsResult.replaceChildren(el("div", { class: "notice ok", text:
      `Ausgegeben (${Math.round(result.playedMs / 1000)} s). War die Ansage im Wartezimmer zu hören?` }));
  } catch (err) {
    const detail = err.data?.hint ? `${err.message} — ${err.data.hint}` : err.message;
    dom.ttsResult.replaceChildren(el("div", { class: "notice error", text: detail }));
  }
});

document.getElementById("clearCacheBtn").addEventListener("click", async () => {
  const ok = await confirmDialog("Alle zwischengespeicherten Ansagen werden gelöscht und beim nächsten Aufruf neu erzeugt.", { title: "Zwischenspeicher leeren", confirmText: "Leeren" });
  if (!ok) return;
  try {
    const result = await api("/api/voices/cache/clear", { method: "POST" });
    toast(`${result.removed} Dateien gelöscht.`, "ok");
    loadStatus();
  } catch (err) {
    toast(err.message, "error");
  }
});

// ------------------------------------------------------------- piSignage

async function probe(full) {
  dom.probeResult.replaceChildren(el("p", { class: "muted", text: "Prüfung läuft…" }));
  try {
    const result = await api(`/api/diagnostics/signage${full ? "?full=true" : ""}`);
    const nodes = [
      el("div", {
        class: `notice ${result.reachable ? "ok" : "error"}`,
        text: result.reachable ? `Erreichbar unter ${result.baseUrl}.` : result.hint,
      }),
    ];
    const rows = Object.entries(result.endpoints || {});
    if (rows.length) {
      nodes.push(el("pre", { text: rows.map(([path, r]) =>
        `${r.ok ? "OK  " : "FEHL"}  ${path}   ${r.status || r.error || ""}`).join("\n") }));
    }
    dom.probeResult.replaceChildren(...nodes);
  } catch (err) {
    dom.probeResult.replaceChildren(el("div", { class: "notice error", text: err.message }));
  }
}

document.getElementById("probeBtn").addEventListener("click", () => probe(false));
document.getElementById("probeFullBtn").addEventListener("click", async () => {
  const ok = await confirmDialog("Auf dem Wartezimmer-Fernseher erscheint kurz eine Testeinblendung.", { title: "Anzeige testen", confirmText: "Test auslösen" });
  if (ok) probe(true);
});

// ------------------------------------------------------------ Aufrufprotokoll

const CHANNEL_LABEL = { ok: "ok", partial: "teilweise", failed: "Fehler", skipped: "aus", "no-mopidy": "kein Mopidy" };

async function loadCallLog() {
  try {
    const entries = await api("/api/calls?limit=40");
    dom.calllog.replaceChildren();
    for (const entry of entries) {
      const audioKind = entry.channels?.audio === "ok" ? "ok" : entry.channels?.audio === "failed" ? "error" : "warn";
      dom.calllog.appendChild(el("tr", {}, [
        el("td", { class: "mono nowrap", text: timeOf(entry.createdAt) }),
        el("td", { text: entry.lastName }),
        el("td", { text: entry.room }),
        el("td", {}, el("span", { class: `badge ${audioKind}`, text: CHANNEL_LABEL[entry.channels?.audio] || "–" })),
        el("td", { class: "muted", text: entry.channels?.signage || "–" }),
        el("td", { class: "muted mono", text: entry.voice || "–" }),
      ]));
    }
    if (entries.length === 0) {
      dom.calllog.appendChild(el("tr", {}, el("td", { colspan: "6", class: "muted", text: "Noch keine Aufrufe." })));
    }
  } catch (err) {
    toast(err.message, "error");
  }
}

document.getElementById("reloadLog").addEventListener("click", loadCallLog);

// -------------------------------------------------------------------- Start

loadStatus();
loadVoices();
loadCallLog();
setInterval(loadStatus, 30000);
