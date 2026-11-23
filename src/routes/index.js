"use strict";
/**
 * Alle Routen an einer Stelle.
 *
 * In der Vorversion war derselbe Router dreimal gemountet (/api, / und nochmal
 * /), sodass jede Route unter mehreren Adressen existierte und /monitor mit
 * sich selbst kollidierte. Hier gilt: eine Adresse pro Zweck.
 *
 * Zugriffsebenen:
 *   requireStaff    – Bedienung, verändernde Aufrufe
 *   requireDisplay  – Anzeigegeräte, nur Aufrufanzeige
 *   (offen)         – Anmeldung und Gesundheitscheck
 */
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const path = require("path");

const config = require("../config");
const auth = require("../middleware/auth");
const patients = require("../controllers/patients");
const importCtrl = require("../controllers/import");
const display = require("../controllers/display");
const system = require("../controllers/system");
const authCtrl = require("../controllers/auth");
const voiceStudio = require("../controllers/voiceStudio");
const announce = require("../controllers/announce");
const weather = require("../services/weather");

const router = express.Router();
const viewFile = (name) => path.join(config.paths.public, name);

// Uploads bleiben im Arbeitsspeicher – keine Patientendaten auf der Platte.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.import.maxFileSizeMb * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(json|csv|txt)$/i.test(file.originalname);
    cb(ok ? null : new Error("Es werden nur .json- und .csv-Dateien angenommen."), ok);
  },
});

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Zu viele Anmeldeversuche. Bitte später erneut versuchen.", code: "RATE_LIMIT" },
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------- Anmeldung
router.get("/login", (req, res) => res.sendFile(viewFile("login.html")));
router.post("/api/auth/login", loginLimiter, authCtrl.login);
router.post("/api/auth/logout", authCtrl.logout);
router.get("/api/auth/me", authCtrl.me);

// ------------------------------------------------------------ Gesundheit
router.get("/api/health", system.health);

// ------------------------------------------------------------- Bedienung
router.get("/", auth.requireStaff, (req, res) => res.sendFile(viewFile("index.html")));
router.get("/import", auth.requireStaff, (req, res) => res.sendFile(viewFile("import.html")));
router.get("/system", auth.requireStaff, (req, res) => res.sendFile(viewFile("system.html")));
router.get("/voice-studio", auth.requireStaff, (req, res) => res.sendFile(viewFile("voice-studio.html")));

// ------------------------------------------------------------- Anzeigen
router.get("/tv", auth.requireDisplay, (req, res) => res.sendFile(viewFile("tv.html")));
router.get("/monitor", auth.requireDisplay, (req, res) => res.sendFile(viewFile("monitor.html")));
router.get("/rss.xml", auth.requireDisplay, display.rss);
router.get("/api/display/state", auth.requireDisplay, display.state);
router.get("/api/display/last", auth.requireDisplay, display.last);

// ------------------------------------------------------------- Wetter
// Ohne Token erreichbar: enthält keine Patientendaten, und die bestehenden
// piSignage-Assets verweisen bereits auf /pi-wetter.
const weatherCsp = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com",
  "font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "img-src 'self' data: https://svs.gsfc.nasa.gov",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join("; ");
const sendWeatherPage = (req, res) => {
  res.set("Content-Security-Policy", weatherCsp);
  res.sendFile(viewFile("wetter.html"));
};
router.get("/wetter", sendWeatherPage);
router.get("/pi-wetter", sendWeatherPage);
router.get("/api/weather/forecast", async (req, res, next) => {
  try {
    const result = await weather.forecast();
    if (!result.ok) return res.status(503).json({ error: result.error });
    res.set("Cache-Control", "no-store");
    res.json(result.data);
  } catch (err) {
    next(err);
  }
});

// ------------------------------------------------------- Patienten-API
router.use("/api", apiLimiter);

router.get("/api/config", system.publicConfig);
router.get("/api/rooms", auth.requireStaff, patients.rooms);

router.get("/api/patients", auth.requireStaff, patients.list);
router.post("/api/patients", auth.requireStaff, patients.create);
router.delete("/api/patients", auth.requireStaff, patients.removeAll);
router.post("/api/patients/reset", auth.requireStaff, patients.resetCalled);

router.get("/api/patients/:id", auth.requireStaff, patients.get);
router.put("/api/patients/:id", auth.requireStaff, patients.update);
router.delete("/api/patients/:id", auth.requireStaff, patients.remove);
router.patch("/api/patients/:id/status", auth.requireStaff, patients.setStatus);
router.post("/api/patients/:id/call", auth.requireStaff, patients.call);
router.post("/api/patients/:id/recall", auth.requireStaff, patients.recall);

router.get("/api/queue", auth.requireStaff, patients.queueState);
router.post("/api/queue/abort", auth.requireStaff, patients.abortQueue);
router.get("/api/calls", auth.requireStaff, patients.callLog);

// ------------------------------------------------------- Freie Durchsage
router.post("/api/announce", auth.requireStaff, announce.speak);
router.post("/api/announce/preview", auth.requireStaff, announce.preview);
router.get("/api/announce/presets", auth.requireStaff, announce.presets);
router.get("/api/announce/history", auth.requireStaff, announce.history);

// ------------------------------------------------------------ Import
router.post("/api/import/preview", auth.requireStaff, upload.single("file"), importCtrl.preview);
router.post("/api/import/apply", auth.requireStaff, importCtrl.apply);
router.post("/api/import/prewarm", auth.requireStaff, importCtrl.prewarm);

// ------------------------------------------------- Stimmen und Diagnose
router.get("/api/voices", auth.requireStaff, system.voices);
router.post("/api/voices/test", auth.requireStaff, system.testVoice);
router.post("/api/voices/play", auth.requireStaff, system.playTest);
router.post("/api/voices/cache/clear", auth.requireStaff, system.clearCache);

router.get("/api/status", auth.requireStaff, system.status);
router.get("/api/diagnostics/selftest", auth.requireStaff, system.selftest);
router.get("/api/diagnostics/signage", auth.requireStaff, system.diagnoseSignage);
router.get("/api/diagnostics/mopidy", auth.requireStaff, system.diagnoseMopidy);

// ------------------------------------------------------ Aufnahme-Studio
router.get("/api/voice-studio/prompts", auth.requireStaff, voiceStudio.prompts);
router.post(
  "/api/voice-studio/clip/:index",
  auth.requireStaff,
  express.raw({ type: "audio/wav", limit: "25mb" }),
  voiceStudio.saveClip
);
router.get("/api/voice-studio/clip/:index", auth.requireStaff, voiceStudio.getClip);
router.delete("/api/voice-studio/clip/:index", auth.requireStaff, voiceStudio.deleteClip);
router.get("/api/voice-studio/export", auth.requireStaff, voiceStudio.exportDataset);
router.get("/api/voice-studio/install", auth.requireStaff, voiceStudio.checkInstall);

module.exports = router;
