---
name: superwhisper-rag
description: Query the user's local Super Whisper dictation archive (SQLite + bge-m3 embeddings).
disable-model-invocation: true
---

# superwhisper-rag

Query the local Super Whisper dictation archive at
`~/Library/Application Support/superwhisper-rag/swrag.sqlite`. Append-only
(survives Super Whisper's retention deletions); `swrag sql` opens it
read-only. `swrag` is a thin `sqlite3` wrapper with `vec0` preloaded. Output
is sqlite3 list mode (pipe-separated, no header).

## Input

Pipe SQL via stdin:

```bash
swrag sql <<'SQL'
SELECT folder_name, datetime_iso FROM recording
WHERE superseded_by IS NULL ORDER BY datetime_iso DESC LIMIT 5;
SQL

# Or a pipe:        echo "SELECT folder_name FROM recording LIMIT 5" | swrag sql
# Or a file:        swrag sql < query.sql
# Forward sqlite3 flags (e.g. JSON):  echo "…" | swrag sql -- -json
```

## Semantic search

No in-SQL `embed()`. `swrag embed` reads text from stdin and prints a SQLite
blob literal (`x'…'`). Inline it with command substitution:

```bash
swrag sql <<SQL
SELECT r.folder_name, vec_distance_cosine(v.embedding, $(echo 'how do notifications work' | swrag embed)) AS dist
FROM recording_vec v JOIN recording r USING (folder_name)
WHERE r.superseded_by IS NULL ORDER BY dist LIMIT 10
SQL
```

For text with apostrophes, quotes, `$`, or backticks, embed via a quoted
heredoc and interpolate the blob variable:

```bash
QV=$(swrag embed <<'EOF'
how do notifications work when I say "don't"
EOF
)
swrag sql <<SQL
SELECT r.folder_name, vec_distance_cosine(v.embedding, $QV) AS dist
FROM recording_vec v JOIN recording r USING (folder_name)
WHERE r.superseded_by IS NULL ORDER BY dist LIMIT 10
SQL
```

## Schema

- `recording` — one row per dictation (append-only). `folder_name` (PK),
  `datetime_iso` (indexed — sort/filter on this, NOT raw `datetime`),
  `mode_name`/`mode_name_lower` (indexed), `app_name`, `language`,
  `duration_sec`, `raw_word_count`, `processed_word_count`.
  - Transcripts: `raw_transcript` (STT, always present), `processed_transcript`
    (LLM, NULL if no LLM). Use `COALESCE(processed_transcript, raw_transcript)`.
  - `superseded_by` points at a newer reprocessing row. **Always filter
    `WHERE superseded_by IS NULL`** unless the user asks for reprocessing history.
  - `source_deleted_at`/`source_audio_lost_at` — preservation markers.
    `audio_hash` groups reprocessings of the same audio.
- `recording_fts` — FTS5 over both transcript columns. `MATCH`, `snippet()`, `bm25()`.
- `recording_trgm` — FTS5 trigram mirror of `recording_fts` (same rowid). Substring/
  infix + light fuzzy: `MATCH 'icing'` finds "pricing"; accelerates `LIKE '%s%'`.
  No stemming (use `recording_fts`); needs ≥3 chars.
- `recording_vec` — vec0, 1024-d bge-m3. `vec_distance_cosine(...)`. For long
  recordings this row is the L2-normalized centroid of its chunks (coarse filtering).
- `recording_chunk` — ~300-word chunks of long recordings (word count > 500).
  `id` (PK), `folder_name`, `chunk_idx`, `text`.
- `recording_chunk_vec` — vec0 keyed by `chunk_id` (= `recording_chunk.id`).
  **PK column is `chunk_id`, not `rowid`.**
- `recording_chunk_fts` — FTS5 over chunk text. Join via
  `recording_chunk_fts.rowid = recording_chunk.id`.
- `recording_chunk_trgm` — FTS5 trigram mirror of `recording_chunk_fts` (same rowid).

## Search variants

Always `WHERE r.superseded_by IS NULL` on the recording side of any join. Add
an explicit `LIMIT` — output fills the context window.

```sql
-- modes — Discover the user's modes first (modes are user-configurable).
SELECT mode_name, COUNT(*) AS n FROM recording
WHERE superseded_by IS NULL GROUP BY mode_name ORDER BY n DESC;

-- today — Today's recordings.
SELECT folder_name, datetime_iso, mode_name,
       COALESCE(processed_transcript, raw_transcript) AS transcript
FROM recording
WHERE superseded_by IS NULL AND date(datetime_iso)=date('now','localtime')
ORDER BY datetime_iso DESC;

-- mode-recent — Last 7 days of a mode (replace 'meeting' with what `modes` surfaced).
SELECT folder_name, datetime_iso, duration_sec,
       COALESCE(processed_transcript, raw_transcript) AS transcript
FROM recording
WHERE superseded_by IS NULL AND mode_name_lower='meeting'
  AND datetime_iso >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
ORDER BY datetime_iso DESC;

-- keyword — Keyword search (FTS5, whole-row). snippet() auto-selects the matched column.
SELECT r.folder_name, r.datetime_iso,
       snippet(recording_fts,-1,'«','»','…',10) AS snip, bm25(recording_fts) AS bm25
FROM recording_fts JOIN recording r ON r.rowid=recording_fts.rowid
WHERE recording_fts MATCH 'bullmq' AND r.superseded_by IS NULL
ORDER BY bm25 LIMIT 10;
-- MATCH: 'bullmq', '"corporate group"', 'notif*', 'bull NEAR queue'

-- semantic — Semantic search (whole-row). Inline $(echo '…' | swrag embed), or $QV for special chars.
SELECT r.folder_name, r.datetime_iso,
       COALESCE(r.processed_transcript, r.raw_transcript) AS transcript,
       vec_distance_cosine(v.embedding, $(echo 'how do notifications work' | swrag embed)) AS dist
FROM recording_vec v JOIN recording r USING (folder_name)
WHERE r.superseded_by IS NULL ORDER BY dist LIMIT 10;

-- semantic-filtered — Semantic + structured filter.
SELECT r.folder_name, r.datetime_iso, r.app_name,
       vec_distance_cosine(v.embedding, $(echo 'how do notifications work' | swrag embed)) AS dist
FROM recording_vec v JOIN recording r USING (folder_name)
WHERE r.superseded_by IS NULL AND r.app_name='Cursor' AND r.mode_name_lower='universal'
ORDER BY dist LIMIT 10;
```

```sql
-- hybrid — Hybrid (keyword + semantic), whole-row, RRF k=60.
--    Q="notifications"; QV=$(echo "$Q" | swrag embed); swrag sql <<SQL
WITH kw AS (SELECT recording_fts.rowid AS rid,
                   ROW_NUMBER() OVER (ORDER BY bm25(recording_fts)) AS r
            FROM recording_fts WHERE recording_fts MATCH '$Q' LIMIT 50),
     vec AS (SELECT folder_name,
                   ROW_NUMBER() OVER (ORDER BY vec_distance_cosine(embedding,$QV)) AS r
            FROM recording_vec LIMIT 50)
SELECT r.folder_name, r.datetime_iso,
       COALESCE(r.processed_transcript, r.raw_transcript) AS transcript,
       COALESCE(1.0/(60+kw.r),0)+COALESCE(1.0/(60+vec.r),0) AS rrf
FROM recording r
LEFT JOIN kw  ON kw.rid=r.rowid
LEFT JOIN vec USING (folder_name)
WHERE r.superseded_by IS NULL AND (kw.r IS NOT NULL OR vec.r IS NOT NULL)
ORDER BY rrf DESC LIMIT 10
-- SQL

-- best-moment — Best moment per long recording + full transcript (canonical long-form RAG).
WITH ranked AS (SELECT chunk_id,
                       vec_distance_cosine(embedding, $(echo 'how do notifications work' | swrag embed)) AS dist
                FROM recording_chunk_vec ORDER BY dist LIMIT 50),
     best AS (SELECT c.folder_name, c.id AS chunk_id, c.chunk_idx, c.text, ranked.dist,
                     ROW_NUMBER() OVER (PARTITION BY c.folder_name ORDER BY ranked.dist) AS rn
              FROM ranked JOIN recording_chunk c ON c.id=ranked.chunk_id)
SELECT r.folder_name, r.datetime_iso, r.mode_name, best.chunk_idx AS hit_idx,
       best.text AS hit_chunk,
       COALESCE(r.processed_transcript, r.raw_transcript) AS full_transcript, best.dist
FROM best JOIN recording r USING (folder_name)
WHERE best.rn=1 AND r.superseded_by IS NULL ORDER BY best.dist LIMIT 5;

-- chunk-neighbors — Chunk + immediate neighbors (lighter context than `best-moment`).
WITH hit AS (SELECT c.folder_name, c.chunk_idx,
                     vec_distance_cosine(v.embedding, $(echo 'how do notifications work' | swrag embed)) AS dist
              FROM recording_chunk_vec v JOIN recording_chunk c ON c.id=v.chunk_id
              JOIN recording r ON r.folder_name=c.folder_name
              WHERE r.superseded_by IS NULL ORDER BY dist LIMIT 1)
SELECT c.folder_name, c.chunk_idx, c.text
FROM hit, recording_chunk c
WHERE c.folder_name=hit.folder_name
  AND c.chunk_idx BETWEEN hit.chunk_idx-1 AND hit.chunk_idx+1
ORDER BY c.chunk_idx;

-- keyword-chunk — Keyword search (FTS5, chunk-level) — sharper bm25 than whole-row.
SELECT r.folder_name, r.datetime_iso, c.chunk_idx,
       snippet(recording_chunk_fts,1,'«','»','…',10) AS snip, bm25(recording_chunk_fts) AS bm25
FROM recording_chunk_fts JOIN recording_chunk c ON c.id=recording_chunk_fts.rowid
JOIN recording r ON r.folder_name=c.folder_name
WHERE recording_chunk_fts MATCH 'pricing' AND r.superseded_by IS NULL
ORDER BY bm25 LIMIT 20;
```

```sql
-- hybrid-chunk — Hybrid (chunk-level) — usually beats either alone for long-form.
--     Same shell pattern as `hybrid`: Q="pricing"; QV=$(echo "$Q" | swrag embed); swrag sql <<SQL
WITH kw AS (SELECT recording_chunk_fts.rowid AS chunk_id,
                   ROW_NUMBER() OVER (ORDER BY bm25(recording_chunk_fts)) AS r
            FROM recording_chunk_fts WHERE recording_chunk_fts MATCH '$Q' LIMIT 50),
     vec AS (SELECT chunk_id,
                   ROW_NUMBER() OVER (ORDER BY vec_distance_cosine(embedding,$QV)) AS r
            FROM recording_chunk_vec LIMIT 50)
SELECT r.folder_name, r.datetime_iso, c.chunk_idx, c.text,
       COALESCE(1.0/(60+kw.r),0)+COALESCE(1.0/(60+vec.r),0) AS rrf
FROM recording_chunk c JOIN recording r ON r.folder_name=c.folder_name
LEFT JOIN kw  ON kw.chunk_id=c.id
LEFT JOIN vec ON vec.chunk_id=c.id
WHERE r.superseded_by IS NULL AND (kw.r IS NOT NULL OR vec.r IS NOT NULL)
ORDER BY rrf DESC LIMIT 10
-- SQL

-- filter-then-retrieve — Filter-then-retrieve (chunk): "in <mode>/<date range>, find the moment."
WITH eligible AS (SELECT c.id AS chunk_id, c.folder_name, c.chunk_idx, c.text
                  FROM recording_chunk c JOIN recording r ON r.folder_name=c.folder_name
                  WHERE r.superseded_by IS NULL AND r.mode_name_lower='meeting'
                    AND r.datetime_iso >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days'))
SELECT e.folder_name, e.chunk_idx, e.text,
       vec_distance_cosine(v.embedding, $(echo 'pricing tier discussion' | swrag embed)) AS dist
FROM recording_chunk_vec v JOIN eligible e ON e.chunk_id=v.chunk_id
ORDER BY dist LIMIT 10;

-- rank-recordings — Rank RECORDINGS by best-chunk match (short rows fall back to row-level vec).
WITH q AS (SELECT $(echo 'how do notifications work' | swrag embed) AS qv),
     chunk_best AS (SELECT c.folder_name, MIN(vec_distance_cosine(v.embedding,q.qv)) AS dist
                    FROM recording_chunk c JOIN recording_chunk_vec v ON v.chunk_id=c.id, q
                    GROUP BY c.folder_name),
     short_direct AS (SELECT v.folder_name, vec_distance_cosine(v.embedding,q.qv) AS dist
                      FROM recording_vec v, q
                      WHERE NOT EXISTS (SELECT 1 FROM recording_chunk c WHERE c.folder_name=v.folder_name))
SELECT r.folder_name, ROUND(d.dist,3) AS best_dist, r.mode_name,
       ROUND(r.duration_sec/60.0,1) AS min,
       CASE WHEN EXISTS (SELECT 1 FROM recording_chunk c WHERE c.folder_name=r.folder_name)
            THEN 'chunk' ELSE 'row' END AS via
FROM (SELECT * FROM chunk_best UNION ALL SELECT * FROM short_direct) d
JOIN recording r ON r.folder_name=d.folder_name
WHERE r.superseded_by IS NULL ORDER BY d.dist LIMIT 10;

-- reprocess-history — Reprocessing history of a recording (only when asked).
SELECT folder_name, datetime_iso, mode_name, superseded_by, superseded_at
FROM recording
WHERE audio_hash=(SELECT audio_hash FROM recording WHERE folder_name='1779143179')
ORDER BY datetime_iso;
```

```sql
-- trigram — Substring / light-fuzzy (trigram, whole-row). For infixes ('icing' in
--     'pricing'), glued identifiers, or typos — the porter tokenizer (`keyword`) can't
--     match these. Needs >=3 chars; no stemming ('notification' != 'notifications').
SELECT r.folder_name, r.datetime_iso,
       snippet(recording_trgm,-1,'«','»','…',10) AS snip, bm25(recording_trgm) AS bm25
FROM recording_trgm JOIN recording r ON r.rowid=recording_trgm.rowid
WHERE recording_trgm MATCH 'icing' AND r.superseded_by IS NULL
ORDER BY bm25 LIMIT 10;
-- Trigram also accelerates LIKE: WHERE raw_transcript LIKE '%icing%' uses the index.

-- trigram-chunk — Substring / fuzzy at chunk granularity (trigram). Sharper for long recordings.
SELECT r.folder_name, r.datetime_iso, c.chunk_idx,
       snippet(recording_chunk_trgm,1,'«','»','…',10) AS snip, bm25(recording_chunk_trgm) AS bm25
FROM recording_chunk_trgm JOIN recording_chunk c ON c.id=recording_chunk_trgm.rowid
JOIN recording r ON r.folder_name=c.folder_name
WHERE recording_chunk_trgm MATCH 'icing' AND r.superseded_by IS NULL
ORDER BY bm25 LIMIT 20;

-- recency-decay — Recency-decay ranking: relevance × time boost. "What did I say about X"
--     preferring recent hits. Pure SQL, no schema. Half-life 30 days.
--     QV=$(echo 'how do notifications work' | swrag embed); swrag sql <<SQL
WITH scored AS (
  SELECT r.folder_name, r.datetime_iso, r.mode_name,
         vec_distance_cosine(v.embedding, $QV) AS dist
  FROM recording_vec v JOIN recording r USING (folder_name)
  WHERE r.superseded_by IS NULL)
SELECT folder_name, datetime_iso, mode_name, ROUND(dist,3) AS dist,
       ROUND((1.0-dist)*exp(-(julianday('now')-julianday(datetime_iso))/30.0),3) AS score
FROM scored ORDER BY score DESC LIMIT 10
-- SQL
```

## Pick your surface

| User asked for                                  | Use                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Today / this week / this mode                   | `today`, `mode-recent`                                            |
| "What did I say about X" — keyword              | `keyword` (whole-row) or `keyword-chunk` (long-form)              |
| "What did I say about X" — semantic/paraphrase  | `semantic` (whole-row) or `best-moment` (long-form)               |
| Best of keyword + semantic                      | `hybrid` (whole-row) or `hybrid-chunk` (usually wins long-form)   |
| "In `<mode>`/`<app>`/`<date>`, find the moment" | `filter-then-retrieve` (chunk) or `semantic-filtered` (whole-row) |
| Rank recordings by best moment                  | `rank-recordings`                                                 |
| Substring / typo / glued identifier             | `trigram` (whole-row) or `trigram-chunk` (chunk)                  |
| "What did I say about X" — recent first         | `recency-decay`                                                   |
| Reprocessing history                            | `reprocess-history`                                               |

- Chunk recipes (`best-moment`–`rank-recordings`) for "find the moment" in long
  recordings; whole-row (`keyword`–`hybrid`) for "show me the recording" (short
  rows have no chunks).
- Filter on `recording` before ranking (`filter-then-retrieve`) — chunk_vec has
  no metadata columns.
- `LIMIT 5` for full-transcript (`best-moment`); `LIMIT 10–20` for chunk-text
  (`chunk-neighbors`–`filter-then-retrieve`); `LIMIT 50` for RRF CTEs.

## Reading distances

`vec_distance_cosine(a,b)` = `1 − cos(a,b)` in `[0,2]`. bge-m3:

| Distance  | Meaning                                     |
| --------- | ------------------------------------------- |
| < 0.25    | Tight match (paraphrase / near-duplicate)   |
| 0.25–0.45 | Strong topical match — most real hits       |
| 0.45–0.55 | Plausibly related — verify with the snippet |
| > 0.55    | Likely noise                                |

If your best hit is > ~0.55, say so ("weak match — try different phrasing or
FTS"). Cross-lingual scores run ~0.05 higher; consider embedding a translated
query if recall is poor.

## Anti-patterns

- `JOIN recording_chunk_vec v ON v.rowid=c.id` — the PK is `chunk_id`, not
  `rowid`. Always `v.chunk_id`.
- `WHERE recording_fts MATCH …` without `r.superseded_by IS NULL` — you'll
  surface old reprocessings as duplicates.
- `vec_distance_cosine(embedding, 'text')` — a text literal is not a vector.
  Always shell-compose with `$(echo '…' | swrag embed)` (or `$QV`).
- `recording_trgm MATCH 'ab'` — trigram needs ≥3 characters; 1–2 char queries
  return nothing. Use `recording_fts` prefix matching (`'ab*'`) for short terms.
- `LIMIT 50` on a full-transcript recipe — meetings can be 10K+ words. Use
  `LIMIT 5` for full transcripts, `LIMIT 20` for chunk-text.
- Reaching for `recording_chunk*` for short recordings — short rows have no
  chunks; they appear only via `recording*` / `recording_vec`.
- Hard-coding mode names like `'Meeting'` without running `modes` — modes
  are user-configurable.

## Going underneath swrag

`swrag` is thin. Drive sqlite3 directly when you need more:

```bash
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode json" \
  "SELECT folder_name FROM recording LIMIT 5"
```

## Other commands

- `swrag index` — ingest from Super Whisper now.
- `swrag path [archive|sqlite3|vec0]` — print a path for shell composition.
- `swrag embed` — print an embedding as `x'…'` (text via stdin: `echo 'text' | swrag embed`, or a quoted heredoc).
- `swrag doctor` — verify setup.
