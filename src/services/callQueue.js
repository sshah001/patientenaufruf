"use strict";
/**
 * Der Patientenaufruf – ein Knopfdruck, ein Ablauf.
 *
 * Warum eine Warteschlange?
 * In der Vorversion wurde die Audiowiedergabe nicht abgewartet. Zwei schnell
 * hintereinander gedrückte Knöpfe führten dazu, dass Mopidy die erste Ansage
 * mitten im Satz durch die zweite ersetzte. Hier wird jeder Aufruf vollständig
 * abgearbeitet, bevor der nächste beginnt.
 *
 * Reihenfolge innerhalb eines Aufrufs – bewusst so:
 *   1. Datenbank aktualisieren
 *   2. Bild sofort ausgeben (Wartezimmer-TV, Monitore, Bedienoberfläche)
 *   3. Sprachdatei holen (meist bereits vorproduziert = sofort da)
 *   4. Ansage ausgeben, n-mal, mit Pause dazwischen
 *   5. Protokolleintrag abschließen
 *
 * Das Bild erscheint also nie erst nach der Sprachsynthese.
 */
const EventEmitter = require("events");

const config = require("./../config");
const log = require("../util/logger")("aufruf");
const { buildAnnouncement } = require("../util/text");

const Patients = require("../db/patients");
const CallLogs = require("../db/callLogs");

const tts = require("./tts");
const mopidy = require("./audio/mopidyClient");
const gong = require("./audio/gong");
const signage = require("./signage");

class CallQueue extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.running = false;
    this.abortController = null;
    this.history = [];
  }

  /** Aktueller Zustand für Oberfläche und Diagnose. */
  state() {
    return {
      running: this.running,
      current: this.current
        ? { patientId: this.current.patientId, room: this.current.roomLabel, phase: this.current.phase, startedAt: this.current.startedAt }
        : null,
      queued: this.queue.length,
      pending: this.pending(),
      queue: this.queue.map((job) => ({ patientId: job.patientId, room: job.roomLabel })),
    };
  }

  /**
   * Anzahl der Aufrufe, die noch abzuarbeiten sind – der gerade laufende
   * zählt mit. Das ist die Zahl, die für die Bedienung eine Bedeutung hat
   * ("wie viele Ansagen kommen noch?").
   */
  pending() {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /**
   * Stellt einen Aufruf in die Warteschlange.
   * @returns {{accepted: boolean, position?: number, reason?: string}}
   */
  enqueue(job) {
    const max = config.announcement.maxQueueLength;
    if (this.pending() >= max) {
      return { accepted: false, reason: `Die Warteschlange ist voll (${max} Ansagen).` };
    }

    // Doppelte Patientenaufrufe abfangen. Freie Durchsagen dürfen sich
    // wiederholen – dieselbe Ansage zweimal hintereinander ist zulässig.
    if (job.patientId) {
      if (this.queue.some((j) => j.patientId === job.patientId)) {
        return { accepted: false, reason: "Dieser Patient steht bereits in der Warteschlange." };
      }
      if (this.current && this.current.patientId === job.patientId) {
        return { accepted: false, reason: "Dieser Patient wird gerade aufgerufen." };
      }
    }

    this.queue.push(job);
    // Position VOR dem Anstoßen bestimmen: _drain() entnimmt den Auftrag noch
    // im selben Ereignisdurchlauf, danach wäre queue.length bereits kleiner.
    const position = this.pending();
    this.emit("queued", { ...job, position });
    this._drain();
    return { accepted: true, position };
  }

  /** Bricht die laufende Ansage ab und leert die Warteschlange. */
  async abortAll() {
    const cleared = this.queue.length;
    this.queue.length = 0;
    if (this.abortController) this.abortController.abort();
    await mopidy.stop().catch(() => {});
    this.emit("aborted", { cleared });
    return { cleared };
  }

  async _drain() {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      this.current = job;
      job.startedAt = new Date().toISOString();
      try {
        if (job.type === "announcement") await this._processAnnouncement(job);
        else await this._process(job);
      } catch (err) {
        log.error("Unerwarteter Fehler im Aufruf:", err);
        this.emit("failed", { job, error: err.message });
      }
      this.current = null;
    }

    this.running = false;
    this.emit("idle");
  }

  async _process(job) {
    const setPhase = (phase) => {
      job.phase = phase;
      this.emit("phase", { patientId: job.patientId, phase, room: job.roomLabel });
    };

    // --- 1. Patient laden und Status setzen -----------------------------
    setPhase("db");
    if (!Patients.get(job.patientId)) {
      this.emit("failed", { job, error: "Patient nicht gefunden." });
      return;
    }

    const patient = Patients.markCalled(job.patientId, { room: job.roomLabel, roomId: job.roomId });

    const room = config.practice.rooms.find((r) => r.id === job.roomId) || { label: job.roomLabel, spoken: job.roomLabel };

    const spokenText = buildAnnouncement({
      template: config.announcement.template,
      templateNoGender: config.announcement.templateNoGender,
      patient,
      room: room.spoken,
      practiceName: config.practice.name,
    });

    const logEntry = CallLogs.create({
      patientId: patient.id,
      lastName: patient.lastName,
      gender: patient.gender,
      roomId: room.id,
      room: room.label,
      spokenText,
      repeatCount: config.announcement.repeatCount,
      result: "speaking",
      triggeredBy: job.triggeredBy || "ui",
    });

    // --- 2. Bild sofort ausgeben ----------------------------------------
    setPhase("display");
    const signageResult = await signage.announce(patient, room);
    this.emit("called", {
      patient,
      room,
      call: signageResult.call,
      spokenText,
    });

    // --- 3. Sprachdatei holen -------------------------------------------
    setPhase("tts");
    let audio = null;
    let audioStatus = "skipped";

    if (config.tts.enabled) {
      audio = await tts.speak(spokenText);
      if (!audio.ok) {
        audioStatus = "failed";
        log.error(`Ansage für ${log.patient(patient.lastName)} konnte nicht erzeugt werden: ${audio.error}`);
        this.emit("warning", { patientId: job.patientId, message: `Sprachausgabe fehlgeschlagen: ${audio.error}` });
      } else if (audio.cached) {
        log.debug("Ansage aus dem Zwischenspeicher.");
      }
    }

    // --- 4. Ansage ausgeben ---------------------------------------------
    if (audio && audio.ok) {
      setPhase("audio");
      audioStatus = await this._play(audio, {
        repeats: config.announcement.repeatCount,
        gongEnabled: config.announcement.gongEnabled,
        onWarning: (message) => this.emit("warning", { patientId: job.patientId, message }),
      });
    }

    // --- 5. Abschließen --------------------------------------------------
    setPhase("done");
    logEntry.result = audioStatus === "failed" ? "failed" : "done";
    logEntry.audioMs = audio?.durationMs || 0;
    logEntry.voice = audio?.voice || "";
    logEntry.channels = {
      audio: audioStatus,
      signage: signageResult.ok ? signageResult.mode : "failed",
      browser: "ok",
    };
    saveLog(logEntry);

    this.history.unshift({ at: new Date().toISOString(), lastName: patient.lastName, room: room.label, audio: audioStatus });
    this.history.length = Math.min(this.history.length, 50);

    this.emit("completed", { patientId: job.patientId, room: room.label, audio: audioStatus });
    log.info(`Aufruf abgeschlossen: ${log.patient(patient.lastName)} -> ${room.label} (Audio: ${audioStatus})`);
  }

  /**
   * Gibt eine fertige Audiodatei über Mopidy aus – n-mal, mit Gong davor.
   * Gemeinsamer Weg für Patientenaufrufe und freie Durchsagen.
   *
   * @returns {Promise<"ok"|"partial"|"failed"|"no-mopidy">}
   */
  async _play(audio, { repeats = 1, gongEnabled = false, onWarning } = {}) {
    if (!config.mopidy.enabled) return "no-mopidy";

    this.abortController = new AbortController();
    const total = Math.max(1, repeats);
    let played = 0;

    try {
      for (let i = 0; i < total; i += 1) {
        if (this.abortController.signal.aborted) break;

        if (gongEnabled && i === 0) {
          const gongFile = await gong.ensure();
          if (gongFile) {
            await mopidy.playUrlAndWait(gongFile.url, {
              expectedMs: gongFile.durationMs,
              signal: this.abortController.signal,
            });
          }
        }

        const result = await mopidy.playUrlAndWait(audio.url, {
          expectedMs: audio.durationMs,
          signal: this.abortController.signal,
        });

        if (result.ok) {
          played += 1;
        } else {
          log.warn(`Wiedergabe ${i + 1}/${total} fehlgeschlagen: ${result.error}`);
          if (onWarning) onWarning(`Audioausgabe: ${result.error}`);
          break;
        }

        if (i < total - 1 && !this.abortController.signal.aborted) {
          await sleep(config.announcement.repeatDelayMs);
        }
      }
    } finally {
      this.abortController = null;
    }

    return played === total ? "ok" : played > 0 ? "partial" : "failed";
  }

  /**
   * Freie Durchsage: beliebiger Text, keine Patientenzuordnung.
   *
   * Läuft durch dieselbe Warteschlange wie die Patientenaufrufe – dadurch
   * kann eine Durchsage niemals mitten in einen laufenden Aufruf platzen.
   */
  async _processAnnouncement(job) {
    const setPhase = (phase) => {
      job.phase = phase;
      this.emit("phase", { announcementId: job.id, phase, text: job.text });
    };

    setPhase("tts");
    const logEntry = CallLogs.create({
      kind: "announcement",
      lastName: "",
      room: "",
      spokenText: job.text,
      repeatCount: job.repeats,
      result: "speaking",
      triggeredBy: job.triggeredBy || "durchsage",
    });

    const audio = await tts.speak(job.text);
    if (!audio.ok) {
      logEntry.result = "failed";
      logEntry.error = audio.error;
      saveLog(logEntry);
      this.emit("warning", { message: `Durchsage konnte nicht erzeugt werden: ${audio.error}` });
      this.emit("completed", { announcementId: job.id, audio: "failed" });
      return;
    }

    // Auf Wunsch zusätzlich auf den Wartezimmer-Anzeigen einblenden.
    if (job.showOnDisplay) {
      setPhase("display");
      this.emit("announcementDisplay", {
        id: job.id,
        text: job.text,
        seconds: job.displaySeconds || config.signage.overlay.popupSeconds,
      });
    }

    setPhase("audio");
    const audioStatus = await this._play(audio, {
      repeats: job.repeats,
      gongEnabled: job.gong,
      onWarning: (message) => this.emit("warning", { message }),
    });

    setPhase("done");
    logEntry.result = audioStatus === "failed" ? "failed" : "done";
    logEntry.audioMs = audio.durationMs;
    logEntry.voice = audio.voice;
    logEntry.channels = { audio: audioStatus, signage: job.showOnDisplay ? "overlay" : "skipped", browser: "ok" };
    saveLog(logEntry);

    this.emit("completed", { announcementId: job.id, audio: audioStatus });
    log.info(`Durchsage abgeschlossen (Audio: ${audioStatus}): "${job.text.slice(0, 60)}"`);
  }
}

/** Protokolleintrag fortschreiben – ein Fehler darf den Aufruf nicht abbrechen. */
function saveLog(entry) {
  try {
    CallLogs.update(entry.id, entry);
  } catch (err) {
    log.warn("Protokolleintrag konnte nicht gespeichert werden:", err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = new CallQueue();
module.exports.CallQueue = CallQueue;
