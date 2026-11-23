# =============================================================================
#  Patientenaufruf – Container
#
#  Läuft sowohl auf x86-64 (Server) als auch auf arm64 (Raspberry Pi 4/5).
#  Piper wird in einer virtuellen Python-Umgebung installiert; die
#  Stimmmodelle kommen per Volume dazu und liegen NICHT im Image
#  (sie sind mehrere hundert Megabyte groß).
# =============================================================================

FROM node:24-bookworm-slim

# --- Systemabhängigkeiten --------------------------------------------------
# python3-venv + pip: für Piper
# espeak-ng-data:     Aussprachedaten, die Piper zur Lautumsetzung braucht
# curl:               für den Healthcheck
# tini:               ordentliches Signal-Handling (SIGTERM erreicht Node)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      python3-pip \
      espeak-ng-data \
      curl \
      tini \
    && rm -rf /var/lib/apt/lists/*

# --- Piper -----------------------------------------------------------------
ENV VIRTUAL_ENV=/opt/piper-venv
RUN python3 -m venv "$VIRTUAL_ENV" \
    && "$VIRTUAL_ENV/bin/pip" install --no-cache-dir --upgrade pip \
    && "$VIRTUAL_ENV/bin/pip" install --no-cache-dir piper-tts
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
ENV PIPER_BIN="$VIRTUAL_ENV/bin/piper"

WORKDIR /app

# --- Node-Abhängigkeiten (eigene Schicht für besseres Caching) -------------
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- Anwendung -------------------------------------------------------------
COPY src ./src
COPY public ./public
COPY config ./config
COPY tools ./tools

# Schreibbare Verzeichnisse anlegen und dem Node-Benutzer übergeben.
RUN mkdir -p data/audio-cache data/voice-dataset voices uploads \
    && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    TZ=Europe/Berlin \
    PIPER_VOICES_DIR=/app/voices

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
