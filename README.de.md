# immich-federation

Bindet Alben von den Immich-Servern deiner Freunde in **dein eigenes, unverändertes Immich** ein.

[English version](README.md)

![Alben-Seite mit „Föderiertes Album verbinden" und föderierten Alben](docs/screenshots/albums.webp)

> **Kein offizielles Immich-Projekt.** Unabhängiges Community-Projekt, nicht vom Immich-Team bzw. FUTO entwickelt,
> unterstützt oder empfohlen. Probleme mit dem Gateway bitte nicht beim Immich-Projekt melden.

* Vorschaubilder, EXIF, CLIP-Suche, Gesichter und OCR liegen **lokal** (Immich erzeugt sie selbst aus einer
  Vorschau-Kopie, die das Gateway hochlädt).
* Erst wenn du das Original bzw. das ganze Video öffnest, wird es live vom Server des Freundes gestreamt.
* Kein Immich-Fork, kein Patch: ein zusätzlicher Container vor `immich-server`. Immich-Updates wie gewohnt.

```
Browser / Immich-App ──► gateway (:2283) ──► immich-server (intern, unverändert)
                            └──► Immich des Freundes (über dessen Album-Freigabelink)
```

Föderations-Grundlage ist ein ganz normaler **Album-Freigabelink** des Freundes (`https://freund.de/share/<key>`
oder `/s/<slug>`). Er ist jederzeit widerrufbar; „Download erlauben" und „Metadaten anzeigen" werden respektiert.
Passwortgeschützte Links werden nicht unterstützt.

## Kompatibilität

* **Dein (lokales) Immich:** getestet mit **v3.3.0** (ohne `deviceAssetId`, das es seit v3.3 nicht mehr gibt).
* **Server der Freunde:** getestet **v3.0.3 – v3.3.0** (Album-Freigabelinks `/share/<key>` und `/s/<slug>`).
* Das Gateway nutzt nur die öffentliche Immich-API und ändert Immich nicht. Nach einem Immich-Update siehe
  „Nach einem Immich-Update prüfen".

## Installation (docker compose, ohne Reverse-Proxy)

1. In der `docker-compose.yml` einen Dienst hinzufügen und das Port-Mapping von `immich-server` auf das Gateway
   verschieben:

```yaml
services:
  immich-server:
    # ... unverändert, nur OHNE "ports:".
    # (Immich vertraut X-Forwarded-* aus privaten Docker-Netzen standardmäßig, nichts weiter nötig.)

  immich-federation:
    container_name: immich_federation
    image: ghcr.io/loggel/immich-federation:latest
    restart: always
    ports:
      - '2283:2283'                 # vorher bei immich-server
    environment:
      IMMICH_URL: http://immich-server:2283
      FEDERATION_SECRET: ${FEDERATION_SECRET}   # in .env, siehe unten
    volumes:
      - federation-data:/data
    depends_on:
      - immich-server

volumes:
  federation-data:
```

2. In `.env` ergänzen: `FEDERATION_SECRET=<Ausgabe von: openssl rand -base64 32>`
3. `docker compose up -d immich-federation immich-server`

**Aus dem Quellcode bauen statt Image:** `git clone https://github.com/LoggeL/immich-federation gateway` neben die
Compose-Datei und `image:` durch `build: ./gateway` ersetzen.

Das Immich-Web zeigt jetzt auf der Alben-Seite „Föderiertes Album verbinden"; die Verwaltung liegt unter
`/federation/` (auch im Konto-Menü und in der Seitenleiste).

**FEDERATION_SECRET:** Ohne die Variable erzeugt das Gateway einmalig `/data/secret.key`. Dann liegen Schlüssel und
verschlüsselte Zugangsdaten (Immich-API-Key, Freigabe-Keys) im selben Volume/Backup – die Verschlüsselung schützt
dann nicht vor jemandem mit einer Kopie des Volumes (das Gateway warnt bei jedem Start). Für Produktion daher immer
per `.env` oder Docker-Secret setzen. **Den Wert nicht mehr ändern** – sonst sind gespeicherte Links unlesbar.

**Bind-Mount statt Volume** (`./federation-data:/data`): Das Gateway läuft als UID 1000. Der Container korrigiert
beim Start die Rechte selbst (`chown`); bei NFS/root-squash o.ä. vorher `chown -R 1000:1000 ./federation-data`.

## Produktion hinter Traefik (z.B. Dokploy, `dokploy-network`)

Ausgangslage: `immich-server` hängt im Netz `dokploy-network` und trägt die Traefik-Labels. Danach trägt das
**Gateway** die Labels, `immich-server` ist nur noch intern erreichbar.

```yaml
services:
  immich-server:
    # ... image, volumes, env_file usw. unverändert
    networks:
      - default                      # dokploy-network nur behalten, wenn andere Dienste Immich darüber erreichen
    labels:
      - "traefik.enable=false"       # alle bisherigen traefik.*-Labels entfernen

  immich-federation:
    container_name: immich_federation
    image: ghcr.io/loggel/immich-federation:latest
    restart: always
    environment:
      IMMICH_URL: http://immich_server:2283     # Containername: eindeutig, auch wenn mehrere Netze
      FEDERATION_SECRET: ${FEDERATION_SECRET}
      # ALLOW_PRIVATE_REMOTES: "true"           # nur falls Freunde im LAN/VPN (private IPs) liegen
    volumes:
      - ./federation-data:/data
    depends_on:
      - immich-server
    networks:
      - default                      # zu immich-server
      - dokploy-network              # zu Traefik
    labels:                          # 1:1 die bisherigen Labels von immich-server
      - "traefik.enable=true"
      - "traefik.http.routers.photos.rule=Host(`photos.example.org`)"
      - "traefik.http.routers.photos.entrypoints=websecure"
      - "traefik.http.routers.photos.tls.certresolver=letsencrypt"
      - "traefik.http.services.photos.loadbalancer.server.port=2283"
      - "traefik.docker.network=dokploy-network"

networks:
  dokploy-network:
    external: true
```

Schritte:

1. Backup der Compose-Datei: `cp docker-compose.yml docker-compose.yml.bak-$(date +%Y%m%d)`
2. `FEDERATION_SECRET` in `.env` eintragen.
3. Compose wie oben ändern (Router-/Service-Namen und `Host(...)` aus deinen bisherigen Labels übernehmen).
4. `docker compose up -d immich-federation immich-server` – Traefik schwenkt um, sobald das Gateway healthy ist
   (Downtime: wenige Sekunden).
5. Prüfen: `curl -s https://photos.example.org/federation/api/health` → `{"ok":true}`,
   `curl -s https://photos.example.org/api/server/ping` → `{"res":"pong"}`, Web-Login und Mobile-App testen.

Wird die Domain in der Dokploy-Oberfläche (Reiter „Domains") statt per Labels verwaltet: dort die Domain vom
Dienst `immich-server` auf `immich-federation`, Port `2283`, umstellen – die Labels oben entfallen dann.

**Zurück (Rollback):** Labels/Netz wieder an `immich-server`, Gateway-Dienst entfernen, `docker compose up -d`.

## Update

```sh
docker compose pull immich-federation && docker compose up -d immich-federation
# aus dem Quellcode: cd gateway && git pull && cd .. && docker compose up -d --build immich-federation
```

Die Datenbank (`/data/federation.sqlite`) wird beim Start automatisch migriert. Während des Neustarts ist Immich
kurz (Sekunden) nicht erreichbar; ein laufender Sync macht nach dem Start dort weiter, wo er war.

**Immich selbst** aktualisierst du wie immer (`docker compose pull && docker compose up -d`) – am Gateway ändert
sich dabei nichts.

## Nach einem Immich-Update prüfen

Die Synchronisation nutzt nur stabile API-Endpunkte. Die **Oberflächen-Erweiterungen** (Button, Banner, Badges)
hängen am HTML der Immich-Web-App und können nach einem größeren Update verschwinden – dann fehlt nur die Anzeige,
Sync und Original-Streaming laufen weiter, und `/federation/` funktioniert immer.

1. `/federation/` öffnen: Links da, „zuletzt synchronisiert" aktuell, kein Fehler.
2. Ein föderiertes Album öffnen (Banner?), ein Foto öffnen (Badge „Original liegt auf …"?), hineinzoomen
   (Netzwerk-Tab: Antwort mit Header `x-immich-federation`).
3. In der Browser-Konsole `__immichFederation.diagnose()` auf Alben-Seite, Albumseite und im Viewer aufrufen –
   zeigt, welche DOM-Anker gefunden werden. `localStorage.setItem('ifed-debug', '1')` loggt fehlende Anker.
4. Automatisch: `test/ui/ui-smoke.cjs` (Playwright, Anleitung im Dateikopf).

## Grenzen / bekannte Einschränkungen

* **ZIP-Downloads** (ganzes Album, Mehrfachauswahl) enthalten die **lokalen Vorschau-Kopien**, nicht die Originale –
  Originale einzeln herunterladen (Einzel-Download und Zoom laden das Original vom Freund).
* **Mobile-App:** Anzeige, Zoom, Video und Download laden das Original vom Freund. Beim Download speichert die App die
  Datei unter dem lokalen Namen (`.jpg`/`.mp4`), auch wenn das Original z.B. HEIC/MOV ist.
* Lokale Bearbeitungen (Zuschneiden/Drehen) eines föderierten Fotos: dann liefert dein Immich die bearbeitete
  Fassung (aus der Vorschau-Kopie) statt des Originals.
* Änderungen des Freundes an Datum/GPS/Beschreibung nach dem Import werden nicht nachgezogen (nur neue und entfernte
  Fotos). Live-Fotos: nur das Standbild. Gestapelte Fotos: einzeln.
* Experimentelles HLS-Echtzeit-Transcoding von Immich: Videos spielen dann die lokale 480p-Kopie.
* Passwortgeschützte Freigabelinks werden nicht unterstützt.
* Die Oberflächen-Erweiterungen hängen am DOM der Immich-Web-App und können nach einem Immich-Update verschwinden;
  Sync, Original-Streaming und `/federation/` laufen trotzdem weiter (siehe oben).

## Entfernen

1. In `/federation/` jeden Link mit „Trennen" + „Album und lokale Kopien löschen" entfernen (sonst bleiben die
   Vorschau-Kopien als normale Fotos in Immich).
2. Gateway-Dienst aus der Compose-Datei löschen, Port bzw. Traefik-Labels/Netz wieder an `immich-server`,
   `docker compose up -d --remove-orphans`.
3. In Immich unter *Kontoeinstellungen → API-Schlüssel* den Schlüssel **„Immich Federation Gateway"** löschen
   (je Benutzer, der Föderation genutzt hat).

## Konfiguration

| Variable | Standard | Bedeutung |
|---|---|---|
| `IMMICH_URL` | `http://immich-server:2283` | internes Immich |
| `PORT` | `2283` | Port des Gateways |
| `DATA_DIR` | `/data` | SQLite-DB, Schlüssel, Temp-Dateien |
| `FEDERATION_SECRET` | – (auto) | Schlüssel für AES-256-GCM-Verschlüsselung von API-Keys und Freigabe-Keys |
| `SYNC_INTERVAL_MINUTES` | `30` | automatischer Abgleich |
| `ALLOW_PRIVATE_REMOTES` | `false` | Freunde-Server im LAN/privaten Netzen erlauben (SSRF-Schutz) |
| `VIDEO_PROXY_HEIGHT` | `480` | Höhe der lokalen Video-Kopie |
| `REMOTE_TIMEOUT_MS` | `20000` | Timeout bis zur ersten Antwort des entfernten Servers (Sync) |
| `INTERACTIVE_TIMEOUT_MS` | `8000` | dasselbe beim Öffnen eines Originals; danach wird die lokale Kopie geliefert |
| `DOWNLOAD_CONCURRENCY` | `3` | parallele Downloads beim Sync (über alle Links; Videos zusätzlich nacheinander) |
| `MAX_PREVIEW_MB` / `MAX_VIDEO_MB` | `50` / `4096` | größere Dateien werden beim Sync übersprungen |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Wie es funktioniert

1. **Verbinden:** Du fügst den Freigabelink ein. Das Gateway prüft ihn (`/api/shared-links/me?key=…`), legt mit
   deiner Sitzung einen eigenen, eingeschränkten Immich-API-Key an (asset.read/upload/update/delete,
   album.create/read/update/delete, albumAsset.create/delete, user.read) und speichert ihn verschlüsselt.
2. **Sync** (sofort, alle 30 min, oder „Jetzt synchronisieren"): Für jedes Bild wird die Vorschau (~1440 px),
   für jedes Video die Wiedergabe-Datei geladen und mit ffmpeg auf 480p verkleinert, dann über die normale
   Immich-API hochgeladen, Aufnahmedatum/GPS/Beschreibung („Föderiert von …") gesetzt und in ein lokales Album
   gelegt. Immich erzeugt daraus Thumbnails, CLIP-Embeddings, Gesichter und OCR – alles lokal.
   Vom Freund entfernte Fotos werden lokal gelöscht. Was du lokal löschst, wird nicht erneut importiert.
   Höflich auch bei großen Alben: höchstens 3 Downloads gleichzeitig, Videos nacheinander, nach einem Neustart
   wird nur Fehlendes geladen; Fortschritt (x / y) im Banner und unter `/federation/`. Pro Link lässt sich
   „Videos importieren" abschalten (dann werden Videos gar nicht geladen).
3. **Originale:** Anfragen an `/api/assets/:id/original`, `…/thumbnail?size=fullsize` und `…/video/playback`
   für föderierte Assets prüft das Gateway zuerst bei deinem Immich (gleiche Anfrage als `HEAD` mit deinen
   Zugangsdaten – also inkl. Freigabelinks und deren Download-Recht). Nur bei Erfolg wird vom Freund gestreamt
   (Range-Requests funktionieren). Ist der Freund offline oder erlaubt keine Downloads, liefert dein Immich die
   lokale Vorschau-Kopie.

## Entwicklung

```sh
node --version   # >= 24 (TypeScript läuft per Type-Stripping, keine Abhängigkeiten)
IMMICH_URL=http://localhost:2283 DATA_DIR=./data npm start
npm test         # Unit-Tests + Smoke-Test gegen Fake-Immich
```

## Lizenz

[MIT](LICENSE) © 2026 LoggeL. Immich ist eine Marke der jeweiligen Inhaber; dieses Projekt steht in keiner Verbindung dazu.
