import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import { verbose, warn } from "../log.ts";
import { MetaJsonSchema, SourceRecordingSchema, type SourceRecording } from "../schemas.ts";

export type { SourceRecording };

const FingerprintRowSchema = z.object({
  folderName: z.string(),
  durationMs: z.number().nullable(),
  rawWordCount: z.number().nullable(),
  llmWordCount: z.number().nullable(),
});

export type SourceFingerprint = Omit<z.infer<typeof FingerprintRowSchema>, "folderName">;

/**
 * Real Super Whisper schema (verified against v3.x DB on disk).
 *
 *   recording(
 *     id TEXT PK,                 -- uuid-style; NOT a blob, despite older notes
 *     datetime DATETIME,          -- recording (or reprocess) timestamp
 *     duration DOUBLE,            -- ms; PRESERVED across reprocessings
 *     appVersion TEXT,
 *     modelKey TEXT,
 *     modelName TEXT,
 *     languageModelName TEXT,
 *     recordingDevice TEXT,
 *     rawWordCount INTEGER,
 *     llmWordCount INTEGER,
 *     prompt TEXT,                -- the LLM system prompt; large
 *     processingTime INTEGER,
 *     languageModelProcessingTime INTEGER,
 *     modeName TEXT,
 *     promptContext TEXT,         -- JSON; overlaps with meta.json
 *     folderName TEXT,
 *     fromFile BOOLEAN,
 *     createdAt DATETIME,         -- row insertion time
 *     languageModelKey TEXT
 *   )
 *   recording_fts(recordingId, llmResult, rawResult, result)
 *
 * The transcripts live in the FTS virtual table — we LEFT JOIN to bring
 * them onto the row. `hex(r.id)` produces a stable string regardless of
 * whether `id` is stored as TEXT or BLOB (SQLite duck-typing), so the
 * rest of the pipeline can treat the row's PK as a hex string.
 *
 * Columns we deliberately don't read: `appVersion`, `prompt`,
 * `promptContext`, `processingTime`, `languageModelProcessingTime`,
 * `fromFile`, `createdAt`. None of them surfaces in the cookbook today
 * and `prompt` in particular is large. Add them only when a concrete
 * query needs them — same rule as everywhere else in this project.
 *
 * Note on reprocessings: Super Whisper does NOT provide any
 * back-reference (no parentId, no audioHash, no recordingGroupId)
 * linking a reprocess to its original. `datetime`, `folderName`, and
 * `id` are all reset; `duration` is the only field that survives. We
 * recover the linkage by SHA-1 hashing `output.wav` ourselves — see
 * `hashNewAudioFiles` in `ingester.ts` and migration 002.
 */
const SELECT_ROWS = `
SELECT
  r.folderName,
  hex(r.id)     AS recordingIdHex,
  r.datetime,
  r.duration    AS durationMs,
  r.modeName,
  r.modelKey,
  r.modelName,
  r.languageModelKey,
  r.languageModelName,
  r.recordingDevice,
  r.rawWordCount,
  r.llmWordCount,
  fts.result,
  fts.llmResult,
  fts.rawResult
FROM recording r
LEFT JOIN recording_fts fts ON fts.recordingId = r.id
`;

/**
 * Open a Super Whisper SQLite file read-only and return rows newer than
 * `sinceDatetime` (ISO8601). Pass `null` to read everything.
 *
 * The WHERE clause normalises both sides through SQLite's `datetime()`
 * function so we don't depend on the two strings sharing a separator
 * shape. Super Whisper has historically written `r.datetime` as
 * `"2025-05-18 23:18:42"` (space separator, no `Z`); our own
 * `last_indexed_datetime` is a copy of that same value, so they match
 * char-for-char today. But the same column has occasionally landed as
 * `"2025-05-18T23:18:42.345Z"` after a Super Whisper migration, and a
 * raw `>` comparison silently picks the lexicographically wrong row in
 * those cases (`T` > space → every existing row looks "older" than the
 * bookmark and bulk ingest stalls). `datetime()` parses every ISO8601
 * shape SQLite supports and returns the canonical
 * `YYYY-MM-DD HH:MM:SS` form for comparison, so the predicate is
 * stable under either format.
 */
export function readSourceRecordings(
  path: string,
  sinceDatetime: string | null,
): SourceRecording[] {
  if (!existsSync(path)) {
    throw new Error(`source DB not found: ${path}`);
  }
  const db = new Database(path, { readonly: true });
  try {
    const sql =
      sinceDatetime != null
        ? `${SELECT_ROWS} WHERE datetime(r.datetime) > datetime(?) ORDER BY r.datetime ASC`
        : `${SELECT_ROWS} ORDER BY r.datetime ASC`;
    const stmt = db.prepare(sql);
    const raw: unknown[] = sinceDatetime != null ? stmt.all(sinceDatetime) : stmt.all();
    return raw.map((r) => SourceRecordingSchema.parse(r));
  } finally {
    db.close();
  }
}

/** Read the given folders' rows regardless of the `datetime` bookmark. */
export function readSourceRecordingsByFolder(
  path: string,
  folderNames: readonly string[],
): SourceRecording[] {
  if (folderNames.length === 0) return [];
  const db = new Database(path, { readonly: true });
  try {
    const placeholders = folderNames.map(() => "?").join(", ");
    const raw: unknown[] = db
      .prepare(`${SELECT_ROWS} WHERE r.folderName IN (${placeholders}) ORDER BY r.datetime ASC`)
      .all(...folderNames);
    return raw.map((r) => SourceRecordingSchema.parse(r));
  } finally {
    db.close();
  }
}

/**
 * Every source row's folder name plus the columns that change when Super
 * Whisper rewrites a row in place. Super Whisper 3 inserts a meeting row
 * the moment recording starts (duration 0, no transcript) and fills it in
 * when recording stops without moving `datetime`, so the bookmark alone
 * never revisits it.
 */
export function readSourceFingerprints(path: string): Map<string, SourceFingerprint> {
  const out = new Map<string, SourceFingerprint>();
  if (!existsSync(path)) return out;
  const db = new Database(path, { readonly: true });
  try {
    const rows: unknown[] = db
      .prepare(
        "SELECT folderName, duration AS durationMs, rawWordCount, llmWordCount FROM recording",
      )
      .all();
    for (const r of rows) {
      const parsed = FingerprintRowSchema.safeParse(r);
      if (!parsed.success) continue;
      const { folderName, ...fingerprint } = parsed.data;
      out.set(folderName, fingerprint);
    }
    return out;
  } finally {
    db.close();
  }
}

export interface MetaContext {
  metaPath: string;
  audioPath: string | null;
  hasAudio: boolean;
  language: string | null;
  appName: string | null;
  appCategory: string | null;
  /** The raw, validated meta.json payload, used by `swrag show --include all`. */
  raw: Record<string, unknown> | null;
}

/**
 * Look up the `meta.json` for a recording inside the user's recordings dir
 * and return the fields we care about for ingestion. Missing folder, unreadable
 * file, or malformed JSON returns a stub with `raw: null` and a warning.
 */
export async function readMetaContext(
  recordingsDir: string,
  folderName: string,
): Promise<MetaContext> {
  const folder = join(recordingsDir, folderName);
  const metaPath = join(folder, "meta.json");
  const audioPath = join(folder, "output.wav");
  const hasAudio = existsSync(audioPath);
  const ctx: MetaContext = {
    metaPath,
    audioPath: hasAudio ? audioPath : null,
    hasAudio,
    language: null,
    appName: null,
    appCategory: null,
    raw: null,
  };
  if (!existsSync(metaPath)) {
    verbose(`meta.json missing for ${folderName}`);
    return ctx;
  }
  try {
    const text = await readFile(metaPath, "utf8");
    const json: unknown = JSON.parse(text);
    const parsed = MetaJsonSchema.parse(json);
    ctx.raw = parsed;
    const pc = parsed.promptContext;
    if (pc) {
      ctx.language = pc.modeContext?.language ?? null;
      ctx.appName = pc.applicationContext?.name ?? null;
      ctx.appCategory = pc.applicationContext?.category ?? null;
    }
  } catch (e) {
    warn(`meta.json unreadable for ${folderName}: ${errorMessage(e)}`);
  }
  return ctx;
}

/** mtime of the source DB file in ns precision (or null if missing). */
export function sourceDbMtimeNs(path: string): bigint | null {
  if (!existsSync(path)) return null;
  const s = statSync(path, { bigint: true });
  return s.mtimeNs;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
