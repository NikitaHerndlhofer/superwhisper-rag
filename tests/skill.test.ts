import { describe, expect, test } from "bun:test";
import { SKILL_MD } from "../src/skill.ts";

describe("SKILL_MD", () => {
  test("has the manual-invocation frontmatter", () => {
    expect(SKILL_MD).toContain("name: superwhisper-rag");
    expect(SKILL_MD).toContain("disable-model-invocation: true");
  });

  test("is self-contained: carries the search variants, not splice markers", () => {
    // Canary recipes spanning listing, keyword, semantic, hybrid, chunk, and
    // history variants. If the skill body is empty or a section dropped, these fail.
    expect(SKILL_MD).toContain("-- modes — Discover the user's modes");
    expect(SKILL_MD).toContain("-- keyword — Keyword search (FTS5, whole-row)");
    expect(SKILL_MD).toContain("-- semantic — Semantic search (whole-row)");
    expect(SKILL_MD).toContain(
      "-- hybrid — Hybrid (keyword + semantic), whole-row",
    );
    expect(SKILL_MD).toContain(
      "-- best-moment — Best moment per long recording",
    );
    expect(SKILL_MD).toContain("-- hybrid-chunk — Hybrid (chunk-level)");
    expect(SKILL_MD).toContain(
      "-- filter-then-retrieve — Filter-then-retrieve (chunk)",
    );
    expect(SKILL_MD).toContain(
      "-- rank-recordings — Rank RECORDINGS by best-chunk match",
    );
    expect(SKILL_MD).toContain(
      "-- reprocess-history — Reprocessing history of a recording",
    );
    // New retrieval modalities (v1.3.0): trigram substring/fuzzy + recency-decay.
    expect(SKILL_MD).toContain(
      "-- trigram — Substring / light-fuzzy (trigram, whole-row)",
    );
    expect(SKILL_MD).toContain(
      "-- trigram-chunk — Substring / fuzzy at chunk granularity (trigram)",
    );
    expect(SKILL_MD).toContain("-- recency-decay — Recency-decay ranking");
  });

  test("documents the trigram tables in the schema section", () => {
    expect(SKILL_MD).toContain("recording_trgm");
    expect(SKILL_MD).toContain("recording_chunk_trgm");
    // The ≥3-char floor is the one trigram gotcha an agent must know.
    expect(SKILL_MD).toContain("≥3 chars");
  });

  test("leads with stdin as the default input and documents the quoting-safe embed", () => {
    expect(SKILL_MD).toContain("swrag sql <<'SQL'");
    expect(SKILL_MD).toContain("QV=$(swrag embed <<'EOF'");
    // Canonical inline embedding form (command substitution with its own stdin).
    expect(SKILL_MD).toContain(
      "$(echo 'how do notifications work' | swrag embed)",
    );
  });

  test("describes what the tool does, not what it lacks — no REPL/anti-feature bloat", () => {
    expect(SKILL_MD).not.toContain("REPL");
    expect(SKILL_MD).not.toContain("Doesn't support");
    expect(SKILL_MD).not.toContain("does not support");
  });

  test("does not leak build artifacts or splice markers", () => {
    expect(SKILL_MD).not.toContain("swrag:cookbook");
    expect(SKILL_MD).not.toContain("History of this gating");
    expect(SKILL_MD).not.toContain("v0.6");
    expect(SKILL_MD).not.toContain("deliberately thin passthrough");
  });
});
