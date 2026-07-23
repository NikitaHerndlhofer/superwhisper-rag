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
    expect(SKILL_MD).toContain("-- 0. Discover the user's modes");
    expect(SKILL_MD).toContain("-- 3. Keyword search (FTS5, whole-row)");
    expect(SKILL_MD).toContain("-- 4. Semantic search (whole-row)");
    expect(SKILL_MD).toContain("-- 6. Hybrid (keyword + semantic), whole-row");
    expect(SKILL_MD).toContain("-- 14. Best moment per long recording");
    expect(SKILL_MD).toContain("-- 17. Hybrid (chunk-level)");
    expect(SKILL_MD).toContain("-- 18. Filter-then-retrieve (chunk)");
    expect(SKILL_MD).toContain("-- 19. Rank RECORDINGS by best-chunk match");
    expect(SKILL_MD).toContain("-- 12. Reprocessing history of a recording");
  });

  test("leads with stdin as the default input and documents the quoting-safe embed", () => {
    expect(SKILL_MD).toContain("swrag sql <<'SQL'");
    expect(SKILL_MD).toContain("QV=$(swrag embed <<'EOF'");
  });

  test("does not leak build artifacts or splice markers", () => {
    expect(SKILL_MD).not.toContain("swrag:cookbook");
    expect(SKILL_MD).not.toContain("History of this gating");
    expect(SKILL_MD).not.toContain("v0.6");
    expect(SKILL_MD).not.toContain("deliberately thin passthrough");
  });
});
