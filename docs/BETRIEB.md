# Betrieb und Einrichtung

## Überblick: wie die Teile zusammenspielen

```
   Doctolib-Export (JSON/CSV)
            │
            ▼
   ┌──────────────────────┐        WebSocket        ┌────────────────────┐
   │  Patientenaufruf     │ ──────────────────────► │  Wartezimmer-TV    │
   │  (Node.js + SQLite)  │                         │  /tv  in piSignage │
   └──────────────────────┘                         └────────────────────┘
            │      ▲
    WAV per │      │ JSON-RPC
    HTTP    ▼      │
   ┌──────────────────────┐        Audio-Stream     ┌────────────────────┐
   │  Mopidy              │ ──────────────────────► │  Snapcast-Clients  │
   └──────────────────────┘                         │  (Lautsprecher)    │
            ▲                                       └────────────────────┘
            │ erzeugt
   ┌──────────────────────┐
   │  Piper (lokal)       │  ← eigene Praxisstimme
   └──────────────────────┘
```

Ein Knopfdruck löst genau diese Kette aus:

1. Patientenstatus wird gesetzt.
2. **Sofort** erscheint der Aufruf auf dem Wartezimmer-TV (WebSocket).
3. Die Ansage wird geholt – normalerweise bereits vorproduziert, also ohne
   Wartezeit.
4. Mopidy lädt die WAV-Datei per HTTP vom Server und gibt sie über Snapcast aus.
5. Der Vorgang wird protokolliert.

**Wichtig:** Schritt 4 bedeutet, dass Mopidy den Server über `APP_PUBLIC_URL`
erreichen können muss. Steht dort `localhost`, funktioniert der Ton nur, wenn
Mopidy auf demselben Rechner läuft.

---

## Voraussetzungen

| Komponente | Zweck | Pflicht |
|---|---|---|
| Node.js 22.13+ (empfohlen 24) | Anwendung, enthält auch die Datenbank (`node:sqlite`) | ja |
| Piper | Sprachsynthese | für Ton |
| Mopidy + Snapcast | Audioausgabe im Wartezimmer | für Ton |
| piSignage | Wartezimmer-Fernseher | für Bild |

Ohne Piper/Mopidy läuft alles Übrige weiter – dann eben ohne Ton. Ohne
piSignage funktionieren die Browser-Anzeigen `/tv` und `/monitor` trotzdem.

---

## Installation mit Docker (empfohlen)

Funktioniert auf einem x86-Server und auf einem Raspberry Pi.

Eine separate Datenbank ist nicht nötig: Patientenliste und Aufrufprotokoll
liegen als SQLite-Datei im Docker-Volume `app_data`
(`/app/data/patientenaufruf.db`). Das läuft auf Pi 4 und Pi 5 gleichermaßen.

```bash
# 1. Konfiguration anlegen
cp .env.example .env

# 2. Geheimnisse erzeugen
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('DISPLAY_TOKEN='  + require('crypto').randomBytes(16).toString('hex'))"
# Ausgaben in die .env übernehmen, dazu APP_PIN setzen.

# 3. Adressen eintragen (die IP des Servers, nicht localhost!)
#    APP_PUBLIC_URL=http://192.168.130.196:3300
#    MOPIDY_RPC_URL=http://192.168.130.196:6680/mopidy/rpc
#    SIGNAGE_HOST=192.168.130.204
#    HOST_PORT=3300
#    PIPER_VOICES_HOST_DIR=/root/.local/share/piper   (Ordner mit den .onnx-Stimmen)
#    OPENWEATHER_API_KEY=...                           (für die Wetter-Seite)

# 4. Starten
cd docker
docker compose up -d --build

# 5. Prüfen
docker compose logs -f app
```

Danach im Browser `http://<server-ip>:3300` öffnen und mit dem PIN anmelden.

### Aktualisieren

```bash
git pull
cd docker
docker compose up -d --build
```

Datenbank, vorproduzierte Ansagen und Stimmen überleben das, weil sie im
Volume `app_data` bzw. im Stimmenordner auf dem Server liegen.

### Datensicherung

Die gesamte Datenhaltung ist eine Datei. Sicherung im laufenden Betrieb:

```bash
docker compose exec app node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('/app/data/patientenaufruf.db').exec(\"VACUUM INTO '/app/data/sicherung.db'\")"
docker compose cp app:/app/data/sicherung.db ./sicherung-$(date +%F).db
```

---

## Installation ohne Docker

```bash
# Systempakete (Debian/Ubuntu/Raspberry Pi OS)
sudo apt update
# Node.js 22.13+ bzw. 24 – z. B. über https://nodejs.org oder NodeSource
sudo apt install -y python3-venv espeak-ng-data

# Piper
python3 -m venv ~/.local/piper-venv
~/.local/piper-venv/bin/pip install piper-tts
# In der .env:  PIPER_BIN=/home/<benutzer>/.local/piper-venv/bin/piper

# Anwendung
npm ci --omit=dev
cp .env.example .env    # ausfüllen
npm run check-config    # prüft alles vor dem ersten Start
npm start
```

### Als Dienst einrichten (systemd)

`/etc/systemd/system/patientenaufruf.service`:

```ini
[Unit]
Description=Patientenaufruf
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=praxis
WorkingDirectory=/opt/patientenaufruf
EnvironmentFile=/opt/patientenaufruf/.env
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now patientenaufruf
sudo journalctl -u patientenaufruf -f
```

---

## Mopidy und Snapcast

Der Server schickt Mopidy nur eine **URL**; alles Weitere macht Mopidy.

`/etc/mopidy/mopidy.conf`:

```ini
[http]
enabled = true
hostname = 0.0.0.0        ; damit der Aufruf-Server zugreifen kann
port = 6680

[audio]
; Ausgabe in die Snapcast-Pipe
output = audioresample ! audio/x-raw,rate=48000,channels=2,format=S16LE ! filesink location=/tmp/snapfifo

[stream]
enabled = true            ; erlaubt das Abspielen von http://…-URLs

[m3u]
enabled = false
[local]
enabled = false
```

`/etc/snapserver.conf`:

```ini
[stream]
source = pipe:///tmp/snapfifo?name=Praxis&sampleformat=48000:16:2&codec=flac
```

Prüfen:

```bash
# Antwortet Mopidy?
curl -s -X POST http://<mopidy-host>:6680/mopidy/rpc \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"core.get_version"}'

# Erreicht Mopidy den Aufruf-Server? (auf dem Mopidy-Rechner ausführen)
curl -sI http://<aufruf-server>:3300/api/health
```

Beides lässt sich auch bequem unter **`/system` → Selbsttest** prüfen.

### Kein Ton, obwohl alles „grün" ist

1. `/system` → *Sprachausgabe testen* → **„Über Lautsprecher ausgeben"**.
   Die Fehlermeldung nennt die Stelle, an der es hängt.
2. Kommt „Mopidy konnte die Audiodatei nicht laden": `APP_PUBLIC_URL` zeigt
   auf eine Adresse, die Mopidy nicht erreicht.
3. Kommt keine Fehlermeldung, ist aber nichts zu hören: Snapcast-Client,
   Lautstärke und Verstärker prüfen. Mopidy meldet Erfolg, sobald es die Datei
   abgespielt hat – ob ein Lautsprecher angeschlossen ist, weiß es nicht.

---

## piSignage: Wartezimmer-Fernseher

Empfohlen ist der Modus **`overlay`** (Standard). Dabei zeigt der Fernseher
dauerhaft die Seite `/tv` an, die sich ihre Aufrufe selbst per WebSocket holt.

Vorteil gegenüber dem früheren Weg: Es ist **kein API-Aufruf pro Patient**
nötig. Der Aufruf erscheint sofort und funktioniert auch dann, wenn die
piSignage-API gerade zickt.

### Einrichtung

1. In piSignage ein **Asset vom Typ Link** anlegen:

   ```
   http://192.168.130.196:3300/tv?token=<DISPLAY_TOKEN>
   ```

2. Das Asset in die Playlist aufnehmen. Für eine dauerhafte Anzeige die
   Anzeigedauer auf einen hohen Wert setzen oder das Asset als einzigen
   Playlist-Eintrag verwenden.

3. Fertig. Popup und Laufband bringt die Seite selbst mit.

### Zusätzlich: Laufband über die piSignage-Ticker-Funktion

Wer das Laufband lieber von piSignage zeichnen lässt, trägt als RSS-Quelle ein:

```
http://192.168.130.196:3300/rss.xml?token=<DISPLAY_TOKEN>
```

Der Feed liefert die letzten Aufrufe und ist bewusst nicht zwischenspeicherbar.

### Alternative Modi

In `config/local.json`:

```json
{ "signage": { "mode": "notice" } }
```

- `notice` – der Aufruf wird über die piSignage-Notice-API eingeblendet.
- `asset` – ein vorbereitetes Asset wird kurz abgespielt.

Welche Endpunkte das eigene Gerät versteht, zeigt
**`/system` → piSignage prüfen**. Erst diese Diagnose ausführen, dann den
Modus wählen – dann steht fest, was funktioniert, statt es zu raten.

---

## Eigene Anpassungen

Alles Praxisspezifische gehört in **`config/local.json`**. Diese Datei
überschreibt `config/default.json` und wird bei Updates nicht angefasst.

```json
{
  "practice": {
    "name": "Praxis Dr. Rosenthal",
    "rooms": [
      { "id": "bz1",   "label": "Zimmer 1",  "spoken": "in Zimmer eins",  "color": "#2563eb" },
      { "id": "bz2",   "label": "Zimmer 2",  "spoken": "in Zimmer zwei",  "color": "#0891b2" },
      { "id": "sono",  "label": "Sono",      "spoken": "in die Sonografie", "color": "#7c3aed" },
      { "id": "anm",   "label": "Anmeldung", "spoken": "zur Anmeldung",   "color": "#64748b" }
    ]
  },
  "announcement": {
    "template": "{anrede} {name}, bitte kommen Sie {raum}.",
    "repeatCount": 2,
    "repeatDelayMs": 3000,
    "gongEnabled": true
  },
  "signage": {
    "overlay": { "popupSeconds": 20, "tickerCount": 3 }
  },
  "privacy": {
    "nameDisplay": "full",
    "audioRetentionHours": 24,
    "callLogRetentionDays": 30
  },
  "tts": {
    "lengthScale": 1.0,
    "prewarmRooms": ["bz1", "bz2", "sono", "anm"]
  }
}
```

Wichtige Felder:

- **`spoken`** ist die *gesprochene Wendung inklusive Präposition*. Ohne sie
  entstünde „bitte kommen Sie in Labor" statt „in das Labor".
- **`lengthScale`** steuert das Sprechtempo: kleiner = schneller
  (0.9 ≈ zügig, 1.1 ≈ getragen).
- **`prewarmRooms`** begrenzt die Vorproduktion auf die tatsächlich genutzten
  Räume. Auf einem Raspberry Pi spart das spürbar Zeit.
- **`nameDisplay`**: `full` (Mustermann), `abbrev` (Muster.) oder `initial` (M.)
  – gilt für TV, Monitor und RSS, **nicht** für die Bedienoberfläche.

---

## Datenschutz

Was das System von sich aus tut:

- Die **Patientenliste** verlässt niemals den Bereich der angemeldeten
  Bedienplätze. Anzeigegeräte (TV, Monitor, RSS) bekommen ausschließlich die
  aufbereiteten Aufrufe – nie die Terminliste.
- **Audiodateien** heißen nach ihrem SHA-256-Hash, sind also nicht erratbar,
  und werden nach `privacy.audioRetentionHours` (Standard: 24 h) gelöscht.
- Das **Aufrufprotokoll** löscht sich nach `privacy.callLogRetentionDays`
  (Standard: 30 Tage); der Server räumt beim Start und danach stündlich auf.
- **Logdateien** kürzen Patientennamen auf den ersten Buchstaben, sobald
  `NODE_ENV=production` gesetzt ist.
- Hochgeladene Importdateien werden **nur im Arbeitsspeicher** verarbeitet und
  landen nie auf der Festplatte.

Was du selbst tun musst:

- Einen **PIN** setzen und `SECURITY_AUTH_ENABLED=true` lassen.
- Einen **DISPLAY_TOKEN** setzen, sonst sind `/tv`, `/monitor` und `/rss.xml`
  für jeden im Netz offen.
- Den Server **nicht ins Internet** stellen. Er gehört ins Praxisnetz.
- Bei `nameDisplay: "full"` steht der volle Nachname auf dem Wartezimmer-TV.
  Das ist üblich und zulässig, aber eine bewusste Entscheidung – `abbrev` ist
  die zurückhaltendere Variante.

---

## Wenn etwas nicht funktioniert

**Erster Griff: `/system` → Selbsttest.** Er prüft Konfiguration, Datenbank,
Piper, Stimmmodell, eine Probeansage, Mopidy und piSignage und benennt zu
jedem Fehler den nächsten Schritt.

| Symptom | Wahrscheinliche Ursache |
|---|---|
| Server startet nicht, meldet fehlende Werte | `.env` unvollständig – `npm run check-config` ausführen |
| Anmeldung nicht möglich | `APP_PIN` nicht gesetzt; nach 5 Fehlversuchen 5 Minuten Sperre |
| Kein Ton | Reihenfolge: Piper → Stimmmodell → `APP_PUBLIC_URL` → Mopidy → Snapcast |
| Erster Aufruf des Tages ist langsam | Ansagen noch nicht vorproduziert – `/import` → „Ansagen vorproduzieren" |
| TV zeigt nichts | Token in der Link-URL fehlt; Punkt oben rechts auf `/tv` zeigt die Verbindung |
| TV zeigt alte Aufrufe | Die Seite lädt ihren Stand beim Verbinden neu – Seite neu laden |
| Import löscht zu viel | Modus „Abgleichen" statt „Ersetzen" wählen |
| Namen werden falsch ausgesprochen | Aussprache über `spoken` bzw. eigenen Aufnahmesatz im Datensatz beeinflussen |

Laufende Meldungen:

```bash
docker compose logs -f app          # mit Docker
sudo journalctl -u patientenaufruf -f  # mit systemd
```
