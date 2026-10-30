#!/usr/bin/env bash
# update.sh — aggiorna Meteo sul Raspberry Pi
# Uso manuale: ./update.sh
# Pensato anche per cron: se non ci sono commit nuovi non tocca il container.
# Prerequisiti: git, docker, docker compose

set -e

BRANCH=$(git rev-parse --abbrev-ref HEAD)

echo "==> Controllo aggiornamenti su origin/$BRANCH..."
git fetch origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') — nessun aggiornamento, già alla versione più recente."
    exit 0
fi

echo "==> Nuovi commit trovati, aggiorno..."
git pull --ff-only origin "$BRANCH"

echo "==> Rebuild e riavvio del container..."
docker compose up --build -d

echo "==> Pulizia immagini obsolete..."
docker image prune -f

echo "$(date '+%Y-%m-%d %H:%M:%S') — aggiornamento completato. Meteo disponibile su http://127.0.0.1:8765"
