#!/usr/bin/env node
// claudemd-prove-it — audit a CLAUDE.md against .claude/settings.json.
//
// Answers one question no other linter answers: which of your CLAUDE.md rules
// are actually enforced by a hook or a permission, and which are hopeful prose.
// Plus four deterministic health checks: context cost, import resolution,
// contradiction/duplication, structure lint.
//
//   node prove-it.mjs [dir]              audit a project (default: cwd)
//   node prove-it.mjs --json             machine-readable report
//   node prove-it.mjs --all              list every prose-only rule, not a count
//   node prove-it.mjs --strict           warnings also fail the exit code
//   node prove-it.mjs --user             include ~/.claude/CLAUDE.md in the audit
//   node prove-it.mjs --project-only     ignore ~/.claude/settings.json
//   node prove-it.mjs --no-ancestors     skip CLAUDE.md files above the project (CI use)
//   node prove-it.mjs --no-color         plain output
//
// Exit codes: 0 = no errors · 1 = errors (or warnings with --strict) · 2 = usage/IO
//
// Node stdlib only. No dependencies. Reads files; never writes, never spawns.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const VERSION = '0.1.0';
const TOKEN_DIVISOR = 4;      // chars per token; a stated estimate, not a tokenizer
const IMPORT_MAX_DEPTH = 4;   // matches Claude Code's documented limit
const LINE_GUIDANCE = 200;    // docs: target under 200 lines per CLAUDE.md
const SCAN_DIR_DEPTH = 6;     // nested CLAUDE.md discovery depth cap
const SCAN_FILE_CAP = 20000;  // stop walking after this many entries

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'target', '.idea', '.vscode',
]);

// ---------- CLI ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const positional = argv.filter(a => !a.startsWith('--'));

if (flags.has('--help') || flags.has('-h')) {
  console.log(readSelfDoc());
  process.exit(0);
}
if (flags.has('--version')) { console.log(VERSION); process.exit(0); }

const ROOT = resolve(positional[0] || process.cwd());
const OPTS = {
  json: flags.has('--json'),
  all: flags.has('--all'),
  strict: flags.has('--strict'),
  user: flags.has('--user'),
  projectOnly: flags.has('--project-only'),
  noAncestors: flags.has('--no-ancestors'),
  color: !flags.has('--no-color') && process.stdout.isTTY && !OPTS_JSON_SAFE(),
};
function OPTS_JSON_SAFE() { return flags.has('--json'); }

function readSelfDoc() {
  const src = readFileSync(new URL(import.meta.url), 'utf8');
  return src.split('\n').slice(1, 22).map(l => l.replace(/^\/\/ ?/, '')).join('\n');
}

// ---------- small utils ----------
function tryRead(path) {
  try { return readFileSync(path, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
}
function tryStat(path) {
  try { return statSync(path); } catch { return null; }
}
function expandHome(p) {
  return p.startsWith('~/') || p === '~' ? join(homedir(), p.slice(1)) : p;
}
function rel(p) {
  const r = relative(ROOT, p);
  return r && !r.startsWith('..') ? r.split(sep).join('/') : p.split(sep).join('/');
}
function uniq(arr) { return [...new Set(arr)]; }

// Mask fenced code blocks and inline code spans with spaces (preserves offsets
// and line numbers) so imports/comments/directives inside code are ignored,
// matching the real loader's behavior.
function maskCode(text, { inline = true } = {}) {
  const lines = text.split('\n');
  let inFence = false;
  const out = lines.map(line => {
    const fence = /^(\s*)(```|~~~)/.test(line);
    if (fence) { inFence = !inFence; return ' '.repeat(line.length); }
    if (inFence) return ' '.repeat(line.length);
    if (!inline) return line;
    return line.replace(/`[^`]*`/g, m => ' '.repeat(m.length));
  });
  return out.join('\n');
}

// Remove HTML comments (outside code) the way the loader strips them before
// injection — the token estimate must not bill the user for comments.
function stripComments(text) {
  const masked = maskCode(text);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const start = masked.indexOf('<!--', i);
    if (start === -1) { out += text.slice(i); break; }
    const end = masked.indexOf('-->', start + 4);
    out += text.slice(i, start);
    if (end === -1) break; // unterminated comment: strip to EOF
    i = end + 3;
  }
  return out;
}

function estTokens(text) {
  return Math.ceil(stripComments(text).length / TOKEN_DIVISOR);
}

// ---------- discovery: memory files ----------
// Mirrors what Claude Code loads: ancestor CLAUDE.md walk-up, project
// CLAUDE.md / .claude/CLAUDE.md, CLAUDE.local.md, .claude/rules/**/*.md
// (unconditional vs paths-scoped), nested CLAUDE.md (lazy), @imports (depth 4).

function discoverMemoryFiles(findings) {
  const files = []; // {path, kind, launch:boolean, via}
  const seen = new Set();
  const add = (path, kind, launch, via) => {
    const key = resolve(path);
    if (seen.has(key) || !tryStat(key)) return null;
    seen.add(key);
    const entry = { path: key, kind, launch, via: via || null };
    files.push(entry);
    return entry;
  };

  // ancestors (loaded in full at launch, per docs)
  if (!OPTS.noAncestors) {
    const ancestors = [];
    let dir = dirname(ROOT);
    while (true) {
      ancestors.unshift(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const a of ancestors) {
      add(join(a, 'CLAUDE.md'), 'ancestor', true);
      add(join(a, 'CLAUDE.local.md'), 'ancestor-local', true);
    }
  }

  // project
  const hasRootMd = add(join(ROOT, 'CLAUDE.md'), 'project', true);
  const hasDotMd = add(join(ROOT, '.claude', 'CLAUDE.md'), 'project', true);
  add(join(ROOT, 'CLAUDE.local.md'), 'local', true);
  if (!hasRootMd && !hasDotMd) {
    findings.push(err('no-claude-md', `no CLAUDE.md found at ${rel(join(ROOT, 'CLAUDE.md'))} or .claude/CLAUDE.md`));
  }

  // user scope (opt-in)
  if (OPTS.user) {
    add(join(homedir(), '.claude', 'CLAUDE.md'), 'user', true);
    for (const f of walkMd(join(homedir(), '.claude', 'rules'))) add(f, 'user-rule', true);
  }

  // .claude/rules/**/*.md
  for (const f of walkMd(join(ROOT, '.claude', 'rules'))) {
    const text = tryRead(f) || '';
    const fm = parseFrontmatter(text);
    const scoped = Array.isArray(fm.paths) && fm.paths.length > 0;
    const e = add(f, scoped ? 'rule-scoped' : 'rule', !scoped);
    if (e && scoped) e.paths = fm.paths;
  }

  // nested CLAUDE.md (lazy-loaded)
  for (const f of walkNested(ROOT)) {
    if (resolve(dirname(f)) === resolve(ROOT)) continue;
    add(f, 'nested', false);
  }

  // @imports, breadth-first to depth 4, from every launch-loaded file
  const queue = files.filter(f => f.launch).map(f => ({ path: f.path, depth: 0 }));
  const visited = new Set(queue.map(q => resolve(q.path)));
  while (queue.length) {
    const { path, depth } = queue.shift();
    const text = tryRead(path);
    if (text === null) continue;
    for (const imp of findImports(text)) {
      const target = resolveImport(imp.spec, path);
      if (!target || !tryStat(target)) {
        findings.push(err('broken-import',
          `${rel(path)}:${imp.line} imports @${imp.spec} — file not found` +
          (looksLikePackage(imp.spec) ? ' (if this is a package name, wrap it in backticks so it is not parsed as an import)' : '')));
        continue;
      }
      const key = resolve(target);
      if (visited.has(key)) continue; // already loaded or cycle
      if (depth + 1 > IMPORT_MAX_DEPTH) {
        findings.push(warn('import-depth',
          `${rel(path)}:${imp.line} imports @${imp.spec} beyond ${IMPORT_MAX_DEPTH} hops — Claude Code stops resolving here`));
        continue;
      }
      visited.add(key);
      add(target, 'import', true, `${rel(path)}:${imp.line}`);
      queue.push({ path: target, depth: depth + 1 });
    }
  }

  return files;
}

function looksLikePackage(spec) {
  return /^[\w-]+\/[\w.-]+$/.test(spec) && !spec.includes('.md') && !spec.startsWith('.');
}

function findImports(text) {
  const masked = maskCode(text);
  const out = [];
  const re = /(^|[\s(])@([~.\w][\w./~\\-]*)/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    let spec = m[2].replace(/[.,;:!?)]+$/, '');
    if (!spec || spec === '.' || spec === '..') continue;
    const line = masked.slice(0, m.index).split('\n').length;
    out.push({ spec, line });
  }
  return out;
}

function resolveImport(spec, fromFile) {
  if (spec.startsWith('~')) return expandHome(spec);
  if (isAbsolute(spec)) return spec;
  return resolve(dirname(fromFile), spec);
}

function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = {};
  let listKey = null;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      listKey = kv[2].trim() === '' ? kv[1] : null;
      if (kv[2].trim() !== '') fm[kv[1]] = kv[2].trim();
      else fm[kv[1]] = [];
      continue;
    }
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && listKey) fm[listKey].push(item[1].trim().replace(/^["']|["']$/g, ''));
  }
  return fm;
}

function walkMd(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(p); }
      else if (e.name.endsWith('.md')) out.push(p);
    }
  }
  return out;
}

function walkNested(root) {
  const out = [];
  let count = 0;
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > SCAN_DIR_DEPTH || count > SCAN_FILE_CAP) break;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      count++;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.claude')) continue;
        stack.push({ dir: join(dir, e.name), depth: depth + 1 });
      } else if (e.name === 'CLAUDE.md' || e.name === 'CLAUDE.local.md') {
        out.push(join(dir, e.name));
      }
    }
  }
  return out;
}

// ---------- discovery: settings surface ----------
function discoverSettings(findings) {
  const sources = [
    { path: join(ROOT, '.claude', 'settings.json'), scope: 'project' },
    { path: join(ROOT, '.claude', 'settings.local.json'), scope: 'local' },
  ];
  if (!OPTS.projectOnly) {
    sources.push({ path: join(homedir(), '.claude', 'settings.json'), scope: 'user' });
  }

  const hooks = [];       // {event, matcher, matcherNames[], command, scripts[], scope}
  const permissions = []; // {list, rule, tool, pattern, scope}
  let anySettings = false;

  for (const src of sources) {
    const text = tryRead(src.path);
    if (text === null) continue;
    anySettings = true;
    let json;
    try { json = JSON.parse(text); } catch (e) {
      findings.push(err('settings-parse', `${rel(src.path)} is not valid JSON (${e.message}) — Claude Code will ignore it, and so does this audit`));
      continue;
    }
    for (const [event, groups] of Object.entries(json.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        const matcher = group.matcher ?? '*';
        for (const h of group.hooks || []) {
          const command = h.command || h.url || h.prompt || (h.server ? `${h.server}.${h.tool}` : '') || '';
          hooks.push({
            event, matcher,
            matcherNames: splitMatcher(matcher),
            type: h.type || 'command',
            command,
            scripts: extractScripts(command),
            scope: src.scope,
          });
        }
      }
    }
    for (const list of ['deny', 'ask', 'allow']) {
      for (const rule of (json.permissions || {})[list] || []) {
        const m = String(rule).match(/^([\w-]+)\((.*)\)$/);
        permissions.push({
          list, rule: String(rule),
          tool: m ? m[1] : String(rule),
          pattern: m ? m[2] : '',
          scope: src.scope,
        });
      }
    }
  }

  if (!anySettings) {
    findings.push(warn('no-settings', 'no .claude/settings.json found — every rule in this CLAUDE.md relies on the model choosing to follow it'));
  }
  return { hooks, permissions };
}

function splitMatcher(matcher) {
  if (!matcher || matcher === '*') return ['*'];
  // exact-string list grammar: letters/digits/_/-/space/,/| — else regex
  if (/^[\w\s,|-]+$/.test(matcher)) return matcher.split(/[|,]/).map(s => s.trim()).filter(Boolean);
  return [matcher]; // regex; matched by substring test later
}

function extractScripts(command) {
  const out = [];
  const re = /[\w./\\~$-]+\.(mjs|cjs|js|sh|ps1|py|rb)\b/g;
  let m;
  while ((m = re.exec(command)) !== null) out.push(m[0].split(/[/\\]/).pop());
  return uniq(out);
}

// ---------- directive extraction ----------
const HARD_MARKERS = [
  /\bnever\b/i, /\balways\b/i, /\bmust(?:\s+not)?\b/i, /\bdo not\b/i, /\bdon't\b/i,
  /\bforbidden\b/i, /\bbanned\b/i, /\boff[- ]limits\b/i, /\bnot allowed\b/i,
  /\brequired?\b/i, /\brequires\b/i, /\bread[- ]only\b/i, /\bblock(?:ed|s)?\b/i,
  /\bdeny\b/i, /\bno\s+\w+ing\b/i, /\bonly\s+(?:use|do|if|when|edit|write|read)\b/i,
];
const SOFT_MARKERS = [
  /\bshould(?:\s+not)?\b/i, /\bprefer\b/i, /\bavoid\b/i, /\brecommended\b/i,
  /\bask\s+(?:first|before)\b/i, /\bplease\b/i,
];

function extractDirectives(files) {
  const directives = [];
  let id = 0;
  for (const f of files) {
    if (!f.launch && f.kind !== 'rule-scoped') continue; // enforcement map covers what loads
    const text = tryRead(f.path);
    if (text === null) continue;
    // fences masked so code never reads as rules; inline code kept, since
    // backticked paths are the strongest content a rule carries
    const masked = maskCode(text, { inline: false });
    const rawLines = text.split('\n');
    const lines = masked.split('\n');

    for (const unit of units(lines)) {
      const raw = unit.lines.map(i => rawLines[i]).join(' ').trim();
      const clean = unit.lines.map(i => lines[i]).join(' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/[*_#>`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean.length < 8) continue;
      const hard = HARD_MARKERS.some(re => re.test(clean));
      const soft = !hard && SOFT_MARKERS.some(re => re.test(clean));
      if (!hard && !soft) continue;
      directives.push({
        id: `d${++id}`,
        file: f.path,
        line: unit.lines[0] + 1,
        text: clean,
        raw,
        strength: hard ? 'hard' : 'soft',
        annotation: findAnnotation(rawLines, unit.lines),
      });
    }
  }
  return directives;
}

// A unit is a bullet (with its continuation lines), a heading, or a sentence-
// bearing paragraph line. Comment-only and blank lines never start a unit.
function* units(lines) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || /^\s*<!--/.test(line)) { i++; continue; }
    if (/^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      const indent = line.match(/^\s*/)[0].length;
      const unit = [i];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() &&
             !/^\s*(?:[-*+]|\d+\.)\s+/.test(lines[j]) &&
             lines[j].match(/^\s*/)[0].length > indent) {
        unit.push(j); j++;
      }
      yield { lines: unit };
      i = j;
    } else {
      yield { lines: [i] };
      i++;
    }
  }
}

// ---------- annotations ----------
// Syntax (inert HTML comment; the loader strips comments, so this costs no context):
//   <!-- enforced-by: hook PreToolUse Task -->
//   <!-- enforced-by: deny Write(./protected/**) -->
//   <!-- enforced-by: script subagent-guard.mjs -->
//   <!-- enforced-by: none -->
// Attach it at the end of the rule's line or on the line directly below.
function findAnnotation(rawLines, unitLineIdxs) {
  const scan = [...unitLineIdxs, unitLineIdxs[unitLineIdxs.length - 1] + 1];
  for (const idx of scan) {
    const line = rawLines[idx];
    if (line === undefined) break;
    const m = line.match(/<!--\s*enforced-by:\s*([^>]*?)\s*-->/i);
    if (m) return parseAnnotation(m[1]);
    if (idx > unitLineIdxs[unitLineIdxs.length - 1] && line.trim() && !line.includes('<!--')) break;
  }
  return null;
}

function parseAnnotation(body) {
  const claims = body.split(',').map(s => s.trim()).filter(Boolean).map(claim => {
    if (/^none$/i.test(claim)) return { type: 'none' };
    let m = claim.match(/^hook\s+(\w+)\s+(.+)$/i);
    if (m) return { type: 'hook', event: m[1], needle: m[2] };
    m = claim.match(/^(deny|ask|allow)\s+(.+)$/i);
    if (m) return { type: 'permission', list: m[1].toLowerCase(), rule: m[2] };
    m = claim.match(/^script\s+(.+)$/i);
    if (m) return { type: 'script', name: m[1] };
    return { type: 'invalid', raw: claim };
  });
  return { claims };
}

function verifyAnnotation(annotation, surface) {
  const results = [];
  for (const c of annotation.claims) {
    if (c.type === 'none') { results.push({ claim: c, ok: true, evidence: 'declared advisory' }); continue; }
    if (c.type === 'invalid') { results.push({ claim: c, ok: false, evidence: `unparseable claim "${c.raw}"` }); continue; }
    if (c.type === 'hook') {
      const hit = surface.hooks.find(h =>
        h.event.toLowerCase() === c.event.toLowerCase() &&
        (h.matcher.toLowerCase().includes(c.needle.toLowerCase()) ||
         h.command.toLowerCase().includes(c.needle.toLowerCase())));
      results.push({ claim: c, ok: !!hit, hook: hit || null, evidence: hit
        ? `hook ${hit.event} (matcher: ${hit.matcher}) in ${hit.scope} settings`
        : `no ${c.event} hook matching "${c.needle}" in any settings file` });
      continue;
    }
    if (c.type === 'permission') {
      const want = c.rule.replace(/\s+/g, '');
      const hit = surface.permissions.find(p => p.list === c.list && p.rule.replace(/\s+/g, '') === want);
      results.push({ claim: c, ok: !!hit, evidence: hit
        ? `${hit.list} rule ${hit.rule} in ${hit.scope} settings`
        : `no ${c.list} rule ${c.rule} in any settings file` });
      continue;
    }
    if (c.type === 'script') {
      const name = c.name.split(/[/\\]/).pop().toLowerCase();
      const hit = surface.hooks.find(h => h.scripts.some(s => s.toLowerCase() === name));
      results.push({ claim: c, ok: !!hit, hook: hit || null, evidence: hit
        ? `${c.name} runs in a ${hit.event} hook (matcher: ${hit.matcher})`
        : `${c.name} does not appear in any hook command` });
    }
  }
  return results;
}

// ---------- heuristic enforcement matching ----------
const TOOL_NAMES = ['Bash', 'PowerShell', 'Edit', 'Write', 'Read', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task', 'Agent', 'Workflow', 'Skill',
  'AskUserQuestion', 'TodoWrite'];
const CONCEPT_TOOLS = {
  subagent: ['Task', 'Agent', 'Workflow'],
  'sub-agent': ['Task', 'Agent', 'Workflow'],
  subagents: ['Task', 'Agent', 'Workflow'],
  swarm: ['Task', 'Agent', 'Workflow'],
  shell: ['Bash', 'PowerShell'],
  terminal: ['Bash', 'PowerShell'],
  url: ['WebFetch'],
};
// generic words ('question', 'fetch') are left out on purpose: 'git fetch' and
// 'my question' would claim tools they have nothing to do with
const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'your', 'never', 'always',
  'must', 'not', 'the', 'and', 'for', 'are', 'you', 'may', 'them', 'they', 'file',
  'files', 'claude', 'code', 'when', 'what', 'have', 'has', 'only', 'into', 'every',
  'anything', 'something', 'here', 'there', 'inside', 'without', 'before', 'after']);

// slash-joined English that is not a path ("read/write" would otherwise match
// the word "read/write" inside some hook's echo text)
const NOT_PATHS = new Set(['read/write', 'write/read', 'and/or', 'either/or',
  'y/n', 'r/w', 'i/o', 'a/b', '24/7', 'tcp/ip', 'his/her', 'he/she', 'pass/fail']);

function pathTokens(text) {
  const out = [];
  // backticked spans in the raw text are the strongest path signals
  for (const m of text.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  // bare tokens that look like paths or globs
  for (const m of text.matchAll(/(?:^|\s)((?:[\w.*-]+\/)+[\w.*-]*|\.\w[\w.]*|[\w-]+\.(?:json|md|env|txt|yml|yaml|lock))(?=\s|$|[,.;:])/g)) {
    out.push(m[1]);
  }
  return uniq(out.map(normPath).filter(t => t.length >= 3 && !NOT_PATHS.has(t)));
}
function normPath(t) {
  return t.toLowerCase().replace(/^\.\//, '').replace(/\*+/g, '').replace(/\/+$/, '').replace(/\/+/g, '/').trim();
}

function contentWords(text) {
  return uniq((text.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).filter(w => !STOPWORDS.has(w)));
}

function matchDirective(d, surface) {
  const evidence = [];
  const hooksHit = new Set();
  let score = 0;
  const dText = d.text;
  const dPaths = pathTokens(d.raw);
  const dWords = contentWords(dText);

  // signal 1: literal path overlap with a deny/ask rule or hook command (strong)
  for (const p of dPaths) {
    for (const perm of surface.permissions) {
      if (perm.list === 'allow') continue;
      const rp = normPath(perm.pattern || perm.rule);
      if (rp && (rp.includes(p) || p.includes(rp))) {
        score += 3;
        evidence.push(`rule mentions \`${p}\`; ${perm.list} rule ${perm.rule} covers it (${perm.scope} settings)`);
      }
    }
    for (const h of surface.hooks) {
      if (h.command.toLowerCase().includes(p)) {
        score += 3;
        hooksHit.add(h);
        evidence.push(`rule mentions \`${p}\`; a ${h.event} hook command references it (matcher: ${h.matcher})`);
      }
    }
  }

  // signal 2: tool names (explicit, or via concept words like "subagent")
  const toolsInRule = new Set();
  for (const t of TOOL_NAMES) if (new RegExp(`\\b${t}\\b`).test(d.raw)) toolsInRule.add(t);
  for (const [word, tools] of Object.entries(CONCEPT_TOOLS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(dText)) tools.forEach(t => toolsInRule.add(t));
  }
  for (const h of surface.hooks) {
    const overlap = h.matcherNames.filter(n => toolsInRule.has(n));
    if (overlap.length) {
      score += 2;
      hooksHit.add(h);
      evidence.push(`rule concerns ${overlap.join('/')}; a ${h.event} hook matches ${h.matcher}` +
        (h.scripts.length ? ` (${h.scripts.join(', ')})` : ''));
    }
  }
  for (const perm of surface.permissions) {
    if (perm.list !== 'allow' && toolsInRule.has(perm.tool)) {
      score += 1;
      evidence.push(`rule concerns ${perm.tool}; ${perm.list} rule ${perm.rule} exists`);
    }
  }

  // signal 3: shared words with hook script names (subagent-guard.mjs → subagent).
  // 6-char minimum: short generic words (guard, vault, gate) matched everything
  for (const h of surface.hooks) {
    const scriptWords = h.scripts.flatMap(s => s.replace(/\.\w+$/, '').split(/[-_.]/)).filter(w => w.length >= 6);
    const shared = scriptWords.filter(w => dWords.some(dw => dw === w || dw.startsWith(w) || w.startsWith(dw)));
    if (shared.length) {
      score += Math.min(shared.length, 2);
      hooksHit.add(h);
      evidence.push(`shares "${shared.join('", "')}" with hook script ${h.scripts.join(', ')} (${h.event}, matcher: ${h.matcher})`);
    }
  }

  const verdict = score >= 3 ? 'likely' : score >= 2 ? 'possible' : 'prose';
  return { verdict, score, evidence: uniq(evidence).slice(0, 4), hooksHit };
}

function buildEnforcementMap(directives, surface, findings) {
  const map = [];
  const hooksCovered = new Set();
  for (const d of directives) {
    if (d.annotation) {
      const results = verifyAnnotation(d.annotation, surface);
      const advisory = d.annotation.claims.every(c => c.type === 'none');
      const allOk = results.every(r => r.ok);
      if (advisory) {
        map.push({ ...pick(d), verdict: 'advisory', confidence: 'declared', evidence: ['marked advisory on purpose'] });
      } else if (allOk) {
        map.push({ ...pick(d), verdict: 'wired', confidence: 'annotated + verified', evidence: results.map(r => r.evidence) });
        results.forEach(r => r.hook && hooksCovered.add(r.hook));
      } else {
        const broken = results.filter(r => !r.ok);
        map.push({ ...pick(d), verdict: 'broken', confidence: 'annotated + failed', evidence: broken.map(r => r.evidence) });
        findings.push(err('broken-claim',
          `${rel(d.file)}:${d.line} claims enforcement that is not wired: ${broken.map(r => r.evidence).join('; ')}`));
      }
      continue;
    }
    const m = matchDirective(d, surface);
    if (m.verdict !== 'prose') m.hooksHit.forEach(h => hooksCovered.add(h));
    map.push({ ...pick(d), verdict: m.verdict, confidence: m.verdict === 'prose' ? 'none' : `heuristic (score ${m.score})`, evidence: m.evidence });
  }

  // the reverse check: enforcement that exists with no written rule behind it.
  // SessionStart is exempt (context injection, not enforcement of a rule).
  const seen = new Set();
  for (const h of surface.hooks) {
    if (hooksCovered.has(h) || h.event === 'SessionStart') continue;
    const key = `${h.event}|${h.matcher}|${h.scripts.join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(info('unwritten-hook',
      `a ${h.event} hook (matcher: ${h.matcher}${h.scripts.length ? `, ${h.scripts.join(', ')}` : ''}) enforces something no CLAUDE.md rule states — it works, and nothing documents it`));
  }
  return map;

  function pick(d) {
    return { id: d.id, file: rel(d.file), line: d.line, strength: d.strength, text: clip(d.text, 90) };
  }
}

// ---------- health checks ----------
function checkDuplication(directives, findings) {
  const sets = directives.map(d => new Set(contentWords(d.text)));
  for (let i = 0; i < directives.length; i++) {
    for (let j = i + 1; j < directives.length; j++) {
      const a = sets[i], b = sets[j];
      if (a.size < 3 || b.size < 3) continue;
      const inter = [...a].filter(w => b.has(w)).length;
      const jac = inter / (a.size + b.size - inter);
      const A = directives[i], B = directives[j];
      if (jac >= 0.65 && A.text !== B.text) {
        findings.push(warn('duplicate',
          `near-duplicate rules: ${rel(A.file)}:${A.line} and ${rel(B.file)}:${B.line} say close to the same thing — pick one home`));
      } else if (jac >= 0.4 && oppositePolarity(A.text, B.text)) {
        findings.push(warn('contradiction-candidate',
          `possible contradiction (a judgment call, not a verdict): ${rel(A.file)}:${A.line} vs ${rel(B.file)}:${B.line} — same subject, opposite polarity`));
      }
    }
  }
}

function oppositePolarity(a, b) {
  const neg = /\b(never|do not|don't|not allowed|forbidden|banned|no)\b/i;
  const pos = /\b(always|must|require|do)\b/i;
  return (neg.test(a) && pos.test(b) && !neg.test(b)) || (neg.test(b) && pos.test(a) && !neg.test(a));
}

const VAGUE = [/\bproperly\b/i, /\bappropriately\b/i, /\bas needed\b/i, /\bas appropriate\b/i,
  /\bbest practices\b/i, /\bhigh[- ]quality\b/i, /\bbe careful\b/i, /\bwhere possible\b/i,
  /\bcorrectly\b/i, /\bsensibly\b/i];

function checkClarity(files, directives, findings) {
  for (const f of files.filter(x => x.launch && (x.kind === 'project' || x.kind === 'user'))) {
    const text = tryRead(f.path) || '';
    const lines = text.split('\n').length;
    if (lines > LINE_GUIDANCE) {
      findings.push(warn('length',
        `${rel(f.path)} is ${lines} lines — the docs' guidance is under ${LINE_GUIDANCE}; long files cost context and lose adherence`));
    }
    const caps = (maskCode(text).match(/\b[A-Z]{4,}\b/g) || []).length;
    if (caps / Math.max(lines, 1) > 0.25) {
      findings.push(warn('emphasis',
        `${rel(f.path)} leans on ${caps} ALL-CAPS words — when everything shouts, nothing does`));
    }
    if (lines > 100 && !/^#{1,3} /m.test(text)) {
      findings.push(warn('structure', `${rel(f.path)} has ${lines} lines and no headings — the model scans structure the way readers do`));
    }
  }
  for (const d of directives) {
    for (const v of VAGUE) {
      if (v.test(d.text)) {
        findings.push(info('vague',
          `${rel(d.file)}:${d.line} — "${d.text.match(v)[0]}" is not checkable; say the concrete behavior instead`));
        break;
      }
    }
  }
}

function checkScopedRules(files, findings) {
  const scoped = files.filter(f => f.kind === 'rule-scoped');
  if (!scoped.length) return;
  const allFiles = [];
  let count = 0;
  const stack = [{ dir: ROOT, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > SCAN_DIR_DEPTH || count > SCAN_FILE_CAP) break;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      count++;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !(e.name.startsWith('.') && e.name !== '.claude')) stack.push({ dir: p, depth: depth + 1 });
      } else allFiles.push(relative(ROOT, p).split(sep).join('/'));
    }
  }
  for (const f of scoped) {
    const dead = (f.paths || []).filter(g => !allFiles.some(p => globMatch(g, p)));
    if (dead.length === (f.paths || []).length && dead.length > 0) {
      findings.push(warn('dead-rule',
        `${rel(f.path)} is scoped to paths matching zero files (${dead.join(', ')}) — it will never load`));
    }
  }
}

function globMatch(glob, path) {
  const esc = s => s.replace(/[.+^$()|[\]\\]/g, '\\$&');
  let g = '';
  let last = 0;
  for (const m of glob.matchAll(/\{([^}]+)\}/g)) {
    g += esc(glob.slice(last, m.index));
    g += '(?:' + m[1].split(',').map(esc).join('|') + ')';
    last = m.index + m[0].length;
  }
  g += esc(glob.slice(last));
  g = g.replace(/\*\*\//g, '\u0000').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?').replace(/\u0001/g, '.*');
  try { return new RegExp('^' + g + '$').test(path); } catch { return false; }
}

function checkLocalGitignore(files, findings) {
  const local = files.find(f => f.kind === 'local');
  if (!local) return;
  const gi = tryRead(join(ROOT, '.gitignore'));
  if (gi !== null && !/^\s*\/?CLAUDE\.local\.md\s*$/mi.test(gi)) {
    findings.push(warn('local-not-ignored',
      'CLAUDE.local.md exists but .gitignore does not cover it — personal instructions will end up in the repo'));
  }
}

// ---------- context cost ----------
function contextCost(files) {
  const entry = f => {
    const text = tryRead(f.path) || '';
    return {
      path: rel(f.path), kind: f.kind, via: f.via || undefined,
      lines: text ? text.split('\n').length : 0,
      chars: text.length,
      estTokens: estTokens(text),
    };
  };
  const launch = files.filter(f => f.launch).map(entry);
  const onDemand = files.filter(f => !f.launch).map(entry);
  return {
    method: `chars / ${TOKEN_DIVISOR}, HTML comments stripped first (the loader strips them too). An estimate, not a tokenizer.`,
    launch, onDemand,
    launchTokens: launch.reduce((s, f) => s + f.estTokens, 0),
    onDemandTokens: onDemand.reduce((s, f) => s + f.estTokens, 0),
  };
}

// ---------- scoring ----------
function scoreReport(map, cost, findings) {
  const errs = findings.filter(f => f.level === 'error');
  const warns = findings.filter(f => f.level === 'warn');

  let integrity = 100;
  for (const f of errs) integrity -= f.code === 'broken-claim' ? 40 : 25;
  integrity = Math.max(0, integrity);

  const enforceable = map.filter(m => m.strength === 'hard' && m.verdict !== 'advisory');
  const credit = { wired: 1, likely: 0.75, possible: 0.5, prose: 0, broken: 0 };
  const enforcement = enforceable.length
    ? Math.round(100 * enforceable.reduce((s, m) => s + (credit[m.verdict] || 0), 0) / enforceable.length)
    : 100;

  const t = cost.launchTokens;
  const contextScore = t <= 2500 ? 100 : t >= 12000 ? 0 : Math.round(100 * (12000 - t) / 9500);

  let clarity = 100;
  for (const f of warns) {
    clarity -= { duplicate: 8, 'contradiction-candidate': 10, length: 10, emphasis: 8, structure: 8, 'dead-rule': 8, 'local-not-ignored': 5, 'import-depth': 5, 'no-settings': 0 }[f.code] ?? 5;
  }
  clarity = Math.max(0, clarity);

  const overall = Math.round(integrity * 0.35 + enforcement * 0.25 + contextScore * 0.2 + clarity * 0.2);
  const grade = overall >= 90 ? 'A' : overall >= 80 ? 'B' : overall >= 70 ? 'C' : overall >= 60 ? 'D' : 'F';
  return { overall, grade, integrity, enforcement, context: contextScore, clarity,
    note: 'A low enforcement score is not a verdict on your rules. Most CLAUDE.md rules are behavioral and cannot be hooked. It measures how many of your hard rules would survive the model ignoring them.' };
}

// ---------- findings ----------
function err(code, msg) { return { level: 'error', code, msg }; }
function warn(code, msg) { return { level: 'warn', code, msg }; }
function info(code, msg) { return { level: 'info', code, msg }; }

// ---------- output ----------
const C = {
  dim: s => OPTS.color ? `\x1b[2m${s}\x1b[0m` : s,
  bold: s => OPTS.color ? `\x1b[1m${s}\x1b[0m` : s,
  red: s => OPTS.color ? `\x1b[31m${s}\x1b[0m` : s,
  green: s => OPTS.color ? `\x1b[32m${s}\x1b[0m` : s,
  yellow: s => OPTS.color ? `\x1b[33m${s}\x1b[0m` : s,
  cyan: s => OPTS.color ? `\x1b[36m${s}\x1b[0m` : s,
};
function clip(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + '…'; }
function fmtTokens(n) { return `~${n.toLocaleString('en-US')}`; }

const VERDICT_MARK = {
  wired: ['✓', 'green'], broken: ['✗', 'red'], likely: ['~', 'cyan'],
  possible: ['?', 'yellow'], advisory: ['◦', 'dim'], prose: ['·', 'dim'],
};

function printReport(report) {
  const { score, cost, map, findings } = report;
  const out = [];
  out.push('');
  out.push(C.bold(`claudemd-prove-it ${VERSION}`) + C.dim(`  ${ROOT}`));
  out.push('');
  out.push(`  ${C.bold(`Grade: ${score.grade}`)} (${score.overall}/100)   ` +
    C.dim(`integrity ${score.integrity} · enforcement ${score.enforcement} · context ${score.context} · clarity ${score.clarity}`));
  out.push('');

  out.push(C.bold('CONTEXT COST') + C.dim(`  (${cost.method})`));
  for (const f of cost.launch) {
    out.push(`  ${f.path.padEnd(46)} ${String(f.lines).padStart(5)} lines  ${fmtTokens(f.estTokens).padStart(8)} tokens` + (f.via ? C.dim(`  via ${f.via}`) : ''));
  }
  out.push(`  ${C.bold('loaded every session:')} ${fmtTokens(cost.launchTokens)} tokens`);
  if (cost.onDemand.length) {
    out.push(C.dim(`  on demand (${cost.onDemand.length} nested/path-scoped files): ${fmtTokens(cost.onDemandTokens)} tokens`));
  }
  out.push('');

  out.push(C.bold('ENFORCEMENT MAP') + C.dim('  (hooks + permissions; heuristic verdicts are labeled, never asserted)'));
  const shown = map.filter(m => m.verdict !== 'prose' || OPTS.all);
  for (const m of shown) {
    const [mark, color] = VERDICT_MARK[m.verdict];
    out.push(`  ${C[color](mark)} ${C[color](m.verdict.padEnd(8))} ${clip(m.text, 68).padEnd(70)} ${C.dim(`${m.file}:${m.line}`)}`);
    for (const e of m.evidence) out.push(C.dim(`      ${e}`));
  }
  const prose = map.filter(m => m.verdict === 'prose');
  const proseHard = prose.filter(m => m.strength === 'hard');
  if (!OPTS.all && prose.length) {
    out.push(`  ${C.dim('·')} ${prose.length} rules have no enforcement signal (${proseHard.length} of them are hard never/always/must rules). Run with --all to list them.`);
  }
  out.push('');

  const byLevel = { error: [], warn: [], info: [] };
  for (const f of findings) byLevel[f.level].push(f);
  if (byLevel.error.length) {
    out.push(C.bold(C.red(`ERRORS (${byLevel.error.length})`)));
    for (const f of byLevel.error) out.push(`  ${C.red('✗')} ${f.msg}`);
    out.push('');
  }
  if (byLevel.warn.length) {
    out.push(C.bold(C.yellow(`WARNINGS (${byLevel.warn.length})`)));
    for (const f of byLevel.warn) out.push(`  ${C.yellow('!')} ${f.msg}`);
    out.push('');
  }
  if (byLevel.info.length) {
    out.push(C.bold(`NOTES (${byLevel.info.length})`));
    for (const f of byLevel.info) out.push(`  ${C.dim('-')} ${f.msg}`);
    out.push('');
  }

  out.push(C.dim(score.note));
  out.push('');
  console.log(out.join('\n'));
}

// ---------- main ----------
function main() {
  if (!tryStat(ROOT)) {
    console.error(`claudemd-prove-it: ${ROOT} does not exist`);
    process.exit(2);
  }
  const findings = [];
  const files = discoverMemoryFiles(findings);
  const surface = discoverSettings(findings);
  const directives = extractDirectives(files);
  const map = buildEnforcementMap(directives, surface, findings);
  checkDuplication(directives, findings);
  checkClarity(files, directives, findings);
  checkScopedRules(files, findings);
  checkLocalGitignore(files, findings);
  const cost = contextCost(files);
  const score = scoreReport(map, cost, findings);

  const report = {
    version: VERSION, root: ROOT.split(sep).join('/'),
    score, cost, map, findings,
    surface: {
      hooks: surface.hooks.map(h => ({ event: h.event, matcher: h.matcher, type: h.type, scripts: h.scripts, scope: h.scope })),
      permissions: surface.permissions,
    },
  };

  if (OPTS.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);

  const hasErrors = findings.some(f => f.level === 'error');
  const hasWarns = findings.some(f => f.level === 'warn');
  process.exit(hasErrors || (OPTS.strict && hasWarns) ? 1 : 0);
}

main();
