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
  assert.ok(report.surface.permissions.some(p => p.rule === 'Write(./protected/**)'));
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
