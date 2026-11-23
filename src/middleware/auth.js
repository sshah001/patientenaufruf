"use strict";
/**
 * Zugriffsschutz.
 *
 * In der Vorversion war das gesamte System ohne Anmeldung erreichbar – jeder
 * im Praxis-WLAN konnte unter /api/patients die komplette Patientenliste lesen
 * und löschen. Hier gibt es zwei getrennte Zugänge:
 *
 *   BEDIENUNG  (Personal): PIN-Anmeldung -> signiertes Cookie.
 *   ANZEIGE    (TV, Monitor, RSS): fester Token in der Adresse,
 *              z. B. http://server:3300/tv?token=…
 *              Anzeigegeräte können sich nicht anmelden, brauchen aber auch
 *              nur Lesezugriff auf die Aufrufanzeige.
 *
 * Bewusst kein Benutzerkonten-System: In einer Praxis teilt sich das Team
 * ohnehin einen Rechner; ein PIN, den alle kennen, ist realistisch und wird
 * tatsächlich benutzt. Wer mehr braucht, setzt einen Reverse Proxy davor.
 */
const crypto = require("crypto");
const config = require("../config");
const log = require("../util/logger")("auth");

const COOKIE_NAME = "pa_session";

/** Zeitkonstanter Vergleich, um Rückschlüsse über die Antwortzeit zu verhindern. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) {
    // Trotzdem vergleichen, damit die Laufzeit nicht von der Länge abhängt.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = crypto.createHmac("sha256", config.secrets.sessionSecret || "unsicher").update(data).digest("base64url");
  return `${data}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== "string") return null;
  const [data, mac] = token.split(".");
  if (!data || !mac) return null;

  const expected = crypto.createHmac("sha256", config.secrets.sessionSecret || "unsicher").update(data).digest("base64url");
  if (!safeEqual(mac, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Erzeugt ein Sitzungscookie nach erfolgreicher PIN-Eingabe. */
function issueSession(res, meta = {}) {
  const maxAgeMs = config.security.sessionHours * 3600 * 1000;
  const token = sign({ exp: Date.now() + maxAgeMs, role: "staff", ...meta });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.isProduction && config.security.trustProxy,
    maxAge: maxAgeMs,
    path: "/",
  });
  return token;
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { path: "/" });
}

// --- Schutz gegen PIN-Raten ------------------------------------------------
const attempts = new Map(); // IP -> { count, until }

function throttleKey(req) {
  return req.ip || req.socket.remoteAddress || "unbekannt";
}

function isLockedOut(req) {
  const entry = attempts.get(throttleKey(req));
  if (!entry) return false;
  if (entry.until && entry.until > Date.now()) return Math.ceil((entry.until - Date.now()) / 1000);
  if (entry.until && entry.until <= Date.now()) attempts.delete(throttleKey(req));
  return false;
}

function noteFailure(req) {
  const key = throttleKey(req);
  const entry = attempts.get(key) || { count: 0, until: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.until = Date.now() + 5 * 60 * 1000;
    entry.count = 0;
    log.warn(`Fünf Fehlversuche von ${key} – Anmeldung für 5 Minuten gesperrt.`);
  }
  attempts.set(key, entry);
}

function noteSuccess(req) {
  attempts.delete(throttleKey(req));
}

/** Prüft die eingegebene PIN. */
function checkPin(pin) {
  if (!config.secrets.appPin) return false;
  return safeEqual(pin, config.secrets.appPin);
}

// --- Middleware ------------------------------------------------------------

/** Erkennt eine gültige Sitzung und hängt sie an `req.session`. */
function attachSession(req, res, next) {
  req.session = verify(req.cookies?.[COOKIE_NAME]) || null;
  next();
}

/** Schützt die Bedienoberfläche und alle verändernden Schnittstellen. */
function requireStaff(req, res, next) {
  if (!config.security.authEnabled) return next();
  if (req.session?.role === "staff") return next();

  // Seitenaufrufe zur Anmeldung schicken, Schnittstellenaufrufe klar abweisen.
  const isPageRequest = req.method === "GET" && !req.path.startsWith("/api/");
  if (isPageRequest) {
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  return res.status(401).json({ error: "Nicht angemeldet.", code: "AUTH_REQUIRED" });
}

/**
 * Erlaubt Anzeigegeräten den Lesezugriff.
 * Gültig sind: angemeldete Mitarbeiter ODER der korrekte Anzeige-Token.
 */
function requireDisplay(req, res, next) {
  if (!config.security.authEnabled && !config.privacy.rssRequiresToken) return next();
  if (req.session?.role === "staff") return next();

  const expected = config.secrets.displayToken;
  if (!expected) {
    // Kein Token vergeben -> Anzeigen bleiben offen (Warnung beim Start).
    return next();
  }

  const provided = req.query.token || req.get("x-display-token") || req.cookies?.pa_display;
  if (provided && safeEqual(provided, expected)) {
    // Token merken, damit Folgeanfragen der Seite (CSS, Socket) ihn nicht brauchen.
    res.cookie("pa_display", expected, {
      httpOnly: true,
      sameSite: "lax",
      maxAge: 365 * 24 * 3600 * 1000,
      path: "/",
    });
    return next();
  }

  if (req.method === "GET" && !req.path.startsWith("/api/") && !req.path.endsWith(".xml")) {
    return res
      .status(403)
      .type("html")
      .send(
        "<h1>Zugriff verweigert</h1><p>Diese Anzeigeseite benötigt einen Token. Aufruf: <code>?token=…</code></p>"
      );
  }
  return res.status(403).json({ error: "Anzeige-Token fehlt oder ist falsch.", code: "DISPLAY_TOKEN_REQUIRED" });
}

/** Prüft den Anzeige-Token für WebSocket-Verbindungen. */
function checkDisplayToken(token) {
  if (!config.secrets.displayToken) return true;
  return safeEqual(token, config.secrets.displayToken);
}

module.exports = {
  COOKIE_NAME,
  attachSession,
  requireStaff,
  requireDisplay,
  issueSession,
  clearSession,
  checkPin,
  verify,
  isLockedOut,
  noteFailure,
  noteSuccess,
  checkDisplayToken,
};
