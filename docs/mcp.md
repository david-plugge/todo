# MCP in PocketBase

MCP läuft im nativen Go-PocketBase-Prozess unter `http://127.0.0.1:8090/api/todo/mcp`. Transport und Protokoll übernimmt das offizielle `modelcontextprotocol/go-sdk`; die neun Tools werden mit typisiertem `mcp.AddTool` registriert. `google/jsonschema-go` leitet die Eingabeschemas aus Structs ab. Wiederverwendbare Feldtypen ergänzen UUID-, Längen- und Zahlenlimits. Das SDK validiert die Eingaben; eine eigene JSON-Schema-Implementierung gibt es nicht.

## OAuth-Anschluss

Im MCP-Client die Server-URL eintragen und OAuth-Anmeldung starten. Der Client entdeckt die Metadaten, registriert sich, öffnet die Anmeldung und fragt ausdrücklich nach Zustimmung. Anmeldung erfolgt mit einem bestehenden `todo_users`-Konto. Unter **Verbundene Agenten** in der Account-Seite können erteilte Verbindungen widerrufen werden.

- Authorization Code mit PKCE S256, dynamischer Registrierung öffentlicher Clients und exaktem Redirect-Abgleich. Kein Client-Secret erforderlich.
- `tasks:read` erlaubt Lesen, `tasks:write` erlaubt Änderungen. Der Standard ohne Scope-Angabe ist nur Lesen. Owner wird ausschließlich aus dem Grant bestimmt.
- Access Token: 15 Minuten. Refresh Token: maximal 30 Tage ab Erteilung, mit Rotation. Eine erste vorgezogene Rotation wird toleriert; weitere Rotationen müssen mindestens zehn Minuten auseinanderliegen. Wiederverwendung verbrauchter Codes oder Refresh Tokens widerruft die gesamte Grant-Familie. Refresh entfernt auch vorherige Access Tokens.
- Codes gelten zwei Minuten; offene Zustimmungsanfragen zehn Minuten. Codes, Access- und Refresh Tokens werden nur als SHA-256-Hashes gespeichert. Grants und Widerrufe sind in SQLite persistent.
- Token-Audience ist genau die MCP-Resource. Normale PocketBase-Login-Tokens werden am MCP-Endpunkt nicht akzeptiert.
- `go-oauth2/oauth2/v4` übernimmt Grant-, PKCE- und Token-Lebenszyklus; PocketBase stellt die transaktionale Speicherung und Benutzerprüfung bereit.

Discovery: `/.well-known/oauth-protected-resource/api/todo/mcp` und `/.well-known/oauth-authorization-server`. Endpunkte liegen unter `/api/oauth/`: `register`, `authorize`, `token`, `revoke` sowie die authentifizierte Zustimmungs- und Verbindungsverwaltung.

`TODO_PUBLIC_URL` setzt den festen Issuer-Origin; lokal standardmäßig `http://127.0.0.1:8090`. Außerhalb von Loopback ist HTTPS erforderlich. Host und Browser-Origin müssen exakt dazu passen; native Clients ohne Origin sind erlaubt. Ein Reverse Proxy muss den ursprünglichen Host erhalten. Der lokale Start bleibt an Loopback gebunden. Client-ID-Metadata-Dokumente werden nicht unterstützt; Clients müssen dynamische Registrierung unterstützen.

## Tools

| Tool            | Eingaben                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `list_tasks`    | Optional `limit` (1–100), `cursor`, `completed`, `listId`, `query` (Titel und Beschreibung)        |
| `get_task`      | `id`; liefert auch Tombstones                                                                      |
| `create_task`   | `mutationId`, `title`; optional `description`, `completed`, `dueDate`, `plannedDate`, `listId`     |
| `update_task`   | `mutationId`, `id`, `expectedRevision`, `changes` mit mindestens einem editierbaren Feld           |
| `complete_task` | `mutationId`, `id`, `expectedRevision`                                                             |
| `delete_task`   | `mutationId`, `id`, `expectedRevision`; erzeugt einen Tombstone, keine Wiederherstellung verfügbar |
| `list_lists`    | Optional `limit`, `cursor`                                                                         |
| `create_list`   | `mutationId`, `name`                                                                               |
| `delete_list`   | `mutationId`, `id`, `expectedRevision`; optional `deleteTasks`; erzeugt einen Tombstone            |

Das Löschen einer Liste folgt der App: Ihre aktiven Tasks bleiben erhalten und verlieren nur die Listenzuordnung, sofern `deleteTasks` nicht gesetzt ist. Liste und betroffene Tasks werden in einer Transaktion geschrieben; die Task-Mutations-IDs leiten sich aus der übergebenen `mutationId` ab, sodass ein Wiederholungsversuch keine zweite Revision erzeugt.

Listenabfragen geben `{ items, nextCursor }` in aufsteigender Entity-ID-Reihenfolge zurück, nicht in UI-Rangfolge. Nur aktive Einträge werden aufgelistet. Paging ist kein unveränderlicher Snapshot bei parallelen Änderungen. Tasks enthalten ihren `rank` für eine gesonderte UI-Sortierung. Der Server sieht ausschließlich bereits synchronisierte Daten.

`description` ist eine freie Notiz mit höchstens 10.000 Zeichen; `null` entfernt sie. Die App stellt sie als Markdown dar und entfernt dabei alles außer Text, Hervorhebungen, Listen, Code und Links auf `http`, `https`, `mailto` sowie Seitenanker.

`mutationId` ist eine neue UUID pro beabsichtigtem Schreibvorgang. Bei einer unklaren Antwort exakt dieselbe ID und dieselben Argumente wiederholen. Der gespeicherte ursprüngliche Erfolg wird zurückgegeben, ohne eine weitere Revision zu erzeugen. Andere Argumente mit derselben ID werden abgelehnt.

`expectedRevision` entspricht `entity.remoteRevision` aus dem letzten Read. Ist diese Revision veraltet, wird die gesamte Änderung abgelehnt. Dann erneut lesen und entscheiden, ob der Edit weiterhin sinnvoll ist. Titel, Termine und Listenzuordnung ändern sich ausschließlich bei expliziter Angabe; `null` entfernt Datum oder Listenzuordnung. Datumswerte sind gültige Kalenderdaten im Format `YYYY-MM-DD`.

## Speicherung und Fehler

Die MCP-Command-Ausführung liest den aktuellen Datensatz innerhalb einer Transaktion, erhöht die Feldversionen der geänderten Felder und ruft `applyMutation` auf. PWA-Push und MCP teilen damit dieselbe Validierung, Merge-Logik, Revisionserzeugung, Tombstones, Änderungslogs und Receipts. Gleichzeitige Writes mit derselben Ausgangsrevision können nicht stillschweigend einander überschreiben. Noch unsynchronisierte Geräteänderungen werden weiterhin nach dem [Feldkonfliktmodell](conflicts.md) zusammengeführt.

`content` enthält ein JSON-Textresultat, `structuredContent` dasselbe Objekt. Fachliche Fehler erscheinen als `isError: true`; ungültige Tool-Aufrufe als SDK-Fehler; nicht unterstützte HTTP-RPC-Methoden werden mit HTTP 400 abgewiesen. Notifications führen keine Tools aus. `GET` und `DELETE` antworten nach Authentifizierung mit 405, da der Transport keine SSE-Abonnements oder Sessions anbietet. Der bestehende PocketBase-SSE-Kanal für PWA-Sync bleibt davon unabhängig.

## Tests und Betrieb

```sh
mise install
pnpm run verify
pnpm run test:pocketbase
```

Die Integrationstests verbinden den offiziellen TypeScript-MCP-Client mit einer eigenen Testdatenbank auf Port 8091. Sie prüfen den vollständigen Browser-OAuth-Flow, PKCE/Redirect/Client/Resource-Bindung, Scope-Prüfung, Rotation, Replay und Widerruf sowie CRUD, Idempotenz und MCP → PWA-Sync. Go-Tests prüfen zusätzlich Persistenz über Neustarts, gehashte Speicherung, Rollback und Struct-Schemas.

Das Container-Deployment aktiviert PocketBases IP-basierten Rate-Limiter einmalig per Migration. Methodenspezifische Regeln schützen insbesondere Registrierung, Authorization, Token-Austausch und MCP, ohne normale Sync-Bursts zu drosseln. Dynamische Registrierung ist zusätzlich datenbankweit auf 4.096 Clients begrenzt; am Limit wird der älteste Client ohne Tokenfamilie atomar ersetzt, auch wenn für ihn eine nicht authentifizierte Pending-Anfrage offen ist. Nutzungszeit entsteht erst durch einen authentifizierten, genehmigten Grant. Ein täglicher transaktionaler Cron entfernt abgelaufene Zustimmungsanfragen, vollständig inaktive Tokenfamilien und seit 30 Tagen grant-inaktive Clients ohne Tokenreferenz. Verbrauchte Refresh-Tokens bleiben als kompakte Hash-Evidence erhalten, sind pro Familie auf 4.096 begrenzt und werden nach Ablauf beziehungsweise Entfernung der Familie bereinigt. Fremdschlüssel schützen Clients mit Grants vor paralleler Bereinigung. Die Todo-Sync-Historie wird davon nicht berührt. Proxy-, Betriebs- und Logdetails stehen in [deployment.md](deployment.md).

Quellen: [offizielles Go-SDK](https://github.com/modelcontextprotocol/go-sdk), [JSON Schema für Go](https://github.com/google/jsonschema-go), [Go OAuth2](https://github.com/go-oauth2/oauth2), [MCP-Autorisierung](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
