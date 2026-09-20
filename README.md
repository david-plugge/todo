# Todo — Local-first Aufgabenverwaltung

Svelte 5 / SvelteKit SPA → TanStack DB → eigener Dexie-Adapter → IndexedDB. Aufgaben und Outbox werden gemeinsam gespeichert. Offline-Reads und -Writes benötigen kein Backend. Crash-Sicherheit, PWA-Metadaten sowie unveränderliche Push-Snapshots, Retry und versionsgebundene ACKs sind automatisiert geprüft.

Die Codebasis hat getrennte UI-Komponenten, explizite Command-Verträge, eine Account-Schreibwarteschlange und verbindliche Format-/Lint-Prüfungen. Architektur, Entwicklungsworkflow und offene Betriebsschritte: [docs/architecture.md](docs/architecture.md).

## Start und Tests

Node.js 24, pnpm und mise (Paketmanager/Go/Linter); geprüft mit Node 24.20.0 und lokalem Google Chrome.

```sh
mise install
pnpm install --frozen-lockfile
pnpm run dev             # Todo-Frontend mit HMR; /api wird an das lokale Backend weitergereicht
pnpm run backend         # PocketBase auf 8090 (für Anmeldung und Sync parallel starten)
pnpm run test            # Unit-Tests für Ranking, Daten, Merge und IndexedDB
pnpm run verify          # Format, Lint, Typprüfung, Unit-Tests und Build
pnpm run build           # statische Dateien nach pb_public/
pnpm run test:browser    # 12 Tests mit echtem Chrome/IndexedDB
pnpm run test:pocketbase # Integrationstests gegen echtes PocketBase (backend:install zuvor ausführen)
pnpm run test:startup    # Start ohne automatisches Browserfenster
```

Playwright startet einen lokalen Testserver selbst, der **die Dateien aus `pb_public/`** ausliefert. Vor Browser-Tests den aktuellen Build erstellen. Standard ist installiertes Google Chrome. Alternativ `pnpm exec playwright install chromium` und `PLAYWRIGHT_CHANNEL=chromium pnpm run test:browser`.

Die Browser-Tests starten eine ausschließlich testinterne Harness auf Port 4173 und beenden sie anschließend. Sie ist nicht Teil der ausgelieferten Anwendung.

Die Arbeitsdaten liegen pro Konto in einer eigenen IndexedDB-Datenbank. Testdaten und der Testserver sind davon isoliert; ihr flüchtiger Zustand ist kein Backend für echte Daten. `pnpm run dev`/`preview` liefern keine eigene API aus: Der Dev-Server leitet `/api` und `/.well-known` nur an ein selbst gestartetes PocketBase weiter (Standard `http://127.0.0.1:8090`, abweichend über `TODO_BACKEND_URL`). Ohne laufendes Backend bleibt die Anmeldung erwartungsgemäß erfolglos.

Für das Deployment reicht `pb_public/` neben dem selbst gebauten PocketBase-Go-Binary; eine produktive Node-Anwendung ist nicht erforderlich. Die Browser-Test-Harness ist ausschließlich eine Testfixture. Die SPA nutzt `ssr = false`, `prerender = false` und `adapter-static` mit `fallback: 'index.html'`.

Der produktive Containervertrag mit Fail-Closed-Konfiguration, Non-root-Runtime, Healthcheck und Smoke-Test steht in [docs/deployment.md](docs/deployment.md).

## MCP

Das native Go-Backend integriert das offizielle MCP-SDK und acht typisierte Aufgaben-/Listen-Tools. MCP OAuth unterstützt Browser-Zustimmung, PKCE, Token-Rotation und Widerruf. Anschluss, Berechtigungen und Tests: [docs/mcp.md](docs/mcp.md).

## PocketBase lokal

Todo verbindet die App unter `/` mit PocketBase: Auth, getrennte Benutzerdatenbanken, Owner-Regeln, transaktionaler Push, stabiler Pull-Cursor und SSE als Pull-Trigger. `/account` bleibt als Weiterleitung für bestehende Links erhalten.

```sh
pnpm run backend:install
pnpm run build
pnpm run backend # lokaler Public-URL-Default: http://127.0.0.1:8090
# http://127.0.0.1:8090/
```

Der Server öffnet keinen Browser automatisch. Superuser und App-Benutzer einmalig selbst anlegen; Anleitung, Protokoll und Testergebnisse stehen in [docs/pocketbase.md](docs/pocketbase.md). Die Feldkonfliktauflösung ist deterministisch; Regeln und Tests stehen in [docs/conflicts.md](docs/conflicts.md).

Die Oberfläche unter `/` bietet Listen, manuelle Reihenfolge, **Geplant am** und **Fällig am**. Bestehende Aufgaben speichern beim Verlassen eines Textfelds bzw. direkt bei Datum, Liste und Checkbox; Aufgaben und Listen lassen sich per Drag-and-drop umsortieren. Regeln, Library-Abwägung und Grenzen: [docs/ranking.md](docs/ranking.md).

## Verifizierte Eigenschaften

| Spike                         | Nachweis                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lokaler Datenfluss            | `createCollection`, `useLiveQuery`, Insert/Update/Delete, Rehydration, Write-through, Live-Updates, Offline-Reload und zwei Tabs                                       |
| Atomarität                    | Genau eine native IndexedDB-Transaktion über Aufgabe, Outbox und Metadaten; Commit oder vollständiger Rollback, nach Reload geprüft                                    |
| Crash und PWA                 | Renderer-Crash nach Commit und zwischen erstem und zweitem Write; vollständiger Browser-Neustart offline; gültiges Manifest/Icons und Chrome-Installierbarkeitsprüfung |
| Synchronisation               | Versionsgebundene ACKs, Retry, Timeout, Abbruch, idempotente Wiederholung und zwei Worker getestet                                                                     |
| PocketBase                    | Auth/Owner-Regeln, zwei Geräte, Aufgaben/Listen, Paging mit festem oberen Cursorstand, Tombstones, SSE-Pull, Offline-Auth und Account-Wechsel                          |
| Feldkonflikte                 | Unterschiedliche Felder bleiben erhalten, gleiche Felder konvergieren deterministisch; beide Verbindungsreihenfolgen und Tombstones mit zwei Offline-Geräten getestet  |
| Reihenfolge und Kalenderdaten | Inserts/Moves, 500 Einfügungen, atomare Neuverteilung, konkurrierende Offline-Moves, zwei Kalenderfelder, responsive UI und Legacy-Payloads                            |

Das Szenario „Push läuft → Reload/Crash“ ist mit dem Push-Worker geprüft. **Installation und Standalone-Betrieb auf einem realen Mobilgerät sind noch nicht geprüft.** Ein Renderer-Crash ist kein Nachweis für Stromausfall- oder Speichereviction-Verhalten.

### Testbelege

- [`adapter.test.ts`](src/lib/db/adapter.test.ts): echte TanStack-/Dexie-APIs mit `fake-indexeddb`, gemeinsame native Transaktionsidentität, absichtlicher zweiter Fehler, ConstraintError, Rehydration, gemischte Collection-Writes, stale-write rejection, Tombstones.
- [`migration.test.ts`](src/lib/db/migration.test.ts): Übernahme bestehender v1-Daten; Upgrade-Fehler lässt die alte Datenbank unverändert.
- [`push.test.ts`](src/lib/sync/push.test.ts): v5/v6-Race, unveränderliche Payloads, keine Netzwerkaufrufe innerhalb einer Dexie-Transaktion, Retry mit derselben ID nach verlorener Antwort, falsches ACK, lokaler ACK-Speicherfehler, Backoff, Single Flight, Cancel, Timeout, doppelte Worker und Tombstone-Schutz im Test-Remote.
- [`tests/browser`](tests/browser): 12 Tests gegen den statischen Build. Der Atomaritätstest beobachtet einen erfolgreichen nativen Task-Request **vor** dem Abort. Der Crash-Test pausiert mit dem Debugger beim anschließenden Outbox-Write und beendet dann den Renderer per `Page.crash`.
- Die HTTP-Tests halten ein ACK zurück, nachdem der Testserver die Mutation bereits angewendet hat. Nach Reload bzw. Crash sendet der Client **dieselbe ID und Payload** erneut; der Testserver hält weiterhin genau eine Mutation. Ein weiterer Test bestätigt, dass der Service Worker API-Antworten nicht offline ausliefert.
- PWA-Installierbarkeit und Offline-Browser-Neustart laufen in einem temporären persistenten Chrome-Profil. Die übrigen Tests verwenden isolierte Browserkontexte.

## Lokaler Adapter

[`database.ts`](src/lib/db/database.ts) hält `tasks`, `lists`, `outbox`, `syncMetadata` in einer Dexie-Datenbank. [`adapter.ts`](src/lib/db/adapter.ts) ordnet Collection-Objekte ihren Tabellen zu; [`store.ts`](src/lib/db/store.ts) kapselt fachliche Task-Kommandos.

1. `collection.preload()` wird vor der ersten Mutation abgewartet, außerhalb der Mutation-Funktion.
2. `createTransaction({ mutationFn: adapter.persist })` sammelt synchrone Operationen in `tx.mutate(...)`. Manuelle Transaktionen rufen **keine** `onInsert`/`onUpdate`/`onDelete`-Handler auf. Diese Handler sind bewusst nicht eingerichtet; implizite Einzel-Writes schlagen fehl.
3. `transaction.mutations` liefert `collection`, `type`, `key`, `original`, `modified`. Ein gemeinsames `db.transaction('rw', tables, callback)` umfasst alle betroffenen Tabellen plus `syncMetadata`.
4. `Table.add` prüft Duplicate Keys; Updates/Deletes vergleichen den gespeicherten Record mit `original`, bevor `put`/`delete` schreiben. Veraltete Writes aus anderen Tabs werden abgewiesen.
5. Eine lokale Adapter-Revision und Tabellen-Snapshots werden im selben Commit erfasst. Das Dexie-Promise bestätigt den nativen Commit. `adapter.write(...)` verwendet denselben Mechanismus für interne ACK-/Retry-Writes; es ist keine UI-Schnittstelle und darf kein Netzwerk-I/O enthalten.
6. Bestätigte Snapshots gehen über `sync.begin()`, `write(...)`, `commit()` an TanStack. Dexie `liveQuery` liest Tabelle und Revision in einer gemeinsamen Read-Transaktion für initiale Rehydration und weitere Tab-Änderungen. Ältere Snapshots werden verworfen.
7. `sync.commit()` kann in DB 0.9.2 ein Promise statt `true` zurückgeben. Die Veröffentlichung kann hinter einer laufenden Mutation warten. `mutationFn` wartet daher **nicht** auf dieses Receipt oder ein weiteres Preload; das könnte einen Deadlock erzeugen. Der Caller wartet auf `tx.isPersisted.promise`.

Die Adapter-Revision ist kein Remote-Cursor oder Konfliktmodell. Alle zukünftigen lokalen Schreibpfade müssen die Revision-Konvention einhalten. Rohes Dexie-Schreiben ist keine unterstützte Anwendungsschnittstelle. Die Atomaritätszusage betrifft die Speicherung; mehrere TanStack-Collections veröffentlichen nicht als zusätzlicher gemeinsamer UI-Snapshot.

## Push- und ACK-Protokoll

[`PushWorker`](src/lib/sync/push.ts) verarbeitet pro Aufruf einen begrenzten Snapshot der **persistierten** Outbox. Neue Änderungen währenddessen bleiben für den nächsten Lauf pending. Netzwerkaufrufe erfolgen zwischen, niemals innerhalb lokaler Transaktionen.

Jeder Outbox-Eintrag enthält einen vollständigen unveränderlichen `payload`, dessen `id` und `version` zu `entityId` und `entityVersion` passen. TanStack-Virtual-Properties werden vor der Speicherung entfernt. Transportdaten umfassen nur ID, Entity-Typ/-ID/-Version, Operation und Payload; Retry-Zähler gehören nicht zum Idempotenzschlüssel.

Ein ACK muss `mutationId`, `entityType`, `entityId` und `entityVersion` exakt bestätigen. Danach löscht eine eigene lokale Transaktion ausschließlich diesen Outbox-Eintrag. Der Worker überschreibt keine fachlichen Task-Felder und setzt kein pauschales `synced`-Flag. Ein PocketBase-ACK für versionierte Daten speichert eine Untergrenze für folgende Pulls; die zusammengeführten Felder kommen ausschließlich über Pull. Legacy-Snapshots bestätigen weiterhin bei passender lokaler Version die Serverrevision. So bleibt v6 nach ACK v5 pending. Ein bereits von einem anderen Tab gelöschter Eintrag ist beim zweiten ACK unproblematisch.

Fehler belassen die Mutation in der Outbox und speichern `retryCount`, `lastError`, `nextAttemptAt`. Der Delay steigt von 1 Sekunde bis maximal 60 Sekunden. Neuere Versionen derselben Entity überholen einen zurückgestellten Vorgänger nicht. Ein Lauf stoppt beim ersten Send-/ACK-Fehler. Ein weiterer manueller Lauf versucht fällige Einträge erneut; der Account-Sync verwendet zusätzlich den automatischen Retry-Scheduler im `SyncEngine`. Timeout: 10 Sekunden pro Request. Explizites Cancel erhält den Eintrag ohne Retry-Delay. Es gibt keinen persistenten `inFlight`-Lock, der nach einem Crash hängen bleiben könnte. Pro Worker laufen parallele Aufrufe als Single Flight; mehrere Tabs dürfen dennoch denselben Request senden.

Der Transport muss dieselbe Mutations-ID mit identischer Payload idempotent verarbeiten und alte Requests gegen neuere Zustände absichern. Die Testfixture zeigt dies für **einen logischen Client** mit monotonen Entity-Versionen. Das ist **kein** geräteübergreifendes Konfliktmodell. PocketBase implementiert seit Spike 6 einen transaktionalen Idempotenz-/Änderungslog-Vertrag; Details stehen in [docs/pocketbase.md](docs/pocketbase.md), die Feldkonfliktauflösung aus Spike 7 in [docs/conflicts.md](docs/conflicts.md).

### Datenbank-Upgrade

Schema-Version 2 behält die bisherigen Datenbanknamen bei. v1-Outbox-Einträge enthielten keinen historischen Payload. Da v1 noch keinen Push hatte, fasst das Upgrade die alten Einträge je Entity zum vorhandenen neuesten Zustand zusammen und speichert diesen Snapshot. Es erfindet keine historischen v1-/v2-Payloads. Fehlt die passende Entity/Version, bricht das gesamte Upgrade mit Fehler ab; die Originaldaten bleiben erhalten. Neue Einträge werden nicht coalesced.

## PWA

[`manifest.webmanifest`](static/manifest.webmanifest) definiert `standalone`, Scope/Start-URL und PNG-Icons mit 192/512 Pixeln. Die Icons stammen aus Lucide; `static/icons/app.svg` ist die Quelle der eingecheckten PNG-Exporte. Es gibt keinen eigenen Icon-Generator. Der Browser kann seine normale Installationsfunktion anbieten; ein eigener Installationsdialog ist noch nicht vorgesehen.

Der SvelteKit-Service-Worker cached App-Shell und Assets, niemals `/api/` oder `/_/`. HTTPS oder localhost sind erforderlich; die erste Installation benötigt Netzwerk. Updates aktivieren nach Schließen alter Tabs, ohne erzwungenes `skipWaiting`. Browserdaten bleiben löschbar; `chromeTransactionDurability: 'strict'` ersetzt kein Backup.

## APIs und Quellen

Versionsabfrage vom 2026-09-16; exakte installierte Versionen in `package.json` und Lockfile:

| Komponente                             | Geprüfte Version                                                          |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Svelte / SvelteKit / Static-Adapter    | 5.57.0 / 2.70.3 / 3.0.10                                                  |
| `@tanstack/svelte-db` / `@tanstack/db` | 0.4.1 / 0.9.2                                                             |
| Dexie                                  | 4.4.6                                                                     |
| PocketBase Server / JS SDK             | 0.40.4 / 0.28.1 — lokal integriert und getestet                           |
| `@vite-pwa/sveltekit`                  | 1.1.0 — evaluiert; nativer SvelteKit-Worker reicht für diesen Shell-Cache |

Gelesen wurden die installierten TanStack-Sourcen `src/transactions.ts`, `src/types.ts` und der Collection-Sync-Pfad. Referenzen: [Mutation-Semantik](https://tanstack.com/db/latest/docs/guides/mutations), [Svelte-Live-Queries](https://tanstack.com/db/latest/docs/framework/svelte/overview), [Dexie-Transaktionen](<https://dexie.org/docs/Dexie/Dexie.transaction()>), [Dexie liveQuery](<https://dexie.org/docs/liveQuery()>), [Static-Adapter](https://svelte.dev/docs/kit/adapter-static), [Vite-PWA](https://vite-pwa-org.netlify.app/frameworks/sveltekit.html), [PocketBase/pb_public](https://pocketbase.io/docs/), [PWA-Installierbarkeit](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable), [Chrome Page.crash](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-crash).

Der [Referenzadapter, Commit `20df9e0`](https://github.com/HimanshuKumarDutt094/tanstack-dexie-db-collection/blob/20df9e0ec99abebb4ef220d752c8efc0ef092ed3/src/dexie.ts) wurde gelesen, nicht kopiert. Er verwendet je Collection eine Dexie-Instanz mit Ein-Tabellen-Schema und einzelne Persistenzhandler/Tabellen-Transaktionen. Die benötigte gemeinsame Outbox-Transaktion implementiert dieser Spike selbst.

## Weitere Schritte

Die zentralen Local-first-, Sync- und Workspace-Funktionen sind umgesetzt. Grenzen des Rank-Modells stehen in [docs/ranking.md](docs/ranking.md).

Weiterhin offen: reale installierte Mobile-PWA, Skalierungsnachweis und Backend-Restore/Log-Garbage-Collection. IDs sind vorläufig UUIDv4 (`crypto.randomUUID`); Owner und Serverrevision existieren im Account-Modus, Feldversionen, Rank und Kalenderdaten sind implementiert. Der Adapter liest ganze Tabellen und vergleicht JSON-fähige Records; das ist kein Skalierungsnachweis. Fachliche Kommandos müssen Entity und Outbox gemeinsam schreiben; die generische Transaktions-API erzwingt diese fachliche Vollständigkeit nicht selbst.
