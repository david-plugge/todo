# Container-Deployment

Freiraum wird als ein einzelnes Image ausgeliefert. Das Image baut die Svelte-App und das Go-Backend in getrennten Stufen; zur Laufzeit enthält es weder Node.js noch pnpm noch den Go-Compiler. PocketBase und SQLite laufen mit genau einer Replik und einem persistenten Volume.

## Konfiguration

Der Container startet absichtlich nicht mit unvollständiger oder mehrdeutiger Konfiguration:

- `TODO_PUBLIC_URL` ist der exakte, von Browsern und OAuth-Clients erreichbare Origin, zum Beispiel `https://tasks.example.com`.
- Die URL darf keinen Pfad, Query, Fragment oder abschließenden Slash enthalten.
- Öffentlich ist nur HTTPS erlaubt. HTTP wird ausschließlich für `localhost`, `127.0.0.1` und `::1` akzeptiert.
- `PB_ENCRYPTION_KEY` enthält exakt 32 einzelne Bytes/ASCII-Zeichen. Der Schlüssel muss dauerhaft in einem Secret Store liegen und darf bei einem Deployment nicht wechseln.

Ein geeigneter Schlüssel lässt sich beispielsweise mit `openssl rand -hex 16` erzeugen. Er gehört nicht in `.env.example`, Git, ein Image-Layer oder die Container-History.

`TODO_PUBLIC_URL` ist zugleich OAuth-Issuer, MCP-Resource-Basis und erlaubter CORS-Origin. PocketBase behandelt `--origins` als Liste für CORS-Antwortheader; Requests ohne passenden Browser-Origin werden dadurch nicht allgemein blockiert. Die OAuth-Routen prüfen zusätzlich den exakten `Host` und `Origin`.

Die Anwendung wird am Root des Origins betrieben. Ein Unterpfad wie `/todo` ist nicht Teil des Vertrags.

## Start mit Compose

```sh
cp .env.example .env
# TODO_PUBLIC_URL und PB_ENCRYPTION_KEY in .env setzen
docker compose build
docker compose up -d
docker compose ps
curl --fail "$TODO_PUBLIC_URL/api/health"
```

Compose bindet standardmäßig nur an `127.0.0.1:8090`. `FREIRAUM_BIND_ADDRESS`, `FREIRAUM_PORT` und `FREIRAUM_TAG` können für die Zielumgebung überschrieben werden. Das Root-Dateisystem ist read-only; nur `/app/pb_data` ist persistent und `/tmp` ist ein flüchtiges `tmpfs`.

Einen App-Benutzer legt ein einmaliger Admin-Job an. Das Passwort wird nur als Prozessumgebung übergeben:

```sh
TODO_USER_PASSWORD='...' docker compose run --rm \
  --entrypoint /app/freiraum \
  freiraum user-create user@example.com \
  --dir=/app/pb_data \
  --encryptionEnv=PB_ENCRYPTION_KEY
```

Superuser werden entsprechend mit dem PocketBase-Befehl `superuser create` angelegt. Für dauerhafte Automatisierung müssen Passwörter aus dem Secret Store der Plattform kommen, nicht aus Compose-Dateien oder Shell-History.

## Reverse Proxy

TLS sollte am vorgeschalteten Proxy enden. Dieser muss den ursprünglichen `Host` unverändert weitergeben sowie `X-Real-IP`, `X-Forwarded-For` und `X-Forwarded-Proto` selbst setzen. Von Clients gelieferte Proxy-Header müssen vorher entfernt werden. Lange Read-Timeouts sind für PocketBase-Realtime/SSE erforderlich.

In PocketBase dürfen nur diejenigen Proxy-Header als vertrauenswürdig konfiguriert werden, die der eigene Proxy garantiert neu setzt. Der Containerport soll hinter einem Proxy ausschließlich intern oder auf Loopback erreichbar sein.

## Betriebsgrenzen

- Genau eine Instanz darf auf das Volume schreiben. Keine horizontalen Replikate und keine überlappenden Rolling Updates.
- Deployment-Strategie: alte Instanz sauber stoppen, dann die neue Instanz mit demselben Volume starten.
- Persistiert wird nur `/app/pb_data`. Binary und `pb_public` kommen aus dem unveränderlichen Image.
- Das Image läuft als UID/GID `10001:10001`, ohne Linux-Capabilities und mit `no-new-privileges`.
- Bei Host-Bind-Mounts muss das Datenverzeichnis für UID/GID `10001:10001` schreibbar sein. Das bereitgestellte Named Volume benötigt keine manuelle Rechteanpassung.
- `--dev` ist im Container-Entrypoint nicht aktiv und Command-Overrides werden abgelehnt. Administrative Einmalbefehle müssen den Entry-Point wie oben bewusst überschreiben.

Der Backup-/Restore-Cursorvertrag bleibt ein getrennter Livegang-Schritt und wird durch das Image nicht vorgetäuscht.

## Rate-Limits und OAuth-Wartung

Eine eingebettete Go-Migration aktiviert PocketBases IP-basierten Rate-Limiter einmalig. Sie ergänzt methodenspezifische Regeln für dynamische OAuth-Registrierung, Authorization, Consent, Token, Revoke, Verbindungen, MCP sowie Todo-Push und -Pull. Die Migration überschreibt später im Dashboard vorgenommene Änderungen nicht bei jedem Prozessstart. Weil PocketBases globaler Rate-Limit-Middleware vor dem Laden der Record-Authentifizierung läuft, sind diese Regeln bewusst als Guest/IP-Regeln hinterlegt.

Nur PocketBases expliziter `--dev`-Modus deaktiviert die Limits zur Laufzeit, ohne diese Einstellung zu speichern. Die lokale parallele E2E-Suite nutzt diesen Modus, da alle isolierten Browserkontexte dieselbe Loopback-IP teilen. Der Container-Entrypoint akzeptiert kein `--dev`; der Container-Smoke-Test weist den produktiven 429-Pfad separat nach.

Der Limiter lebt im Speicher einer einzelnen Instanz. Ein Prozessneustart setzt seine Zähler zurück; bei einer späteren horizontalen Architektur wäre deshalb zusätzlich ein gemeinsamer Limiter am Edge erforderlich. Für korrekte IP-Schlüssel dürfen ausschließlich Proxy-Header vertraut werden, die der eigene Reverse Proxy entfernt und neu setzt.

Der Cron-Job `freiraumOAuthCleanup` läuft täglich um `03:23 UTC`. Er löscht ausschließlich:

- abgelaufene offene OAuth-Zustimmungsanfragen und
- vollständige Tokenfamilien, in denen kein unverbrauchter, noch gültiger Code, Access- oder Refresh-Token existiert.

Verbrauchte Refresh-Tokens einer aktiven Familie bleiben erhalten, damit ihre Wiederverwendung weiterhin die gesamte Familie widerruft. Der Job löscht ausdrücklich keine OAuth-Clients, Todo-Changes, Receipts, Tasks, Listen oder Tombstones. Erfolgreiche Läufe loggen die Anzahl gelöschter Pending-Einträge, Familien und Tokens; Fehler werden geloggt und die Transaktion wird vollständig zurückgerollt.

## Prüfung

```sh
pnpm run test:container
```

Der Smoke-Test baut ein frisches Image und prüft:

- Fail-Closed-Start bei fehlender oder ungültiger URL beziehungsweise Schlüssellänge,
- Runtime-Benutzer `10001:10001`, read-only Root-Dateisystem und reduzierte Rechte,
- `/api/health`, App-Shell, Manifest und OAuth-Discovery,
- exakten CORS-Origin,
- Anmeldung und eine echte Task-Mutation,
- Persistenz dieser Mutation nach Container-Neustart mit demselben Named Volume,
- den Docker-Healthcheck.

Der Test benötigt eine erreichbare Docker Engine und räumt Container, Test-Volume und Test-Image anschließend auf.
