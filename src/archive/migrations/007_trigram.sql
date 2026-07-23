-- Substring/fuzzy retrieval surface: trigram-tokenized FTS5 mirrors of the
-- two porter tables (recording_fts, recording_chunk_fts).
--
-- Why: the porter unicode61 tokenizer matches whole tokens (with `*` prefix
-- and NEAR/phrase support) but cannot do infix/substring search — `MATCH
-- 'icing'` won't find "pricing", and glued identifiers like `mybullmq` are
-- invisible to a token-boundary tokenizer. The `trigram` tokenizer (built
-- into SQLite >= 3.34) indexes every 3-character window, so `MATCH 'icing'`
-- finds "pricing", `x LIKE '%icing%'` uses the index, and light typos
-- ("notifcations" vs "notifications") recall via shared trigrams. It does
-- NOT stem ("notification" != "notifications" as tokens), so the porter
-- tables stay — trigram is a complement, not a replacement.
--
-- Cost: trigram indexes are ~3x larger and somewhat slower to query than
-- porter unicode61; a non-issue at personal-archive scale. Queries shorter
-- than 3 characters return nothing (no 3-char window to match).
--
-- Both tables are external-content FTS5 keyed to the same rowid as the
-- porter mirrors, so recipes JOIN on the same rowid as recording_fts /
-- recording_chunk_fts. Sync is trigger-driven (mirrors 004/006); the
-- ingester needs no changes. recording is append-only (BEFORE DELETE
-- ABORT), so recording_trgm has no AFTER DELETE trigger; recording_chunk
-- IS deleted on rechunk, so it gets one (mirrors recording_chunk_ad).

CREATE VIRTUAL TABLE IF NOT EXISTS recording_trgm USING fts5(
  folder_name UNINDEXED,
  raw_transcript,
  processed_transcript,
  content='recording',
  content_rowid='rowid',
  tokenize="trigram remove_diacritics 2"
);

INSERT INTO recording_trgm(recording_trgm) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS recording_trgm_ai AFTER INSERT ON recording BEGIN
  INSERT INTO recording_trgm(rowid, folder_name, raw_transcript, processed_transcript)
  VALUES (new.rowid, new.folder_name, new.raw_transcript, new.processed_transcript);
END;

CREATE TRIGGER IF NOT EXISTS recording_trgm_au
AFTER UPDATE OF raw_result, result, folder_name
ON recording
BEGIN
  INSERT INTO recording_trgm(recording_trgm, rowid, folder_name, raw_transcript, processed_transcript)
  VALUES ('delete', old.rowid, old.folder_name, old.raw_transcript, old.processed_transcript);
  INSERT INTO recording_trgm(rowid, folder_name, raw_transcript, processed_transcript)
  VALUES (new.rowid, new.folder_name, new.raw_transcript, new.processed_transcript);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS recording_chunk_trgm USING fts5(
  folder_name UNINDEXED,
  text,
  content='recording_chunk',
  content_rowid='id',
  tokenize="trigram remove_diacritics 2"
);

INSERT INTO recording_chunk_trgm(recording_chunk_trgm) VALUES ('rebuild');

CREATE TRIGGER IF NOT EXISTS recording_chunk_trgm_ai
AFTER INSERT ON recording_chunk
BEGIN
  INSERT INTO recording_chunk_trgm(rowid, folder_name, text)
  VALUES (new.id, new.folder_name, new.text);
END;

CREATE TRIGGER IF NOT EXISTS recording_chunk_trgm_au
AFTER UPDATE OF text ON recording_chunk
BEGIN
  INSERT INTO recording_chunk_trgm(recording_chunk_trgm, rowid, folder_name, text)
  VALUES ('delete', old.id, old.folder_name, old.text);
  INSERT INTO recording_chunk_trgm(rowid, folder_name, text)
  VALUES (new.id, new.folder_name, new.text);
END;

CREATE TRIGGER IF NOT EXISTS recording_chunk_trgm_ad
AFTER DELETE ON recording_chunk
BEGIN
  INSERT INTO recording_chunk_trgm(recording_chunk_trgm, rowid, folder_name, text)
  VALUES ('delete', old.id, old.folder_name, old.text);
END;
