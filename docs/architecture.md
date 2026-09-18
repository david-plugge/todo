# Architektur und Entwicklungsworkflow

Die Anwendung bleibt local-first: Ein Edit gilt nach dem IndexedDB-Commit als lokal gespeichert. Die Serverbestätigung ist ein eigener Zustand. `/` ist die Produktoberfläche; `/account` bleibt als Kompatibilitäts-Redirect erhalten. Die Browser-Test-Harness ist nicht Teil des Produkt-Routings.

## Verantwortlichkeiten

| Bereich                      | Vertrag und Verantwortung                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `domain/commands.ts`         | `TodoCommands`, `TaskChanges`, `ListChanges`, `CreateTaskOptions`: nur editierbare Felder, keine vom UI gesetzten Owner-, Versions- oder Sync-Metadaten.                                         |
| `domain/recurrence.ts`       | Kanonische, datumsscharfe RRULEs, Berechnung des nächsten Termins und deterministische UUIDv5-IDs für Aufgaben einer Wiederholungsserie.                                                         |
| `db/store.ts`                | `TodoStore` intern; `WorkspaceStore` gibt der UI nur Commands, Live-Collections und Bereitschaft. Validierung, Feldversionen, Rank und Outbox entstehen zusammen.                                |
| `db/adapter.ts`              | Eine native Dexie-Transaktion pro lokalem Schreibvorgang; Veröffentlichung nach Commit.                                                                                                          |
| `application/write-queue.ts` | Pro Account eine geordnete Warteschlange. Fehler werden sichtbar gemeldet, spätere Edits bleiben möglich. Beim Schließen werden akzeptierte Writes vor dem Schließen der Datenbank abgearbeitet. |
| `pocketbase/session.ts`      | Authentifizierung, getrennte Account-Datenbanken, Lebenszyklus von WriteQueue und SyncEngine.                                                                                                    |
| `sync/`                      | Push/ACK und Pull/Cursor mit expliziten Transportverträgen. Remote-Payloads werden vor dem lokalen Schreiben validiert.                                                                          |
| `components/`                | `AccountTodo` verbindet Queries und Commands; Sidebar, Composer, TaskRow und TaskEditor kapseln ihre Darstellung und Eingabezustände.                                                            |
| `ui/`                        | Adapter für Abbruch, geschützte Bedienelemente und Übergabe der Zielposition an Store-Kommandos. Die DnD-Bibliothek übernimmt Gesten und Geometrie.                                              |
| `app.css`                    | Gemeinsame Farbwerte, globale Fokusregeln sowie Layout und Interaktion der schwebenden DnD-Kopie. Komponenten behalten ihre lokalen Tailwind-Regeln.                                             |

Die UI liest Aufgaben ausschließlich aus TanStack-Collections. Die Account-UI kann über ihren Typvertrag weder direkt Dexie-Tabellen noch den Adapter beschreiben. Serverkommunikation bleibt in den Sync-Services. TypeScript-Verträge ersetzen keine Laufzeitvalidierung: Store und Pull prüfen ihre Eingaben; der Server prüft jeden Push erneut.

## Interaktionen

- Titel speichern bei Blur oder Enter; Datum, Liste und Checkbox unmittelbar bei Änderung. Der Editor zeigt den Abschluss des lokalen Writes an.
- Wiederholungen verwenden eine RRULE ohne `RRULE:`-Präfix und benötigen ein Planungs- oder Fälligkeitsdatum als Anker. Beim erstmaligen Erledigen entstehen Abschluss und genau eine nächste Instanz atomar. Planungs- und Fälligkeitsdatum behalten dabei ihren Abstand zum Wiederholungsanker; die deterministische ID aus Serien-ID und Datum verhindert doppelte Instanzen. Unterstützt werden tägliche, wöchentliche, monatliche und jährliche Regeln ohne `COUNT` oder `UNTIL`.
- Drag-and-drop nutzt `svelte-dnd-action` über `SortableRows` und `ListDropTarget`. Die ganze Zeile ist ziehbar; Checkboxen und Eingaben bleiben bedienbar. Touch benötigt einen kurzen Halt, damit Wischen weiterhin scrollt. Pointer-Abbruch und Drops außerhalb einer Zone speichern keine Änderung.
- Tastatur: Leertaste/Enter zum Aufnehmen, Pfeiltasten zum Verschieben, Leertaste/Enter/Escape zum Beenden. Screenreader erhalten eine Anleitung sowie eine Abschlussmeldung. Die Sortierung in gefilterten Ansichten bleibt Teil der gemeinsamen globalen Reihenfolge; siehe [Ranking](ranking.md).
- Abmelden wartet intern auf bereits akzeptierte lokale Writes. Das ist keine Zusicherung für einen erzwungenen Prozessabbruch vor dem IndexedDB-Commit.

## Prüfungen

Node.js 24 verwenden. JavaScript-Abhängigkeiten stehen in `pnpm-lock.yaml`, Go-Abhängigkeiten in `backend/go.mod` und `go.sum`. `mise.toml` pinnt pnpm, Go und golangci-lint. Go nutzt gofmt, goimports und golines (120 Zeichen) sowie die Standard-Linter von golangci-lint.

```sh
mise install
pnpm install --frozen-lockfile
pnpm run format       # Frontend und Dokumentation formatieren
pnpm run backend:format # Go formatieren
pnpm run verify       # Formatcheck, ESLint, Svelte/TypeScript, Unit-Tests, Go-Lint/Tests und Builds
pnpm run backend:install
pnpm run test:e2e     # Browser-Harness, PocketBase und Serverstart ohne Browser-Öffnung
```

Die GitHub-Actions-Konfiguration führt diese Prüfungen mit Chromium unter Linux aus. Lokal verwenden die Browser-Tests standardmäßig Chrome; `PLAYWRIGHT_CHANNEL=chromium` wählt installiertes Playwright-Chromium. Testserver verwenden eigene Datenverzeichnisse und Ports. Fehlerartefakte liegen getrennt nach Browser- und PocketBase-Tests.

## Noch vor einem öffentlichen Betrieb

Diese Änderung bereitet die Codebasis vor; sie richtet keinen Produktivserver ein. Deployment-Ziel, HTTPS/Reverse Proxy, geschützte Administration, Nutzerbereitstellung und ein getesteter Backup-/Restore-Prozess müssen für den konkreten Betrieb eingerichtet werden. Die technischen Labor-Routen sollten in einem öffentlichen Build entfernt oder getrennt bereitgestellt werden. PWA-Installation und Touch-Verhalten müssen zusätzlich auf echten iOS-/Android-Geräten geprüft werden. Die dokumentierten Grenzen bei konkurrierendem Rebalancing gelten weiterhin.

Weitere Protokolldetails: [PocketBase](pocketbase.md), [Konfliktauflösung](conflicts.md), [Ranking und Kalenderdaten](ranking.md).

SvelteKit und der Static-Adapter sind direkt im `sveltekit(...)`-Plugin in `vite.config.ts` konfiguriert. UI-Icons kommen aus `@lucide/svelte`; die PWA verwendet statische Exporte des Lucide-Check-Icons. Playwright verwaltet die Testserver über `globalSetup` und Teardown unter `tests/fixtures/`. Auch der Test gegen automatisches Browser-Öffnen ist ein Playwright-Test.
