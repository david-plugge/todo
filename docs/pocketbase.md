# PocketBase, Auth und inkrementeller Pull

## Lokal starten

```sh
mise install              # Go und golangci-lint aus mise.toml
pnpm install --frozen-lockfile
pnpm run backend:install   # nativen PocketBase-Go-Server bauen
pnpm run build
pnpm run backend          # 127.0.0.1:8090, persistente Daten in pb_data/
```

`pnpm run backend` verwendet `http://127.0.0.1:8090` als `TODO_PUBLIC_URL`, wenn die Variable
nicht bereits gesetzt ist. Ein direkter Binary- oder Containerstart bleibt fail-closed und benötigt
`TODO_PUBLIC_URL` weiterhin explizit.

- App mit Anmeldung: `http://127.0.0.1:8090/`
- PocketBase-Dashboard: `http://127.0.0.1:8090/_/`
- `/account` leitet für bestehende Links auf `/` weiter. Die Browser-Test-Harness ist nicht Teil der ausgelieferten Anwendung.

**Der Server öffnet keinen Browser automatisch.** [`backend/main.go`](../backend/main.go) setzt `ServeEvent.InstallerFunc` auf `nil`. Das gilt auch für frische Testdatenbanken. Einen ersten Superuser explizit mit eigener E-Mail und eigenem Passwort anlegen:

```sh
.tools/freiraum superuser create 'ADMIN_EMAIL' 'ADMIN_PASSWORT' --dir=pb_data
```

Danach im Dashboard in `todo_users` die normalen App-Benutzer mit E-Mail und Passwort anlegen. Es gibt absichtlich keine öffentliche Registrierung und keine produktiven Standardzugangsdaten. Testbenutzer werden nur im temporären Test-Launcher angelegt. Für eine Vorschau in Codex die lokale App-URL im Browser-Panel öffnen; der Server selbst steuert keine Fenster.

Für Deployment werden das aus `backend/` gebaute Binary, `pb_public` und das persistente `pb_data` gebraucht. Go-Migrationen sind im Binary enthalten; Goja-Hooks oder Node-Dienste sind nicht erforderlich. Go, Node und Linter werden nur für Entwicklung und Build benötigt.

Die ursprüngliche Migration behält ihren Namen `1789551000_todo.js` in der Migrationstabelle. Bestehende Collections und Daten bleiben dadurch erhalten; die neue OAuth-Migration ergänzt eigene Tabellen. Vor einem Upgrade `pb_data` konsistent sichern; ein automatisches Downgrade ist nicht vorgesehen.

## Lokale Daten und Auth

`AccountSession` verwendet den persistenten PocketBase-Auth-Store. Pro Benutzer gibt es eine getrennte IndexedDB-Datenbank `todo-account-<ownerId>`. Abmelden verbirgt die Daten und stoppt Sync, löscht aber keine lokalen Daten oder pending Änderungen. Bereits lokal gespeicherte Daten sind keine verschlüsselte Benutzerablage.

Eine gespeicherte Identität öffnet die lokalen Collections sofort, auch bei abgelaufenem Token. Auth-Refresh läuft separat und darf den lokalen Start nicht blockieren. Login/Refresh verwenden zunächst einen isolierten Auth-Store; eine alte Refresh-Antwort kann nach Account-Wechsel nicht den neuen Token ersetzen. Beim nächsten Online-Sync erzwingt PocketBase wieder die Authentifizierung. Ist sie ungültig, bleibt lokale Arbeit möglich; für erneute Anmeldung abmelden und mit demselben Konto anmelden.

Die UI liest Tasks, Listen und Outbox ausschließlich über TanStack-Live-Queries. Fachliche Writes laufen durch die bisherigen atomaren Store-Kommandos. Netzwerkzugriff liegt in Auth-/Sync-Services.

## Serverseitiger Vertrag

[`backend/migrations.go`](../backend/migrations.go) erstellt:

| Sammlung         | Aufgabe                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `todo_users`     | E-Mail-/Passwort-Auth                                                                             |
| `tasks`, `lists` | Aktueller Entity-Zustand, Owner, externe UUID, Serverrevision und letzte Client-Version/Geräte-ID |
| `todo_changes`   | Append-only Änderungslog einschließlich vollständiger Tombstones                                  |
| `todo_receipts`  | Persistente Idempotenzbelege pro Owner und Mutations-ID                                           |
| `_todo_clock`    | Einzelner transaktionaler SQLite-Zähler für die globale Revision                                  |

Client-UUIDs liegen in `entityId`; PocketBase behält seine eigenen Record-IDs. Owner-/Entity-Indizes verhindern doppelte Datensätze. Read-/Realtime-Regeln filtern nach `owner = @request.auth.id`. Normale direkte Create-/Update-/Delete-Aufrufe auf Datensammlungen sind gesperrt; alle Writes gehen durch `/api/todo/push`. Eigene Daten lassen sich dort verändern, fremde nicht. Receipts sind für Clients nicht lesbar.

`POST /api/todo/push` akzeptiert nur `todo_users`-Auth. Owner wird aus dem Auth-Kontext abgeleitet; fremde Payload-Owner, ungültige Versionen, IDs und nicht unterstützte Felder werden abgewiesen. Der Request enthält die unveränderliche Outbox-Payload, `deviceId` und `baseRevision`. In **einer** `runInTransaction`-Transaktion werden:

1. ein vorhandener Owner-/Mutationsbeleg geprüft (identischer Request → identisches ACK; veränderte Payload mit gleicher ID → 409),
2. der aktuelle Datensatz geladen und per Feldversionen zusammengeführt (Legacy-Requests prüfen weiterhin die Basisrevision),
3. die globale Revision erhöht,
4. Datensatz, Änderungslog und ACK-Beleg gespeichert.

Ein Netzwerkabbruch nach Commit kann sicher erneut gesendet werden. Das ACK enthält zusätzlich `serverRevision`. Bei versionierten Mutationen speichert der Client eine ACK-Untergrenze atomar mit dem Entfernen genau dieses Outbox-Eintrags. Zusammengeführte Werte kommen ausschließlich über Pull; ein älterer zurückgestellter Snapshot darf die Untergrenze nicht unterschreiten. Ein ACK v5 entfernt niemals den Outbox-Eintrag für v6. Legacy-Snapshots ohne Feldversionen verwenden weiterhin die bisherige Bestätigung der lokalen Serverrevision.

### Feldkonflikte

Verschiedene Felder werden zusammengeführt; bei demselben Feld entscheidet Zähler plus Geräte-ID. Tombstones können durch alte aktive Snapshots nicht aufgehoben werden. Regeln, ACK-/Pull-Zusammenspiel, Tests und die Grenze bei gemischten Legacy-Requests stehen in [conflicts.md](conflicts.md).

Administratoren müssen ebenfalls den Sync-Vertrag nutzen. Die [MCP-Tools](mcp.md) teilen bereits die transaktionale Schreibfunktion mit dem PWA-Push. Rohe Admin-Änderungen an den Collections erzeugen derzeit kein Änderungslog und sind kein unterstützter Sync-Schreibpfad.

## Stabiler Pull statt Zeitstempel-Cursor

`GET /api/todo/pull?after=...&limit=...` liest eine strikt aufsteigende Änderungsrevision. Der erste Aufruf liefert einen festen oberen Stand `until`; weitere Seiten verwenden denselben Stand. Neue Writes während des Pagings erscheinen erst im nächsten Lauf. Andere Owner können Lücken im Zähler verursachen, aber keine fremden Records in der Antwort.

Antwort: `changes`, `cursor`, `until`, `hasMore`. Limit: 1–100, Standard 50. Tombstones bleiben im Log. Damit entfallen Gleichstand-/Präzisionsprobleme eines `updated > timestamp`-Cursors und instabile Offset-Pages. Der Test erzeugt während des Pagings ein Delete und prüft sowohl den vollständigen alten Stand als auch den nächsten inkrementellen Lauf.

`PullWorker` validiert Owner, Sequenz und Cursor vor dem lokalen Write. Entities und Cursor werden in einer Dexie-Transaktion gespeichert. Hat eine Entity noch Outbox-Einträge, wird ihr neuester Remote-Snapshot unter `syncMetadata` dauerhaft zurückgestellt; der globale Cursor darf trotzdem voranschreiten. Sobald keine lokale Mutation mehr pending ist, wird dieser Snapshot übernommen, sofern er weder älter als die lokal bekannte Serverrevision noch als die persistierte ACK-Untergrenze ist. Dadurch blockiert ein Konflikt nicht sämtliche anderen Remote-Daten.

Mehrere Tabs können parallel anfragen; innerhalb der lokalen Transaktion wird der erwartete Cursor verglichen. Eine alte HTTP-Antwort kann einen bereits weitergelaufenen Cursor nicht zurücksetzen.

## Trigger und Offline-Verhalten

`SyncEngine` startet beim App-Start und reagiert auf lokale Commits, Online-/Focus-Events, manuellen Sync sowie PocketBase-SSE und dessen Reconnect. Single Flight fasst überlappende Trigger zusammen. Netzwerkfehler führen zu weiteren Versuchen; persistierte Outbox-Backoff-Zeiten werden eingehalten. „Sync pausieren“ stoppt Push/Pull und lässt lokale Arbeit weiterlaufen. Manuelles „Pull“ verwendet denselben Pull-/Reconcile-Pfad.

**SSE-Daten werden nie direkt in IndexedDB geschrieben.** Ein Browser-Test hält alle Pull-Antworten zurück: Trotz SSE bleibt die zweite UI unverändert. Erst nach Freigabe des Pulls erscheint der Record.

PocketBase liefert statische Assets mit `Vary: Origin`. Bei einem Precache-Request fehlt der Origin-Header, bei Modul-Requests kann er vorhanden sein. Deshalb verwendet der Service Worker `ignoreVary` ausschließlich für die bekannten, identischen App-Shell-/Build-Dateien. API-/Dashboard-Routen bleiben vom Cache ausgeschlossen. Ohne diese Anpassung startete die echte PocketBase-SPA offline trotz gecachter HTML-Datei nicht; der Regressionstest prüft jetzt genau dieses Deployment.

## Verifikation

```sh
pnpm run test             # Unit-Tests inkl. Ranking, Kalenderdaten, Atomicity und Sync
pnpm run check
pnpm run build
pnpm run test:browser     # 12 bisherige Crash-/PWA-/ACK-Browser-Tests
pnpm run test:pocketbase  # 9 API-/MCP- und 16 Browser-Integrationstests
pnpm run test:startup     # Server startet ohne Betriebssystem-Browseraufruf
```

PocketBase-Tests verwenden eine frische temporäre Datenbank und Testbenutzer auf Port 8091; sie verändern nicht `pb_data`. Zwei isolierte Browserkontexte simulieren Geräte mit getrenntem Storage und unterschiedlichen Geräte-IDs. Geprüft sind Auth, Owner-Isolation, gesperrte direkte Writes, Idempotenz, List-/Task-Push, Paging, Tombstones, SSE als Pull-Trigger, Offline-Reload, abgelaufener Token und Account-Wechsel. Der Starttest fängt `open`/`xdg-open` ab und prüft, dass kein Aufruf erfolgt.

Noch offen: eine tatsächlich installierte Mobile-PWA, Log-/Receipt-Garbage-Collection und ein Restore-/Cursor-Reset-Konzept nach Backend-Datenverlust. Das Log wird im Spike nicht gekürzt.

## Geprüfte Quellen

PocketBase Server 0.40.4 und SDK 0.28.1 sind gepinnt. Implementierung und Tests verwenden die tatsächlichen Binary-/SDK-APIs sowie die erzeugten PocketBase-Typdefinitionen. Relevante Primärquellen: [JS Routing](https://pocketbase.io/docs/js-routing/), [Transaktionen](https://pocketbase.io/docs/js-database/), [Migrationen](https://pocketbase.io/docs/js-migrations/), [API Rules](https://pocketbase.io/docs/api-rules-and-filters/), [SDK/AuthStore](https://github.com/pocketbase/js-sdk), [Default-Installer-Source v0.40.4](https://github.com/pocketbase/pocketbase/blob/v0.40.4/apis/installer.go).
