"use strict";
/**
 * Wettervorhersage für die Wetter-Seite des Wartezimmer-Fernsehers.
 *
 * In der Vorversion stand der OpenWeatherMap-Schlüssel im HTML und jeder
 * Fernseher fragte die API selbst ab. Jetzt holt der Server die Daten, hält
 * sie eine Weile vor (config.weather.cacheMinutes) und liefert sie unter
 * /api/weather/forecast aus. Der Schlüssel bleibt in der .env.
 */
const axios = require("axios");
const config = require("../config");
const log = require("../util/logger")("weather");

let cache = { at: 0, data: null };
let location = null;
let pending = null;

function apiKey() {
  return config.secrets.weatherApiKey;
}

async function resolveLocation() {
  if (location) return location;
  const { zip, country, requestTimeoutMs } = config.weather;
  const res = await axios.get("https://api.openweathermap.org/geo/1.0/zip", {
    params: { zip: `${zip},${country}`, appid: apiKey() },
    timeout: requestTimeoutMs,
  });
  location = { lat: res.data.lat, lon: res.data.lon, name: res.data.name };
  return location;
}

async function fetchForecast() {
  const loc = await resolveLocation();
  const res = await axios.get("https://api.openweathermap.org/data/2.5/forecast", {
    params: { lat: loc.lat, lon: loc.lon, units: "metric", lang: "de", appid: apiKey() },
    timeout: config.weather.requestTimeoutMs,
  });
  return res.data;
}

/**
 * Liefert die 5-Tage-Vorhersage im Format der OpenWeatherMap-API.
 * @returns {Promise<{ok:boolean, data?:object, error?:string, cached?:boolean}>}
 */
async function forecast() {
  if (!config.weather.enabled) return { ok: false, error: "Wetter-Seite ist deaktiviert." };
  if (!apiKey()) return { ok: false, error: "OPENWEATHER_API_KEY ist nicht gesetzt." };

  const maxAgeMs = Math.max(1, config.weather.cacheMinutes) * 60 * 1000;
  if (cache.data && Date.now() - cache.at < maxAgeMs) {
    return { ok: true, data: cache.data, cached: true };
  }

  // Mehrere Fernseher gleichzeitig lösen nur EINE Anfrage aus.
  if (!pending) {
    pending = fetchForecast()
      .then((data) => {
        cache = { at: Date.now(), data };
        return { ok: true, data, cached: false };
      })
      .catch((err) => {
        const status = err.response?.status;
        const msg = status === 401 ? "OpenWeatherMap lehnt den API-Schlüssel ab." : err.message;
        log.warn(`Wetterabruf fehlgeschlagen: ${msg}`);
        // Lieber veraltete Daten zeigen als einen leeren Bildschirm.
        if (cache.data) return { ok: true, data: cache.data, cached: true, stale: true };
        return { ok: false, error: msg };
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

module.exports = { forecast };
