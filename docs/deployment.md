# Container-Deployment

Todo wird als ein einzelnes Image ausgeliefert. Das Image baut die Svelte-App und das Go-Backend in getrennten Stufen; zur Laufzeit enthält es weder Node.js noch pnpm noch den Go-Compiler. PocketBase und SQLite laufen mit genau einer Replik und einem persistenten Volume.

## Konfiguration

Der Container startet absichtlich nicht mit unvollständiger oder mehrdeutiger Konfiguration:

- `TODO_PUBLIC_URL` ist der exakte, von Browsern und OAuth-Clients erreichbare Origin, zum Beispiel `https://tasks.example.com`.
- Die URL darf keinen Pfad, Query, Fragment oder abschließenden Slash enthalten.
- Der Origin muss bereits in Browser-Normalform vorliegen: Schema und Host kleingeschrieben, ohne Standardport `:443` beziehungsweise `:80`. Internationalisierte Domains werden als ASCII/Punycode angegeben; verkürzte, dezimale, oktale oder hexadezimale IPv4-Schreibweisen werden abgelehnt.
- Öffentlich ist nur HTTPS erlaubt. HTTP wird ausschließlich für `localhost`, `127.0.0.1` und `::1` akzeptiert.
- `PB_ENCRYPTION_KEY` enthält exakt 32 einzelne Bytes/ASCII-Zeichen. Der Schlüssel muss dauerhaft in einem Secret Store liegen und darf bei einem Deployment nicht wechseln.
- Ohne Reverse Proxy bleiben `TODO_TRUSTED_PROXY_HEADER` und `TODO_TRUSTED_PROXY_CIDRS` leer. Hinter einem Proxy müssen immer beide gesetzt sein.

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

Compose bindet standardmäßig nur an `127.0.0.1:8090`. `TODO_BIND_ADDRESS`, `TODO_PORT`, `TODO_IMAGE` und `TODO_TAG` können für die Zielumgebung überschrieben werden. Das Root-Dateisystem ist read-only; nur `/app/pb_data` ist persistent und `/tmp` ist ein flüchtiges `tmpfs`.

## GitHub Container Registry

Pushes auf `main` und manuell gestartete Publish-Workflows erzeugen ein Multi-Arch-Image für `linux/amd64` und `linux/arm64` unter `ghcr.io/david-plugge/todo`. Jeder Build erhält den unveränderlichen Tag `sha-<vollständiger-git-sha>`. Der bewegliche Tag `latest` wird ausschließlich für Builds von `main` gesetzt. Das Image enthält außerdem OCI-Quell- und Revisionslabels sowie Provenance- und SBOM-Attestierungen.

Für ein Deployment wird nicht `latest`, sondern der SHA-Tag zusammen mit dem von GHCR ausgegebenen Multi-Arch-Manifest-Digest verwendet. Docker akzeptiert dafür eine kombinierte Tag-und-Digest-Referenz:

```dotenv
TODO_IMAGE=ghcr.io/david-plugge/todo
TODO_TAG=sha-0123456789abcdef0123456789abcdef01234567@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Damit bleibt im Compose-Vertrag sichtbar, welcher Commit deployt wurde, während der Digest exakt die geprüften Bytes festlegt. Auf dem Zielhost wird das Image explizit gepullt; `--no-build` verhindert, dass Compose stattdessen aus dem lokalen Checkout baut:

```sh
docker compose pull todo
docker compose up -d --no-build todo
docker compose ps
curl --fail "$TODO_PUBLIC_URL/api/health"
```

Private GHCR-Packages erfordern auf dem Zielhost eine Anmeldung mit ausschließlich `read:packages`. Bei einem öffentlichen Package ist für das Pulling keine Anmeldung erforderlich. Der Publish-Workflow verwendet ausschließlich das kurzlebige `GITHUB_TOKEN` mit `contents: read` und `packages: write`; ein dauerhaftes Registry-Secret ist nicht notwendig.

Einen App-Benutzer legt ein einmaliger Admin-Job an. Das Passwort wird nur als Prozessumgebung übergeben:

```sh
TODO_USER_PASSWORD='...' docker compose run --rm \
  --entrypoint /app/todo \
  todo user-create user@example.com \
  --dir=/app/pb_data \
  --encryptionEnv=PB_ENCRYPTION_KEY
```

Superuser werden entsprechend mit dem PocketBase-Befehl `superuser create` angelegt. Für dauerhafte Automatisierung müssen Passwörter aus dem Secret Store der Plattform kommen, nicht aus Compose-Dateien oder Shell-History.

## Reverse Proxy

TLS sollte am vorgeschalteten Proxy enden. Dieser muss den ursprünglichen `Host` unverändert weitergeben; lange Read-Timeouts sind für PocketBase-Realtime/SSE erforderlich. Der Containerport muss ausschließlich vom Proxy erreichbar bleiben, zum Beispiel über Loopback oder ein internes Container-Netz.

Die Client-IP wird standardmäßig aus der direkten TCP-Verbindung ermittelt; beliebige Forwarding-Header eines Clients werden nicht vertraut. Soll der IP-basierte Limiter die Adresse vor dem Proxy verwenden, sind beide Variablen erforderlich:

```dotenv
TODO_TRUSTED_PROXY_HEADER=X-Real-IP
TODO_TRUSTED_PROXY_CIDRS=172.20.0.5/32
```

Als Header sind ausschließlich `X-Forwarded-For`, `X-Real-IP` und `CF-Connecting-IP` zulässig. `TODO_TRUSTED_PROXY_CIDRS` bezeichnet die direkten Peer-Adressen des eigenen Proxys, kommasepariert als CIDR; `0.0.0.0/0` und `::/0` werden abgelehnt. Möglichst werden exakte `/32`- beziehungsweise `/128`-Adressen verwendet. Fehlt eine der beiden Variablen oder ist sie ungültig, verweigert der Container den Start.

Der letzte vertrauenswürdige Proxy muss den ausgewählten Header von eingehenden Requests entfernen und selbst neu setzen. Bei `X-Forwarded-For` verwendet Todo den rechtsstehenden gültigen Wert. Das ist für einen einzelnen Proxy gedacht, der den Header ersetzt. Bei mehreren Proxy-Stufen muss die letzte Stufe zuerst eine bereits validierte Client-IP auf einen einzelnen `X-Real-IP`-Wert reduzieren; eine ungeprüft angehängte Client-Kette ist kein unterstützter Vertrauensvertrag. Selbst mit passendem Header wird die weitergereichte IP nur übernommen, wenn die direkte Peer-IP in `TODO_TRUSTED_PROXY_CIDRS` liegt; ansonsten werden externe wie interne Forwarding-Werte entfernt.

## Betriebsgrenzen

- Genau eine Instanz darf auf das Volume schreiben. Keine horizontalen Replikate und keine überlappenden Rolling Updates.
- Deployment-Strategie: alte Instanz sauber stoppen, dann die neue Instanz mit demselben Volume starten.
- Persistiert wird nur `/app/pb_data`. Binary und `pb_public` kommen aus dem unveränderlichen Image.
- Das Image läuft als UID/GID `10001:10001`, ohne Linux-Capabilities und mit `no-new-privileges`.
- Bei Host-Bind-Mounts muss das Datenverzeichnis für UID/GID `10001:10001` schreibbar sein. Das bereitgestellte Named Volume benötigt keine manuelle Rechteanpassung.
- `--dev` ist im Container-Entrypoint nicht aktiv und Command-Overrides werden abgelehnt. Administrative Einmalbefehle müssen den Entry-Point wie oben bewusst überschreiben.

Der Backup-/Restore-Cursorvertrag bleibt ein getrennter Livegang-Schritt und wird durch das Image nicht vorgetäuscht.

## Rate-Limits und OAuth-Wartung

Eine eingebettete Go-Migration aktiviert PocketBases IP-basierten Rate-Limiter einmalig. Sie ergänzt methodenspezifische Regeln für dynamische OAuth-Registrierung, Authorization, Consent, Token, Revoke, Verbindungen, MCP sowie Todo-Push, -Pull und -Snapshot. Die Regeln gelten für Gäste und authentifizierte Requests; dadurch kann ein gültiges PocketBase-Token die spezifischen Limits nicht umgehen. Die Migration überschreibt später im Dashboard vorgenommene Änderungen nicht bei jedem Prozessstart.

Nur PocketBases expliziter `--dev`-Modus deaktiviert die Limits zur Laufzeit, ohne diese Einstellung zu speichern. Die lokale parallele E2E-Suite nutzt diesen Modus, da alle isolierten Browserkontexte dieselbe Loopback-IP teilen. Der Container-Entrypoint akzeptiert kein `--dev`; der Container-Smoke-Test weist den produktiven 429-Pfad separat nach.

Der Limiter lebt im Speicher einer einzelnen Instanz. Ein Prozessneustart setzt seine Zähler zurück; bei einer späteren horizontalen Architektur wäre deshalb zusätzlich ein gemeinsamer Limiter am Edge erforderlich. Für korrekte IP-Schlüssel dürfen ausschließlich Proxy-Header vertraut werden, die der eigene Reverse Proxy entfernt und neu setzt.

Dynamische OAuth-Registrierung hat zusätzlich ein datenbankweit und transaktional geprüftes Hard-Limit von 4.096 Clients. Dieses Limit gilt unabhängig von Quell-IP und Prozessneustarts und begrenzt damit auch verteiltes Wachstum. Ist es erreicht, wird genau die älteste Registrierung ohne Tokenfamilie freigegeben; dazugehörige, noch nicht authentifizierte Zustimmungsanfragen werden in derselben Transaktion verworfen. Ein Angreifer kann Registrierungen daher nicht allein durch wiederholte Aufrufe von `/authorize` festhalten. Sind alle Slots durch Grants geschützt, antwortet die Registrierung mit HTTP 429 und `Retry-After: 3600`. Das Hard-Limit schützt die SQLite-Größe, ersetzt bei öffentlicher Erreichbarkeit aber keinen gemeinsamen Edge-Limiter gegen eine gezielte Kapazitätserschöpfung.

Ein Client gilt erst nach einer authentifizierten, genehmigten Grant-Erstellung als benutzt; das bloße Starten oder Ablehnen eines Authorization-Flows aktualisiert seine Nutzungszeit nicht. Pro Grant-Familie wird eine erste vorgezogene Refresh-Rotation aus Kompatibilitätsgründen akzeptiert. Danach müssen Rotationen mindestens zehn Minuten auseinanderliegen, andernfalls antwortet der Token-Endpunkt mit HTTP 429 und `Retry-After`. Alte Access-Zeilen werden sofort gelöscht. Verbrauchte Refresh-Tokens werden auf Hash, Familie und Ablaufzeit reduziert, sodass die Replay-Erkennung erhalten bleibt, ohne vollständige Token-Datensätze anzusammeln. Bei 4.096 Replay-Hashes wird die Familie widerrufen und muss neu autorisiert werden.

Der Cron-Job `todoOAuthCleanup` läuft täglich um `03:23 UTC`. Er löscht ausschließlich:

- abgelaufene offene OAuth-Zustimmungsanfragen und
- vollständige Tokenfamilien, in denen kein unverbrauchter, noch gültiger Code, Access- oder Refresh-Token existiert, und
- dynamische Clients, deren letzter erfolgreicher Grant mindestens 30 Tage zurückliegt und die von keiner verbliebenen Tokenfamilie referenziert werden; offene, nicht authentifizierte Zustimmungsanfragen dieser Clients werden dabei mit entfernt.

Kompakte Refresh-Replay-Hashes einer aktiven Familie bleiben bis zu ihrer ursprünglichen Ablaufzeit erhalten, damit ihre Wiederverwendung weiterhin die gesamte Familie widerruft. Pending- und Token-Datensätze referenzieren ihren Client zusätzlich über SQLite-Fremdschlüssel; Registrierung, Grant-Erstellung und Bereinigung laufen in serialisierten Transaktionen. Ein Client mit einer Tokenfamilie kann daher auch bei paralleler Bereinigung nicht verschwinden. Der Job löscht außerdem abgelaufene oder familienlose Replay-Evidence, ausdrücklich aber keine Todo-Changes, Receipts, Tasks, Listen oder Tombstones. Erfolgreiche Läufe loggen die Anzahl gelöschter Pending-Einträge, Familien, Tokens, Replay-Einträge und Clients; Fehler werden geloggt und die Transaktion wird vollständig zurückgerollt.

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
