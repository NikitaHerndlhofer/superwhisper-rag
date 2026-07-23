/**
 * Stdin helpers shared by `swrag sql` and `swrag embed`.
 *
 * Both commands accept input from a positional argument OR from stdin.
 * Stdin is the quoting-safe path: a *quoted* heredoc (`<<'EOF'`) disables
 * all shell expansion, so text containing `'`, `$`, or backticks lands
 * verbatim — no escaping to forget. That matters most for `swrag embed`,
 * whose text is user speech (full of apostrophes) and which feeds a blob
 * literal into SQL.
 */

/** Read all of stdin to a UTF-8 string. */
export async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * True iff stdin is piped/redirected (not an interactive terminal).
 *
 * `process.stdin.isTTY` is `true` only when stdin is a real TTY. It is
 * `undefined` for pipes, files, and `Bun.spawnSync({ stdin: "pipe" })`,
 * and `false` in some runtimes. Treat anything that isn't explicitly a
 * TTY as "piped" so `echo "…" | swrag …` and `swrag … < file` both read
 * stdin instead of erroring on missing input.
 */
export function stdinIsPiped(): boolean {
  return process.stdin.isTTY !== true;
}
