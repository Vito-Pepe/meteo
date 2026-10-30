# Meteo

Stazione meteo self-hosted: una pagina web che mostra il meteo della tua posizione (o di una località cercata).

- **Oggi in dettaglio** (vista predefinita): condizioni attuali, temperatura percepita, vento e raffiche, umidità, pressione, nuvolosità, alba/tramonto, UV e le prossime 24 ore ora per ora con grafico.
- **Settimana**: 7 giorni con min/max, pioggia e vento; tocca un giorno per vederne il dettaglio ora per ora.
- **Posizione**: alla prima apertura chiede la posizione al browser. Se non è disponibile, mostra l'ultima località consultata su quel dispositivo, altrimenti ti chiede di cercarne una.
- Funziona su qualsiasi browser moderno (Chrome, Firefox, Safari, Edge, anche da telefono), con tema chiaro/scuro automatico.

Dati da [Open-Meteo](https://open-meteo.com) (gratuito, senza API key) e nomi delle località da OpenStreetMap/Nominatim.

Sul Raspberry Pi di casa la pagina è `https://meteo.<tailnet>.ts.net`, dalla tailnet (indirizzo della repo `ingressi-https`). Si apre anche dal riquadro **Meteo** della homepage.

## Struttura

| File | Cosa fa |
|---|---|
| `server.js` | Server Node.js senza dipendenze: serve la pagina e fa da proxy con cache (10 min) verso le API meteo |
| `public/` | Interfaccia web (HTML, CSS, JavaScript semplice) |
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

## Sviluppo

```bash
npm start        # http://localhost:8765
npm test
```
