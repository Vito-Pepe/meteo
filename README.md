# Meteo

Stazione meteo self-hosted: una pagina web che mostra il meteo della tua posizione (o di una località cercata).

- **Oggi in dettaglio** (vista predefinita): condizioni attuali, temperatura percepita, vento e raffiche, umidità, pressione, nuvolosità, alba/tramonto, UV e le prossime 24 ore ora per ora con grafico.
- **Settimana**: 7 giorni con min/max, pioggia e vento; tocca un giorno per vederne il dettaglio ora per ora.
- **Posizione**: alla prima apertura chiede la posizione al browser. Se non è disponibile, mostra l'ultima località consultata su quel dispositivo, altrimenti ti chiede di cercarne una.
- Funziona su qualsiasi browser moderno (Chrome, Firefox, Safari, Edge, anche da telefono), con tema chiaro/scuro automatico.

Dati da [Open-Meteo](https://open-meteo.com) (gratuito, senza API key) e nomi delle località da OpenStreetMap/Nominatim.

## Struttura

| File | Cosa fa |
|---|---|
| `server.js` | Server Node.js senza dipendenze: serve la pagina e fa da proxy con cache (10 min) verso le API meteo |
| `public/` | Interfaccia web (HTML, CSS, JavaScript semplice) |
| `Dockerfile`, `docker-compose.yml` | Immagine `node:22-alpine`, funziona su Raspberry Pi (arm64 e armv7) |
| `test/` | Test del server (`npm test`) |

## Installazione sul Raspberry

```bash
git clone https://github.com/Vito-Pepe/meteo.git
cd meteo

# Controlla che la porta 8765 sia libera (nessun output = libera)
sudo ss -tlnp | grep ':8765 '

docker compose up -d --build
```

La pagina è su `http://<ip-del-raspberry>:8765` oppure `http://<nome-tailscale>:8765`.

Se la porta 8765 è occupata, cambia la **prima** parte di `ports` in `docker-compose.yml` (per esempio `"8790:8765"`).

Per aggiornare: `git pull && docker compose up -d --build`.

### Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `PORT` | `8765` | Porta interna del container |
| `CACHE_TTL_SECONDS` | `600` | Durata della cache delle risposte meteo |

## Posizione automatica: serve HTTPS

I browser concedono la posizione **solo a pagine HTTPS** (o `localhost`). Aprendo `http://…:8765` la ricerca funziona, ma il pulsante "usa la mia posizione" no.

Con Tailscale si risolve in un comando sul Raspberry, che pubblica l'app in HTTPS **solo dentro la tua tailnet**:

```bash
sudo tailscale serve --bg --https=443 http://127.0.0.1:8765
```

Poi apri `https://<nome-raspberry>.<tua-tailnet>.ts.net`. Il certificato è valido e il browser chiederà il permesso per la posizione.

Prerequisiti (una tantum, dal pannello di amministrazione di Tailscale → DNS): **MagicDNS** e **HTTPS Certificates** attivi.

Se sulla porta 443 c'è già un'altra app servita così, usa un'altra porta HTTPS, per esempio `--https=8443`, e apri `https://<nome>.ts.net:8443`.

Per vedere o rimuovere la configurazione: `tailscale serve status`, `sudo tailscale serve --https=443 off`.

## Sviluppo

```bash
npm start        # http://localhost:8765
npm test
```
