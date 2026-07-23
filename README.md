# superwhisper-rag

A local-first, append-only archive of your [Super Whisper](https://superwhisper.com)
dictation history with full-text and multilingual semantic search.

`swrag` keeps a private SQLite database in sync with Super Whisper's
recordings, embeds every transcript with `bge-m3` (1024-d, 100+ languages)
via local [Ollama](https://ollama.com), and exposes the whole thing as a
thin [`sqlite3`](https://sqlite.org) wrapper.

Super Whisper is great at capture but doesn't help you find what you've
said later. You can keep the audio history forever — but it piles up on
disk, and there's no semantic search across it. Or you let it
auto-delete — and then it's just gone. Either way, the actual signal —
the transcript, the decision, the moment — is hard to get back to.
`swrag` extracts only the searchable substance into its own small
archive and leaves the audio policy to Super Whisper.

It's useful if you:

- Want to search what you said weeks or months ago — semantically (in any
  language) or by keyword — without scrolling Super Whisper's UI.
- Want an AI agent (Cursor, Claude Code) to be able to look things up in
  your dictation history on demand.
- Want a local, private, queryable history of your voice. No cloud, no
  telemetry, no account.

## Quick taste

```bash
# Today's dictations. processed_transcript = the LLM-cleaned text;
# falls back to raw_transcript when the mode didn't run an LLM.
swrag sql <<'SQL'
SELECT folder_name, datetime_iso, mode_name,
       COALESCE(processed_transcript, raw_transcript) AS transcript
FROM recording
WHERE date(datetime_iso) = date('now','localtime')
  AND superseded_by IS NULL
ORDER BY datetime_iso DESC;
SQL

# Discover the modes you've actually used — modes are user-configurable in
# Super Whisper, so don't assume any particular name exists.
swrag sql <<'SQL'
SELECT mode_name, COUNT(*) AS n
FROM recording
WHERE superseded_by IS NULL
GROUP BY mode_name
ORDER BY n DESC;
SQL

# Filter by Super Whisper mode — replace 'meeting' with one of the names
# the previous query showed. `mode_name_lower` is an indexed generated
# column, so case-insensitive matches are cheap.
swrag sql <<'SQL'
SELECT folder_name, datetime_iso, duration_sec,
       COALESCE(processed_transcript, raw_transcript) AS transcript
FROM recording
WHERE mode_name_lower = 'meeting'
  AND datetime_iso >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')
  AND superseded_by IS NULL
ORDER BY datetime_iso DESC;
SQL

# Keyword search with snippets. recording_fts indexes raw_transcript and
# processed_transcript; the -1 in snippet() lets it pick whichever column
# matched.
swrag sql <<'SQL'
SELECT r.folder_name, snippet(recording_fts, -1, '«', '»', '…', 5)
FROM recording_fts JOIN recording r ON r.rowid = recording_fts.rowid
WHERE recording_fts MATCH 'bullmq' AND r.superseded_by IS NULL
ORDER BY bm25(recording_fts) LIMIT 10;
SQL

# Substring / fuzzy search via the trigram index. The porter tokenizer above
# matches whole words; recording_trgm matches 3-character windows, so it
# finds infixes ('icing' inside 'pricing'), glued identifiers, and typos
# ('notifcations'). Needs >=3 chars; no stemming (use recording_fts for that).
swrag sql <<'SQL'
SELECT r.folder_name, snippet(recording_trgm, -1, '«', '»', '…', 5)
FROM recording_trgm JOIN recording r ON r.rowid = recording_trgm.rowid
WHERE recording_trgm MATCH 'icing' AND r.superseded_by IS NULL
ORDER BY bm25(recording_trgm) LIMIT 10;
SQL

# Semantic search — works in any language; the shell composes the embedding.
# `$(echo '…' | swrag embed)` runs in a subshell with its own stdin, so it
# splices cleanly into the heredoc body.
swrag sql <<SQL
SELECT r.folder_name,
       COALESCE(r.processed_transcript, r.raw_transcript) AS transcript,
       vec_distance_cosine(v.embedding, $(echo 'how do notifications work' | swrag embed)) AS dist
FROM recording_vec v JOIN recording r USING (folder_name)
WHERE r.superseded_by IS NULL
ORDER BY dist LIMIT 10;
SQL

# Find the precise moment in a long meeting — chunk-level semantic search
# returns ~300-word windows instead of "this hour-long meeting probably
# talked about it". `best-moment` in the cookbook joins the full transcript
# back in for context.
swrag sql <<SQL
SELECT r.folder_name, c.chunk_idx, c.text,
       vec_distance_cosine(v.embedding, $(echo 'how do we price the enterprise tier' | swrag embed)) AS dist
FROM recording_chunk_vec v
JOIN recording_chunk c ON c.id = v.chunk_id
JOIN recording r ON r.folder_name = c.folder_name
WHERE r.superseded_by IS NULL
ORDER BY dist LIMIT 10;
SQL
```

See [`docs/sql-cookbook.md`](docs/sql-cookbook.md) for the full set of
recipes.

`processed_transcript`, `raw_transcript`, and `datetime_iso` are the
v1.1.0 canonical columns — stable across Super Whisper versions, indexed,
safe to query. Super Whisper's own `result`, `llm_result`, and
`raw_result` columns are mirrored into the archive as-is for raw access
when you need it; they shift shape between SW releases, so the canonical
columns are what you want in day-to-day queries.

## Long-form recordings

Meetings are too long for a single embedding to be useful — `bge-m3`'s
~8K-token window silently drops the back half of anything over ~5K
words, and even within budget a single vector averages every topic
into mush. So at ingest, recordings above ~500 words are also split
into ~300-word overlapping windows (sentence- and speaker-boundary-
aware, deterministic, no LLM call) and embedded individually into
`recording_chunk_vec` and `recording_chunk_fts`. The row-level
`recording_vec` still works for coarse filtering — it's now the
L2-normalized centroid of the row's chunks. Once you've found the
chunk, `COALESCE(processed_transcript, raw_transcript)` on the parent
row is the full transcript right there for context. Recipes `chunked-rows`
through `hybrid-chunk` in the cookbook cover the chunk-level patterns.

## Install

macOS + [Homebrew](https://brew.sh). Two commands, end to end:

```bash
brew install NikitaHerndlhofer/tap/superwhisper-rag
swrag bootstrap
```

`brew install` handles the binary and dependencies (Ollama is pulled
in for you). `swrag bootstrap` then does everything else:

1. Starts the Ollama service if it isn't already running.
2. Pulls `bge-m3` if it isn't already pulled (~2 GB, one-time).
3. Installs the event-driven watch agent (launchd) that keeps the
   archive in sync as Super Whisper writes new recordings.
4. Indexes your Super Whisper archive (chunks any long-form
   recordings; see above).
5. Installs the manual-invocation agent skill for Cursor and Claude Code.
6. Runs `swrag doctor` and prints a summary.

Idempotent — re-run any time to restore the setup to known-good state.
Each step is independently invokable too (`swrag index`,
`swrag enable-watch`, `swrag install-skill`, `swrag doctor`) if you'd
rather pick and choose.

### About the watcher

The archive stays in sync via an FSEvents-based watcher
(`swrag watch`) that runs as a single launchd keepalive agent
(`com.superwhisper-rag.watch`). When Super Whisper writes a new
recording — audio file, `meta.json`, or a row to its internal
SQLite — the watcher detects it within ~2 seconds (a short debounce
coalesces the burst Super Whisper emits per recording) and ingests
it. Events on the source DB and the recordings tree are both
watched, so either signal triggers a sync. No cron, no polling.

Every ingest also applies any pending data updaters, so a
`brew upgrade` that ships a new chunker or backfill catches your
existing archive up automatically — no manual reindex. Even without
the agent, every `swrag sql` runs a sub-millisecond mtime-fast-path
ingest before the query, so on-demand freshness is automatic too.

To remove the launchd agent: `swrag disable-watch`. To reinstall it:
`swrag enable-watch` (or just `swrag bootstrap`).

### About the agent skill

`swrag bootstrap` writes `SKILL.md` to both
`~/.cursor/skills/superwhisper-rag/` and
`~/.claude/skills/superwhisper-rag/`. The skill is **manual-invocation
only** — the agent can never reach for it autonomously. To use it, type
`/superwhisper-rag` (Claude Code) or `@superwhisper-rag` (Cursor). See
[`docs/agent-integration.md`](docs/agent-integration.md) for the
guarantee.

To re-install (e.g. after editing it locally): `swrag install-skill`.
Your edits are backed up to `SKILL.md.bak.<timestamp>` first.

### Verify the setup

```bash
swrag doctor
```

Should report all 8 checks OK (sqlite3 binary + custom build + vec
extension + Ollama + archive + data version + chunk coverage + watch
agent).

## Configuration

All have sensible defaults; you shouldn't need to set any of them.

| Variable             | Purpose                                                                              |
| -------------------- | ------------------------------------------------------------------------------------ |
| `SWRAG_SOURCE_DIR`   | Super Whisper recordings dir (default `~/Documents/superwhisper`)                    |
| `SWRAG_SOURCE_DB`    | Super Whisper SQLite path                                                            |
| `SWRAG_ARCHIVE`      | Our archive's path                                                                   |
| `SWRAG_OLLAMA_HOST`  | Ollama URL (or `OLLAMA_HOST`; default `http://127.0.0.1:11434`)                      |
| `SWRAG_EMBED_MODEL`  | Embedding model (default `bge-m3`)                                                   |
| `SWRAG_KEEP_ALIVE`   | Ollama `keep_alive` value (default `"15m"` - the model will unload after 15 minutes) |
| `SWRAG_VERBOSE`      | Truthy → verbose stderr logs                                                         |
| `SWRAG_SKIP_EMBED`   | Truthy → text-only ingest, skip the embed pass                                       |
| `SWRAG_SQLITE_DYLIB` | Custom path to `libsqlite3.dylib`                                                    |

## Commands

| Command                                | What it does                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `swrag sql`                            | Run SQL via sqlite3 (default: list mode). SQL comes from stdin: `echo "…" \| swrag sql`, `swrag sql <<'SQL' … SQL`, or `swrag sql < file.sql`. Forward sqlite3 flags with `--` (`echo "…" \| swrag sql -- -json`). No positional.                                                             |
| `swrag index`                          | Ingest changes from Super Whisper now.                                                                                                                                                                                                                                                        |
| `swrag bootstrap`                      | One-shot post-install: start ollama, pull `bge-m3`, install the watch agent, index, install the agent skill, verify. Safe to re-run.                                                                                                                                                          |
| `swrag doctor`                         | Verify the environment.                                                                                                                                                                                                                                                                       |
| `swrag path [archive\|sqlite3\|vec0]`  | Print a filesystem path. Default: `archive`.                                                                                                                                                                                                                                                  |
| `swrag embed`                          | Print the embedding of text as a SQLite blob literal (`x'…'`), for shell composition. Text comes from stdin: `echo 'text' \| swrag embed`, or a quoted heredoc (`swrag embed <<'EOF' … EOF`) — the heredoc avoids shell-quoting hazards for text with apostrophes, quotes, `$`, or backticks. |
| `swrag install-skill`                  | Install the manual-invocation `SKILL.md` to Cursor and Claude Code.                                                                                                                                                                                                                           |
| `swrag watch`                          | Run the event-driven watch daemon in the foreground (intended for launchd).                                                                                                                                                                                                                   |
| `swrag enable-watch` / `disable-watch` | Manage the launchd watch agent.                                                                                                                                                                                                                                                               |

## Forwarding flags to sqlite3

`swrag sql` itself takes zero flags. To use any sqlite3 flag —
`-json`, `-csv`, `-line`, `-column`, `-box`, `-markdown`, `-cmd "…"`,
`-header`, `-separator`, etc. — put `--` after `sql` and everything
after the `--` is forwarded to sqlite3 verbatim. Pipe the SQL in on stdin:

```bash
# JSON output
echo "SELECT folder_name FROM recording LIMIT 5" | swrag sql -- -json

# Markdown table for human reading
echo "SELECT folder_name, datetime FROM recording LIMIT 5" | swrag sql -- -cmd ".mode markdown"

# Named parameters (sqlite3's own .parameter set)
echo "SELECT folder_name FROM recording WHERE app_name = :app LIMIT 5" | \
  swrag sql -- -cmd ".parameter set :app 'Cursor'"

# Compose with semantic embeddings (the `swrag embed` trick still works)
swrag sql -- -json <<SQL
SELECT folder_name,
       vec_distance_cosine(embedding, $(echo 'hello' | swrag embed)) AS d
FROM recording_vec ORDER BY d LIMIT 5;
SQL
```

## Piping SQL & embeddings (quoting-safe)

`swrag sql` and `swrag embed` both read from stdin. A **quoted heredoc**
(`<<'EOF'`) disables all shell expansion, so SQL or embed text containing
quotes, `$`, or backticks lands verbatim — no escaping to forget. This is
the recommended path for anything non-trivial (and for arbitrary user
speech, which is full of apostrophes):

```bash
# Pipe SQL — only SQL-standard '' doubling needed for string literals.
swrag sql <<'SQL'
SELECT folder_name, datetime_iso FROM recording
WHERE raw_transcript LIKE '%don''t%' AND superseded_by IS NULL
ORDER BY datetime_iso DESC LIMIT 10;
SQL

# Quoting-safe semantic search: embed via stdin, interpolate the blob.
QV=$(swrag embed <<'EOF'
how do notifications work when I say "don't"
EOF
)
swrag sql <<SQL
SELECT folder_name, vec_distance_cosine(embedding, $QV) AS d
FROM recording_vec ORDER BY d LIMIT 5;
SQL
```

To combine piped SQL with sqlite3 flags, put the flags after `--`:

```bash
swrag sql -- -json <<'SQL'
SELECT folder_name, datetime_iso FROM recording LIMIT 5;
SQL
```

If you'd rather bypass `swrag sql` entirely (e.g. to script around it),
`swrag path` exposes the underlying file paths so you can drive sqlite3
yourself:

```bash
sqlite3 "$(swrag path)" \
  -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
  -cmd ".mode csv" \
  "SELECT folder_name FROM recording LIMIT 5"
```

## Privacy

- Embeddings go only to `http://127.0.0.1:11434` (or wherever
  `SWRAG_OLLAMA_HOST` points). Verifiable via `swrag doctor`.
- The archive is plain SQLite on your disk. Back up with Time Machine or
  git-crypt; it never leaves your machine on its own.
- Super Whisper's `meta.json` contains your prompts and clipboard nouns.
  The bundled skill instructs the agent not to surface them unless you
  explicitly ask.

## License

MIT — see [LICENSE](LICENSE).
