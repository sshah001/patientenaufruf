"use strict";
/**
 * Daten für Anzeigegeräte: Wartezimmer-TV, Monitorbrowser und RSS-Laufband.
 *
 * Diese Endpunkte liefern bewusst NUR aufbereitete Aufrufe – nie die
 * Patientenliste. Selbst wer den Anzeige-Token kennt, sieht damit nicht,
 * wer heute noch alles einen Termin hat.
 */
const config = require("../config");
const signage = require("../services/signage");
const { escapeXml } = require("../util/text");

// GET /api/display/state
exports.state = (req, res) => {
  res.json({
    practice: { name: config.practice.name, logoUrl: config.practice.logoUrl },
    overlay: config.signage.overlay,
    last: signage.lastCall(),
    recent: signage.recent(config.signage.overlay.tickerCount),
    serverTime: new Date().toISOString(),
  });
};

// GET /api/display/last
exports.last = (req, res) => {
  res.json(signage.lastCall() || null);
};

/**
 * GET /rss.xml
 * Laufband-Quelle für piSignage (Ticker-Widget).
 *
 * Zwei Dinge sind hier wichtig:
 *  - Jeder Eintrag bekommt eine GUID mit Zeitstempel, sonst zeigt piSignage
 *    nach dem ersten Abruf nichts Neues mehr an.
 *  - Caching wird konsequent unterbunden.
 */
exports.rss = (req, res) => {
  const calls = signage.recent(config.signage.overlay.tickerCount);
  const base = config.app.publicUrl;
  const now = new Date().toUTCString();
  const stamp = Date.now();

  const items = calls.length
    ? calls.map((call, index) => {
        const text = `${call.headline} — ${call.room}`;
        return `    <item>
      <title><![CDATA[${text}]]></title>
      <link>${escapeXml(base)}/tv</link>
      <description><![CDATA[${text}]]></description>
      <guid isPermaLink="false">${escapeXml(call.id)}-${stamp}-${index}</guid>
      <pubDate>${new Date(call.at).toUTCString()}</pubDate>
    </item>`;
      })
    : [
        `    <item>
      <title><![CDATA[${escapeXml(config.practice.name)}]]></title>
      <link>${escapeXml(base)}/tv</link>
      <description><![CDATA[Herzlich willkommen]]></description>
      <guid isPermaLink="false">idle-${stamp}</guid>
      <pubDate>${now}</pubDate>
    </item>`,
      ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title><![CDATA[${escapeXml(config.practice.name)} — Patientenaufruf]]></title>
    <link>${escapeXml(base)}/tv</link>
    <description><![CDATA[Die zuletzt aufgerufenen Patienten]]></description>
    <language>de-de</language>
    <ttl>1</ttl>
    <lastBuildDate>${now}</lastBuildDate>
${items.join("\n")}
  </channel>
</rss>`;

  res.set({
    "Content-Type": "application/rss+xml; charset=UTF-8",
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.send(xml);
};
