"use strict";
/**
 * Direkte Anbindung an die Piper-Binary.
 *
 * Bewusst OHNE Shell: der Prozess wird mit `spawn(bin, args)` gestartet und der
 * Text über stdin übergeben. Damit kann kein Patientenname aus dem Import je
 * als Shell-Befehl interpretiert werden (das war in der Vorversion möglich).
 *
 * Piper existiert in mehreren Varianten (C++-Binary, piper-tts aus PyPI,
 * piper1-gpl) mit leicht unterschiedlichen Parameternamen. Beim ersten Aufruf
 * wird `--help` ausgewertet und die passende Schreibweise gemerkt.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const log = require("../../util/logger")("piper");

let capabilities = null;

/** Führt einen Prozess aus und sammelt stdout/stderr. */
function run(bin, args, { input, timeoutMs = 20000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: err.message, spawnError: err });
      return;
    }

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill("SIGKILL");
      resolve({ code: -1, stdout, stderr: `${stderr}\n[Zeitüberschreitung nach ${timeoutMs} ms]`, timedOut: true });
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: err.message, spawnError: err });
    });

    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (input !== undefined) {
      child.stdin.on("error", () => {}); // EPIPE ignorieren, wenn Piper früh abbricht
      child.stdin.end(input, "utf8");
    }
  });
}

/**
 * Ermittelt einmalig, ob Piper verfügbar ist und welche Parameternamen es kennt.
 */
async function detect(binPath) {
  if (capabilities && capabilities.bin === binPath) return capabilities;

  const result = await run(binPath, ["--help"], { timeoutMs: 15000 });
  const help = `${result.stdout}\n${result.stderr}`;

  if (result.spawnError && result.spawnError.code === "ENOENT") {
    capabilities = {
      bin: binPath,
      available: false,
      reason: `Piper wurde nicht gefunden ("${binPath}"). Bitte PIPER_BIN in der .env auf den vollständigen Pfad setzen.`,
    };
    return capabilities;
  }

  // Manche Builds beenden --help mit Code 1, liefern aber trotzdem Text.
  const looksLikePiper = /piper/i.test(help) || /--model/.test(help);
  if (!looksLikePiper) {
    capabilities = {
      bin: binPath,
      available: false,
      reason: `"${binPath}" antwortet nicht wie Piper. Ausgabe: ${help.slice(0, 200)}`,
    };
    return capabilities;
  }

  capabilities = {
    bin: binPath,
    available: true,
    outputFlag: help.includes("--output_file") ? "--output_file" : "--output-file",
    supportsLengthScale: help.includes("--length_scale") || help.includes("--length-scale"),
    lengthScaleFlag: help.includes("--length_scale") ? "--length_scale" : "--length-scale",
    noiseScaleFlag: help.includes("--noise_scale") ? "--noise_scale" : "--noise-scale",
    noiseWFlag: help.includes("--noise_w") ? "--noise_w" : "--noise-w",
    sentenceSilenceFlag: help.includes("--sentence_silence") ? "--sentence_silence" : "--sentence-silence",
    supportsSentenceSilence: /--sentence[_-]silence/.test(help),
    supportsNoise: /--noise[_-]scale/.test(help),
    version: (help.match(/piper[\s-]*v?(\d+\.\d+[\d.]*)/i) || [])[1] || "unbekannt",
  };

  log.info(`Piper gefunden (${capabilities.bin}, Version ${capabilities.version}, Ausgabe-Parameter ${capabilities.outputFlag}).`);
  return capabilities;
}

/**
 * Synthetisiert `text` mit dem Modell `modelPath` nach `outputPath`.
 *
 * @returns {Promise<{ok: boolean, durationMs: number, error?: string}>}
 */
async function synthesize({ text, modelPath, outputPath, options = {}, binPath, timeoutMs = 30000 }) {
  const caps = await detect(binPath);
  if (!caps.available) {
    return { ok: false, durationMs: 0, error: caps.reason, engineUnavailable: true };
  }
  if (!fs.existsSync(modelPath)) {
    return { ok: false, durationMs: 0, error: `Stimmmodell nicht gefunden: ${modelPath}` };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const args = ["--model", modelPath, caps.outputFlag, outputPath];

  if (caps.supportsLengthScale && options.lengthScale != null) {
    args.push(caps.lengthScaleFlag, String(options.lengthScale));
  }
  if (caps.supportsNoise && options.noiseScale != null) {
    args.push(caps.noiseScaleFlag, String(options.noiseScale));
  }
  if (caps.supportsNoise && options.noiseW != null) {
    args.push(caps.noiseWFlag, String(options.noiseW));
  }
  if (caps.supportsSentenceSilence && options.sentenceSilenceSec != null) {
    args.push(caps.sentenceSilenceFlag, String(options.sentenceSilenceSec));
  }
  if (options.speakerId != null) {
    args.push("--speaker", String(options.speakerId));
  }

  const started = Date.now();
  const result = await run(caps.bin, args, { input: text, timeoutMs });
  const durationMs = Date.now() - started;

  if (result.code !== 0 && !fs.existsSync(outputPath)) {
    return {
      ok: false,
      durationMs,
      error: result.timedOut
        ? `Piper hat nach ${timeoutMs} ms nicht geantwortet.`
        : `Piper endete mit Code ${result.code}: ${result.stderr.trim().slice(0, 400)}`,
    };
  }

  const stat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;
  if (!stat || stat.size < 128) {
    return { ok: false, durationMs, error: "Piper hat eine leere Audiodatei erzeugt." };
  }

  return { ok: true, durationMs, bytes: stat.size };
}

/** Setzt die gemerkten Fähigkeiten zurück (z. B. nach Konfigurationsänderung). */
function reset() {
  capabilities = null;
}

/** Status für die Diagnoseseite. */
async function status(binPath) {
  const caps = await detect(binPath);
  return {
    available: caps.available,
    bin: caps.bin,
    version: caps.version || null,
    reason: caps.reason || null,
  };
}

module.exports = { synthesize, detect, status, reset };
