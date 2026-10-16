import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync, statSync, utimesSync } from "node:fs";
import { z } from "zod";
import { ensureFresh } from "../src/ingest/ingester.ts";
import { makeEnv, queryAll, queryOne, stubEmbed, type TestEnv } from "./helpers.ts";

const CountRowSchema = z.object({ n: z.number() });
const DeletedAtRowSchema = z.object({
  source_deleted_at: z.string().nullable(),
});
const TranscriptRowSchema = z.object({
  duration_ms: z.number(),
  raw_transcript: z.string().nullable(),
});
const FolderRowSchema = z.object({ folder_name: z.string() });

const MEETING_FOLDER = "1792189684";
const MEETING_ID = "meeting-stub-id";
const MEETING_START = "2026-10-16 22:28:04.000";
const MEETING_TRANSCRIPT = "Let us review the harbour migration plan.";

let env: TestEnv;

beforeEach(() => {
  env = makeEnv();
});

afterEach(() => {
  rmSync(env.workDir, { recursive: true, force: true });
});

function defaultOpts() {
  return {
    sourceDb: env.sourceDb,
    sourceDir: env.sourceDir,
    archive: env.archive,
    embedModel: "test-model",
    ollamaHost: "http://127.0.0.1:0",
    embedFn: stubEmbed,
  };
}

/** Super Whisper 3 inserts a meeting row the moment recording starts. */
function startMeetingInSource(): void {
  const sdb = new Database(env.sourceDb);
  try {
    sdb
      .prepare(
        `INSERT INTO recording (id, datetime, duration, modeName, rawWordCount, llmWordCount, folderName)
         VALUES (?, ?, 0, 'Meeting', 0, 0, ?)`,
      )
      .run(MEETING_ID, MEETING_START, MEETING_FOLDER);
  } finally {
    sdb.close();
  }
  touchSource();
}

/** ...and rewrites the same row in place when it stops, keeping `datetime`. */
function finishMeetingInSource(): void {
  const sdb = new Database(env.sourceDb);
  try {
    sdb
      .prepare(
        "UPDATE recording SET duration = 17185, rawWordCount = 7, llmWordCount = 7 WHERE folderName = ?",
      )
      .run(MEETING_FOLDER);
    sdb
      .prepare(
        "INSERT INTO recording_fts (recordingId, llmResult, rawResult, result) VALUES (?, '', ?, ?)",
      )
      .run(MEETING_ID, MEETING_TRANSCRIPT, MEETING_TRANSCRIPT);
  } finally {
    sdb.close();
  }
  touchSource();
}

function touchSource(): void {
  const later = new Date(Date.now() + 5_000);
  utimesSync(env.sourceDb, later, later);
}

function readArchivedMeeting(): z.infer<typeof TranscriptRowSchema> {
  const db = new Database(env.archive, { readonly: true });
  try {
    return queryOne(
      db,
      TranscriptRowSchema,
      "SELECT duration_ms, raw_transcript FROM recording WHERE folder_name = ?",
      MEETING_FOLDER,
    );
  } finally {
    db.close();
  }
}

function searchArchive(term: string): string[] {
  const db = new Database(env.archive, { readonly: true });
  try {
    return queryAll(
      db,
      FolderRowSchema,
      `SELECT r.folder_name FROM recording_fts
       JOIN recording r ON r.rowid = recording_fts.rowid
       WHERE recording_fts MATCH ?`,
      term,
    ).map((r) => r.folder_name);
  } finally {
    db.close();
  }
}

describe("ensureFresh", () => {
  test("first run ingests every source row", async () => {
    const r = await ensureFresh(defaultOpts());
    expect(r.fastPath).toBe(false);
    expect(r.newRows).toBeGreaterThanOrEqual(5);

    const db = new Database(env.archive, { readonly: true });
    try {
      const total = queryOne(db, CountRowSchema, "SELECT COUNT(*) AS n FROM recording");
      // 5 rows in source DB + 1 source row with no meta is still ingested.
      expect(total.n).toBe(6);
    } finally {
      db.close();
    }
  });

  test("second run hits the mtime fast path", async () => {
    await ensureFresh(defaultOpts());
    const r = await ensureFresh(defaultOpts());
    expect(r.fastPath).toBe(true);
    expect(r.embedded).toBe(0);
    expect(r.newRows).toBe(0);
  });

  test("source row removed -> source_deleted_at is set", async () => {
    await ensureFresh(defaultOpts());

    const sdb = new Database(env.sourceDb);
    sdb.exec("DELETE FROM recording WHERE folderName = '1779000400'");
    sdb.close();
    const now = new Date();
    utimesSync(env.sourceDb, now, now);

    rmSync(`${env.sourceDir}/recordings/1779000400`, {
      recursive: true,
      force: true,
    });

    const r = await ensureFresh(defaultOpts());
    expect(r.fastPath).toBe(false);
    expect(r.sourceDeletions).toBe(1);

    const db = new Database(env.archive, { readonly: true });
    try {
      const row = queryOne(
        db,
        DeletedAtRowSchema,
        "SELECT source_deleted_at FROM recording WHERE folder_name = ?",
        "1779000400",
      );
      expect(row.source_deleted_at).not.toBeNull();
    } finally {
      db.close();
    }
  });

  test("model switch wipes vec table and re-embeds", async () => {
    await ensureFresh({ ...defaultOpts(), embedModel: "model-A" });
    const now = new Date();
    utimesSync(env.sourceDb, now, now);

    const r = await ensureFresh({ ...defaultOpts(), embedModel: "model-B" });
    expect(r.modelSwitched).toBe(true);
    expect(r.embedded).toBeGreaterThanOrEqual(5);
  });

  test("skipEmbeddings keeps text but does not call embed", async () => {
    let calls = 0;
    const fn = async (texts: string[]) => {
      calls++;
      return stubEmbed(texts);
    };
    await ensureFresh({ ...defaultOpts(), embedFn: fn, skipEmbeddings: true });
    expect(calls).toBe(0);
    const db = new Database(env.archive, { readonly: true });
    try {
      const n = queryOne(db, CountRowSchema, "SELECT COUNT(*) AS n FROM recording");
      expect(n.n).toBeGreaterThanOrEqual(5);
    } finally {
      db.close();
    }
  });

  test("should pick up a meeting finalised in place after its in-progress stub was indexed", async () => {
    startMeetingInSource();
    await ensureFresh(defaultOpts());
    finishMeetingInSource();

    await ensureFresh(defaultOpts());

    expect(readArchivedMeeting()).toEqual({
      duration_ms: 17185,
      raw_transcript: MEETING_TRANSCRIPT,
    });
    expect(searchArchive("harbour")).toEqual([MEETING_FOLDER]);
  });

  test("should not re-ingest a repaired row on later syncs", async () => {
    startMeetingInSource();
    await ensureFresh(defaultOpts());
    finishMeetingInSource();
    await ensureFresh(defaultOpts());
    touchSource();

    const r = await ensureFresh(defaultOpts());

    expect(r.fastPath).toBe(false);
    expect(r.updatedRows).toBe(0);
  });

  test("should repair a meeting stub left stale by an earlier binary once upgraded", async () => {
    startMeetingInSource();
    await ensureFresh(defaultOpts());
    finishMeetingInSource();
    const adb = new Database(env.archive);
    try {
      const setConfig = adb.prepare("UPDATE config SET value = ? WHERE key = ?");
      setConfig.run(statSync(env.sourceDb, { bigint: true }).mtimeNs.toString(), "source_mtime_ns");
      setConfig.run("6", "data_version");
    } finally {
      adb.close();
    }

    await ensureFresh(defaultOpts());

    expect(readArchivedMeeting()).toEqual({
      duration_ms: 17185,
      raw_transcript: MEETING_TRANSCRIPT,
    });
  });
});
