# Betrieb auf dem Raspberry Pi

Kurzantwort: **Ja – auf einem Pi 5 vollständig, auf einem Pi 4 mit einer
Einschränkung bei der Datenbank.**

| Baustein | Pi 4 (Cortex-A72) | Pi 5 (Cortex-A76) | Anmerkung |
|---|---|---|---|
| Docker / Docker Compose | ja | ja | offizielle arm64-Pakete |
| Node.js 22 (`node:22-bookworm-slim`) | ja | ja | Image gibt es für `linux/arm64/v8` |
| Piper (Sprachsynthese) | ja | ja | `piper-tts` liefert ein aarch64-Wheel |
| onnxruntime (Piper-Unterbau) | ja | ja | aarch64-Wheels vorhanden |
| Mopidy | ja | ja | reines Python, GStreamer aus Debian |
| Snapserver | ja | ja | `snapserver_*_arm64_bookworm.deb` |
| Snapclient | ja | ja | `snapclient_*_arm64_bookworm.deb` |
| piSignage-Anbindung | ja | ja | nur HTTP, keine Architekturfrage |
| Datenbank (SQLite) | ja | ja | eingebaut |

Die Angaben zu den Paketen sind geprüft, nicht geschätzt: `piper-tts` 1.8.0
enthält `piper_tts-1.8.0-cp39-abi3-manylinux_2_17_aarch64…whl`, `onnxruntime`
veröffentlicht `manylinux_2_28_aarch64`-Wheels, Snapcast 0.35.0 liefert
`arm64`-Pakete für Bullseye, Bookworm und Trixie, und das Node-Image ist für
`linux/arm64/v8` verfügbar.

---

## Datenbank

Seit Version 2.1 speichert das System Patientenliste und Aufrufprotokoll in
einer SQLite-Datei (über das in Node eingebaute `node:sqlite`). Die frühere
Einschränkung – MongoDB ≥ 5.0 läuft auf dem Pi 4 nicht, weil es ARMv8.2-A
verlangt – entfällt damit. Pi 4 und Pi 5 sind gleichermaßen geeignet.

Empfehlung: die Datei auf einer SSD statt auf der SD-Karte ablegen
(`DB_PATH` in der `.env`), weil SD-Karten bei vielen kleinen Schreibvorgängen
schneller verschleißen.

## Wie schnell ist die Sprachsynthese auf einem Pi?

Entscheidend ist, dass die Ansagen **nach dem Import im Hintergrund
vorproduziert** werden. Beim Knopfdruck wird nur noch eine fertige Datei
abgespielt – die Rechenleistung des Pi spielt dann keine Rolle mehr.

Gemessen auf dem Entwicklungsrechner: 56 Ansagen (8 Patienten × 7 Räume) in
67 Sekunden, also rund 1,4 Sekunden je Ansage bei zwei parallelen Prozessen.
Ein Pi 4 ist für diese Art Rechenarbeit erfahrungsgemäß etwa drei- bis sechsmal
langsamer, ein Pi 5 etwa halb so langsam wie der Pi 4. Als **Schätzung**:

| Tagesliste | Pi 5 | Pi 4 |
|---|---|---|
| 20 Patienten × 4 Räume | ~1–2 Min. | ~3–5 Min. |
| 60 Patienten × 4 Räume | ~4–6 Min. | ~10–15 Min. |

Das läuft im Hintergrund, während das Personal schon arbeitet. Zwei Stellschrauben,
falls es zu lange dauert:

```json
{
  "tts": {
    "prewarmRooms": ["bz1", "bz2", "anm"],
    "prewarmConcurrency": 4
  }
}
```

- **`prewarmRooms`** auf die tatsächlich genutzten Räume begrenzen. Das ist mit
  Abstand der größte Hebel: Fünf statt sieben Räume sparen fast ein Drittel.
- **`prewarmConcurrency`** auf 3–4 setzen (Pi 4 und 5 haben vier Kerne).
- Eine **`low`-Stimme** statt `medium` ist etwa doppelt so schnell, klingt aber
  merklich schlechter. Für die eigene Praxisstimme würde ich bei `medium` bleiben.

Ein nicht vorproduzierter Aufruf – etwa ein spontan hinzugefügter Patient –
dauert auf dem Pi 4 entsprechend ungefähr 4–8 Sekunden, bis die Ansage beginnt.
Das Bild auf dem Wartezimmer-Fernseher erscheint dabei trotzdem sofort, weil die
Anzeige vor der Sprachsynthese ausgelöst wird.

---

## Wärme und Dauerbetrieb

- **Kühlung ist Pflicht.** Ein Pi 5 ohne aktiven Lüfter drosselt unter
  Dauerlast; beim Pi 4 genügt ein guter Passivkühler. Ohne Kühlung wird die
  Vorproduktion spürbar langsamer.
- **Vom SD-Kartenbetrieb abraten.** Eine SSD am USB-3-Anschluss (Pi 4) oder am
  PCIe-Anschluss (Pi 5) ist deutlich haltbarer. Datenbank und Audio-Zwischen-
  speicher schreiben regelmäßig, und SD-Karten sterben daran.
- **Arbeitsspeicher:** 4 GB genügen, 8 GB sind bequemer. Node belegt etwa
  100–150 MB, Piper je Prozess rund 200–300 MB, der Rest bleibt dem System als
  Zwischenspeicher.

---

## Aufteilung auf mehrere Geräte

Alles muss nicht auf einem Gerät laufen. Bewährt in einer Praxis:

```
Pi 5 (oder kleiner Server)        Pi 4 / Pi Zero 2 W          Fernseher
├─ Patientenaufruf (Docker)       └─ Snapclient                └─ piSignage
├─ Piper                             + Verstärker                 zeigt /tv
├─ Mopidy
└─ Snapserver
```

Snapclients sind anspruchslos – dafür genügt ein Pi Zero 2 W je Wartebereich.
Mehrere Snapclients spielen synchron, sodass eine Ansage in allen Räumen
gleichzeitig zu hören ist.

---

## Docker-Image für arm64 bauen

Das mitgelieferte `docker/Dockerfile` ist architekturneutral – auf dem Pi
genügt:

```bash
cd docker
docker compose build
docker compose up -d
```

Der Bau dauert auf einem Pi einige Minuten, vor allem wegen `pip install
piper-tts`. Wer das vermeiden will, baut auf einem schnelleren Rechner für
arm64 vor:

```bash
docker buildx build --platform linux/arm64 -t patientenaufruf:2 --load .
docker save patientenaufruf:2 | ssh pi@192.168.130.196 docker load
```

---

## Installation ohne Docker

Auf einem Pi ist das oft die einfachere Variante, weil Mopidy und Snapcast
ohnehin direkt auf dem Gerät laufen sollen (Zugriff auf die Audio-Ausgabe):

```bash
# Grundlagen
sudo apt update
sudo apt install -y nodejs npm python3-venv espeak-ng-data

# Piper
python3 -m venv ~/piper-venv
~/piper-venv/bin/pip install piper-tts
# .env:  PIPER_BIN=/home/pi/piper-venv/bin/piper

# Mopidy
wget -q -O /etc/apt/trusted.gpg.d/mopidy.gpg https://apt.mopidy.com/mopidy.gpg
sudo wget -q -O /etc/apt/sources.list.d/mopidy.list https://apt.mopidy.com/bookworm.list
sudo apt update && sudo apt install -y mopidy

# Snapcast (arm64-Pakete von GitHub)
wget https://github.com/badaix/snapcast/releases/download/v0.35.0/snapserver_0.35.0-1_arm64_bookworm.deb
wget https://github.com/badaix/snapcast/releases/download/v0.35.0/snapclient_0.35.0-1_arm64_bookworm.deb
sudo apt install -y ./snapserver_*.deb ./snapclient_*.deb

# Anwendung
npm ci --omit=dev
npm run check-config
```

Die Einrichtung von Mopidy und Snapcast steht in [BETRIEB.md](BETRIEB.md).

---

## Quellen

- [Raspberry Pi Documentation – Processors](https://www.raspberrypi.com/documentation/computers/processors.html)
- [ARM Cortex-A72 (Pi 4)](https://en.wikipedia.org/wiki/ARM_Cortex-A72) · [ARM Cortex-A76 (Pi 5)](https://en.wikipedia.org/wiki/ARM_Cortex-A76)
- [Snapcast-Releases](https://github.com/badaix/snapcast/releases)
