"use strict";
/**
 * Systemstatus, Diagnose und Stimmverwaltung.
 *
 * Ziel: Wenn im Praxisalltag "der Aufruf geht nicht" gemeldet wird, soll eine
 * einzige Seite zeigen, welches Teilsystem klemmt – statt in Logdateien zu
 * suchen.
 */
const os = require("os");

const config = require("../config");
const pkg = require("../../package.json");
const tts = require("../services/tts");
const mopidy = require("../services/audio/mopidyClient");
const signage = require("../services/signage");
const gong = require("../services/audio/gong");
const callQueue = require("../services/callQueue");
const realtime = require("../realtime");
const Patients = require("../db/patients");
const db = require("../db/connect");

// GET /api/config  – für die Oberfläche, ohne Geheimnisse
exports.publicConfig = (req, res) => {
  res.json(config.publicView());
};

// GET /api/status  – Kurzüberblick
exports.status = async (req, res, next) => {
  try {
    const [ttsStatus, mopidyStatus, signageStatus, counts] = await Promise.all([
      tts.status(),
      mopidy.ping(),
      signage.status(),
      Patients.countByStatus(),
    ]);

    const byStatus = counts;
    const validation = config.validate();

    res.json({
      app: {
        name: config.app.name,
        version: pkg.version,
        publicUrl: config.app.publicUrl,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      database: {
        ok: db.isConnected(),
        state: db.isConnected() ? "geöffnet" : "geschlossen",
        engine: "SQLite",
        file: config.secrets.useMemoryDb ? null : config.paths.database,
        inMemory: config.secrets.useMemoryDb,
      },
      patients: {
        waiting: byStatus.waiting || 0,
        called: byStatus.called || 0,
        inTreatment: byStatus.in_treatment || 0,
        completed: byStatus.completed || 0,
        total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      },
      tts: ttsStatus,
      mopidy: mopidyStatus,
      signage: signageStatus,
      queue: callQueue.state(),
      clients: realtime.counts(),
      configuration: validation,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/health  – schlanker Endpunkt für Docker/Monitoring
exports.health = (req, res) => {
  const dbOk = db.isConnected();
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, uptimeSec: Math.round(process.uptime()) });
};

// GET /api/voices  – verfügbare Stimmen
exports.voices = async (req, res, next) => {
  try {
    const status = await tts.status();
    res.json({
      active: status.activeVoice,
      configured: status.configuredVoice,
      voices: status.voices,
      engine: status.engine,
      voicesDir: config.paths.voices,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/voices/test   { text?, voiceId? }
 * Erzeugt eine Probeansage und liefert die Adresse zum Anhören.
 */
exports.testVoice = async (req, res, next) => {
  try {
    const text = String(req.body?.text || "Frau Mustermann, bitte kommen Sie in Behandlungszimmer eins.").slice(0, 300);
    const result = await tts.speak(text, { voiceId: req.body?.voiceId, force: req.body?.force === true });

    if (!result.ok) {
      return res.status(500).json({ error: result.error, code: "TTS_FAILED" });
    }
    res.json({ ok: true, url: result.url, durationMs: result.durationMs, cached: result.cached, voice: result.voice, text: result.text });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/voices/play   { text?, voiceId? }
 * Erzeugt eine Probeansage UND gibt sie über Mopidy/Snapcast aus –
 * der Test des kompletten Weges bis zum Lautsprecher.
 */
exports.playTest = async (req, res, next) => {
  try {
    const text = String(req.body?.text || "Dies ist ein Test der Sprachausgabe.").slice(0, 300);
    const audio = await tts.speak(text, { voiceId: req.body?.voiceId });
    if (!audio.ok) return res.status(500).json({ error: audio.error, code: "TTS_FAILED", step: "tts" });

    const playback = await mopidy.playUrlAndWait(audio.url, { expectedMs: audio.durationMs });
    if (!playback.ok) {
      return res.status(502).json({
        error: playback.error,
        code: "PLAYBACK_FAILED",
        step: "mopidy",
        hint: `Konnte Mopidy die Datei unter ${audio.url} abrufen? Die Adresse muss vom Mopidy-Rechner aus erreichbar sein.`,
        audioUrl: audio.url,
      });
    }
    res.json({ ok: true, audioUrl: audio.url, playedMs: playback.playedMs });
  } catch (err) {
    next(err);
  }
};

// POST /api/voices/cache/clear
exports.clearCache = async (req, res, next) => {
  try {
    const result = await tts.clearCache();
    gong.invalidate();
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/diagnostics/signage?full=true
 * Testet die piSignage-Endpunkte. Mit `full=true` wird auch eine sichtbare
 * Testeinblendung ausgelöst – deshalb nur auf ausdrückliche Anforderung.
 */
exports.diagnoseSignage = async (req, res, next) => {
  try {
    const result = await signage.client.probe({
      full: req.query.full === "true",
      sampleText: "Anzeigetest – bitte ignorieren",
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
};

// GET /api/diagnostics/mopidy
exports.diagnoseMopidy = async (req, res, next) => {
  try {
    const ping = await mopidy.ping();
    res.json({
      ...ping,
      audioBaseUrl: config.mopidy.audioBaseUrl,
      hint: ping.ok
        ? "Mopidy antwortet. Falls trotzdem nichts zu hören ist: Snapcast-Ausgang und Lautstärke prüfen."
        : "Mopidy antwortet nicht. Läuft der Dienst, und stimmt MOPIDY_RPC_URL?",
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/diagnostics/selftest
 * Prüft in einem Durchgang alle Teilsysteme und benennt konkrete nächste
 * Schritte. Das ist der Endpunkt, der bei Störungen als Erstes zu öffnen ist.
 */
exports.selftest = async (req, res, next) => {
  try {
    const checks = [];
    const add = (name, ok, detail, hint) => checks.push({ name, ok, detail, hint });

    // Konfiguration
    const validation = config.validate();
    add("Konfiguration", validation.ok, validation.errors.join(" ") || "Vollständig.", validation.warnings.join(" "));

    // Datenbank
    const dbOk = db.isConnected();
    add(
      "Datenbank",
      dbOk,
      dbOk ? `SQLite geöffnet (${config.secrets.useMemoryDb ? "nur im Arbeitsspeicher" : config.paths.database}).` : "Datenbank ist nicht geöffnet.",
      dbOk ? "" : "Schreibrechte für den Ordner data/ prüfen (bzw. DB_PATH)."
    );

    // Sprachsynthese
    const ttsStatus = await tts.status();
    add(
      "Piper (Sprachsynthese)",
      ttsStatus.engine.available,
      ttsStatus.engine.available
        ? `Einsatzbereit${ttsStatus.engine.version && ttsStatus.engine.version !== "unbekannt" ? ` (Version ${ttsStatus.engine.version})` : ""} – ${ttsStatus.engine.bin}`
        : ttsStatus.engine.reason,
      ttsStatus.engine.available ? "" : "PIPER_BIN auf den vollständigen Pfad zur Piper-Datei setzen."
    );
    add(
      "Stimmmodell",
      Boolean(ttsStatus.activeVoice),
      ttsStatus.activeVoice ? `${ttsStatus.activeVoice.label} (${ttsStatus.activeVoice.id})` : "Keine Stimme gefunden.",
      ttsStatus.activeVoice ? "" : `.onnx-Dateien nach ${config.paths.voices} legen.`
    );

    // Probeansage
    if (ttsStatus.engine.available && ttsStatus.activeVoice) {
      const sample = await tts.speak("Systemtest.");
      add("Probeansage", sample.ok, sample.ok ? `${sample.durationMs} ms Audio erzeugt.` : sample.error, "");
    }

    // Mopidy – bewusst deaktiviert ist kein Fehler, sondern eine Einstellung.
    const mopidyStatus = await mopidy.ping();
    if (!config.mopidy.enabled) {
      add("Mopidy / Snapcast", true, "In der Konfiguration deaktiviert – es wird kein Ton ausgegeben.", "");
    } else {
      add(
        "Mopidy / Snapcast",
        mopidyStatus.ok,
        mopidyStatus.ok ? `Version ${mopidyStatus.version}, Zustand ${mopidyStatus.state}` : mopidyStatus.error,
        mopidyStatus.ok ? "" : `Erreichbarkeit von ${config.mopidy.rpcUrl} prüfen.`
      );
    }

    // Erreichbarkeit der eigenen Adresse (wichtig: Mopidy lädt darüber)
    const localish = /localhost|127\.0\.0\.1/.test(config.app.publicUrl);
    add(
      "Öffentliche Adresse",
      !localish || !config.mopidy.enabled,
      config.app.publicUrl,
      localish && config.mopidy.enabled
        ? "APP_PUBLIC_URL zeigt auf localhost. Mopidy auf einem anderen Rechner kann darüber keine Audiodateien laden."
        : ""
    );

    // piSignage
    if (config.signage.enabled) {
      const probe = await signage.client.probe({ full: false });
      add("piSignage", probe.reachable, probe.reachable ? "Erreichbar." : probe.hint, probe.hint || "");
    }

    const ok = checks.every((c) => c.ok);
    res.json({ ok, checks, checkedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
};
