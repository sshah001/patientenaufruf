"use strict";
/**
 * Zentrale Konfiguration.
 *
 * Reihenfolge (späteres überschreibt früheres):
 *   1. config/default.json   – eingecheckte Standardwerte, KEINE Geheimnisse
 *   2. config/local.json     – lokale Anpassungen der Praxis (optional, nicht im Git)
 *   3. Umgebungsvariablen    – Geheimnisse und Deployment-Werte (.env)
 *
 * Alle Pfadangaben werden relativ zum Projekt-Root aufgelöst.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Konfigurationsdatei ${file} ist kein gültiges JSON: ${err.message}`);
  }
}

/** Tiefes Zusammenführen; Arrays werden ersetzt, nicht gemischt. */
function merge(base, override) {
  if (!override) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    const canRecurse =
      value && typeof value === "object" && !Array.isArray(value) &&
      out[key] && typeof out[key] === "object" && !Array.isArray(out[key]);
    if (canRecurse) {
      out[key] = merge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

const env = process.env;

function envStr(name) {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}
function envBool(name) {
  const v = envStr(name);
  if (v === undefined) return undefined;
  return ["1", "true", "yes", "ja", "on"].includes(v.toLowerCase());
}
function envInt(name) {
  const v = envStr(name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? undefined : n;
}

/** Entfernt undefined-Werte, damit merge() nichts unnötig überschreibt. */
function clean(obj) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const cleaned = clean(v);
    const isEmptyObject =
      cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0;
    if (isEmptyObject) continue;
    out[k] = cleaned;
  }
  return out;
}

const defaults = readJson(path.join(ROOT, "config", "default.json"));
if (!defaults) {
  throw new Error("config/default.json fehlt – das Projekt ist unvollständig installiert.");
}
const local = readJson(path.join(ROOT, "config", "local.json"));

const fromEnv = clean({
  app: {
    port: envInt("PORT"),
    publicUrl: envStr("APP_PUBLIC_URL"),
    timezone: envStr("TZ"),
    logLevel: envStr("LOG_LEVEL"),
  },
  practice: {
    name: envStr("PRACTICE_NAME"),
  },
  tts: {
    enabled: envBool("TTS_ENABLED"),
    piperBin: envStr("PIPER_BIN"),
    voicesDir: envStr("PIPER_VOICES_DIR"),
    voice: envStr("PIPER_VOICE"),
  },
  mopidy: {
    enabled: envBool("MOPIDY_ENABLED"),
    rpcUrl: envStr("MOPIDY_RPC_URL"),
  },
  signage: {
    enabled: envBool("SIGNAGE_ENABLED"),
    host: envStr("SIGNAGE_HOST"),
    port: envInt("SIGNAGE_PORT"),
  },
  weather: {
    enabled: envBool("WEATHER_ENABLED"),
    zip: envStr("WEATHER_ZIP"),
  },
  security: {
    authEnabled: envBool("SECURITY_AUTH_ENABLED"),
    trustProxy: envBool("TRUST_PROXY"),
  },
});

const config = merge(merge(defaults, local), fromEnv);

// --- Geheimnisse ausschließlich aus der Umgebung ----------------------------
config.secrets = {
  useMemoryDb: envBool("USE_MEMORY_DB") === true,
  sessionSecret: envStr("SESSION_SECRET"),
  appPin: envStr("APP_PIN"),
  displayToken: envStr("DISPLAY_TOKEN"),
  signageUser: envStr("SIGNAGE_USER") || "pi",
  signagePassword: envStr("SIGNAGE_PASSWORD"),
  weatherApiKey: envStr("OPENWEATHER_API_KEY"),
  databasePath: envStr("DB_PATH"),
};

// Ältere config/local.json ohne Wetter-Abschnitt weiterhin akzeptieren.
config.weather = { enabled: false, zip: "", country: "DE", cacheMinutes: 15, requestTimeoutMs: 8000, ...(config.weather || {}) };

// --- Abgeleitete Werte ------------------------------------------------------
config.app.publicUrl = String(config.app.publicUrl || "").replace(/\/+$/, "");
config.mopidy.audioBaseUrl = `${config.app.publicUrl}/audio`;

config.paths = {
  root: ROOT,
  public: path.join(ROOT, "public"),
  uploads: path.join(ROOT, "uploads"),
  data: path.join(ROOT, "data"),
  voices: path.resolve(ROOT, config.tts.voicesDir),
  audioCache: path.resolve(ROOT, config.tts.cacheDir),
  voiceDataset: path.join(ROOT, "data", "voice-dataset"),
  database: path.resolve(ROOT, config.secrets.databasePath || path.join("data", "patientenaufruf.db")),
};

config.isProduction = env.NODE_ENV === "production";
config.isTest = env.NODE_ENV === "test";

// Räume normalisieren: Whitespace weg, IDs sicherstellen, spoken-Fallback.
//
// `spoken` ist die vollständige gesprochene Wendung EINSCHLIESSLICH Präposition
// ("in das Labor", "zur Anmeldung"). Ohne sie entstünde "bitte kommen Sie in
// Labor". Fehlt die Angabe, wird "in <Raum>" ergänzt.
config.practice.rooms = (config.practice.rooms || [])
  .map((room, index) => {
    const label = String(typeof room === "string" ? room : room.label ?? "").trim();
    const fallbackId = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const spoken = typeof room === "object" && room.spoken ? String(room.spoken).trim() : `in ${label}`;
    return {
      id: String((typeof room === "object" && room.id) || fallbackId || `raum-${index + 1}`).trim(),
      label,
      spoken,
      color: (typeof room === "object" && room.color) || "#2563eb",
    };
  })
  .filter((r) => r.label);

/**
 * Prüft die Konfiguration auf Fehler (blockierend) und Warnungen (Hinweis).
 * Wird beim Start und von `npm run check-config` verwendet.
 */
function validate() {
  const errors = [];
  const warnings = [];


  if (config.security.authEnabled) {
    if (!config.secrets.appPin) {
      errors.push("SECURITY_AUTH_ENABLED=true, aber APP_PIN ist leer – niemand könnte sich anmelden.");
    } else if (config.secrets.appPin.length < 4) {
      errors.push("APP_PIN ist zu kurz (mindestens 4 Zeichen).");
    }
    if (!config.secrets.sessionSecret) {
      errors.push('SESSION_SECRET fehlt. Erzeugen mit: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    } else if (config.secrets.sessionSecret.length < 32) {
      warnings.push("SESSION_SECRET ist kürzer als 32 Zeichen – bitte länger wählen.");
    }
  } else {
    warnings.push("Authentifizierung ist DEAKTIVIERT. Jeder im Netz kann Patientendaten sehen und ändern.");
  }

  if (!config.app.publicUrl) {
    errors.push("APP_PUBLIC_URL fehlt. Mopidy und der Wartezimmer-TV brauchen eine erreichbare Adresse.");
  } else if (/localhost|127\.0\.0\.1/.test(config.app.publicUrl) && config.mopidy.enabled) {
    warnings.push(
      `APP_PUBLIC_URL zeigt auf ${config.app.publicUrl}. Läuft Mopidy auf einem anderen Rechner, kann es darüber keine Audiodateien laden.`
    );
  }

  if (config.practice.rooms.length === 0) {
    errors.push("Es ist kein Behandlungsraum konfiguriert (practice.rooms).");
  }
  const roomIds = config.practice.rooms.map((r) => r.id);
  const duplicateRoom = roomIds.find((id, i) => roomIds.indexOf(id) !== i);
  if (duplicateRoom) {
    errors.push(`Die Raum-ID "${duplicateRoom}" ist doppelt vergeben.`);
  }

  if (config.signage.enabled && !config.secrets.signagePassword) {
    warnings.push("SIGNAGE_PASSWORD ist leer – die piSignage-Anbindung wird sich vermutlich nicht anmelden können.");
  }
  if (config.weather.enabled && !config.secrets.weatherApiKey) {
    warnings.push("OPENWEATHER_API_KEY ist leer – die Wetter-Seite (/wetter) bleibt ohne Daten.");
  }
  if (config.privacy.rssRequiresToken && !config.secrets.displayToken) {
    warnings.push("DISPLAY_TOKEN ist leer – Anzeigeseiten (/tv, /monitor) und der RSS-Feed sind dann ungeschützt erreichbar.");
  }

  return { errors, warnings, ok: errors.length === 0 };
}

config.validate = validate;

/** Für Clients gefilterte Sicht – enthält garantiert keine Geheimnisse. */
config.publicView = function publicView() {
  return {
    app: { name: config.app.name, publicUrl: config.app.publicUrl },
    practice: {
      name: config.practice.name,
      logoUrl: config.practice.logoUrl,
      rooms: config.practice.rooms,
    },
    announcement: {
      repeatCount: config.announcement.repeatCount,
      repeatDelayMs: config.announcement.repeatDelayMs,
      gongEnabled: config.announcement.gongEnabled,
    },
    privacy: { nameDisplay: config.privacy.nameDisplay, showFirstName: config.privacy.showFirstName },
    signage: { enabled: config.signage.enabled, overlay: config.signage.overlay },
    tts: { enabled: config.tts.enabled, voice: config.tts.voice },
    mopidy: { enabled: config.mopidy.enabled },
    security: { authEnabled: config.security.authEnabled },
  };
};

module.exports = config;
