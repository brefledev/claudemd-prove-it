import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const doctor = process.env.PROVE_IT || join(here, '..', 'prove-it.mjs');
const fixture = name => join(here, 'fixtures', name);
const tempRoots = [];

// Every run isolates from the machine: no user settings, no ancestor CLAUDE.md.
function run(dir, ...extra) {
  const args = [doctor, dir, '--json', '--project-only', '--no-ancestors', ...extra];
  try {
    const stdout = execFileSync(process.execPath, args, { encoding: 'utf8' });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (e) {
    if (e.stdout === undefined) throw e;
    return { code: e.status, report: e.stdout ? JSON.parse(e.stdout) : null };
  }
}

function project(files = {}, settings) {
  const dir = mkdtempSync(join(tmpdir(), 'prove-it-'));
  tempRoots.push(dir);
  const all = { 'CLAUDE.md': '# Rules\n', ...files };
  if (settings !== undefined) all['.claude/settings.json'] = typeof settings === 'string' ? settings : JSON.stringify(settings);
  for (const [name, content] of Object.entries(all)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return dir;
}

function runRaw(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [doctor, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: 0, stdout, report: stdout.trim().startsWith('{') ? JSON.parse(stdout) : null };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', report: e.stdout?.trim().startsWith('{') ? JSON.parse(e.stdout) : null };
  }
}

const finding = (report, code) => report.findings.some(f => f.code === code);
const rule = (report, text) => report.map.find(m => m.text.includes(text));

after(() => {
  for (const dir of tempRoots) rmSync(dir, { recursive: true, force: true });
});

test('clean fixture: exit 0, both annotated rules verify as wired, grade A', () => {
  const { code, report } = run(fixture('clean'));
  assert.equal(code, 0);
  const wired = report.map.filter(m => m.verdict === 'wired');
  assert.equal(wired.length, 2);
  assert.equal(report.findings.filter(f => f.level === 'error').length, 0);
  assert.equal(report.score.enforcement, 100);
  assert.equal(report.score.grade, 'A');
});

test('clean fixture: @import resolves and is counted in launch cost', () => {
  const { report } = run(fixture('clean'));
  const imported = report.cost.launch.find(f => f.kind === 'import');
  assert.ok(imported, 'imported file missing from launch cost');
  assert.match(imported.path, /docs\/style\.md$/);
});

test('clean fixture: token estimate strips HTML comments like the loader does', () => {
  const { report } = run(fixture('clean'));
  const main = report.cost.launch.find(f => f.kind === 'project');
  assert.ok(main.estTokens > 0);
  // the file carries two annotation comments, so the estimate must sit below raw chars/4
  assert.ok(main.estTokens < Math.ceil(main.chars / 4), 'comments were billed as context');
});

test('broken fixture: exit 1 with broken-claim and broken-import errors', () => {
  const { code, report } = run(fixture('broken'));
  assert.equal(code, 1);
  const codes = report.findings.filter(f => f.level === 'error').map(f => f.code);
  assert.ok(codes.includes('broken-claim'), `missing broken-claim in ${codes}`);
  assert.ok(codes.includes('broken-import'), `missing broken-import in ${codes}`);
  const broken = report.map.find(m => m.verdict === 'broken');
  assert.ok(broken, 'no rule marked broken in the enforcement map');
  assert.match(broken.evidence.join(' '), /git-guard\.sh/);
});

test('mixed fixture: heuristic tiers land where designed', () => {
  const { code, report } = run(fixture('mixed'));
  assert.equal(code, 0);

  const byText = needle => report.map.find(m => m.text.includes(needle));
  assert.equal(byText('protected').verdict, 'likely');
  assert.equal(byText('subagents').verdict, 'likely');
  assert.equal(byText('curl').verdict, 'possible');
  assert.equal(byText('completion').verdict, 'prose');

  // every heuristic verdict carries evidence; prose carries none
  for (const m of report.map) {
    if (m.verdict === 'likely' || m.verdict === 'possible') {
      assert.ok(m.evidence.length > 0, `${m.text} has no evidence`);
    }
  }
});

test('mixed fixture: duplicate and contradiction candidates are flagged as warnings', () => {
  const { report } = run(fixture('mixed'));
  const codes = report.findings.filter(f => f.level === 'warn').map(f => f.code);
  assert.ok(codes.includes('duplicate'), `missing duplicate in ${codes}`);
  assert.ok(codes.includes('contradiction-candidate'), `missing contradiction-candidate in ${codes}`);
});

test('mixed fixture: --strict promotes warnings to a failing exit code', () => {
  const { code } = run(fixture('mixed'), '--strict');
  assert.equal(code, 1);
});

test('broken fixture: a hook no rule mentions is reported as unwritten enforcement', () => {
  const { report } = run(fixture('broken'));
  const note = report.findings.find(f => f.code === 'unwritten-hook');
  assert.ok(note, 'missing unwritten-hook note');
  assert.match(note.msg, /url-guard\.mjs/);
});

test('nonexistent directory: exit 2', () => {
  try {
    execFileSync(process.execPath, [doctor, join(here, 'no-such-dir'), '--json'], { encoding: 'utf8' });
    assert.fail('should have exited nonzero');
  } catch (e) {
    assert.equal(e.status, 2);
  }
});

test('json report carries the settings surface for the judgment layer', () => {
  const { report } = run(fixture('mixed'));
  assert.ok(report.surface.hooks.some(h => h.scripts.includes('subagent-guard.mjs')));
  assert.ok(report.surface.permissions.some(p => p.rule === 'Edit(./protected/**)'));
});

test('findings 1-2: script claims require an existing script and active hooks', () => {
  const hook = disabled => ({ disableAllHooks: disabled, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard.mjs' }] }] } });
  const missing = project({ 'CLAUDE.md': '- Never force-push. <!-- enforced-by: script guard.mjs -->' }, hook(false));
  assert.equal(rule(run(missing).report, 'force-push').verdict, 'broken');
  const disabled = project({ 'CLAUDE.md': '- Never force-push. <!-- enforced-by: script guard.mjs -->', 'guard.mjs': '' }, hook(true));
  assert.equal(rule(run(disabled).report, 'force-push').verdict, 'broken');
});

test('findings 3-4: annotations bind to their own rule and explicit claims are audited', () => {
  const adjacent = project({ 'CLAUDE.md': '- Never write secrets.\n- Always run tests. <!-- enforced-by: none -->' }, {});
  const adjacentReport = run(adjacent).report;
  assert.equal(rule(adjacentReport, 'write secrets').verdict, 'prose');
  assert.equal(rule(adjacentReport, 'run tests').verdict, 'advisory');
  const explicit = project({ 'CLAUDE.md': '- No subagent swarms. <!-- enforced-by: hook PreToolUse Task -->' }, {});
  assert.equal(rule(run(explicit).report, 'subagent swarms').verdict, 'broken');
});

test('findings 5-7: permission spaces and commas are literal; blank annotations fail', () => {
  const spaces = project({ 'CLAUDE.md': '- Never inspect status. <!-- enforced-by: deny Bash(git status) -->' }, { permissions: { deny: ['Bash(gitstatus)'] } });
  assert.equal(rule(run(spaces).report, 'inspect status').verdict, 'broken');
  const comma = project({ 'CLAUDE.md': '- Never read backups. <!-- enforced-by: deny Read(./private,backup/**) -->' }, { permissions: { deny: ['Read(./private,backup/**)'] } });
  assert.equal(rule(run(comma).report, 'read backups').verdict, 'wired');
  const blank = project({ 'CLAUDE.md': '- Never write secrets. <!-- enforced-by: -->' }, {});
  assert.equal(rule(run(blank).report, 'write secrets').verdict, 'broken');
});

test('finding 8: exec-form hook args retain script paths', () => {
  const dir = project({ 'CLAUDE.md': '- Always run checks. <!-- enforced-by: script guard.mjs -->', 'guard.mjs': '' }, {
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: ['guard.mjs'] }] }] },
  });
  assert.equal(rule(run(dir).report, 'run checks').verdict, 'wired');
});

test('finding 9: CLAUDE_CONFIG_DIR supplies user memory and settings', () => {
  const dir = project({ 'CLAUDE.md': '- Project guidance.' });
  const profile = project({ 'CLAUDE.md': '- Never inspect status. <!-- enforced-by: deny Bash(git status) -->', 'settings.json': JSON.stringify({ permissions: { deny: ['Bash(git status)'] } }) });
  const result = runRaw([dir, '--json', '--user', '--no-ancestors'], { CLAUDE_CONFIG_DIR: profile });
  assert.equal(result.code, 0);
  assert.equal(rule(result.report, 'inspect status').verdict, 'wired');
  assert.ok(result.report.cost.launch.some(f => f.kind === 'user'));
});

test('findings 10-12 and 28: imports parse absolute paths, skip comments/fences, and report the @ line', () => {
  const absolute = project({ 'CLAUDE.md': '@/definitely-missing-review-file.md\n@E:/definitely-missing-review-file.md' }, {});
  const messages = run(absolute).report.findings.filter(f => f.code === 'broken-import').map(f => f.msg);
  assert.equal(messages.length, 2);
  assert.ok(messages.some(m => m.includes('@/definitely')));
  assert.ok(messages.some(m => m.includes('@E:/definitely')));

  const inactive = project({ 'CLAUDE.md': '<!--\n@missing-comment.md\nNever write secrets.\n-->\n\n````markdown\n```js\n@missing-fence.md\nNever edit output.\n```\n````' }, {});
  const inactiveReport = run(inactive).report;
  assert.equal(inactiveReport.findings.filter(f => f.code === 'broken-import').length, 0);
  assert.equal(inactiveReport.map.length, 0);

  const commentFence = project({ 'CLAUDE.md': '<!--\n```\n@missing.md\n-->\nNever edit credentials.' }, {});
  const commentFenceReport = run(commentFence).report;
  assert.equal(finding(commentFenceReport, 'broken-import'), false);
  assert.ok(rule(commentFenceReport, 'edit credentials'));

  const inlineComment = project({ 'CLAUDE.md': 'Use `<!--` to open a comment.\nNever edit credentials.' }, {});
  assert.ok(rule(run(inlineComment).report, 'edit credentials'));
  const fencedComment = project({ 'CLAUDE.md': '```html <!-- example\n@missing.md\n```\nNever edit credentials.' }, {});
  const fencedCommentReport = run(fencedComment).report;
  assert.equal(finding(fencedCommentReport, 'broken-import'), false);
  assert.ok(rule(fencedCommentReport, 'edit credentials'));

  const lines = project({ 'CLAUDE.md': '# Rules\n\n\n\n@missing.md' }, {});
  assert.match(run(lines).report.findings.find(f => f.code === 'broken-import').msg, /CLAUDE\.md:5 /);
});

test('findings 13-14: imported nested memory is promoted and lazy-file imports are validated', () => {
  const promoted = project({ 'CLAUDE.md': '@src/CLAUDE.md', 'src/CLAUDE.md': '- Never edit generated output.' }, {});
  const promotedReport = run(promoted).report;
  assert.ok(promotedReport.cost.launch.some(f => /src\/CLAUDE\.md$/.test(f.path)));
  assert.equal(rule(promotedReport, 'generated output').strength, 'hard');

  const lazy = project({ 'src/CLAUDE.md': '@missing-nested.md', '.claude/rules/scoped.md': '---\npaths:\n  - src/**\n---\n@missing-scoped.md' }, {});
  assert.equal(run(lazy).report.findings.filter(f => f.code === 'broken-import').length, 2);
});

test('finding 15: deep branches do not stop shallow sibling scans', () => {
  const files = { 'a-shallow/CLAUDE.md': '- Never edit shallow files.', 'a-shallow/index.ts': '', '.claude/rules/scoped.md': '---\npaths:\n  - a-shallow/*.ts\n---\n- Never edit scoped files.' };
  files['z-deep/1/2/3/4/5/6/leaf.txt'] = '';
  const report = run(project(files, {}), '--strict').report;
  assert.ok(report.cost.onDemand.some(f => /a-shallow\/CLAUDE\.md$/.test(f.path)));
  assert.equal(finding(report, 'dead-rule'), false);
});

test('findings 16-17: YAML path lists, comments, classes, and brace wildcards match files', () => {
  const files = {
    'src/a.ts': '', 'lib/nested/b.ts': '',
    '.claude/rules/flow.md': '---\npaths: ["src/[ab].ts"]\n---\n- Never edit flow files.',
    '.claude/rules/comment.md': '---\npaths:\n  - "src/**" # source files\n---\n- Never edit source files.',
    '.claude/rules/brace.md': '---\npaths:\n  - "{src/**,lib/**}"\n---\n- Never edit library files.',
  };
  const report = run(project(files, {}), '--strict').report;
  assert.equal(finding(report, 'dead-rule'), false);
  assert.equal(report.cost.launch.filter(f => f.kind === 'rule').length, 0);
});

test('finding 18: linked rule directories are traversed', () => {
  const dir = project({}, {});
  const shared = project({ 'security.md': '- Never write credentials.' });
  mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
  symlinkSync(shared, join(dir, '.claude', 'rules', 'shared'), 'junction');
  assert.ok(rule(run(dir).report, 'write credentials'));
});

test('finding 19: claudeMdExcludes removes matched rules from findings and cost', () => {
  const dir = project({ '.claude/rules/disabled.md': '- Never write secrets. <!-- enforced-by: script absent.mjs -->' }, { claudeMdExcludes: ['**/.claude/rules/disabled.md'] });
  const report = run(dir).report;
  assert.equal(finding(report, 'broken-claim'), false);
  assert.equal(report.cost.launch.some(f => /disabled\.md$/.test(f.path)), false);
});

test('findings 20-21: directory imports fail and unreachable fifth-hop targets stay warnings', () => {
  const directory = project({ 'CLAUDE.md': '@docs' }, {});
  mkdirSync(join(directory, 'docs'));
  assert.equal(finding(run(directory).report, 'broken-import'), true);

  const chain = project({ 'CLAUDE.md': '@one.md', 'one.md': '@two.md', 'two.md': '@three.md', 'three.md': '@four.md', 'four.md': '@five.md' }, {});
  const report = run(chain).report;
  assert.equal(finding(report, 'broken-import'), false);
  assert.equal(finding(report, 'import-depth'), true);
});

test('findings 22-23: exact repeats are duplicates and direct opposites are contradictions', () => {
  const duplicate = run(project({ 'CLAUDE.md': '- Never edit generated files inside build.\n- Never edit generated files inside build.' }, {})).report;
  assert.equal(finding(duplicate, 'duplicate'), true);
  const opposite = run(project({ 'CLAUDE.md': '- Never edit generated files inside build.\n- Always edit generated files inside build.' }, {})).report;
  assert.equal(finding(opposite, 'contradiction-candidate'), true);
  assert.equal(finding(opposite, 'duplicate'), false);
});

test('finding 24: regex and wildcard hook matchers contribute tool evidence', () => {
  for (const matcher of ['^(Bash|Edit)$', '*']) {
    const dir = project({ 'CLAUDE.md': '- Never run curl in Bash.', 'check.mjs': '' }, { hooks: { PreToolUse: [{ matcher, hooks: [{ type: 'command', command: 'node check.mjs' }] }] } });
    assert.notEqual(rule(run(dir).report, 'curl in Bash').verdict, 'prose');
  }
});

test('finding 25: gitignore globs cover CLAUDE.local.md', () => {
  const dir = project({ 'CLAUDE.local.md': '- Personal note.', '.gitignore': '*.local.md' }, {});
  assert.equal(finding(run(dir, '--strict').report, 'local-not-ignored'), false);
});

test('finding 26: malformed settings shapes return JSON findings instead of crashing', () => {
  for (const settings of ['null', '{"hooks":{"PreToolUse":[{"hooks":{}}]}}']) {
    const result = runRaw([project({}, settings), '--json', '--project-only', '--no-ancestors']);
    assert.ok(result.report, `missing JSON for ${settings}`);
  }
});

test('finding 27: judgment instructions accept ordinary exit-1 audit reports', () => {
  const result = run(fixture('broken'));
  assert.equal(result.code, 1);
  assert.ok(result.report);
  for (const path of [join(here, '..', 'PROMPT.md'), join(here, '..', 'skills', 'claudemd-prove-it', 'SKILL.md')]) {
    const instructions = readFileSync(path, 'utf8');
    assert.match(instructions, /read stdout[\s\S]*exits 1/);
    assert.match(instructions, /Stop only when it exits 2/);
  }
});

test('finding 29: -h prints help and exits zero', () => {
  const result = runRaw(['-h']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /node prove-it\.mjs \[dir\]/);
});

test('script paths support args, spaces, drive paths, and project placeholders', () => {
  const dir = project({
    'CLAUDE.md': '- Always run checks. <!-- enforced-by: script guard.mjs -->',
    'dir with space/guard.mjs': '',
  }, { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: ['dir with space/guard.mjs'] }] }] } });
  assert.equal(rule(run(dir).report, 'run checks').verdict, 'wired');
  const placeholder = project({ 'CLAUDE.md': '- Always run checks. <!-- enforced-by: script guard.mjs -->', 'guard.mjs': '' }, {
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}/guard.mjs"' }] }] },
  });
  assert.equal(rule(run(placeholder).report, 'run checks').verdict, 'wired');
  const splitQuote = project({ 'CLAUDE.md': '- Always run checks. <!-- enforced-by: script guard.mjs -->', 'scripts/guard.mjs': '' }, {
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'node "${CLAUDE_PROJECT_DIR}"/scripts/guard.mjs' }] }] },
  });
  assert.equal(rule(run(splitQuote).report, 'run checks').verdict, 'wired');
  const absoluteScript = join(dir, 'dir with space', 'guard.mjs');
  const absolute = project({ 'CLAUDE.md': '- Always run checks. <!-- enforced-by: script guard.mjs -->' }, {
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: `node "${absoluteScript}"` }] }] },
  });
  assert.equal(rule(run(absolute).report, 'run checks').verdict, 'wired');
});

// ---------- accuracy regressions (2026-11-24 audit) ----------
const hookOn = (event, matcher, command) => ({ [event]: [{ ...(matcher === null ? {} : { matcher }), hooks: [{ type: 'command', command }] }] });

test('accuracy 1: a hook whose script is missing is an error, not silently dropped', () => {
  const dir = project({ 'CLAUDE.md': '- Never run curl in Bash.' }, { hooks: hookOn('PreToolUse', 'Bash', 'node scripts/gone-guard.mjs') });
  const { code, report } = run(dir);
  assert.equal(code, 1);
  const f = report.findings.find(x => x.code === 'hook-script-missing');
  assert.ok(f, `missing hook-script-missing in ${report.findings.map(x => x.code)}`);
  assert.match(f.msg, /gone-guard\.mjs/);
  const unresolvable = project({ 'CLAUDE.md': '# Rules' }, { hooks: hookOn('PreToolUse', 'Bash', 'node "$TOOLS_DIR/guard.mjs"') });
  assert.equal(finding(run(unresolvable).report, 'hook-script-missing'), false, 'an unexpandable path is unknown, not missing');
  const echoed = project({ 'CLAUDE.md': '# Rules' }, { hooks: hookOn('SessionStart', null, 'echo "state absent — run: node scripts/brief-render.mjs"') });
  const echoedReport = run(echoed).report;
  assert.equal(finding(echoedReport, 'hook-script-missing'), false, 'a script named inside echo text is not run');
  assert.equal(echoedReport.cost.hooks.sessionStart.count, 1, 'the echo hook stays on the surface');
});

test('accuracy 4b: the project root is not path evidence; a name match counts toward coverage of an enforced rule', () => {
  const dir = project({ 'CLAUDE.md': '- Never write to `secrets/`.', 'guard.mjs': '' }, {
    permissions: { deny: ['Edit(./secrets/**)'] },
    hooks: hookOn('PreToolUse', 'Bash', 'node guard.mjs secrets-guard'),
  });
  const rooted = project({ 'guard.mjs': '' }, {});
  writeFileSync(join(rooted, '.claude', 'settings.json'), JSON.stringify({ hooks: hookOn('PreToolUse', 'Edit', `node guard.mjs --root "${rooted}"`) }));
  writeFileSync(join(rooted, 'CLAUDE.md'), `- Always work inside \`${rooted.split('\\').join('/')}\`.\n`);
  const rootedReport = run(rooted).report;
  assert.equal(rootedReport.surface.hooks.length, 1);
  assert.equal(rule(rootedReport, 'work inside').verdict, 'prose');
  const notes = run(dir).report.findings.filter(f => f.code === 'unwritten-hook').map(f => f.msg).join('\n');
  assert.doesNotMatch(notes, /secrets-guard/, 'secrets-guard shares a name with an enforced rule');
});

test('accuracy 2: one weak signal repeated across hook entries stays prose', () => {
  const hooks = { PostToolUse: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].map(matcher => ({ matcher, hooks: [{ type: 'command', command: 'node formatter.mjs' }] })) };
  const dir = project({ 'CLAUDE.md': '- Never skip the formatter.', 'formatter.mjs': '' }, { hooks });
  assert.equal(rule(run(dir).report, 'formatter').verdict, 'prose');
});

test('accuracy 3: non-enforcing events neither match tools nor count as unwritten enforcement', () => {
  const dir = project({ 'CLAUDE.md': '- Never run curl in Bash.', 'check.mjs': '' }, {
    hooks: { ...hookOn('SessionStart', '*', 'node check.mjs'), ...hookOn('SessionEnd', null, 'echo bye') },
  });
  const { report } = run(dir);
  assert.equal(rule(report, 'curl in Bash').verdict, 'prose');
  assert.equal(finding(report, 'unwritten-hook'), false);
});

test('accuracy 4: path overlap ignores echo text and bare words, keeps real path arguments', () => {
  const echoed = project({ 'CLAUDE.md': '- Never edit `config/prod.json` by hand.', 'log.mjs': '' },
    { hooks: hookOn('PreToolUse', 'Bash', 'node log.mjs; echo "config/prod.json changed"') });
  assert.equal(rule(run(echoed).report, 'prod.json').verdict, 'prose');
  const word = project({ 'CLAUDE.md': '- Always rebase onto `main` before pushing.', 'guard.mjs': '' },
    { hooks: hookOn('PreToolUse', 'Bash', 'node guard.mjs --branch main') });
  assert.equal(rule(run(word).report, 'rebase').verdict, 'prose');
  const real = project({ 'CLAUDE.md': '- Never edit `config/prod.json` by hand.', 'guard.mjs': '' },
    { hooks: hookOn('PreToolUse', 'Bash', 'node guard.mjs config/prod.json') });
  assert.equal(rule(run(real).report, 'prod.json').verdict, 'likely');
});

test('accuracy 5: dispatcher hooks keep one identity per lane', () => {
  const hooks = {
    PreToolUse: [
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'node adapter.mjs secrets-guard' }] },
      { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: 'node adapter.mjs askgate' }] },
    ],
  };
  const dir = project({ 'CLAUDE.md': '- Every adapter must log its decisions.', 'adapter.mjs': '' }, { hooks });
  const notes = run(dir).report.findings.filter(f => f.code === 'unwritten-hook').map(f => f.msg).join('\n');
  assert.match(notes, /secrets-guard/);
  assert.match(notes, /askgate/);
  const annotated = project({ 'CLAUDE.md': '- Never write secrets. <!-- enforced-by: script secrets-guard -->', 'adapter.mjs': '' }, { hooks });
  assert.equal(rule(run(annotated).report, 'write secrets').verdict, 'wired');
});

test('accuracy 6: prohibited and refuses read as hard rules', () => {
  const report = run(project({ 'CLAUDE.md': '- Force-push is prohibited.\n- The guard refuses unsigned tags.' }, {})).report;
  assert.equal(rule(report, 'Force-push').strength, 'hard');
  assert.equal(rule(report, 'unsigned tags').strength, 'hard');
});

test('accuracy 7: English words and hyphen compounds are not tool names', () => {
  const hooks = { PreToolUse: [
    { matcher: 'Agent', hooks: [{ type: 'command', command: 'node guard.mjs' }] },
    { matcher: 'Read', hooks: [{ type: 'command', command: 'node guard.mjs' }] },
  ] };
  const report = run(project({ 'CLAUDE.md': '- Agent-created commits must use the house identity.\n- Read the style guide first; it is required.\n- Never call `Agent` without approval.', 'guard.mjs': '' }, { hooks })).report;
  assert.equal(rule(report, 'Agent-created').verdict, 'prose');
  assert.equal(rule(report, 'style guide').verdict, 'prose');
  assert.notEqual(rule(report, 'without approval').verdict, 'prose');
});

test('accuracy 8: managed settings and enabled plugin hooks are part of the surface', () => {
  const managed = project({ 'managed-settings.json': JSON.stringify({ permissions: { deny: ['Edit(./secrets/**)'] } }),
    'managed-settings.d/20-hooks.json': JSON.stringify({ allowManagedHooksOnly: true }) });
  const profile = project({ 'settings.json': '{}' });
  const dir = project({ 'CLAUDE.md': '- Never write secrets. <!-- enforced-by: deny Edit(./secrets/**) -->', 'guard.mjs': '' },
    { hooks: hookOn('PreToolUse', 'Bash', 'node guard.mjs') });
  const managedRun = runRaw([dir, '--json', '--no-ancestors'], { CLAUDE_CONFIG_DIR: profile, PROVE_IT_MANAGED_DIR: managed });
  assert.equal(rule(managedRun.report, 'write secrets').verdict, 'wired');
  assert.ok(managedRun.report.surface.permissions.some(p => p.scope === 'managed'));
  assert.equal(managedRun.report.surface.hooks.length, 0, 'allowManagedHooksOnly drops project hooks');

  const pluginRoot = project({ 'hooks/hooks.json': JSON.stringify({ hooks: hookOn('PreToolUse', 'Bash', 'node "${CLAUDE_PLUGIN_ROOT}/scripts/plug-guard.mjs"') }), 'scripts/plug-guard.mjs': '' });
  const withPlugin = project({
    'settings.json': JSON.stringify({ enabledPlugins: { 'demo@market': true } }),
    'plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: { 'demo@market': [{ scope: 'user', installPath: pluginRoot }] } }),
  });
  const plain = project({ 'CLAUDE.md': '- Always guard shell. <!-- enforced-by: script plug-guard.mjs -->' }, {});
  const pluginRun = runRaw([plain, '--json', '--no-ancestors'], { CLAUDE_CONFIG_DIR: withPlugin, PROVE_IT_MANAGED_DIR: join(plain, 'no-managed') });
  assert.equal(rule(pluginRun.report, 'guard shell').verdict, 'wired');
  assert.ok(pluginRun.report.surface.hooks.some(h => h.scope === 'plugin:demo@market'));
});

test('accuracy 9: SessionStart hook output is reported as context the audit cannot fully measure', () => {
  const dir = project({ 'CLAUDE.md': '# Rules', 'inject.mjs': '' }, { hooks: { SessionStart: [{ hooks: [
    { type: 'command', command: 'node inject.mjs' },
    { type: 'command', command: 'node inject.mjs >/dev/null 2>&1' },
    { type: 'command', command: `echo "${'x'.repeat(400)}"` },
  ] }] } });
  const { report } = run(dir);
  assert.equal(report.cost.hooks.sessionStart.count, 3);
  assert.deepEqual(report.cost.hooks.sessionStart.unmeasured, ['inject.mjs']);
  assert.equal(report.cost.hooks.sessionStart.unmeasuredHooks, 1, 'output sent to /dev/null is not context');
  assert.ok(report.cost.hooks.sessionStart.staticEstTokens >= 100);
  assert.equal(finding(report, 'hook-context'), true);
});

test('accuracy 12: Write, Glob and Grep path rules never match and cannot enforce', () => {
  const dir = project({ 'CLAUDE.md': '- Never write to `secrets/`. <!-- enforced-by: deny Write(./secrets/**) -->\n- Never touch `vault/` files.' },
    { permissions: { deny: ['Write(./secrets/**)', 'Grep(./vault/**)'] } });
  const { code, report } = run(dir);
  assert.equal(code, 1);
  const inert = report.findings.filter(f => f.code === 'inert-permission');
  assert.equal(inert.length, 2);
  assert.match(inert[0].msg, /Edit\(\.\/secrets\/\*\*\)/);
  assert.equal(rule(report, 'write to').verdict, 'broken');
  assert.equal(rule(report, 'vault/').verdict, 'prose');
});
