"use strict";
/**
 * Echtzeit-Verbindung zu allen Anzeigen.
 *
 * Zwei Räume:
 *   "staff"    Bedienoberfläche – bekommt alles, inklusive vollständiger Namen.
 *   "display"  Wartezimmer-TV und Monitore – bekommen nur die Aufrufanzeige,
 *              bereits datenschutzgerecht gekürzt (siehe privacy.nameDisplay).
 *
 * Anzeigegeräte sehen dadurch niemals die komplette Patientenliste.
 */
const { Server } = require("socket.io");
const config = require("../config");
const log = require("../util/logger")("socket");
const auth = require("../middleware/auth");

let io = null;

function init(httpServer) {
  const origins = config.security.allowedOrigins;
  io = new Server(httpServer, {
    cors: {
      origin: origins.length ? origins : [config.app.publicUrl, `http://localhost:${config.app.port}`],
      credentials: true,
    },
    pingTimeout: 20000,
  });

  io.use((socket, next) => {
    const { role, token } = socket.handshake.auth || {};
    const cookies = parseCookies(socket.handshake.headers.cookie || "");

    // Anzeigegeräte: Token prüfen.
    if (role === "display") {
      if (auth.checkDisplayToken(token || cookies.pa_display)) {
        socket.data.role = "display";
        return next();
      }
      return next(new Error("Anzeige-Token fehlt oder ist falsch."));
    }

    // Bedienoberfläche: Sitzungscookie prüfen.
    if (!config.security.authEnabled) {
      socket.data.role = "staff";
      return next();
    }
    const session = auth.verify(cookies[auth.COOKIE_NAME]);
    if (session?.role === "staff") {
      socket.data.role = "staff";
      return next();
    }
    return next(new Error("Nicht angemeldet."));
  });

  io.on("connection", (socket) => {
    const room = socket.data.role === "display" ? "display" : "staff";
    socket.join(room);
    log.debug(`Verbunden: ${socket.id} als ${room}`);

    socket.on("disconnect", () => log.debug(`Getrennt: ${socket.id}`));
  });

  log.info("Echtzeit-Verbindung bereit.");
  return io;
}

function parseCookies(header) {
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function get() {
  if (!io) throw new Error("Echtzeit-Verbindung ist noch nicht initialisiert.");
  return io;
}

/** An die Bedienoberfläche (vollständige Daten). */
function toStaff(event, payload) {
  if (io) io.to("staff").emit(event, payload);
}

/** An die Anzeigegeräte (nur Aufrufinformationen). */
function toDisplay(event, payload) {
  if (io) io.to("display").emit(event, payload);
}

/** An alle. */
function toAll(event, payload) {
  if (io) io.emit(event, payload);
}

function counts() {
  if (!io) return { staff: 0, display: 0 };
  return {
    staff: io.sockets.adapter.rooms.get("staff")?.size || 0,
    display: io.sockets.adapter.rooms.get("display")?.size || 0,
  };
}

module.exports = { init, get, toStaff, toDisplay, toAll, counts };
