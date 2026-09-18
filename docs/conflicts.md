# Feldkonflikte

Tasks führen Versionen für `title`, `completed`, `deletedAt`, `rank`, `dueDate`, `plannedDate` und `listId`; Listen für `name`, `deletedAt` und `rank`. Die Erweiterungen für Ranking und Kalenderdaten sind in [ranking.md](ranking.md) beschrieben. Eine Feldversion besteht aus `{ counter, deviceId }`. Der Account-Store erzeugt sie zusammen mit Entity und unveränderlichem Outbox-Snapshot in derselben lokalen Transaktion.

## Vergleich und Merge

Ein lokaler Edit erhöht den größten bekannten Entity-/Feldzähler um eins. Nur die bearbeiteten Felder erhalten diesen Zähler und die persistente Geräte-ID. Unveränderte Felder behalten ihre Version. Der Zähler überlebt Reloads im Datensatz; eine Änderung nach einem bereits gepullten Merge liegt über dessen bekannten Zählern. Unsichere Integer werden abgewiesen.

PocketBase vergleicht jedes Feld unabhängig:

1. Der höhere Zähler gewinnt.
2. Bei gleichem Zähler gewinnt die lexikographisch größere Geräte-ID (direkter Stringvergleich, keine Locale-Sortierung).
3. Gleiche Feldversion mit anderem Wert ist ein ungültiger Request und ergibt 409.

Damit bleiben beispielsweise ein neuer Titel von A und `completed = true` von B beide erhalten. Bei konkurrierenden Titeln gewinnen beide Verbindungsreihenfolgen denselben Titel. Das ist eine deterministische Auswahl, keine Aussage darüber, welche Offline-Änderung zeitlich später war. Geräte benötigen eindeutige, stabile IDs; kopierte Browserprofile mit derselben ID sind keine getrennten Geräte.

`version` im zusammengeführten Datensatz ist das Maximum beider Entity-Versionen. `createdAt` wird mit Minimum, `updatedAt` mit Maximum zusammengeführt; Zeitstempel entscheiden niemals einen Feldkonflikt. `remoteRevision` bleibt die separate globale Serverrevision. Für eine feste Menge gültiger Mutationen ist der fachliche Merge kommutativ, assoziativ und idempotent. Die Serverrevision hängt weiterhin vom Append-only-Log ab.

## Löschungen

Ein aktiver Datensatz hat für `deletedAt` die Version `{ counter: 0, deviceId: '' }` und keinen Löschzeitpunkt. Jede Löschung hat einen positiven Zähler und gewinnt deshalb gegen aktive Snapshots, selbst wenn diese andere Felder mit höheren Zählern enthalten. Unter konkurrierenden Löschungen gilt derselbe Feldvergleich. Alte Creates oder späte Offline-Edits können einen Tombstone nicht entfernen. Die UI blendet ihn aus; lokale Kommandos verweigern weitere Änderungen. Wiederherstellen ist nicht vorgesehen.

## Push, ACK und Pull

Der Server führt den Feld-Merge innerhalb der bestehenden Transaktion für Record, Änderungslog und Idempotenzbeleg durch. Versionierte Mutationen dürfen auf einer veralteten Basis aufbauen; die Feldversionen entscheiden. Receipts bestätigen weiterhin exakt die gesendete Mutations-ID und Entity-Version. Eine verlorene Antwort lässt sich mit unveränderten Request-Bytes wiederholen.

Ein ACK bestätigt die Annahme einer Mutation, **nicht** die Gleichheit des lokalen Snapshots mit dem zusammengeführten Serverstand. Bei versionierten Mutationen entfernt der Client atomar nur diesen Outbox-Eintrag und speichert eine Untergrenze `ack:<Typ>:<ID>` in `syncMetadata`. Er setzt die lokale `remoteRevision` nicht vorzeitig auf die ACK-Revision.

Der einzige Pfad für die zusammengeführten Werte bleibt Pull. Solange weitere lokale Mutationen pending sind, werden Remote-Snapshots dauerhaft zurückgestellt. Danach darf kein Snapshot unterhalb der ACK-Untergrenze den lokalen Stand überschreiben. Erst ein ausreichend neuer Pull installiert die zusammengeführten Werte und entfernt die Untergrenze. Ein Netzwerkausfall zwischen ACK und Pull bewahrt deshalb die lokale Änderung; ein späterer Pull ergänzt die übrigen Felder. Ein ACK für v1 lässt v2 samt Feldversionen pending, auch über einen Reload hinweg.

## Bestehende Daten

Es ist keine Dexie- oder PocketBase-Schemamigration nötig: Feldversionen sind zusätzliche JSON-Eigenschaften. Ein bestehender Datensatz ohne Feldversionen erhält beim nächsten neuen Edit deterministische Basisversionen mit seinem bisherigen `version`-Zähler und leerer Geräte-ID; ein fehlendes `deletedAt` bleibt bei Zähler null.

Bereits persistierte alte Outbox-Requests und Receipts werden niemals umgeschrieben. Alte Requests funktionieren weiter gegen ebenfalls alte Records nach den bisherigen Basisrevisionsregeln. Hat ein anderes Gerät den Record bereits auf Feldversionen umgestellt, wird ein alter Request mit 409 angehalten und bleibt lokal erhalten. Eine automatische Übernahme solcher **gemischten alten/neuen Pending-Konflikte** ist nicht implementiert. Ebenso fehlen Konflikthistorie, manuelle Gewinnerwahl und Tombstone-/Receipt-Garbage-Collection.

## Nachweis

- `src/lib/domain/versions.test.ts` führt den tatsächlichen PocketBase-Merge-Helper aus: unterschiedliche/gleiche Felder, sechs Reihenfolgen von drei Edits, Idempotenz/Assoziativität, kausal nachfolgende Edits, Tombstones, ungültige Stamps, Legacy-Baselines, Listen sowie atomare lokale Speicherung mit Rollback.
- `src/lib/sync/pull.test.ts` prüft ACK-Untergrenze, fehlgeschlagenen Folge-Pull und v1/v2-Race mit Reload.
- `tests/pocketbase/conflicts.spec.ts` prüft zwei getrennte Chrome-Kontexte, echte Offline-Edits und Offline-Reloads. Unterschiedliche Felder, dasselbe Feld und Löschen gegen Bearbeiten laufen jeweils in beiden Verbindungsreihenfolgen. Anschließend werden die vollständigen Datensätze beider IndexedDBs mit PocketBase verglichen und erneut geladen. API-Tests prüfen Feldvalidierung, stabile Receipts, Legacy-Downgrade-Schutz und Listen.

Ausführen: `pnpm test`, `pnpm run check`, `pnpm run build`, `pnpm run test:pocketbase`. Ranking, Kalenderdaten und konkurrierende Offline-Moves sind umgesetzt, siehe [ranking.md](ranking.md).
