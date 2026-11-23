"use strict";
/**
 * Express-Anwendung.
 */
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");

const config = require("./config");
const auth = require("./middleware/auth");
const errors = require("./middleware/errors");
const routes = require("./routes");
const log = require("./util/logger")("http");

function createApp() {
  const app = express();

  if (config.security.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // Sicherheits-Header. Die Anzeigeseiten laden ausschließlich eigene
  // Ressourcen, deshalb kann die Content-Security-Policy eng bleiben.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "blob:"],
          connectSrc: ["'self'", "ws:", "wss:"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'self'"], // piSignage bindet /tv als Seite ein
        },
      },
      crossOriginEmbedderPolicy: false,
      // Der Wartezimmer-TV lädt die Seite über eine andere Adresse.
      crossOriginResourcePolicy: { policy: "cross-origin" },
    })
  );

  const origins = config.security.allowedOrigins;
  app.use(
    cors({
      origin: origins.length ? origins : true,
      credentials: true,
    })
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(cookieParser());
  app.use(auth.attachSession);

  // Knappe Zugriffsprotokollierung – ohne Abfrageparameter, damit keine
  // Anzeige-Token im Log landen.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on("finish", () => {
      if (req.path === "/api/health") return;
      log.debug(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  // --- Audiodateien -------------------------------------------------------
  // Mopidy holt die Ansagen hierüber. Die Dateinamen sind SHA-256-Hashes und
  // damit nicht erratbar; Verzeichnislisting ist aus.
  fs.mkdirSync(config.paths.audioCache, { recursive: true });
  app.use(
    "/audio",
    express.static(config.paths.audioCache, {
      index: false,
      dotfiles: "deny",
      maxAge: "1h",
      setHeaders: (res) => {
        res.set("X-Robots-Tag", "noindex, nofollow");
        res.set("Content-Type", "audio/wav");
      },
    })
  );

  // --- Statische Dateien der Oberfläche ------------------------------------
  app.use(
    express.static(config.paths.public, {
      index: false,
      dotfiles: "deny",
      extensions: false,
      setHeaders: (res, filePath) => {
        // "no-cache" heißt: darf zwischengespeichert werden, muss aber vor
        // jeder Verwendung per ETag rückgefragt werden. Das kostet fast nichts
        // und verhindert, dass nach einem Update veraltete Skripte im Browser
        // eines Praxisrechners kleben bleiben.
        if (/\.(css|js|html)$/.test(filePath)) res.set("Cache-Control", "no-cache");
      },
    })
  );

  app.use(routes);

  app.use(errors.notFound);
  app.use(errors.handler);

  return app;
}

module.exports = { createApp };
