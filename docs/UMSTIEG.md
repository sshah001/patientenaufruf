# Umstieg von der Version 1 (Container `patientenaufruf-app`, Stand Juni 2025)

Die bisher laufende Version (`/var/lib/Patientenaufruf_v01` im Container,
Port 3300, MongoDB auf 192.168.130.196) wird **nicht verändert**, bis die neue
Version im Praxisalltag geprüft ist.

## Was sich ändert

| | Version 1 | Version 2.1 |
|---|---|---|
| Code | `server.js`, `controllers/`, `views/` | `src/`, `public/` |
| Datenbank | MongoDB (eigener Server, Passwort) | SQLite-Datei im Volume `app_data` |
| Zugang | offen für alle im Netz | PIN für die Bedienung, Token für TV/Monitor |
| Import | löscht vor jedem Import alle Patienten | Vorschau, dann Abgleich – Aufgerufene bleiben erhalten |
| Piper | per Shell (`echo … \| piper`) | direkt, ohne Shell; Ersatzstimme bei defektem Modell |
| piSignage | `monitor-rss.html` als Asset | Seite `/tv?token=…` als Asset (Modus `overlay`) |
| Wetter | API-Schlüssel im HTML | Server holt die Daten, Schlüssel in der `.env` |
| Config-Volume | enthielt Programmcode (`config/*.js`) | nur noch JSON-Einstellungen |

Daten aus MongoDB müssen nicht übernommen werden: Die Tagesliste wird jeden
Morgen neu importiert, und das alte Aufrufprotokoll ist nach 30 Tagen ohnehin
zu löschen.

## Schritt 1 – parallel testen (Port 3301)

```bash
git clone https://github.com/sshah001/patientenaufruf.git /opt/patientenaufruf-v2
cd /opt/patientenaufruf-v2
cp .env.example .env
# In der .env setzen:
#   HOST_PORT=3301
#   APP_PUBLIC_URL=http://192.168.130.196:3301
#   PIPER_VOICES_HOST_DIR=/root/.local/share/piper
#   PIPER_VOICE=<eine vorhandene Stimme, z. B. de_DE-thorsten-medium>
#   SESSION_SECRET, APP_PIN, DISPLAY_TOKEN, SIGNAGE_PASSWORD, OPENWEATHER_API_KEY
cd docker
docker compose -p patientenaufruf-v2 up -d --build
docker compose -p patientenaufruf-v2 logs -f app
```

Dann `http://192.168.130.196:3301/system` öffnen und den Selbsttest ausführen.
Zum Testen des Fernsehers in piSignage ein zweites Link-Asset auf
`http://192.168.130.196:3301/tv?token=<DISPLAY_TOKEN>` anlegen.

## Schritt 2 – umschalten

Wenn alles passt:

```bash
docker stop patientenaufruf-app          # alte Version anhalten (nicht löschen)
# in /opt/patientenaufruf-v2/.env: HOST_PORT=3300, APP_PUBLIC_URL=…:3300
cd /opt/patientenaufruf-v2/docker
docker compose -p patientenaufruf-v2 up -d
```

In piSignage das Asset von `monitor-rss.html` auf `/tv?token=…` umstellen.
`/pi-wetter` bleibt unter derselben Adresse erreichbar.

## Zurück zur alten Version

```bash
docker compose -p patientenaufruf-v2 down
docker start patientenaufruf-app
```
