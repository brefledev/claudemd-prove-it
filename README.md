# claudemd-prove-it

[![test](https://github.com/brefledev/claudemd-prove-it/actions/workflows/test.yml/badge.svg)](https://github.com/brefledev/claudemd-prove-it/actions/workflows/test.yml)

Your CLAUDE.md is full of rules written like law: never force-push, don't touch that folder. The Claude Code docs state what those rules are worth:

> Claude treats them as context, not enforced configuration. To block an action
> regardless of what Claude decides, use a PreToolUse hook instead.
> — [code.claude.com/docs/en/memory](https://code.claude.com/docs/en/memory)

Caps-lock changes nothing. NEVER, ALWAYS, MUST — the model reads them as ambiance. Every rule in your CLAUDE.md sits in one of two buckets. Either a hook or a permission in .claude/settings.json backs it, so the rule applies regardless of what the model decides. Or, it’s an instruction in a context file, obeyed until the model gets busy, finds a loophole, and appoints itself the exception.

`claudemd-prove-it` reads every memory file Claude Code would load, reads your settings files (user, project, local, managed policy, and the hooks of enabled plugins), and maps each rule to the hook or permission that enforces it. Rules with nothing behind them get counted and listed. One file, Node stdlib only, no dependencies. It reads your project. It writes nothing and spawns nothing.

**The mapping below `wired` is heuristic.** Matching English sentences to shell hooks requires inference, so each result shows its evidence and confidence level. The output never states an inferred link as fact. Annotate the rule as described below, and the check becomes a plain existence test: pass or fail.

## Installation, all one file of it

```bash
# grab the one file (there is only one)
curl -O https://raw.githubusercontent.com/brefledev/claudemd-prove-it/main/prove-it.mjs

# audit the current project
node prove-it.mjs

# machine-readable, for CI
node prove-it.mjs --json

# fail the build on warnings too
node prove-it.mjs --strict
```

Exit codes are blunt: `0` no errors (warnings allowed), `1` errors (a broken import, a rule claiming enforcement that does not exist, a hook whose script is gone, a permission rule Claude Code never matches), `2` bad invocation. `--strict` promotes warnings to failures.

## What a run looks like

Run against the vault this tool was built in, whose CLAUDE.md imports an AGENTS.md:

```
Grade: C (70/100)   integrity 100 · enforcement 15 · context 58 · clarity 100

CONTEXT COST
  AGENTS.md                         134 lines   ~5,150 tokens  via CLAUDE.md:3
  loaded every session: ~5,158 tokens
  plus SessionStart hooks: 24 commands, ~1,310 tokens of literal text; 20 print
    script output this audit cannot measure

ENFORCEMENT MAP
  ~ likely   | protected/ | AI read-only. Writing, moving and renaming...   AGENTS.md:58
      rule mentions `protected`; deny rule Edit(/protected/**) covers it
  ~ likely   | system/ | Instructions, skills, scripts, schemas...        AGENTS.md:60
      rule mentions `system/authority`; deny rule Edit(/system/authority/**) covers it
  · 14 rules have no enforcement signal (12 of them are hard never/always/must rules)

NOTES
  - a PreToolUse hook (matcher: AskUserQuestion, claude-adapter.mjs askgate) can
    enforce something no memory-file rule describes — document it or remove it
```

That last section is the reverse check: hooks that can enforce rules your memory files never mention. A rule without a hook fails the first time the model shrugs it off; a hook without a rule confuses the next person who reads the config.

## What “enforced” means here

Each extracted rule (a line carrying never / always / must / don't / only / required and similar markers) gets one of six verdicts:

| Verdict | Meaning | How it's decided |
|---|---|---|
| ✓ `wired` | annotation names an enforcer, and it exists | deterministic |
| ✗ `broken` | annotation names an enforcer, and it does NOT exist | deterministic, exits 1 |
| ~ `likely` | strong overlap between the rule and a hook or permission | heuristic, score ≥ 3 |
| ? `possible` | weaker overlap | heuristic, score 2 |
| ◦ `advisory` | you marked the rule as prose on purpose | declared |
| · `prose` | no enforcement signal found | default |

The heuristic scores three signals, and the report states which ones fired:

- **Path overlap (+3).** The rule mentions `protected/private`, a deny rule covers `./protected/private/**`, or a hook passes that path as an argument. Paths match by whole segments. Echoed text, bare words like `main`, the project root, and a path half your hooks name all count for nothing. Strongest signal by far.
- **Tool match (+2, or +1 after the fact).** The rule concerns Bash, subagents, or another tool, and a PreToolUse or PermissionRequest matcher covers that tool. A PostToolUse hook acts after the tool ran and earns +1. Tool names that are also English words (Read, Edit, Write, Task, Agent) count only when written as tools: `` `Read` ``, `Read(...)`, "the Read tool".
- **Name overlap (+1 to +2).** The rule shares a word of six letters or more, or its plural, with the hook's script name (`subagent-guard.mjs` → "subagent"). A dispatcher hook such as `node adapter.mjs askgate` is named by its lane, `askgate`, not by the script every lane shares.

Each hook entry and each permission rule is scored on its own, and the best one decides. One weak signal repeated across ten hooks does not add up to evidence. Only events that can stop or push back on an action count: PreToolUse, PermissionRequest, PostToolUse, UserPromptSubmit, Stop, SubagentStop. SessionStart and SessionEnd hooks inject context or observe; they enforce nothing.

**Thresholds are deliberately conservative.** A score of 1 reports as prose, because a false "this is enforced" is worse than a false "this is not."

The heuristic can be fooled. A rule that shares a word with an unrelated hook scores as `possible` and is flat wrong. That's why every verdict shows its work - so you can overrule it, or annotate the rule and skip the guessing.

## HTML comments finally get a job

Add an HTML comment naming the enforcer, on the rule's line or the line below:

```markdown
- Never write to `secrets/`. <!-- enforced-by: deny Edit(./secrets/**) -->
- Always lint after edits.   <!-- enforced-by: script lint-check.mjs -->
- No subagent swarms.        <!-- enforced-by: hook PreToolUse Task -->
- Answer first, short.       <!-- enforced-by: none -->
```

Three selector forms: `deny|ask|allow <rule>` exactly matches a permission entry, `script <name>` matches an existing script run by an active hook, `hook <Event> <text>` matches an active event's matcher or command. `none` says "this rule is advisory on purpose" and stops the tool from counting it against you. Comma-separate multiple claims; commas inside permission parentheses stay part of that permission.

**Annotations cost zero tokens at runtime:** Claude Code strips block-level HTML comments from CLAUDE.md before injecting it into context, so the model never sees them and they never spend a token. (This tool's token estimate strips them too, for the same reason.)

The payoff = the failure mode annotations catch - **a rule that claims enforcement that is not wired.** You wrote the hook, documented it, then renamed the script or deleted the settings entry six weeks later. The comment still says enforced; the settings say otherwise. That mismatch is an error, it's listed by file and line, and it fails the exit code. A hook whose script no longer exists is an error too, annotated or not: it fails every time it fires.

**`Write(...)` rules block nothing.** Claude Code checks file access against `Edit(...)` and `Read(...)` rules only. It accepts `Write(path)`, `Glob(path)` and `Grep(path)` rules and never matches them ([docs](https://code.claude.com/docs/en/permissions)). A deny rule in that shape is an error here, with the rule to write instead, and an annotation pointing at one reports `broken`.

## More problems at no additional cost

**Context cost.** CLAUDE.md and everything it imports loads into every session you start, and you pay for it in the context window. The report shows lines and an estimated token count per file, split into loaded-every-session versus loaded-on-demand (nested CLAUDE.md files, path-scoped rules). The estimate is characters ÷ 4 with comments stripped. It's an estimate; the tool has no tokenizer and says so in the output. SessionStart hooks add their output to every session too. The tool never runs them, so it counts the text it can read (echo literals, files a hook cats) and names the scripts whose output it cannot measure.

**Import resolution.** `@path` imports are parsed the way Claude Code parses them: code spans and fenced blocks skipped, paths resolved relative to the importing file, four hops deep, cycles detected. Broken imports are errors. A bare `@scope/package` in the text gets flagged with a hint, because Claude Code will try to import it as a file unless you wrap it in backticks.

**Contradiction and duplication.** Near-duplicate rules get flagged with both locations, so you can pick one home. Rule pairs on the same subject with opposite polarity (one says never, one says always) flag as contradiction *candidates*. The docs note that when two rules conflict, the model may pick either one arbitrarily. **Judging whether a candidate is a true contradiction needs a reader;** the tool only points.

**Structure lint.** Files past the documented 200-line guidance, missing headings, ALL-CAPS emphasis dense enough to cancel itself out, and directives no one could verify ("be careful", "use best practices") each get a note with the line number.

## The judgment pass (optional) - some questions require reading

The CLI is deterministic and runs anywhere. For the judgment calls it refuses to make (does `vault-gate.mjs` cover Core Law 2? is that contradiction candidate a true conflict?), paste [PROMPT.md](PROMPT.md) into a Claude Code session in your project. Claude runs the CLI, reads the hook scripts the heuristics pointed at, and upgrades or downgrades each uncertain verdict with a stated reason. The deterministic numbers pass through untouched.

The entire pass runs in a single context. It spawns no subagents (at least, that's what the prompt instructs). An audit of one markdown file should not cost you a swarm.

## Scope

Four things this tool is not:

- **A best-practices scorer.** Plenty of those exist now. [AgentLint](https://www.agentlint.app/) runs 33 checks across five dimensions, [cclint](https://github.com/carlrannaberg/cclint) validates frontmatter and settings schemas, [AgentLinter](https://agentlinter.com/) hunts prompt injection and leaked keys, and agnix ships 156 rules plus an LSP server that lints as you type. Good tools, all of them. Every one checks how your CLAUDE.md is written. **This one checks whether the rules in it *do* anything.**
- **An auto-fixer.** It finds the problem and points. The fixing is yours.
- **A skills auditor.** For now it verifies the enforcement it can read: hooks and permissions in settings files and enabled plugins. Skills and subagent definitions shape behavior too, and can carry hooks of their own that it does not read yet, and wiring rules to those is a v2 problem I haven't solved yet.
- **A tokenizer.** Characters ÷ 4, labeled as such, every time it appears.

## A diagram would be excessive

One file because the audit is one job. The deterministic checks (existence, resolution, counting) live in code where they are testable and CI-able; the semantic checks (does this hook mean what the rule means) live in the optional prompt where a model reads the scripts in your repo, in one session. Nothing here needs a package or an agent fleet.

## License

MIT. Carry on.
