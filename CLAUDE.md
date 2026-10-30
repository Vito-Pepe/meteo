# Istruzioni per Claude (meteo)

## Lingua

Rispondi sempre in italiano, anche nei commit, nelle PR e nei commenti al codice.

## Raspberry Pi: infrastruttura condivisa

Questa app gira su un Raspberry Pi 5 insieme ad altre app (Docker + Tailscale). L'elenco di tutto ciò che è già occupato sul Pi (porte, cartelle, progetti compose, container, reti e bridge, firewall, volumi, dispositivi e percorsi Tailscale, cron, nomi dei cookie) è nel file **`INFRASTRUTTURA-PI.md` della repo `Vito-Pepe/sillabe`**:
https://raw.githubusercontent.com/Vito-Pepe/sillabe/main/INFRASTRUTTURA-PI.md

- **Leggilo prima** di scegliere o cambiare porte, nomi, reti, volumi, `tailscale serve`/funnel, cron o firewall, e prima di dare comandi da eseguire sul Pi. Non dare per libero niente di ciò che elenca; nel dubbio fai lanciare all'utente i comandi della sua sezione 9 e lavora sul loro output.
- Se non riesci a scaricarlo, aggiungi la repo `Vito-Pepe/sillabe` alla sessione e leggilo da lì.
- **Tienilo aggiornato**: se il tuo lavoro aggiunge, cambia o toglie qualcosa di infrastrutturale sul Pi, aggiorna `INFRASTRUTTURA-PI.md` nella repo `Vito-Pepe/sillabe` (aggiungila alla sessione con accesso in scrittura) con una PR, e dai all'utente il link diretto. Fallo nello stesso lavoro, non "dopo".
- Mai `tailscale serve` sull'host del Pi per una nuova app: gli indirizzi HTTPS si aggiungono nella repo `Vito-Pepe/ingressi-https`.

## Come lavorare con l'utente

- Il Pi segue `main`. Lavora su un branch e apri una PR verso `main`; l'utente la unisce su GitHub con **"Create a merge commit"** e non cancella il branch. Dai sempre il **link diretto** della PR e, prima di chiedere di unirla, verifica che sia ancora aperta.
- Claude non può fare SSH sul Pi: prepara i comandi a blocchi, da incollare uno alla volta, con l'output atteso. Segreti solo nel `.env` sul Pi, mai su git.
- Claude non può creare repo su GitHub (403): se serve una repo nuova, chiedi all'utente di crearla (Public, con "Add a README file").
- Una repo nuova che girerà sul Pi deve avere anche lei un `CLAUDE.md` con queste istruzioni (copialo da una delle repo esistenti).

## Note su questa repo

- Sul Pi l'app sta nella cartella `~/parole/meteo`, dentro la clone di Parole (installata così prima di queste sessioni): progetto compose `meteo`, container `meteo`, porta 8765. Il Pi segue `main` e si aggiorna da solo ogni 5 minuti con `update.sh` via cron (senza `sudo`): mantieni `update.sh` funzionante.
- L'indirizzo `https://meteo.<tailnet>.ts.net` viene dalla repo `ingressi-https` (`serve/meteo.json` → `http://127.0.0.1:8765`). Se cambi la porta, cambiala anche lì e in `INFRASTRUTTURA-PI.md`. La posizione automatica del browser funziona solo in HTTPS.
- Mappa (scheda "Mappa", `public/meteo-map.js`): griglia di punti in pixel allo zoom della griglia (4-11), dati da `/api/map` (punti a gruppi verso Open-Meteo, cache di 1 ora, limiti `MAP_LIMITS` sotto quelli gratuiti) e mappe da `/tiles/` (proxy verso `tile.openstreetmap.org` con `USER_AGENT`, cache in memoria, al massimo 4 download insieme: regole d'uso delle tessere di OSM). Leaflet è copiato in `public/vendor/leaflet/` (1.9.4, BSD-2): per aggiornarlo si sostituiscono quei file dal pacchetto npm, tenendo `LICENSE`. Le attribuzioni di OpenStreetMap e Open-Meteo devono restare visibili sulla mappa.
- Server senza dipendenze npm (`server.js`), pagina in `public/`, test con `npm test`. I dati vengono da Open-Meteo (previsioni e ricerca delle località, senza chiave) e da Nominatim di OpenStreetMap (nome del luogo dalla posizione): il server li tiene in cache 10 minuti e si presenta con `USER_AGENT`. Non togliere la cache né fare più richieste: Nominatim ne permette al massimo una al secondo.
