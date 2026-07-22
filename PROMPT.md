# claudemd-prove-it: judgment pass

Paste everything below this line into a Claude Code session in the project you
want audited. `prove-it.mjs` must be present (in the project or on a known path);
adjust the path in step 1 if needed.

---

Audit this project's CLAUDE.md against its Claude Code settings. Work alone in
this session: do not spawn subagents, agents, tasks, or workflows at any point.
The audit is one file and one settings surface; it fits in one context.

1. Run `node prove-it.mjs --json` from the project root and read the output. If
   the command fails, stop and report the failure instead of improvising an
   audit by hand.

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
