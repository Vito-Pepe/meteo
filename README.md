# Meteo

Stazione meteo self-hosted: una pagina web che mostra il meteo della tua posizione (o di una località cercata).

- **Oggi in dettaglio** (vista predefinita): condizioni attuali, temperatura percepita, vento e raffiche, umidità, pressione, nuvolosità, alba/tramonto, UV e le prossime 24 ore ora per ora con grafico.
- **Settimana**: 7 giorni con min/max, pioggia e vento; tocca un giorno per vederne il dettaglio ora per ora.
- **Mappa** (scheda in alto), da spostare col dito, con due viste:
  - **Tempo**: un disegno animato all'ora scelta. Ci sono nuvole più grandi e fitte dove la nuvolosità è alta, che si muovono col vento, pioggia che cade e temporali con nuvole scure, lampi e fulmini. Ci sono anche neve, nebbia e un alone di sole dove è sereno.
  - **Temperatura**: zone colorate dal blu, sempre più intenso verso il freddo, ai rossi, sempre più intensi verso il caldo, con i gradi sopra.

  In basso si scelgono il giorno (oggi e i 6 dopo) e l'ora. Toccando la mappa si vedono temperatura, pioggia, nuvolosità e vento del punto più vicino, e "Previsioni di qui" apre le previsioni di quel punto. Nella vista mappa la barra in alto sta su una riga e sul telefono la ricerca si apre con la lente, così la mappa prende quasi tutto lo schermo.
- **Posizione**: alla prima apertura chiede la posizione al browser. Se non è disponibile, mostra l'ultima località consultata su quel dispositivo, altrimenti ti chiede di cercarne una.
- Funziona su qualsiasi browser moderno (Chrome, Firefox, Safari, Edge, anche da telefono), con tema chiaro/scuro automatico.

Dati da [Open-Meteo](https://open-meteo.com) (gratuito, senza API key), nomi delle località da OpenStreetMap/Nominatim, mappe di [OpenStreetMap](https://www.openstreetmap.org/copyright) mostrate con [Leaflet](https://leafletjs.com).

Sul Raspberry Pi di casa la pagina è `https://meteo.<tailnet>.ts.net`, dalla tailnet (indirizzo della repo `ingressi-https`). Si apre anche dal riquadro **Meteo** della homepage.

## Struttura

| File | Cosa fa |
|---|---|
| `server.js` | Server Node.js senza dipendenze: serve la pagina e fa da proxy con cache verso le API meteo e le mappe |
| `labels.js` | I nomi dei luoghi da mettere sopra il meteo, ricavati dalle tessere di OpenStreetMap e ricostruiti a 2x o 3x per i telefoni (legge e scrive i PNG con zlib) |
| `public/` | Interfaccia web (HTML, CSS, JavaScript semplice); la mappa è in `meteo-map.js` e `meteo-map.css` |
| `public/vendor/leaflet/` | Leaflet 1.9.4 (licenza BSD-2, in `LICENSE`), copiato qui così la pagina non dipende da siti esterni |
| `Dockerfile`, `docker-compose.yml` | Immagine `node:22-alpine`, funziona su Raspberry Pi (arm64 e armv7) |
| `update.sh` | Aggiorna l'app sul Pi quando su `main` ci sono commit nuovi (da cron, ogni 5 minuti) |
| `test/` | Test del server (`npm test`) |
| `CLAUDE.md` | Istruzioni per Claude Code: infrastruttura del Pi e come lavorare su questa repo |

## Sul Raspberry Pi

Sul Pi di casa l'app è già installata nella cartella `~/parole/meteo` (progetto compose e container `meteo`, porta 8765): non va installata una seconda volta.

### Installazione

Su un Pi nuovo:

```bash
cd ~
git clone https://github.com/Vito-Pepe/meteo.git
cd meteo

# Controlla che la porta 8765 sia libera (nessun output = libera)
sudo ss -tlnp | grep ':8765 '

docker compose up -d --build
curl -s http://127.0.0.1:8765/healthz
```

Risposta attesa: `{"ok":true}`.

Su un Pi con altre app controlla prima che porta e nomi siano liberi in `INFRASTRUTTURA-PI.md` (repo `sillabe`). Per cambiare porta: la **prima** parte di `ports` in `docker-compose.yml` (per esempio `"8790:8765"`) e la stessa porta in `serve/meteo.json` della repo `ingressi-https`.

### Aggiornamenti

`update.sh` controlla se su GitHub ci sono commit nuovi e solo in quel caso aggiorna la cartella e ricostruisce il container. Gira da cron ogni 5 minuti, **senza `sudo`**: con `sudo` la cartella `.git` diventa di root e gli aggiornamenti si rompono.

```bash
(crontab -l 2>/dev/null; echo "*/5 * * * * cd $HOME/parole/meteo && ./update.sh >> $HOME/parole/meteo/update.log 2>&1") | crontab -
```

Con l'installazione in `~/meteo` il percorso è `$HOME/meteo`. Per aggiornare subito: `./update.sh`.

### Indirizzo HTTPS

I browser concedono la posizione **solo a pagine HTTPS** (o `localhost`): aprendo `http://…:8765` la ricerca funziona, ma il pulsante "usa la mia posizione" no.

L'indirizzo HTTPS, solo dentro la tailnet, viene dal servizio `meteo` della repo `ingressi-https` (`serve/meteo.json` → `http://127.0.0.1:8765`): vedi il suo README. **Non usare `tailscale serve` sul Pi**: una regola sull'host sostituisce quella già presente sulla stessa porta, ed è già successo che la homepage sparisse.

### Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `PORT` | `8765` | Porta interna del container |
| `CACHE_TTL_SECONDS` | `600` | Durata della cache delle risposte meteo |
| `MAP_CACHE_TTL_SECONDS` | `3600` | Durata della cache dei punti della mappa |
| `MAP_LIMITE_MINUTO`, `MAP_LIMITE_ORA`, `MAP_LIMITE_GIORNO` | `400`, `3000`, `7000` | Punti al massimo chiesti a Open-Meteo per la mappa (gratis fino a 600 al minuto, 5000 all'ora, 10000 al giorno) |

## Come funziona la mappa

- La pagina mette una griglia di punti sulla parte visibile, a circa 100 pixel l'uno dall'altro, e chiede `/api/map?points=lat,lon;lat,lon;…` (al massimo 100 punti, con `;` e `,` codificati: il proxy HTTPS di Tailscale toglie i parametri con `;`). Il server li chiede a Open-Meteo tutti insieme, in una sola richiesta, e li tiene un'ora.
- Ogni punto arriva con 8 giorni ora per ora (temperatura, tempo, probabilità e millimetri di pioggia, giorno o notte, nuvolosità, velocità e direzione del vento): cambiare giorno e ora non chiede niente al server. Sono 8 variabili: sotto le 10, ogni punto conta come una chiamata sola a Open-Meteo.
- Il disegno è un canvas in un livello della mappa: sopra le tessere, sotto il punto blu e le schede. Nella vista Tempo si muove al massimo a 30 fotogrammi al secondo e si ferma quando la mappa non si vede. Con "Riduci movimento" del telefono resta fermo.
- Nella vista Temperatura ogni punto della griglia è un pixel di un'immagine piccolissima, ingrandita con lo sfumato del browser: diventa un campo di colore continuo, senza conti in più.
- I nomi dei luoghi stanno **sopra** il disegno del meteo, così si leggono anche sotto le nuvole e i colori. Il server li ricava dalla stessa tessera di OpenStreetMap (`labels.js`). Tiene solo le scritte: i pixel scuri e grigi raggruppati in pezzi grandi come lettere, mentre strade, ferrovie e confini restano sotto. Le scrive nere con un alone bianco su sfondo trasparente, e col tema scuro si invertono. A OpenStreetMap ogni tessera si chiede una volta sola, per la mappa e per le scritte.
- Le tessere di OpenStreetMap sono a bassa risoluzione: sugli schermi dei telefoni (2x o 3x) le scritte si vedrebbero ingrandite e sgranate. Per questo la pagina chiede le scritte alla scala del suo schermo (`/labels/z/x/y@2x.png` o `@3x.png`) e il server le ricostruisce più grandi, con i bordi netti: ingrandisce l'inchiostro delle lettere, lo taglia dove passa il loro bordo e rifà l'alone rotondo. La prima volta una tessera a 3x costa al Pi qualche decina di millisecondi, poi resta in cache.
- La griglia è la stessa a ogni zoom (i punti di uno zoom sono anche in quello dopo): allontanandosi i punti tornano dalla cache. Oltre lo zoom 11 i modelli non hanno più dettaglio e i punti restano quelli.
- Le mappe passano dal server (`/tiles/z/x/y.png`), che le scarica da OpenStreetMap con il suo User-Agent, quattro alla volta, e le tiene in memoria (fino a 64 MB), come chiedono le [regole d'uso](https://operations.osmfoundation.org/policies/tiles/).
- Il server non supera i limiti di Open-Meteo: oltre i numeri della tabella risponde "Troppe richieste" e la mappa lo scrive in alto.

## Sviluppo

```bash
npm start        # http://localhost:8765
npm test
```
