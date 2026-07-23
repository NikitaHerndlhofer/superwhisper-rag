import { defineCommand, runMain } from "citty";
import { existsSync, realpathSync } from "node:fs";
import { VERSION } from "./config.ts";
import { getEnv } from "./env.ts";
import { error } from "./log.ts";
import { resolvePaths, type ResolvedPaths } from "./paths.ts";
import type { Env } from "./schemas.ts";
import { runBootstrap } from "./commands/bootstrap.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runEmbed } from "./commands/embed.ts";
import { disableWatch, enableWatch } from "./commands/enable-watch.ts";
import { runIndex } from "./commands/index.ts";
import { installSkill } from "./commands/install-skill.ts";
import { getPath, PathTargetSchema } from "./commands/path.ts";
import { runSql } from "./commands/sql.ts";
import { runWatchCommand } from "./commands/watch.ts";
import { readAllStdin, stdinIsPiped } from "./stdin.ts";

// The CLI surface is intentionally tiny — zero flags. Everything that used
// to be a flag is an env var, parsed and validated through `getEnv()`.
// See `src/schemas.ts` for the full list of `SWRAG_*` vars, and the
// README's "Configuration" table for the user-facing summary.
//
// We defer the actual `getEnv()` / `resolvePaths()` call until a handler
// runs (rather than evaluating at module top level) so that
// `swrag --help` and `swrag --version` work even when the user has a
// malformed env var set — citty handles help-only invocations without
// dispatching to a subcommand handler.
interface Context {
  env: Env;
  paths: ResolvedPaths;
}

let _ctx: Context | null = null;
function ctx(): Context {
  if (_ctx) return _ctx;
  const env = getEnv();
  const paths = resolvePaths({
    sourceDir: env.SWRAG_SOURCE_DIR,
    sourceDb: env.SWRAG_SOURCE_DB,
    archive: env.SWRAG_ARCHIVE,
    ollamaHost: env.SWRAG_OLLAMA_HOST ?? env.OLLAMA_HOST,
    embedModel: env.SWRAG_EMBED_MODEL,
  });
  _ctx = { env, paths };
  return _ctx;
}

/**
 * Everything after a literal `--` on the command line. We detect this
 * here, before citty runs, because citty's positional parser doesn't
 * preserve the `--` boundary for us. Capturing it once at entry keeps
 * the handler code from reaching back into `process.argv`.
 */
const DASHDASH_INDEX = process.argv.indexOf("--");
const PASSTHROUGH_ARGS: readonly string[] =
  DASHDASH_INDEX < 0 ? [] : process.argv.slice(DASHDASH_INDEX + 1);

/**
 * True iff the user typed a positional argument BEFORE the `--`
 * separator. Citty's parser doesn't respect `--`, so its `args.query`
 * value will include positionals that appear after `--` as well — we
 * can't use it to tell "the user supplied inline SQL alongside
 * passthrough" from "the user supplied SQL inside the passthrough".
 * For the conflict-detection in `sqlCmd`, we have to scan argv
 * ourselves and check whether anything non-flag lives between the
 * subcommand and the `--`.
 *
 * `subcommand` is the literal we expect at `process.argv[2]`, e.g.
 * `"sql"`. The function returns true if there's a positional in
 * `process.argv[3..DASHDASH_INDEX)` — strict bounds, because argv[2]
 * is the subcommand name itself and DASHDASH_INDEX is the `--`.
 */
function hasInlinePositionalBeforeDashDash(subcommand: string): boolean {
  if (DASHDASH_INDEX < 0) return false;
  // process.argv layout under bun-compiled CLI: [bun_exec, subcommand, ...]
  // and DASHDASH_INDEX is the index of `--`. We look at the args
  // strictly between (subcommand_idx + 1) and DASHDASH_INDEX.
  const subIdx = process.argv.indexOf(subcommand);
  if (subIdx < 0 || subIdx >= DASHDASH_INDEX - 1) return false;
  for (let i = subIdx + 1; i < DASHDASH_INDEX; i++) {
    const a = process.argv[i];
    if (a == null) continue;
    // Treat anything that doesn't start with `-` as a positional. (The
    // sql subcommand exposes zero flags of its own, so any `-…` token
    // before `--` is the user's mistake — but it's not "inline SQL".)
    if (!a.startsWith("-")) return true;
  }
  return false;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/* -------------------------------------------------------------------------- */
/* sql — thin proxy to the sqlite3 CLI                                        */
/* -------------------------------------------------------------------------- */

const sqlCmd = defineCommand({
  meta: {
    name: "sql",
    description:
      "Run SQL through sqlite3 (vec preloaded, archive read-only, ingest first). Pipe SQL via stdin (`echo \"…\" | swrag sql`, `swrag sql <<'SQL' … SQL`, `swrag sql < file.sql`). Forward sqlite3 flags with `--` (`echo \"…\" | swrag sql -- -json`). No positional — SQL is stdin-only.",
  },
  args: {
    query: {
      type: "positional",
      required: false,
      description:
        "Not used. `swrag sql` reads SQL from stdin only; a positional is rejected with an error pointing to the pipe/heredoc forms. (Kept in the schema so citty captures it for a clear error instead of a generic unknown-arg message.)",
    },
  },
  async run({ args }) {
    const passthrough = PASSTHROUGH_ARGS.length > 0;

    // Pipe-only: a positional before `--` (or with no `--` at all) is rejected.
    // citty doesn't respect `--`, so when `--` is present we scan argv ourselves
    // (`hasInlinePositionalBeforeDashDash`); without `--`, citty's `args.query`
    // is reliable. The `--` tail may still carry SQL for sqlite3 (the raw
    // passthrough escape hatch) — that's after `--`, so it's not "inline".
    const hasPositional = passthrough
      ? hasInlinePositionalBeforeDashDash("sql")
      : asString(args.query) != null;
    if (hasPositional) {
      error(
        "swrag sql reads SQL from stdin only — a positional isn't accepted. " +
          "Pipe it (`echo \"…\" | swrag sql`), use a heredoc (`swrag sql <<'SQL' … SQL`), " +
          "or redirect a file (`swrag sql < file.sql`). To forward sqlite3 flags, " +
          "use `echo \"…\" | swrag sql -- -json`.",
      );
      process.exit(2);
    }

    // Resolve the SQL. Precedence:
    //   1. `echo "…" | swrag sql`        → piped stdin (no `--`)
    //   2. `swrag sql <<'SQL' … SQL`    → heredoc stdin (no `--`)
    //   3. `swrag sql < file.sql`        → redirected stdin (no `--`)
    //   4. `echo "…" | swrag sql -- -json` → piped stdin + forwarded flags
    //   5. `swrag sql -- -json "SELECT …"` → raw passthrough: tail owns the SQL slot
    //   6. `swrag sql` (TTY, no `--`)    → error — no SQL provided
    //
    // When `--` is present and stdin is piped, we read SQL from stdin and
    // forward the tail as flags (case 4). When `--` is present and stdin is a
    // TTY, the tail owns everything — sqlite3 takes SQL as its 2nd positional
    // (case 5). buildArgs appends `sql` after `extraArgs`, which is the
    // sqlite3-correct order (DATABASE, flags, SQL).
    let sql: string | null;
    if (passthrough) {
      sql = stdinIsPiped() ? (await readAllStdin()).trim() : null;
    } else if (stdinIsPiped()) {
      sql = await readAllStdin();
    } else {
      error(
        "no SQL provided: pipe it (`echo \"…\" | swrag sql`), use a heredoc " +
          "(`swrag sql <<'SQL' … SQL`), or redirect a file (`swrag sql < file.sql`).",
      );
      process.exit(2);
    }

    const { paths } = ctx();
    const r = await runSql({
      sql,
      archive: paths.archive,
      sourceDb: paths.sourceDb,
      sourceDir: paths.sourceDir,
      embedModel: paths.embedModel,
      ollamaHost: paths.ollamaHost,
      extraArgs: [...PASSTHROUGH_ARGS],
    });
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.exitCode);
  },
});

/* -------------------------------------------------------------------------- */
/* index — Super Whisper ingestion                                            */
/* -------------------------------------------------------------------------- */

const indexCmd = defineCommand({
  meta: {
    name: "index",
    description: "Ingest changes from Super Whisper into the archive",
  },
  args: {},
  async run() {
    const { env, paths } = ctx();
    await runIndex({
      ...paths,
      skipEmbeddings: env.SWRAG_SKIP_EMBED,
    });
  },
});

/* -------------------------------------------------------------------------- */
/* doctor                                                                     */
/* -------------------------------------------------------------------------- */

const doctorCmd = defineCommand({
  meta: { name: "doctor", description: "Verify your setup" },
  args: {},
  async run() {
    const r = await runDoctor(ctx().paths);
    process.stdout.write(r.output);
    process.exit(r.exitCode);
  },
});

/* -------------------------------------------------------------------------- */
/* bootstrap — one-shot post-install finisher                                 */
/* -------------------------------------------------------------------------- */

const bootstrapCmd = defineCommand({
  meta: {
    name: "bootstrap",
    description:
      "One-shot post-install: start ollama, pull the embed model, migrate from any v0.9.x install, index the archive, enable the event-driven watch agent, install the agent skill, and verify. Safe to re-run.",
  },
  args: {},
  async run() {
    const r = await runBootstrap(ctx().paths);
    process.exit(r.exitCode);
  },
});

/* -------------------------------------------------------------------------- */
/* watch — long-running FSEvents daemon                                       */
/* -------------------------------------------------------------------------- */

const watchCmd = defineCommand({
  meta: {
    name: "watch",
    description:
      "Run the FSEvents-based watch daemon in the foreground (intended for launchd; use `swrag enable-watch` to install it).",
  },
  args: {},
  async run() {
    const { env, paths } = ctx();
    await runWatchCommand({
      archive: paths.archive,
      sourceDir: paths.sourceDir,
      sourceDb: paths.sourceDb,
      embedModel: paths.embedModel,
      ollamaHost: paths.ollamaHost,
      skipEmbeddings: env.SWRAG_SKIP_EMBED,
    });
  },
});

/* -------------------------------------------------------------------------- */
/* path — print a filesystem path                                             */
/* -------------------------------------------------------------------------- */

const pathCmd = defineCommand({
  meta: {
    name: "path",
    description: "Print a path: archive (default), sqlite3, or vec0",
  },
  args: {
    target: {
      type: "positional",
      required: false,
      description: "archive | sqlite3 | vec0",
    },
  },
  run({ args }) {
    const target = PathTargetSchema.parse(asString(args.target) ?? "archive");
    process.stdout.write(`${getPath({ target, archive: ctx().paths.archive })}\n`);
  },
});

/* -------------------------------------------------------------------------- */
/* embed — print a vector as a SQL blob literal                               */
/* -------------------------------------------------------------------------- */

const embedCmd = defineCommand({
  meta: {
    name: "embed",
    description:
      "Emit a SQL blob literal (x'…') of the given text's embedding. Pipe text via stdin (`echo 'text' | swrag embed`) or a quoted heredoc (`swrag embed <<'EOF' … EOF`) — stdin avoids shell-quoting hazards for text containing apostrophes, quotes, $, or backticks. No positional.",
  },
  args: {
    text: {
      type: "positional",
      required: false,
      description:
        "Not used. `swrag embed` reads text from stdin only; a positional is rejected with an error pointing to the pipe/heredoc forms.",
    },
  },
  async run({ args }) {
    const arg = asString(args.text);
    if (arg != null) {
      error(
        "swrag embed reads text from stdin only — a positional isn't accepted. " +
          "Pipe it (`echo 'text' | swrag embed`) or use a quoted heredoc " +
          "(`swrag embed <<'EOF' … EOF`) for text with apostrophes, quotes, $, or backticks.",
      );
      process.exit(2);
    }
    let text: string;
    if (stdinIsPiped()) {
      text = (await readAllStdin()).trim();
    } else {
      error(
        "no text to embed: pipe it (`echo 'text' | swrag embed`) or use a " +
          "quoted heredoc (`swrag embed <<'EOF' … EOF`).",
      );
      process.exit(2);
    }
    if (text.length === 0) {
      error("no text to embed: the input was empty.");
      process.exit(2);
    }
    const { paths } = ctx();
    process.stdout.write(
      await runEmbed({
        text,
        embedModel: paths.embedModel,
        ollamaHost: paths.ollamaHost,
      }),
    );
  },
});

/* -------------------------------------------------------------------------- */
/* install-skill / enable-watch / disable-watch                               */
/* -------------------------------------------------------------------------- */

const installSkillCmd = defineCommand({
  meta: {
    name: "install-skill",
    description: "Install the manual-invocation SKILL.md to ~/.cursor and ~/.claude",
  },
  args: {},
  async run() {
    const results = await installSkill(ctx().paths.archive);
    for (const r of results) {
      process.stdout.write(`${r.action}: ${r.path}\n`);
    }
  },
});

const enableWatchCmd = defineCommand({
  meta: {
    name: "enable-watch",
    description: "Install the keepalive launchd watch agent (event-driven ingest)",
  },
  args: {},
  async run() {
    await enableWatch({ binPath: resolveBinPath() });
  },
});

const disableWatchCmd = defineCommand({
  meta: { name: "disable-watch", description: "Remove the launchd watch agent" },
  args: {},
  async run() {
    await disableWatch();
  },
});

/**
 * Resolve the binary path that the launchd plist should embed.
 *
 * We deliberately prefer Homebrew's stable symlink (`/opt/homebrew/bin/swrag`)
 * over the version-specific Cellar realpath. On `brew upgrade superwhisper-rag`
 * the new bottle lands at a fresh Cellar dir, the symlink is rewired
 * atomically, and `brew cleanup` deletes the old Cellar — which would
 * leave a launchd plist pointing at a deleted realpath. The symlink
 * survives upgrades, so the plist captured by `swrag enable-watch` keeps
 * working across versions without re-running the command.
 *
 * Resolution order:
 *   1. /opt/homebrew/bin/swrag                    (Apple Silicon brew)
 *   2. /usr/local/bin/swrag                       (Intel brew)
 *   3. realpath(process.execPath)                 (compiled binary outside brew)
 *
 * If none of those resolve we throw rather than write a plist that
 * points at a path which is known not to exist — the user would only
 * discover the breakage when launchd silently failed to start the
 * watch daemon.
 */
function resolveBinPath(): string {
  for (const p of ["/opt/homebrew/bin/swrag", "/usr/local/bin/swrag"]) {
    if (existsSync(p)) return p;
  }
  const execPath = process.execPath;
  if (execPath && !execPath.endsWith("/bun")) {
    try {
      return realpathSync(execPath);
    } catch {
      return execPath;
    }
  }
  throw new Error(
    "cannot resolve a stable swrag binary path for launchd. " +
      "Install via Homebrew (`brew install NikitaHerndlhofer/tap/superwhisper-rag`) " +
      "and re-run `swrag enable-watch`.",
  );
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

const main = defineCommand({
  meta: {
    name: "swrag",
    version: VERSION,
    description:
      "Thin sqlite3 wrapper for your Super Whisper dictation archive. Adds an event-driven watch daemon and an embed() shortcut.",
  },
  subCommands: {
    sql: sqlCmd,
    index: indexCmd,
    doctor: doctorCmd,
    bootstrap: bootstrapCmd,
    path: pathCmd,
    embed: embedCmd,
    "install-skill": installSkillCmd,
    watch: watchCmd,
    "enable-watch": enableWatchCmd,
    "disable-watch": disableWatchCmd,
  },
});

runMain(main).catch((e: unknown) => {
  error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
