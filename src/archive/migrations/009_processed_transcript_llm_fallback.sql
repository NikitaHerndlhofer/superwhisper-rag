-- v1.4.0: `processed_transcript` falls back to `llm_result`.
--
-- Migration 006 derived `processed_transcript` from `result` alone,
-- assuming SW always mirrors its LLM output there. Super Whisper 3
-- meeting modes broke that: they leave `result` equal to `raw_result`
-- and write the meeting summary (notes, decisions, action items) only to
-- `llm_result`. Those rows got a NULL `processed_transcript`, so the
-- summary was invisible to every canonical column and to both keyword
-- indexes, even though the embedder (`chunkSourceBody`) already
-- prefers `llm_result` and was vectorising it.
--
-- New derivation: `result` when it differs from raw (unchanged
-- precedence), else `llm_result` when it is non-blank and differs from
-- raw, else NULL.
--
-- SQLite cannot alter a generated column's expression, so the two
-- derived columns are dropped and re-added. DROP COLUMN refuses columns
-- referenced by triggers or views, so every dependant is dropped first
-- and recreated afterwards: the FTS sync triggers, both external-content
-- FTS tables (rebuilt so already-archived summaries get indexed), and
-- `v_search`. The UPDATE OF lists gain `llm_result`, which now feeds
-- the index — SW3 rewrites `llm_result` in place when a meeting summary
-- lands after the recording was first ingested.

DROP TRIGGER IF EXISTS recording_ai;
DROP TRIGGER IF EXISTS recording_au;
DROP TRIGGER IF EXISTS recording_trgm_ai;
DROP TRIGGER IF EXISTS recording_trgm_au;
DROP VIEW IF EXISTS v_search;
DROP TABLE IF EXISTS recording_fts;
DROP TABLE IF EXISTS recording_trgm;

ALTER TABLE recording DROP COLUMN processed_word_count;
ALTER TABLE recording DROP COLUMN processed_transcript;

ALTER TABLE recording ADD COLUMN processed_transcript TEXT GENERATED ALWAYS AS (
  CASE
    WHEN result IS NOT NULL
     AND result != ''
     AND result != raw_result
    THEN result
    WHEN llm_result IS NOT NULL
     AND trim(llm_result) != ''
     AND llm_result != raw_result
    THEN llm_result
    ELSE NULL
  END
) VIRTUAL;

ALTER TABLE recording ADD COLUMN processed_word_count INTEGER GENERATED ALWAYS AS (
  CASE
    WHEN processed_transcript IS NULL THEN 0
    ELSE (length(trim(processed_transcript))
          - length(replace(trim(processed_transcript), ' ', ''))) + 1
  END
) VIRTUAL;

CREATE VIRTUAL TABLE recording_fts USING fts5(
  folder_name UNINDEXED,
  raw_transcript,
  processed_transcript,
  content='recording', content_rowid='rowid',
  tokenize="porter unicode61 remove_diacritics 2"
);

INSERT INTO recording_fts(recording_fts) VALUES ('rebuild');

CREATE VIRTUAL TABLE recording_trgm USING fts5(
  folder_name UNINDEXED,
  raw_transcript,
  processed_transcript,
  content='recording',
  content_rowid='rowid',
  tokenize="trigram remove_diacritics 2"
);

INSERT INTO recording_trgm(recording_trgm) VALUES ('rebuild');

CREATE TRIGGER recording_ai AFTER INSERT ON recording BEGIN
  INSERT INTO recording_fts(rowid, folder_name, raw_transcript, processed_transcript)
  VALUES (new.rowid, new.folder_name, new.raw_transcript, new.processed_transcript);
END;

CREATE TRIGGER recording_au
AFTER UPDATE OF raw_result, result, llm_result, folder_name
ON recording
BEGIN
  INSERT INTO recording_fts(recording_fts, rowid, folder_name, raw_transcript, processed_transcript)
  VALUES ('delete', old.rowid, old.folder_name, old.raw_transcript, old.processed_transcript);
  INSERT INTO recording_fts(rowid, folder_name, raw_transcript, processed_transcript)
  VALUES (new.rowid, new.folder_name, new.raw_transcript, new.processed_transcript);
END;

CREATE TRIGGER recording_trgm_ai AFTER INSERT ON recording BEGIN
  INSERT INTO recording_trgm(rowid, folder_name, raw_transcript, processed_transcript)
  VALUES (new.rowid, new.folder_name, new.raw_transcript, new.processed_transcript);
END;

CREATE TRIGGER recording_trgm_au
AFTER UPDATE OF raw_result, result, llm_result, folder_name
ON recording
BEGIN
  INSERT INTO recording_trgm(recording_trgm, rowid, folder_name, raw_transcript, processed_transcript)
  VALUES ('delete', old.rowid, old.folder_name, old.raw_transcript, old.processed_transcript);
  INSERT INTO recording_trgm(rowid, folder_name, raw_transcript, processed_transcript)
  VALUES (new.rowid, new.folder_name, new.raw_transcript, new.processed_transcript);
END;

CREATE VIEW v_search AS
  SELECT r.*, recording_fts.rowid AS fts_rowid
  FROM recording r JOIN recording_fts ON r.rowid = recording_fts.rowid;
