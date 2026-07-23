import { embedOne } from "../embed/ollama.ts";

export interface EmbedOptions {
  text: string;
  embedModel: string;
  ollamaHost: string;
}

/**
 * Compute an embedding and emit it as a SQLite blob literal (`x'…'`).
 *
 * Designed for shell composition with `swrag sql` (both read from stdin).
 * The quoting-safe form reads the embed text from a quoted heredoc (which
 * disables all shell expansion), captures the blob in a variable, and
 * interpolates that variable into the SQL heredoc — the blob is hex + `x''`,
 * so it carries no shell metacharacters:
 *
 *   QV=$(swrag embed <<'EOF'
 *   text with 'apostrophes', $vars, and `backticks`
 *   EOF
 *   )
 *   swrag sql <<SQL
 *   SELECT folder_name FROM recording_vec
 *   ORDER BY vec_distance_cosine(embedding, $QV)
 *   LIMIT 10;
 *   SQL
 *
 * The inline form is fine for simple text with no metacharacters — the
 * `$(echo '…' | swrag embed)` runs in a subshell with its own stdin:
 *
 *   swrag sql <<SQL
 *   … vec_distance_cosine(embedding, $(echo 'hello' | swrag embed)) …
 *   SQL
 *
 * Or with raw sqlite3:
 *
 *   sqlite3 "$(swrag path)" \
 *     -cmd ".load $(swrag path vec0) sqlite3_vec_init" \
 *     "SELECT ... vec_distance_cosine(embedding, $(echo 'hello' | swrag embed)) ..."
 */
export async function runEmbed(opts: EmbedOptions): Promise<string> {
  const vec = await embedOne(opts.text, {
    host: opts.ollamaHost,
    model: opts.embedModel,
  });
  return `${floatVecToBlobLiteral(vec)}\n`;
}

/**
 * Encode a Float32Array as a SQLite blob literal (`x'aabbcc…'`) suitable
 * for inlining into a SQL string.
 *
 * Bytes are host-native order. This only works because every supported
 * target (darwin-arm64, darwin-x64) is little-endian, which matches
 * sqlite-vec's on-disk Float32 layout. If we ever ship a big-endian
 * target we'd need to byte-swap here.
 */
function floatVecToBlobLiteral(vec: Float32Array): string {
  const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return `x'${hex}'`;
}
