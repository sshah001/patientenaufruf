"use strict";
/**
 * Serverstart.
 *
 * Reihenfolge: Konfiguration prüfen -> Datenbank -> HTTP -> Echtzeit ->
 * Hintergrundaufgaben. Bricht die Konfigurationsprüfung mit einem Fehler ab,
 * startet der Server gar nicht erst – statt später im Betrieb zu scheitern.
 */
require("dotenv").config();

const http = require("http");

const config = require("./config");
const logger = require("./util/logger");
const log = logger("server");

logger.setLevel(config.app.logLevel || "info");

const { createApp } = require("./app");
const db = require("./db/connect");
const realtime = require("./realtime");
const callQueue = require("./services/callQueue");
const broadcast = require("./services/broadcast");
const signage = require("./services/signage");
const tts = require("./services/tts");

let server;
let cleanupTimer;

function banner() {
  const url = config.app.publicUrl;
  const lines = [
    "",
    "  ┌──────────────────────────────────────────────────────────────┐",
    `  │  ${config.app.name} – ${config.practice.name}`.padEnd(65) + "│",
    "  ├──────────────────────────────────────────────────────────────┤",
    `  │  Bedienung        ${url}/`.padEnd(65) + "│",
    `  │  Import           ${url}/import`.padEnd(65) + "│",
    `  │  System & Test    ${url}/system`.padEnd(65) + "│",
    `  │  Stimm-Studio     ${url}/voice-studio`.padEnd(65) + "│",
    `  │  Wartezimmer-TV   ${url}/tv`.padEnd(65) + "│",
    `  │  Monitor          ${url}/monitor`.padEnd(65) + "│",
    `  │  Laufband (RSS)   ${url}/rss.xml`.padEnd(65) + "│",
    "  └──────────────────────────────────────────────────────────────┘",
    "",
  ];
  console.log(lines.join("\n"));
}

/** Verbindet die Warteschlange mit den Echtzeit-Benachrichtigungen. */
function wireEvents() {
  callQueue.on("queued", () => broadcast.queue(callQueue.state()));
  callQueue.on("phase", (payload) => {
    broadcast.callPhase(payload);
    broadcast.queue(callQueue.state());
  });
  callQueue.on("called", (payload) => {
    broadcast.call(payload);
    broadcast.patients();
  });
  callQueue.on("completed", () => {
    broadcast.queue(callQueue.state());
    broadcast.patients();
  });
  callQueue.on("announcementDisplay", (payload) => broadcast.announcement(payload));
  callQueue.on("warning", (payload) => broadcast.warning(payload));
  callQueue.on("failed", (payload) => broadcast.warning({ message: payload.error }));
  callQueue.on("idle", () => broadcast.queue(callQueue.state()));
  callQueue.on("aborted", () => broadcast.queue(callQueue.state()));
}

async function start() {
  // 1. Konfiguration prüfen
  const check = config.validate();
  for (const warning of check.warnings) log.warn(warning);
  if (!check.ok) {
    log.error("Der Server kann nicht starten – die Konfiguration ist unvollständig:");
    for (const error of check.errors) log.error(`  • ${error}`);
    log.error("Hinweis: .env.example als Vorlage nach .env kopieren und ausfüllen.");
    process.exit(1);
  }

  // 2. Datenbank und Aufrufverlauf
  await db.connect();
  await signage.restoreRecent().catch((err) => log.warn("Aufrufverlauf nicht wiederherstellbar:", err.message));

  // 3. HTTP und Echtzeit
  const app = createApp();
  server = http.createServer(app);
  realtime.init(server);
  wireEvents();

  await new Promise((resolve, reject) => {
    server.listen(config.app.port, resolve).on("error", reject);
  });

  banner();
  log.info(`Server hört auf Port ${config.app.port}.`);

  // 4. Teilsysteme prüfen (blockiert den Start nicht)
  tts
    .status()
    .then((status) => {
      if (!status.engine.available) {
        log.warn(`Sprachsynthese nicht einsatzbereit: ${status.engine.reason}`);
      } else if (status.activeVoice) {
        const marker = status.activeVoice.isCustom ? " (eigene Praxisstimme)" : "";
        log.info(`Stimme aktiv: ${status.activeVoice.label}${marker}`);
      }
    })
    .catch((err) => log.warn("Stimmprüfung fehlgeschlagen:", err.message));

  signage.verifyOnStart().catch((err) => log.warn("piSignage-Prüfung fehlgeschlagen:", err.message));

  // 5. Aufräumen des Audio-Zwischenspeichers, stündlich
  await tts.cleanup().catch(() => {});
  cleanupTimer = setInterval(() => {
    tts.cleanup().catch((err) => log.warn("Aufräumen fehlgeschlagen:", err.message));
    try {
      const removed = require("./db/callLogs").purgeExpired();
      if (removed) log.info(`Aufrufprotokoll: ${removed} abgelaufene Einträge gelöscht.`);
    } catch (err) {
      log.warn("Aufrufprotokoll konnte nicht aufgeräumt werden:", err.message);
    }
  }, 3600 * 1000);
  cleanupTimer.unref();
}

// --- Geordnetes Herunterfahren ---------------------------------------------
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal} empfangen – Server wird beendet…`);

  const force = setTimeout(() => {
    log.error("Beenden dauert zu lange, erzwinge Abbruch.");
    process.exit(1);
  }, 10000);
  force.unref();

  clearInterval(cleanupTimer);
  await callQueue.abortAll().catch(() => {});

  if (server) {
    await new Promise((resolve) => server.close(resolve));
    log.info("HTTP-Server geschlossen.");
  }
  await db.disconnect();
  log.info("Datenbankverbindung geschlossen.");

  clearTimeout(force);
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  log.error("Unbehandelte Promise-Ablehnung:", reason);
});
process.on("uncaughtException", (err) => {
  log.error("Unbehandelte Ausnahme:", err.stack || err.message);
  shutdown("uncaughtException");
});

if (require.main === module) {
  start().catch((err) => {
    log.error("Serverstart fehlgeschlagen:", err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { start, shutdown };
