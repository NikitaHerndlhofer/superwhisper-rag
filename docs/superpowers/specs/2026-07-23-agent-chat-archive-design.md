# Agent Chat Archive — `acrag` + `agent-archive-core`

**Status:** Draft for review
**Date:** 2026-07-23
**Author:** Design session (superpowers brainstorming)

## 1. Overview

Goal: archive chats with AI coding agents (Cursor, Claude Code, Codex, OpenCode) into a
SQLite database, chunk them, and provide keyword / fuzzy / semantic / recency-decay search
over chunked and full conversations, exposed to agents via a `SKILL.md`.

This mirrors `swrag` (Super Whisper archive) but for conversational data. To avoid duplicating
the hard shared logic (embeddings, chunking, FTS5/vec index ops, migrations, CLI plumbing), we
extract a shared library — `agent-archive-core` — and consume it from both `swrag` and `acrag`.

Priority agents: **Cursor** (highest), then **Claude Code**, then **Codex**, then **OpenCode**.

### Non-goals (this phase)

- No FSEvents / filesystem watcher in `acrag`. Ingestion is **hooks-only** (event-driven), with a
  one-shot **sweep** for completeness. The `watch/` (FSEvents) watcher stays in `swrag`'s own repo
  (NOT in the core) — `swrag` still needs it because Super Whisper has no hook and just drops files in
  a folder.
- No multi-user / server mode. Single local user, single DB per agent (or one shared DB).

## 2. Repositories & packaging

Three repos:

| Repo                           | Role                                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-archive-core`           | Shared library: mechanisms only (open/embed/chunk/fts+vec/migrations/cli-utils). No schema, no orchestration, no watch in acrag's path. |
| `acrag` (new)                  | Chat archive CLI + hooks + `SKILL.md`. Owns conversation schema, ingest orchestration, search recipes.                                  |
| `swrag` (existing, refactored) | Whisper archive CLI. Refactored to consume `agent-archive-core`; keeps its `recording` schema + FSEvents watcher.                       |

### Packaging recommendation

Distribute `agent-archive-core` as a **git URL dependency** (tagged):
`"agent-archive-core": "github:nikitaherndlhofer/agent-archive-core#v0.1.0"`.

- `bun install` resolves it; `bun build --compile` bundles it into each binary at build time, so the
  lib is only needed at build time, never at runtime.
- No npm publish required. Optional later: publish to npm for semver range resolution.

### Build / runtime

- Runtime: **Bun** (per workspace rule). Binaries via `bun build --compile`.
- SQLite via `bun:sqlite` for the CLI; the compiled binary loads `sqlite-vec` as a runtime extension
  (same pattern as `swrag`).
- Embedding model: **bge-m3** (same as `swrag`), loaded by the core.

## 3. `agent-archive-core` — shared library surface

The core is a **mechanisms library**. It owns what is genuinely identical across frontends; it does
NOT own schema, orchestration, triggers, or search recipes (those differ per frontend).

### Exports

- `openArchive(path, { migrations, extensions })` — opens SQLite, loads `sqlite-vec`, runs the
  injected migration set via `PRAGMA user_version`. Returns a typed handle.
- `embed(texts: string[]): Promise<Float32Array[]>` — bge-m3 batched embedding (core owns the model
  - batching + caching of identical inputs).
- `chunkText(text, strategy): Chunk[]` — pure deterministic **prose** chunker (already exists in
  `swrag`'s `src/ingest/chunker.ts`; `chunkText` is generic). `strategy` is injected by the frontend
  (`swrag`: by-text with speaker heuristics). Used for prose transcripts.
- `chunkSegments(segments, strategy): Chunk[]` — structured, **segment-aware** chunker for
  conversational transcripts. Takes pre-parsed typed segments (text/thinking/code/tool_call/
  tool_result/diff) and emits chunks that keep semantic units intact (a code block, a diff, or a
  tool call+result pair stays whole), sub-chunking only oversized segments with content-aware
  boundaries (line-aware for code/tool-output, sentence-aware for prose). Tags each chunk with a
  `chunk_type`. `acrag` uses this; `swrag` keeps `chunkText`.
- FTS5 / vec index helpers — generic over table names passed in: `ftsUpsert`, `ftsMatch`,
  `vecUpsert`, `vecSearch`, plus tokenizer config (`porter unicode61` for stemmed keyword;
  `trigram remove_diacritics 2` for fuzzy/substring).
- Migration runner — applies an injected ordered list of SQL migration files, bumping
  `PRAGMA user_version`. Frontend provides its own migration SQL.
- `cliUtils` — arg parsing, stdin reading, version/help formatting (shared CLI plumbing).

### Explicitly NOT in the core

- `watch/` (FSEvents) — stays in `swrag` only. (Kept in swrag's repo, not the core.)
- Schema / migrations — per-frontend.
- `ingestFile` orchestration (hash check → turn diff → embed-only-new → supersede) — per-frontend,
  assembled from core primitives.
- Triggers (hooks) — per-frontend.
- Search recipes / `SKILL.md` — per-frontend (different tables/columns).

### Extraction cost for `swrag`

`swrag`'s `src/archive/open.ts` and `src/ingest/chunker.ts` are mostly generic but hard-wired to
`swrag`'s migrations and `recording` table for freshness checks. Refactor = parameterize migrations
and the freshness check (dependency injection). `chunkText` is already pure and moves cleanly.

## 4. `acrag` schema

One SQLite DB (default `~/.acrag/acrag.sqlite`), managed via `PRAGMA user_version` migrations. A
separate `config.data_version` governs data transformations (re-embedding), mirroring `swrag`.

### Tables

```sql
-- A conversation = one agent session transcript file. Agent-agnostic: no agent-specific booleans
-- or fields live here. Subagents are any conversation with a non-null parent_conversation_id.
-- Dynamic attributes (background, agent-specific flags) live in conversation_tag (see below).
-- Conversation lifetime is derived from messages: [MIN(message.created_at), MAX(message.created_at)].
CREATE TABLE conversation (
  id                     TEXT PRIMARY KEY,      -- agent's conversation_id (or file-hash-derived if none)
  agent_name             TEXT NOT NULL,         -- 'cursor' | 'claude-code' | 'codex' | 'opencode'
  repository             TEXT,                  -- git repo name (from remote origin, else workspace basename)
  source_path            TEXT NOT NULL,         -- absolute path to the transcript file
  file_hash              TEXT,                  -- last-ingested content hash of source_path
  parent_conversation_id TEXT,                  -- set for subagents (links to parent conversation)
  model                  TEXT,
  superseded_by          TEXT,                  -- set when an in-place edit replaces this conversation
  created_at             TEXT NOT NULL DEFAULT (datetime('now'))  -- when first archived
);

-- Dynamic tagging (replaces hardcoded is_subagent / is_background). Any conversation can have
-- any tags: 'background', 'subagent' (if not implied by parent_conversation_id), agent-specific
-- labels, etc. Queryable + indexable; no schema change needed to add a tag.
CREATE TABLE conversation_tag (
  conversation_id TEXT NOT NULL REFERENCES conversation(id),
  tag             TEXT NOT NULL,
  PRIMARY KEY(conversation_id, tag)
);
CREATE INDEX conv_tag_tag ON conversation_tag(tag);

-- A message = one turn (user or assistant or tool/system) within a conversation.
CREATE TABLE message (
  id                TEXT PRIMARY KEY,            -- conversation_id + ':' + seq
  conversation_id   TEXT NOT NULL REFERENCES conversation(id),
  seq               INTEGER NOT NULL,            -- 0-based order within conversation
  role              TEXT NOT NULL,               -- 'user' | 'assistant' | 'system' | 'tool'
  content           TEXT NOT NULL,               -- aggregated text of the turn
  tool_name         TEXT,                         -- for tool calls (generic; null if not a tool call)
  tool_call_id      TEXT,
  created_at        TEXT,                         -- ISO8601 from transcript (the turn's time in the agent)
  content_hash      TEXT,                         -- for cheap diffing on re-ingest
  UNIQUE(conversation_id, seq)
);

-- A chunk = a searchable unit. One chunk per turn-segment by default; large segments are SPLIT
-- into multiple chunks (never truncated — no context loss; each split carries a contextual header).
CREATE TABLE chunk (
  id                TEXT PRIMARY KEY,            -- conversation_id + ':' + message_seq + ':' + sub
  conversation_id   TEXT NOT NULL REFERENCES conversation(id),
  message_id        TEXT NOT NULL REFERENCES message(id),
  sub               INTEGER NOT NULL DEFAULT 0,   -- sub-chunk index within a turn/segment
  role              TEXT NOT NULL,
  chunk_type        TEXT NOT NULL DEFAULT 'text', -- text|thinking|code|tool_call|tool_result|diff
  text              TEXT NOT NULL,                -- full chunk text (incl. contextual header for split chunks)
  token_count       INTEGER,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX chunk_conv ON chunk(conversation_id);
CREATE INDEX chunk_msg  ON chunk(message_id);
```

### FTS5 (keyword + fuzzy)

Two virtual tables over `chunk.text`, mirroring `swrag`:

```sql
-- stemmed keyword search
CREATE VIRTUAL TABLE chunk_fts USING fts5(text, content='chunk', content_rowid='rowid',
  tokenize='porter unicode61');

-- substring / infix / fuzzy search
CREATE VIRTUAL TABLE chunk_trigram USING fts5(text, content='chunk', content_rowid='rowid',
  tokenize='trigram remove_diacritics 2');
```

Both kept in sync via triggers on `chunk` insert/update/delete (same pattern as `swrag`).

### sqlite-vec (semantic)

```sql
CREATE VIRTUAL TABLE chunk_vec USING vec0(
  embedding float[1024]   -- bge-m3 dimension
);
```

`chunk_vec.rowid` ↔ `chunk.rowid`. Re-embedding is keyed by `content_hash`; unchanged chunks skip
embedding (idempotent), exactly like `swrag`'s dirty-row re-embed.

## 5. Chunking strategy

**Per-turn outer boundary + segment-aware sub-chunking.** Cursor chats are structured (prose,
code blocks, tool calls + results, diffs, thinking), not prose blobs — a flat token-split would
break code blocks, split tool calls from their results, and waste embeddings on giant file dumps.
The chunker is segment-aware instead.

- **Outer boundary = the turn (`message`).** Turns are natural semantic boundaries; do not merge
  across turns. Each chunk carries `conversation_id` + `message_id` + `role` + `chunk_type`.
- **Within a turn, chunk by typed segment**, keeping semantic units intact:
  - a **code block** stays one chunk (never split mid-function);
  - a **file diff** (`old_string`/`new_string`) stays whole;
  - a **tool call + its result** are paired/adjacent (not separated);
  - **prose** (user prompt, assistant explanation, thinking) chunks by sentence/paragraph.
- **Sub-chunk only oversized segments** (default threshold **512 tokens**), with content-aware
  boundaries: **line-aware** for code/tool-output/diffs, **sentence-aware** for prose. Small
  segments stay as single chunks — the segment/turn boundary matters more than uniform size.
- **`chunk_type` tag** on every chunk: `text` | `thinking` | `code` | `tool_call` | `tool_result` |
  `diff`. Recipes filter on it ("search only my prompts", "only code the agent wrote", "exclude
  tool dumps").
- **Large segments are split, never truncated** — no context is lost. A 2000-line file read becomes
  multiple chunks, each fully embedded. Each split chunk carries a **contextual header** so it stays
  self-describing out of context (e.g. "[tool_result: Read src/foo.ts — part 2/4, lines 501–1000]"),
  and adjacent split chunks **overlap slightly** (a few lines) so a hit near a boundary isn't
  orphaned. The `thread` and `context` recipes reconstruct the full segment and its neighbors.

Rationale: user turns carry the intent/prompts (highest retrieval signal); assistant turns carry
the response + reasoning; tool results carry the context the agent acted on. Segment-aware
chunking keeps each chunk topically coherent and type-filterable, and lets recipes reconstruct a
conversation by joining `chunk`→`message`→`conversation`.

## 6. Embedding

- **Model:** bge-m3 (1024-dim), owned by the core's `embed()`.
- **Embed both user + assistant turns** (confirmed). User turns carry the intent/prompts; assistant
  turns carry the response. Both are embedded into `chunk_vec`.
- **Thinking blocks**: embedded too (reasoning is high-signal and worth searching), tagged
  `chunk_type='thinking'` so recipes can include/exclude them.
- **Tool/system turns**: embedded in full, same as user/assistant turns. They carry the context
  the agent acted on and are worth searching.
- **Every chunk is embedded in full — never truncated.** Large segments are split into multiple
  fully-embedded chunks (see §5), so no context is lost and vectors stay focused on coherent units.
- **Idempotent**: per-chunk `content_hash`; re-ingest embeds only chunks whose hash changed.

## 7. Ingestion — hooks only (no FSEvents)

`acrag` ingestion is **event-driven via agent hooks**, plus a one-shot sweep. No filesystem watcher.

### Hook set (Cursor; Claude Code / Codex analogous via their own hook systems)

| Hook            | Payload field used                                       | acrag action                                                                                                                                          |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stop`          | `transcript_path` (+ `conversation_id`)                 | **background** `ingestFile(transcript_path)` — primary per-turn ingest                                                                                |
| `subagentStop`  | `agent_transcript_path` (+ `subagent_id`)                | **background** `ingestFile(agent_transcript_path)` as a **separate conversation**, `parent_conversation_id` resolved from the `subagentStart` mapping |
| `workspaceOpen` | (none — scans dirs)                                      | **background sweep** (`acrag index`) — catches crashes, edits, missed turns, and any new transcripts                                                  |

`subagentStart` is used only to record the `subagent_id → parent_conversation_id` mapping (and
`subagent_type`, `task`) into a small local state table so `subagentStop` can link the subagent
conversation to its parent. (If the mapping is unavailable, fall back to deriving the parent from
the transcript content; if that also fails, ingest as an unlinked standalone conversation — still
searchable.)

**No** `sessionStart` / `sessionEnd` hooks — neither does useful work for ingest. `stop` already
fires per turn with the complete exchange.

### Transcript parsing (Cursor JSONL)

Cursor transcripts are JSONL (one event per line) under `workspaceStorage`. A turn is a _tree of
typed segments_, not a text blob. The parser (lives in `acrag` — agent-specific) produces typed
segments that feed the core's `chunkSegments`:

- **Stream line-by-line.** A single tool-result line can be MBs; cap line size, skip malformed lines
  (append races during active writes), never load the whole file into memory at once.
- **Emit typed segments**: `{role, kind: text|thinking|code|tool_call|tool_result|diff|subagent,
  content, tool_name, tool_call_id, timestamp, agent_transcript_path?}`.
- **Extract structure**: `conversation_id`, per-message `role`/`seq`/`content`/timestamps, tool
  calls + results, thinking blocks, diffs, attachments, subagent references (for
  `parent_conversation_id` linking).
- **Derive `repository`** from `workspace_roots` (git remote origin URL → repo name, else the
  workspace basename). Apply dynamic **tags** (e.g. `background`) from hook metadata into
  `conversation_tag` — never hardcode agent-specific booleans on the conversation row.
- **Schema-drift robustness** (biggest Cursor-path risk): Cursor's JSONL schema evolves across
  versions → version-detect, ignore unknown fields, fail soft (log + skip a line, don't abort the
  whole file). Build and test the parser against a captured sample from the user's real install.

### Non-blocking, always

The hook command spawns `acrag ingest` **detached** (`nohup … &`, exit 0 instantly) so the agent
never waits on embedding. Ingest is idempotent, so background re-fires are safe.

### `acrag hook <event>` subcommand

The hooks.json calls one acrag subcommand per event, e.g. `acrag hook stop`. It reads the hook JSON
payload from stdin, extracts the right path, and triggers a background `ingestFile`. acrag ships a
generated `hooks.json` (and a `cursor://settings` install snippet) so setup is "drop this file".

### `ingestFile(path)` pipeline (idempotent)

1. Read file → compute `file_hash`.
2. Look up `conversation` row by `source_path`. If `file_hash` matches → exit (no-op).
3. Parse transcript → list of turns (`role`, `seq`, `content`, timestamps).
4. Diff against stored `message` rows (by `conversation_id`+`seq`, cheap via `content_hash`):
   - new turns → insert `message` rows, chunk them, embed new chunks, upsert FTS5 + vec.
   - changed turns → update `message`, re-chunk + re-embed affected chunks, sync FTS5/vec.
   - removed turns → delete their `message`/`chunk` rows + FTS5/vec entries.
5. Update `conversation.file_hash`.
6. If the transcript was structurally replaced (rare in-place edit beyond append), set the old
   conversation row `superseded_by = <new id>` and insert the new conversation row.

### Edit handling

- **Fork edits** (Cursor's default when you edit+resubmit a past prompt): a **new** transcript file
  is created → caught by the next `stop`/`subagentStop` hook → ingested as a **new conversation**
  (linked to the parent via `parent_conversation_id` if it's a subagent, or standalone). The original
  branch's file is untouched → no supersede needed.
- **In-place edits** (rare; e.g. Cursor rewriting/compacting a transcript, or a manual edit): no
  hook fires → caught by the next **sweep**, which re-hashes and **supersedes**.
- **Crash / kill mid-turn**: `stop` never fires → the file on disk has the last-written state → the
  **sweep** ingests it on the next `workspaceOpen` (or manual `acrag index`).

Net: hooks catch everything that grows or forks; the sweep catches in-place edits and crash gaps. No
"message edited" hook exists in Cursor/Claude/Codex, and we don't need one.

## 8. The sweep — `acrag index`

One-shot scan of configured transcript directories (per agent):

- Cursor: `~/Library/Application Support/Cursor/User/workspaceStorage/*/...` (exact layout to be
  confirmed during implementation by inspecting a real install).
- Claude Code, Codex, OpenCode: their respective transcript dirs (to be confirmed).

For each transcript file found:

1. compute `file_hash`;
2. unchanged since last ingest → skip;
3. new → ingest (parse, chunk, embed both roles, upsert conversation + messages + chunks + FTS5/vec);
4. changed → supersede old, ingest new;
5. derive `parent_conversation_id` for subagent transcripts (from content/path; fallback unlinked).

**Triggers:**

- **automatic**: `workspaceOpen` hook → background `acrag index` (every time Cursor opens a workspace,
  interrupted/crashed sessions since last open get caught).
- **manual**: `acrag index` CLI (escape hatch / explicit backfill).
- **optional**: a launchd timer running `acrag index` every N minutes (NOT a watch — a cron-like
  trigger). Documented but not required.

First run backfills all history (one-time embed cost). Subsequent runs are cheap (hash-skip; only
changed files re-embed).

## 9. Search recipes & `SKILL.md`

`acrag` ships a condensed `SKILL.md` (straight instructions, all search variants, no build
artifacts) — same editorial discipline as `swrag`'s refactored skill. Recipes use **semantic
kebab-case slugs** (no numbers), consistent with `swrag`. Recipes are `acrag`-specific (they query
`conversation`/`message`/`chunk`, not `recording`).

Proposed recipe set (slug — purpose):

- `agents` — discover which agents/sources are archived (`SELECT agent_name, COUNT(*) …`).
- `recent` — recent conversations.
- `today` — today's conversations.
- `turns` — recent turns across all conversations (join `message`↔`conversation`).
- `keyword` — FTS5 stemmed search over `chunk_fts` (`porter unicode61`).
- `fuzzy` — trigram substring/infix search over `chunk_trigram` (catches typos / partial tokens).
- `semantic` — `sqlite-vec` bge-m3 vector search over `chunk_vec` (pipe query via `acrag embed`).
- `recency-decay` — semantic relevance × recency (same ranking shape as `swrag`'s recipe).
- `hybrid` — combine `keyword` + `semantic` (FTS5 rank + vec distance, weighted).
- `by-agent` — filter conversations/turns by `agent_name`.
- `by-repo` — filter conversations/turns by `repository` (e.g. all chats in `SuperWhisperRag`).
- `by-tag` — filter conversations by dynamic tag via `conversation_tag` (e.g. `background`).
- `subagents` — conversations with a `parent_conversation_id` (optionally joined to their parent).
- `thread` — reconstruct a full conversation: all `message` rows for a `conversation_id` ordered by
  `seq` (the "give me the whole chat" recipe).
- `context` — neighboring turns around a given chunk (join `chunk`→`message` by `conversation_id` +
  adjacent `seq`), for "what was said around this hit".
- `by-chunk-type` — filter chunks by `chunk_type` (e.g. only `text` prompts, only `code` the agent
  wrote, only `diff`s), optionally combined with `keyword`/`semantic`.

`acrag sql` and `acrag embed` take input via **stdin only** (same pipe-only convention as `swrag`),
avoiding shell-quoting issues. `acrag embed` returns a vec literal suitable for `vec_search`/`vec0`.

## 10. `swrag` refactor (consume the core)

1. Extract `chunkText` + tokenizer config + `embed` + `openArchive` (parameterized) + migration
   runner + CLI utils into `agent-archive-core`.
2. `swrag` depends on the core via git URL; its `src/archive/open.ts` injects `swrag`'s own migrations
   and `recording`-based freshness check.
3. `swrag` keeps: `recording` schema + migrations, FSEvents `watch/`, its `SKILL.md` + recipes, its
   CLI commands.
4. Behavior unchanged; covered by existing `tests/` (skill canary, semantic e2e). Verify the binary
   still builds and all tests pass after extraction.

## 11. Phasing / implementation order

1. **`agent-archive-core`** — extract from `swrag`; publish tag `v0.1.0`. Surface: `openArchive`,
   `embed`, `chunkText`, `chunkSegments`, FTS5/vec helpers, migration runner, `cliUtils`. Unit tests
   for each.
2. **`swrag` refactor** — consume the core; green tests; rebuild binary; smoke test. (Proves the
   core works before `acrag` is built on it.)
3. **`acrag` skeleton** — repo, schema + migrations, `openArchive` wiring, `acrag sql`/`acrag embed`
   stdin pipe, minimal `SKILL.md`.
4. **`acrag` ingest** — Cursor JSONL parser (typed segments, schema-drift-robust), `ingestFile`
   pipeline, segment-aware chunking via `chunkSegments` (per-turn + sub-chunk, `chunk_type` tagged),
   embedding (both roles, large-tool-result truncation), FTS5/vec sync.
5. **`acrag` hooks** — `acrag hook stop|subagentStop|workspaceOpen`, generated `hooks.json`, detached
   background ingest, `subagentStart` mapping table.
6. **`acrag` sweep** — `acrag index` (scan, hash, ingest/supersede, parent-link derivation).
7. **`acrag` recipes** — full `SKILL.md` recipe set; canary tests asserting recipe headers (like
   `swrag`'s `tests/skill.test.ts`); semantic e2e test (like `swrag`'s `tests/semantic.test.ts`).
8. **Claude Code / Codex / OpenCode** ingest — their transcript formats + hook systems, reusing the
   same `ingestFile` core.

## 12. Open questions / risks

- **Cursor transcript on-disk layout** — exact paths + JSONL shape (and whether subagent transcripts
  encode `parent_conversation_id`) must be confirmed by inspecting a real install before finalizing
  the parser and the sweep's dir scan. Mitigation: build the Cursor parser against a captured sample;
  fall back to unlinked subagent conversations if the parent link isn't derivable.
- **Cursor JSONL schema drift** — Cursor's transcript schema evolves across versions; a parser that
  works today may break on an update. Mitigation: version-detect, ignore unknown fields, fail soft
  (skip a malformed line, don't abort the file), pin the parser's tested schema version, and add a
  canary test against a captured fixture.
- **Claude Code / Codex hook systems** — Cursor's hook surface is confirmed (rich). Claude Code
  (SessionEnd-style hooks) and Codex (notify/hooks) need the same per-turn `stop`-equivalent; confirm
  each agent fires a hook with a transcript path after a turn. If an agent only offers session-end
  hooks, that agent falls back to sweep-only ingestion (higher latency, still correct).
- **Packaging** — git URL dependency recommended; confirm acceptable (vs npm publish) at review.
- **DB layout** — one DB per agent vs one shared DB. Default: **one shared DB** with `agent_name`
  discrimination (simpler cross-agent search). Revisit if scale or isolation demands otherwise.
- **Embedding cost on backfill** — first sweep embeds all history (could be thousands of turns).
  Acceptable one-time cost; run in background. Consider a `--limit`/`--since` flag on `acrag index`
  for incremental backfill.
