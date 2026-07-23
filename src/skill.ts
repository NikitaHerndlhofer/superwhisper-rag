/**
 * The full `SKILL.md` body, imported from `src/skill.md` so the skill content
 * lives in a plain Markdown file (syntax highlighting, easy review/edit) and
 * is inlined into the compiled binary as a string at build time.
 *
 * Written to both:
 *   ~/.cursor/skills/superwhisper-rag/SKILL.md
 *   ~/.claude/skills/superwhisper-rag/SKILL.md
 *
 * Frontmatter contract (per Anthropic Agent Skills spec — see
 * https://docs.anthropic.com/en/docs/claude-code/skills):
 *
 *   `name`                           — skill identifier.
 *   `description`                    — shown in the user's `/skills` picker.
 *                                      Does NOT enter the agent's context when
 *                                      `disable-model-invocation` is true.
 *   `disable-model-invocation: true` — runtime-enforced opt-out from
 *                                      auto-routing. The user explicitly
 *                                      summons the skill (`/superwhisper-rag`
 *                                      in Claude Code, `@superwhisper-rag` in
 *                                      Cursor) and the agent has no mechanism
 *                                      to reach for it on its own.
 */
import SKILL_MD from "./skill.md" with { type: "text" };

export { SKILL_MD };
