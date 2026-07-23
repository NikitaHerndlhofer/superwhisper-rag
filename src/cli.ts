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
import { runSql, readSqlInput } from "./commands/sql.ts";
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
      "Run SQL through sqlite3 (vec preloaded, archive read-only, ingest first). Pipe SQL via stdin (`echo \"…\" | swrag sql`), pass it as a positional, or forward it after `--`. Use `--` to pass sqlite3 flags.",
  },
  args: {
    query: {
      type: "positional",
      required: false,
      description:
        "SQL string, '-' for stdin, or omit. With no positional and piped stdin, SQL is read from stdin; with no positional, no `--`, and a TTY, the command errors (no SQL provided).",
    },
  },
  async run({ args }) {
    const queryArg = asString(args.query);
    const explicitStdin = queryArg === "-";
    const inline = explicitStdin ? null : (queryArg ?? null);
    const passthrough = PASSTHROUGH_ARGS.length > 0;

    // Reject `swrag sql "SQL" -- <args>`. Either form is fine on its own
    // — inline SQL, or SQL forwarded inside the `--` tail — but combining
    // them used to silently drop the inline SQL. Surface the conflict
    // rather than guess which one the user wanted.
    //
    // Note: we cannot rely on citty's `args.query` to tell us whether
    // the user supplied an inline positional, because citty doesn't
    // respect `--` and will happily pull a string out of the
    // passthrough tail and into `query`. We scan argv directly instead
    // — see `hasInlinePositionalBeforeDashDash`.
    if (passthrough && hasInlinePositionalBeforeDashDash("sql")) {
      error(
        "cannot combine inline SQL with `--` passthrough. " +
          "Put your SQL either before `--`, or inside the tail after `--` — not both. " +
          "(To pipe SQL and still pass flags, use `swrag sql - -- <flags>`.)",
      );
      process.exit(2);
    }

    // Resolve the SQL. Precedence:
    //   1. `swrag sql -`            → read stdin (explicit)
    //   2. `swrag sql "SELECT …"`   → inline positional
    //   3. `echo "…" | swrag sql`   → piped stdin (no positional, no `--`)
    //   4. `swrag sql` (TTY)        → error — no SQL provided (no REPL;
    //                                 agents should never hang on a TTY)
    //
    // When `--` is present the tail owns the SQL slot, so we ignore citty's
    // positional capture (`inline`) entirely — citty doesn't respect `--`
    // and may stuff a tail positional into `query`. Only an explicit `-`
    // can override the tail (the `swrag sql - -- -json` shape: SQL from
    // stdin, flags from the tail).
    let sql: string | null;
    if (passthrough) {
      sql = explicitStdin ? (await readAllStdin()).trim() : null;
    } else if (explicitStdin) {
      sql = await readSqlInput(null, true);
    } else if (inline != null) {
      sql = inline;
    } else if (stdinIsPiped()) {
      sql = await readAllStdin();
    } else {
      error(
        "no SQL provided: pipe it (`echo \"…\" | swrag sql`), pass it as a " +
          "positional (`swrag sql \"SELECT …\"`), use `-` to read stdin, " +
          "or forward it after `--`.",
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
      "Emit a SQL blob literal (x'…') of the given text's embedding. Pass text as a positional, as '-' for stdin, or pipe it (e.g. `echo \"it's\" | swrag embed`) — stdin avoids shell-quoting hazards for text containing quotes, $, or backticks.",
  },
  args: {
    text: {
      type: "positional",
      required: false,
      description: "Text to embed, '-' for stdin, or omit to read from a pipe",
    },
  },
  async run({ args }) {
    const arg = asString(args.text);
    let text: string;
    if (arg === "-") {
      text = (await readAllStdin()).trim();
    } else if (arg != null) {
      text = arg;
    } else if (stdinIsPiped()) {
      text = (await readAllStdin()).trim();
    } else {
      error(
        "no text to embed: pass it as a positional (`swrag embed 'hi'`), " +
          "as '-' (`swrag embed -`), or via a pipe (`echo 'hi' | swrag embed`).",
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
