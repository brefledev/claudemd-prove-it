import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const doctor = join(here, '..', 'prove-it.mjs');
const fixture = name => join(here, 'fixtures', name);

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
