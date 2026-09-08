---
name: claudemd-prove-it
description: Audit CLAUDE.md against .claude/settings.json. Reports which rules are enforced by hooks/permissions and which are prose, plus context cost, import resolution, contradictions, and structure. Use when the user asks to audit, check, lint, or grade their CLAUDE.md, or asks whether their Claude Code rules are enforced.
---

# claudemd-prove-it

Audit the current project's CLAUDE.md against its Claude Code settings. Work
alone in this session: do not spawn subagents, agents, tasks, or workflows at
any point. The audit is one file and one settings surface; it fits in one
context.

1. Locate `prove-it.mjs`. Look in this skill's directory first, then the project
   root. Run `node prove-it.mjs --json` from the project root and read stdout
   even when the command exits 1; exit 1 is a complete audit containing
   ordinary findings. Stop only when it exits 2, crashes, or produces no valid
   JSON.

2. The JSON is the deterministic layer. Its numbers pass through to your
   report unchanged: token estimates, import errors, broken enforcement
   claims, file lists, the grade inputs. Do not recompute or second-guess
   them.

3. Your job is the verdicts the CLI refuses to make:
   - For every rule marked `likely` or `possible`, open the hook script or
     settings entry named in its evidence. Read what the code does. Then
     state one of: CONFIRMED (the mechanism enforces this rule; say how),
     PARTIAL (it enforces a slice of the rule; name the slice and what is
     uncovered), or UNRELATED (the overlap was coincidence; downgrade to
     prose). Quote the line of the script that decides your call.
   - For every hook listed as enforcing something no rule states, read its
     script and say in one sentence what it enforces, so the user can decide
     whether to write the missing rule.
   - For every contradiction candidate, read the two rules in place and say
     whether they conflict for a model following them, or only share words.

4. Label every judgment as yours. The CLI's verdicts are marked heuristic;
   yours are marked judged. Never present either as verified fact: the only
   verified facts in this audit are existence checks and file contents.

5. Report format: the CLI's grade line first, then your judged enforcement
   map (one line per rule: verdict, rule, mechanism, your one-sentence
   reason), then unwritten hooks, then contradictions, then the three fixes
   with the highest payoff. Keep it short enough to read in one sitting.
