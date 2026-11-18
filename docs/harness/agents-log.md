# Harness log

What was missing → what was added → where. Environments, not prompts, carry
improvements forward.

---

- 2026-11-18 · **MAD role agents not deployed in project/session** → the
  `/mad:*` commands and `mad-guard` hook exist at user level
  (`~/.zcode/commands/mad/`, `~/.zcode/hooks/guard.mjs`), but no role agents
  are installed (`~/.zcode/agents` missing, project `.zcode/agents` missing),
  so the phase pipelines cannot dispatch analyst/pm/architect/scrum-master/dev/
  qa/reviewer. The orchestrator (main session) runs each phase itself,
  preserving the artifacts and gates. Fix option: run the harness kit's
  project installer (`D:\agent-harness-kit\install.ps1`) inside photoHistory so
  `.zcode/agents/` exists. Where: this file, process notes in `stories/`.
- 2026-11-18 · **No project verify pipeline** → AGENTS.md requires
  `verify/verify.mjs` or equivalent; the project had none → added
  `verify/verify.mjs` (typecheck + dateHints tests by default, `--rust` /
  `--build` / `--all` flags, `verify/last-run.log` trail). Where: `verify/`.
- 2026-11-18 · **No stories/ directory** → story files had no home → created
  `stories/` with STORY-001..004 context-packs. Where: `stories/`.
