/**
 * v1.3.2 resync marker.
 *
 * Binaries before v1.3.2 only revisited source rows newer than the
 * `datetime` bookmark, so a Super Whisper 3 meeting indexed while still
 * recording stayed frozen as an empty stub. `ensureFresh` now re-reads
 * any archived row whose source fingerprint has drifted, but only on the
 * slow path. A pending updater forces that slow path, so this empty
 * updater repairs already-stale archives on the first run after upgrade
 * instead of waiting for the next source DB change.
 */
import type { Database } from "bun:sqlite";
import type { IngestOptions } from "../../ingest/ingester.ts";

export async function resyncRewrittenRows(_archive: Database, _opts: IngestOptions): Promise<void> {
  // Intentionally empty. See module docstring.
}
