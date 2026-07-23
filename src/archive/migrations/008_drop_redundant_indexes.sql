-- Drop two redundant indexes.
--
-- idx_recording_datetime: indexes the raw `datetime` column, but the only
--   production query on it (the incremental-ingest bookmark in
--   ingest/sources.ts) wraps the column in `datetime()`, which makes any
--   index unusable. Every cookbook recipe sorts/filters on the normalized
--   `datetime_iso` instead (idx_recording_datetime_iso). The raw-datetime
--   index is dead weight.
--
-- idx_recording_chunk_folder: a plain `folder_name` index on
--   recording_chunk, but the table's `UNIQUE (folder_name, chunk_idx)`
--   constraint already creates a composite auto-index whose leftmost
--   column is `folder_name` — so it serves every `WHERE folder_name = ?`
--   (and the `ORDER BY chunk_idx` cases too). The standalone index is
--   redundant.
--
-- Idempotent: DROP INDEX IF EXISTS.

DROP INDEX IF EXISTS idx_recording_datetime;
DROP INDEX IF EXISTS idx_recording_chunk_folder;
