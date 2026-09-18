# Reihenfolge, Kalenderdaten und UI

`/` zeigt eine responsive Aufgabenansicht mit Listen, „Mein Tag“, geplanten und erledigten Aufgaben. Tasks lassen sich beim Anlegen oder über „Bearbeiten“ einer Liste zuordnen und mit zwei unabhängigen Kalenderdaten versehen:

- `plannedDate` / **Geplant am**: Tag, an dem an der Aufgabe gearbeitet werden soll. „Mein Tag“ filtert danach.
- `dueDate` / **Fällig am**: Termin der Aufgabe. Vergangene Termine werden bei offenen Tasks hervorgehoben.

Beides sind optionale `YYYY-MM-DD`-Strings, keine UTC-Zeitstempel. `null` entfernt ein Datum und erhält eine eigene Feldversion. Client und Server validieren echte Kalendertage einschließlich Schaltjahren. Geplant und fällig dürfen unabhängig voneinander liegen. Es gibt keine Uhrzeiten oder Erinnerungen.

Die UI verwendet weiterhin TanStack-Live-Queries und die atomaren Store-Kommandos. Bestehende Tasks speichern ohne Speichern-Schaltfläche: Titel beim Verlassen des Feldes oder Enter, Datum und Liste beim Ändern, Erledigt beim Antippen. Ein Klick auf den Titel oder „Bearbeiten“ öffnet die Felder. Neue Aufgaben werden weiterhin ausdrücklich angelegt.

Jedes Ereignis schreibt nur sein eigenes Feld; Remote-Änderungen unberührter Felder bleiben erhalten. Während einer Titeleingabe überschreibt ein Pull den Entwurf nicht. Eine lokale Warteschlange serialisiert schnelle Änderungen, einschließlich Titel-Blur plus Checkbox-Klick. „Gespeichert“ erscheint erst nach dem IndexedDB-Commit; Fehler werden angezeigt und leere Titel nicht übernommen. „Details schließen“ ist keine Speichern-Aktion.

## Evaluierte Varianten

| Variante                                                                        | Eigenschaften                                                                                                                              | Entscheidung                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| [rocicorp/fractional-indexing](https://github.com/rocicorp/fractional-indexing) | Kleine JS-Bibliothek mit Typen, variablen Schlüsseln, `generateKeyBetween` und `generateNKeysBetween`; direkte lexikographische Sortierung | Geeignete Alternative bei künftig variabler Schlüssellänge. Gleichzeitige Einfügungen brauchen weiterhin eine Kollisionsstrategie. |
| [lexorank-ts](https://github.com/kvandake/lexorank-ts)                          | TypeScript-Referenz mit LexoRank-Objekten, `between`, `genNext` und `genPrev`                                                              | Das vollständige LexoRank-Modell wird für diesen Spike nicht benötigt.                                                             |
| Eigene begrenzte Fractional-Positionen                                          | Feste 128-Bit-Zahlen als 32-stellige Hex-Strings, Mittelpunkt und gleichmäßige Verteilung                                                  | Implementiert ohne zusätzliche Dependency; leicht serverseitig validierbar, Rebalancing explizit testbar.                          |

Die öffentlichen APIs der beiden Repositories wurden am 2026-09-16 geprüft; keine der Bibliotheken wird eingebunden. Unser Format ist LexoRank-artig, nicht mit Jira-LexoRank kompatibel.

## Reihenfolge und Rebalancing

[`rank.ts`](../src/lib/ranking/rank.ts) reserviert Null und den maximalen 128-Bit-Wert als äußere Grenzen. Zwischen zwei Nachbarn entsteht der ganzzahlige Mittelpunkt. Stringvergleich entspricht durch feste Länge und einheitliches Alphabet der numerischen Ordnung. `localeCompare` wird dafür nicht verwendet. Bei identischen Ranks entscheidet die Entity-ID; damit sehen alle Geräte dieselbe Reihenfolge.

Ein normales Insert oder Move schreibt nur die neue beziehungsweise bewegte Entity samt Outbox. Tasks und Listen haben jeweils eine eigene globale Reihenfolge. Listen filtern diese Task-Reihenfolge, sie bilden keine getrennten Rank-Bereiche. Tasks und Listen lassen sich an der ganzen Zeile per Drag-and-drop umsortieren; `createTask(..., options, beforeId)` erlaubt auch direktes Einfügen vor einem Task. Ein Move benötigt keine Netzverbindung.

Sind benachbarte Ranks gleich oder direkt nebeneinander, fehlt ein darstellbarer Mittelpunkt. Dann verteilt `planPlacement` die aktive Collection einschließlich des neuen/bewegten Eintrags gleichmäßig neu. Sämtliche geänderten Entities, Feldversionen, Outbox-Einträge und Adapter-Metadaten committen in **einer** Dexie-Transaktion. Ein fehlgeschlagener Outbox-Write rollt alles zurück. `rebalance(kind)` bietet denselben Mechanismus explizit für interne Aufrufer. Tombstones werden dabei ausgelassen.

128 Bits begrenzen Speicherbedarf und Validierung. Extrem einseitiges wiederholtes Einfügen verbraucht trotzdem Abstände; der Test erzwingt dies mit 500 Inserts in denselben Bereich. Eine Neuverteilung kostet O(n) Writes und ist keine Skalierungszusage für große Collections.

## Drag-and-drop

[`SortableRows.svelte`](../src/lib/components/SortableRows.svelte) verwendet `svelte-dnd-action` für Maus, Touch, Tastatur, Auto-Scroll und eine mitgezogene Kopie. Die Vorschau ordnet Zeilen mit Sveltes `flip`-Animation um; bei reduzierter Bewegung entfällt die Animation. Auf Touch beginnt Ziehen nach 180 ms Halten. Ein sofortiger Wisch scrollt weiterhin. Eingabefelder, Checkboxen und Aktionsbuttons starten keinen Drag.

`consider` verändert nur die lokale Vorschau. Beim Pointer-Drop schreibt `finalize` einmal über `moveTask` oder `moveList`. Escape und Touch-Cancel beenden den Pointer-Drag ohne Speicherung; Loslassen außerhalb einer Zone verändert ebenfalls nichts. Der kleine Adapter in `drag.ts` ergänzt diese Abbruchsemantik, da die Bibliothek Pointer-Drags über `mouseup` beendet. Vorschau- und Schattenobjekte gelangen nie in die Datenbank.

Mit Tastatur: Zeile fokussieren, Leertaste oder Enter zum Aufnehmen, Pfeiltasten zum Verschieben, Leertaste/Enter/Escape zum Beenden. Die Bibliothek finalisiert Tastaturbewegungen bei jedem Pfeilschritt; diese werden unmittelbar gespeichert. Die Seitenleisten-Listen sind über `ListDropTarget.svelte` zusätzliche Task-Drop-Zonen. Ein Drop schreibt nur `listId`; die globale Rank-Semantik bleibt unverändert. Abbrechen und Offline-Persistenz werden mit Playwright geprüft.

## Offline-Konflikte

`rank`, `dueDate`, `plannedDate` und `listId` sind normale versionierte Felder. Gleichzeitiges Verschieben desselben Tasks löst der bestehende Vergleich `(counter, deviceId)` auf. Datums- oder Titeländerungen bleiben dabei unabhängig erhalten. Verschiedene Tasks dürfen denselben Rank bekommen; der ID-Vergleich hält die Sortierung stabil. Ein späteres Einfügen genau zwischen solchen Nachbarn repariert den Bereich durch eine lokale Neuverteilung.

**Rebalancing sind echte Rank-Writes.** Bei einer gleichzeitig offline entstandenen Verschiebung entscheidet derselbe Feldvergleich. Beide Geräte konvergieren, aber nicht jede konkurrierende Positionsabsicht bleibt erhalten. Es gibt keine verteilte Sperre, keine Rebalance-Epoche und keine atomare serverseitige Bulk-Mutation: Während mehrere Outbox-Einträge übertragen werden, können andere Geräte Zwischenstände sehen. Ein weitergehendes Produkt müsste bei Bedarf koordinierte Rebalancing-Epochen oder ein anderes Positionsmodell ergänzen.

## Bestehende Daten und alte Clients

Die neuen JSON-Felder benötigen keine DB-Schemamigration. Bestehende unranked Tasks behalten ihre relative Reihenfolge nach `createdAt` und ID; Listen verwenden die ID. Beim ersten Insert/Move mit solchen Nachbarn werden echte Ranks zusammen mit Outbox-Einträgen zugewiesen. Nur Lesen erzeugt keine Writes.

Alte Payloads ohne die neuen Feldversionen bleiben gültig. Fehlende neue Werte haben die Version `(0, '')`; bei Kalenderdaten und Listenzuordnung sind fehlend und `null` ohne vorherige Änderung semantisch gleich. Eine alte Payload kann dadurch neuere Ranks/Daten/Zuordnungen nicht löschen. Ihre ursprünglichen Request-Bytes und Idempotenzbelege bleiben unverändert. Die ältere Grenze bei Records ganz ohne Feldversionen gilt weiterhin, siehe [conflicts.md](conflicts.md).

`listId` ist eine optionale logische Zuordnung zur externen Listen-UUID. Die UI bietet eigene aktive Listen an. Es gibt noch keine Lösch-/Umbenennungsoberfläche für Listen, keine kaskadierende Löschung und keinen serverseitigen Fremdschlüssel für diese JSON-Zuordnung. Ein fehlender Listen-Datensatz blendet seine Tasks in „Alle Aufgaben“ nicht aus.

## Verifikation

- `src/lib/ranking/rank.test.ts`: Insert before/after/between, first/last, Listen, 500 Inserts, Kollisionen, Legacy-Ranks, Reload, vollständiger Rollback beim Rebalancing, Datumvalidierung und Entfernen.
- `tests/pocketbase/ranking.spec.ts`: zwei isolierte Geräte in Los Angeles und Tokio, konkurrierende Offline-Moves und unabhängige Datumsänderungen, Offline-Reload, beide Verbindungsreihenfolgen, vollständiger Vergleich beider IndexedDBs mit PocketBase, Datumsentfernung und offen gebliebener Editor bei Remote-Änderung. Außerdem echte API-Tests für Datum-/Rank-Validierung, alte unveränderte Payloads und Rebalance-vs-Move in beiden Reihenfolgen; UI-Test bei 390 Pixeln für Listen und Datumsanlage.
- `tests/pocketbase/live-edit.spec.ts`: Autosave ohne Speichern, Titel-Blur plus Checkbox, Datums-/Listenänderungen, Validierung und Offline-Reload; Maus-Drop, Escape-Abbruch, Tastatur sowie Touch-Drops für Tasks und Listen bei 390 Pixeln.
- Die bestehenden Atomaritäts-, Crash-, PWA-, Auth-, SSE-, ACK- und Browserstart-Tests bleiben Teil der Suite.

```sh
pnpm test
pnpm run check
pnpm run build
pnpm run test:pocketbase
pnpm run test:browser
pnpm run test:startup
```

Noch offen sind echtes installiertes Mobile-PWA-Verhalten, größere Datenmengen, Log-/Receipt-Garbage-Collection und die Betriebsstrategie nach Backend-Restore. Die Touch-Tests laufen mit Chrome-Emulation, nicht auf einem echten iPhone/Android-Gerät.
