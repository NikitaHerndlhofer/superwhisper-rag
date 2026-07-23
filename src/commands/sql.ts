import { ensureFresh } from "../ingest/ingester.ts";
import { warn } from "../log.ts";
import { execSqlite3Interactive, runSqlite3, type Sqlite3Result } from "../sqlite3.ts";
import { readAllStdin } from "../stdin.ts";

/**
 * Run a SQL query against the archive by exec'ing the sqlite3 CLI.
 *
 * This is a deliberately thin passthrough. We do exactly four things:
 *
 *   1. mtime-fast-path ingest from Super Whisper (sub-ms when nothing
 *      changed). A hard failure here downgrades to a `warn()` so the
 *      query still runs against whatever the archive already has.
 *   2. Open the archive read-only via `file:…?mode=ro`.
 *   3. `-cmd ".load <vec0_path> sqlite3_vec_init"` so vector search works.
 *   4. Hand the user's SQL to sqlite3 and forward its stdout/stderr/exit.
 *
 * Output is sqlite3's default (list mode, pipe-separated, no header). For
 * any other mode, two routes are available:
 *
 *   a. `swrag sql -- <args>` passthrough — `<args>` is forwarded to sqlite3
 *      verbatim, e.g. `swrag sql -- -json "SELECT 1"`. See `extraArgs`.
 *   b. Drive sqlite3 directly:
 *      `sqlite3 "$(swrag path)" -cmd ".load $(swrag path vec0) sqlite3_vec_init" …`
 *
 * For semantic search, compose with `swrag embed`:
 *
 *   swrag sql "SELECT folder_name
 *              FROM recording_vec
 *              ORDER BY vec_distance_cosine(embedding, $(swrag embed 'hello'))
 *              LIMIT 5"
 */
export interface RunSqlOptions {
  /** SQL to execute. `null` or empty drops into the sqlite3 REPL. */
  sql: string | null;
  archive: string;
  sourceDb: string;
  sourceDir: string;
  embedModel: string;
  ollamaHost: string;
  /**
   * Verbatim sqlite3 args forwarded after our setup flags. Populated when
   * the user wrote `swrag sql -- <stuff>` — `<stuff>` lands here and we
   * pass it to sqlite3 untouched.
   */
  extraArgs?: string[];
}

/** Read SQL from stdin or use the inline argument. */
export async function readSqlInput(
  inline: string | null,
  fromStdin: boolean,
): Promise<string | null> {
  if (fromStdin) {
    return readAllStdin();
  }
  return inline;
}

export async function runSql(opts: RunSqlOptions): Promise<Sqlite3Result> {
  try {
    await ensureFresh({
      sourceDb: opts.sourceDb,
      sourceDir: opts.sourceDir,
      archive: opts.archive,
      embedModel: opts.embedModel,
      ollamaHost: opts.ollamaHost,
    });
  } catch (e) {
    // Surface the failure but still run the query against whatever data
    // the archive already has. Silent staleness here is a worse failure
    // mode than a one-line warning.
    warn(`pre-query ingest failed, archive may be stale: ${errorMessage(e)}`);
  }

  const extra = opts.extraArgs ?? [];
  const trimmed = (opts.sql ?? "").trim();

  // Passthrough mode: the user wrote `swrag sql -- <args>`. `<args>` may
  // carry sqlite3 flags and/or the SQL itself. When the caller also hands
  // us SQL (the `swrag sql - -- -json` shape — SQL via stdin, flags via the
  // tail), we keep both: `buildArgs` appends `sql` after `extraArgs`,
  // which is the sqlite3-correct order (DATABASE, flags, SQL).
  if (extra.length > 0) {
    return runSqlite3({
      archive: opts.archive,
      sql: trimmed.length > 0 ? trimmed : null,
      readonly: true,
      extraArgs: extra,
    });
  }

  if (trimmed.length === 0) {
    const code = execSqlite3Interactive({
      archive: opts.archive,
      sql: null,
      readonly: true,
    });
    return { exitCode: code, stdout: "", stderr: "" };
  }

  return runSqlite3({
    archive: opts.archive,
    sql: trimmed,
    readonly: true,
  });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
