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
//   node prove-it.mjs --project-only     project settings only: no user, managed, or plugin layers
//   node prove-it.mjs --no-ancestors     skip CLAUDE.md files above the project (CI use)
//   node prove-it.mjs --no-color         plain output
//
// Settings read: user, project, local, managed (PROVE_IT_MANAGED_DIR overrides
// the OS policy directory), and hooks of enabled plugins.
// Exit codes: 0 = no errors · 1 = errors (or warnings with --strict) · 2 = usage/IO
// Node stdlib only. No dependencies. Reads files; never writes, never spawns.

import { readFileSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const VERSION = '0.2.0';
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
const flags = new Set(argv.filter(a => a.startsWith('-')));
const positional = argv.filter(a => !a.startsWith('-'));

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
  excludes: [],
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
function userConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude');
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
  let fenceChar = null;
  let fenceLength = 0;
  const out = lines.map(line => {
    const fence = line.match(/^\s*(`{3,}|~{3,})/);
    if (!fenceChar && fence) {
      fenceChar = fence[1][0];
      fenceLength = fence[1].length;
      return ' '.repeat(line.length);
    }
    if (fenceChar) {
      const close = line.match(/^\s*(`+|~+)\s*$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) {
        fenceChar = null;
        fenceLength = 0;
      }
      return ' '.repeat(line.length);
    }
    if (!inline) return line;
    return line.replace(/`[^`]*`/g, m => ' '.repeat(m.length));
  });
  return out.join('\n');
}

function processComments(text, remove = false) {
  let inComment = false;
  let fenceChar = null;
  let fenceLength = 0;
  return text.split('\n').map(line => {
    if (fenceChar) {
      const close = line.match(/^\s*(`+|~+)\s*$/);
      if (close && close[1][0] === fenceChar && close[1].length >= fenceLength) fenceChar = null;
      return line;
    }
    if (!inComment) {
      const openingFence = line.match(/^\s*(`{3,}|~{3,})/);
      if (openingFence) {
        fenceChar = openingFence[1][0];
        fenceLength = openingFence[1].length;
        return line;
      }
    }
    let out = ''; let pos = 0;
    while (pos < line.length) {
      if (inComment) {
        const end = line.indexOf('-->', pos);
        const stop = end === -1 ? line.length : end + 3;
        if (!remove) out += ' '.repeat(stop - pos);
        pos = stop;
        if (end !== -1) inComment = false;
      } else {
        const start = commentStartOutsideInlineCode(line, pos);
        if (start === -1) { out += line.slice(pos); break; }
        out += line.slice(pos, start);
        pos = start;
        inComment = true;
      }
    }
    return out;
  }).join('\n');
}

function commentStartOutsideInlineCode(line, from) {
  let ticks = 0;
  for (let i = from; i < line.length; i++) {
    if (line[i] === '`') {
      let length = 1;
      while (line[i + length] === '`') length++;
      ticks = ticks === length ? 0 : ticks || length;
      i += length - 1;
    } else if (!ticks && line.startsWith('<!--', i)) return i;
  }
  return -1;
}

// Remove HTML comments (outside code) the way the loader strips them before
// injection — the token estimate must not bill the user for comments.
function stripComments(text) {
  return processComments(text, true);
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
  const seen = new Map();
  const excluded = path => OPTS.excludes.some(pattern => {
    const logical = resolve(path).split(sep).join('/');
    let real = logical;
    try { real = realpathSync(path).split(sep).join('/'); } catch {}
    return globMatch(pattern.split('\\').join('/'), logical) || globMatch(pattern.split('\\').join('/'), real);
  });
  const add = (path, kind, launch, via) => {
    const key = resolve(path);
    const stat = tryStat(key);
    if (!stat?.isFile() || excluded(key)) return null;
    if (seen.has(key)) {
      const entry = seen.get(key);
      if (launch && !entry.launch) {
        entry.launch = true;
        entry.kind = kind;
        entry.via = via || entry.via;
      }
      return entry;
    }
    const entry = { path: key, kind, launch, via: via || null };
    seen.set(key, entry);
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

  // managed policy memory loads for every user on the machine
  if (!OPTS.projectOnly) add(join(managedDir(), 'CLAUDE.md'), 'managed', true);

  // user scope (opt-in)
  if (OPTS.user) {
    add(join(userConfigDir(), 'CLAUDE.md'), 'user', true);
    for (const f of walkMd(join(userConfigDir(), 'rules'))) add(f, 'user-rule', true);
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

  // Resolve imports in launch and on-demand memory. Imports inherit their
  // source's loading mode; a launch import promotes a previously lazy file.
  const queue = files.map(f => ({ path: f.path, depth: 0, launch: f.launch }));
  const visited = new Map(queue.map(q => [resolve(q.path), q.launch]));
  while (queue.length) {
    const { path, depth, launch } = queue.shift();
    const text = tryRead(path);
    if (text === null) continue;
    for (const imp of findImports(text)) {
      if (depth + 1 > IMPORT_MAX_DEPTH) {
        findings.push(warn('import-depth',
          `${rel(path)}:${imp.line} imports @${imp.spec} beyond ${IMPORT_MAX_DEPTH} hops — Claude Code stops resolving here`));
        continue;
      }
      const target = resolveImport(imp.spec, path);
      const targetStat = target && tryStat(target);
      if (!targetStat?.isFile()) {
        findings.push(err('broken-import',
          `${rel(path)}:${imp.line} imports @${imp.spec} — file not found or not a regular file` +
          (looksLikePackage(imp.spec) ? ' (if this is a package name, wrap it in backticks so it is not parsed as an import)' : '')));
        continue;
      }
      const key = resolve(target);
      const previous = visited.get(key);
      const added = add(target, 'import', launch, `${rel(path)}:${imp.line}`);
      if (!added) continue;
      if (previous === true || previous === launch) continue;
      visited.set(key, launch || previous || false);
      queue.push({ path: target, depth: depth + 1, launch });
    }
  }

  return files;
}

function looksLikePackage(spec) {
  return /^[\w-]+\/[\w.-]+$/.test(spec) && !spec.includes('.md') && !spec.startsWith('.');
}

function findImports(text) {
  const masked = maskCode(processComments(text));
  const out = [];
  const re = /(^|[\s(])@((?:[A-Za-z]:[\\/]|\/|~\/|\.\.?[\\/]|[\w-])[\w./~\\:-]*)/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    let spec = m[2].replace(/[.,;:!?)]+$/, '');
    if (!spec || spec === '.' || spec === '..') continue;
    const at = m.index + m[1].length;
    const line = masked.slice(0, at).split('\n').length;
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
      if (kv[2].trim() !== '') {
        const value = stripYamlComment(kv[2]).trim();
        if (/^\[.*\]$/.test(value)) fm[kv[1]] = splitYamlFlow(value.slice(1, -1));
        else fm[kv[1]] = unquote(value);
      }
      else fm[kv[1]] = [];
      continue;
    }
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && listKey) fm[listKey].push(unquote(stripYamlComment(item[1]).trim()));
  }
  return fm;
}

function stripYamlComment(value) {
  let quote = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if ((c === '"' || c === "'") && value[i - 1] !== '\\') quote = quote === c ? null : quote || c;
    if (c === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i);
  }
  return value;
}
function unquote(value) { return value.replace(/^(["'])([\s\S]*)\1$/, '$2'); }
function splitYamlFlow(value) {
  const parts = []; let quote = null; let start = 0;
  for (let i = 0; i <= value.length; i++) {
    const c = value[i];
    if ((c === '"' || c === "'") && value[i - 1] !== '\\') quote = quote === c ? null : quote || c;
    if ((c === ',' && !quote) || i === value.length) { parts.push(unquote(value.slice(start, i).trim())); start = i + 1; }
  }
  return parts.filter(Boolean);
}

function walkMd(dir) {
  const out = [];
  const stack = [dir];
  const visited = new Set();
  while (stack.length) {
    const d = stack.pop();
    let real;
    try { real = realpathSync(d); } catch { continue; }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e.name);
      const isDir = e.isDirectory() || (e.isSymbolicLink() && tryStat(p)?.isDirectory());
      if (isDir) { if (!SKIP_DIRS.has(e.name)) stack.push(p); }
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
    if (depth > SCAN_DIR_DEPTH || count > SCAN_FILE_CAP) continue;
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
// Hook events, by what they can do to a rule. Only tool events carry tool
// matchers; only enforcing events can stop, veto, or force feedback on an
// action. SessionStart/SessionEnd/Notification/PreCompact and friends inject
// context or observe — they never count as enforcement.
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);
const PREVENTING_EVENTS = new Set(['PreToolUse', 'PermissionRequest']);
const ENFORCING_EVENTS = new Set([...TOOL_EVENTS, 'UserPromptSubmit', 'Stop', 'SubagentStop']);

// Path rules on these tools are accepted by Claude Code but never matched: it
// checks file access against Edit(...) and Read(...) only (docs: permissions,
// "Write(path), Glob(path), and Grep(path) rules don't match").
const INERT_PATH_TOOLS = { Write: 'Edit', NotebookEdit: 'Edit', MultiEdit: 'Edit', Glob: 'Read', Grep: 'Read' };

function managedDir() {
  if (process.env.PROVE_IT_MANAGED_DIR) return resolve(process.env.PROVE_IT_MANAGED_DIR);
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  return '/etc/claude-code';
}

function settingsSources() {
  const sources = [];
  if (!OPTS.projectOnly) sources.push({ path: join(userConfigDir(), 'settings.json'), scope: 'user' });
  sources.push(
    { path: join(ROOT, '.claude', 'settings.json'), scope: 'project' },
    { path: join(ROOT, '.claude', 'settings.local.json'), scope: 'local' },
  );
  if (!OPTS.projectOnly) {
    // managed-settings.json first, then managed-settings.d/*.json alphabetically
    sources.push({ path: join(managedDir(), 'managed-settings.json'), scope: 'managed' });
    let dropIns = [];
    try { dropIns = readdirSync(join(managedDir(), 'managed-settings.d')).filter(n => n.endsWith('.json') && !n.startsWith('.')).sort(); } catch {}
    for (const n of dropIns) sources.push({ path: join(managedDir(), 'managed-settings.d', n), scope: 'managed' });
  }
  return sources;
}

function readSettingsObject(path, findings) {
  const text = tryRead(path);
  if (text === null) return null;
  let json;
  try { json = JSON.parse(text); } catch (e) {
    findings.push(err('settings-parse', `${rel(path)} is not valid JSON (${e.message}) — Claude Code will ignore it, and so does this audit`));
    return null;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    findings.push(err('settings-schema', `${rel(path)} must contain a JSON object — Claude Code will ignore this settings file`));
    return null;
  }
  return json;
}

function discoverSettings(findings) {
  const hooks = [];       // {id, event, matcher, matcherNames[], command, scripts[], lane, scope}
  const permissions = []; // {list, rule, tool, pattern, scope, inert}
  const excludes = [];
  const enabledPlugins = {};
  const managedPlugins = new Set();
  let anySettings = false;
  let disableAllHooks = false;        // user/project/local value after precedence
  let disableManagedHooks = false;    // only managed settings can disable managed hooks
  let allowManagedHooksOnly = false;

  for (const src of settingsSources()) {
    const json = readSettingsObject(src.path, findings);
    if (!json) continue;
    if (src.scope !== 'managed') anySettings = true;
    if (typeof json.disableAllHooks === 'boolean') {
      if (src.scope === 'managed') disableManagedHooks = disableAllHooks = json.disableAllHooks;
      else disableAllHooks = json.disableAllHooks;
    }
    if (src.scope === 'managed' && json.allowManagedHooksOnly === true) allowManagedHooksOnly = true;
    if (Array.isArray(json.claudeMdExcludes)) excludes.push(...json.claudeMdExcludes.filter(x => typeof x === 'string'));
    if (json.enabledPlugins && typeof json.enabledPlugins === 'object' && !Array.isArray(json.enabledPlugins)) {
      for (const [key, on] of Object.entries(json.enabledPlugins)) {
        enabledPlugins[key] = on === true;
        if (src.scope === 'managed' && on === true) managedPlugins.add(key);
      }
    }
    collectHooks(json.hooks, src.scope, null, hooks, findings);
    collectPermissions(json.permissions, src.scope, permissions, findings);
  }

  if (!OPTS.projectOnly) {
    for (const plugin of installedPlugins(Object.keys(enabledPlugins).filter(k => enabledPlugins[k]))) {
      const scope = `plugin:${plugin.key}`;
      const manifest = readSettingsObject(join(plugin.root, '.claude-plugin', 'plugin.json'), []) || {};
      let hookDoc = null;
      if (typeof manifest.hooks === 'string') hookDoc = readSettingsObject(resolve(plugin.root, manifest.hooks), findings);
      else if (manifest.hooks && typeof manifest.hooks === 'object') hookDoc = { hooks: manifest.hooks };
      hookDoc = hookDoc || readSettingsObject(join(plugin.root, 'hooks', 'hooks.json'), findings);
      if (hookDoc) collectHooks(hookDoc.hooks, scope, plugin.root, hooks, findings, managedPlugins.has(plugin.key));
    }
  }

  if (!anySettings) {
    findings.push(warn('no-settings', 'no .claude/settings.json found — every rule in this CLAUDE.md relies on the model choosing to follow it'));
  }
  const active = hooks.filter(h => {
    if (h.scriptState === 'missing') return false;
    if (h.scope === 'managed') return !disableManagedHooks;
    if (allowManagedHooksOnly && !h.managedPlugin) return false;
    return !disableAllHooks;
  });
  return { hooks: active, permissions, excludes, disableAllHooks };
}

function installedPlugins(keys) {
  if (!keys.length) return [];
  const registry = readSettingsObject(join(userConfigDir(), 'plugins', 'installed_plugins.json'), []);
  const table = registry && typeof registry.plugins === 'object' ? registry.plugins : {};
  const out = [];
  for (const key of keys) {
    const entries = Array.isArray(table[key]) ? table[key] : table[key] ? [table[key]] : [];
    const root = entries.map(e => e && e.installPath).find(p => typeof p === 'string' && tryStat(p)?.isDirectory());
    if (root) out.push({ key, root });
  }
  return out;
}

function collectHooks(hookObject, scope, pluginRoot, hooks, findings, managedPlugin = false) {
  if (!hookObject || typeof hookObject !== 'object' || Array.isArray(hookObject)) return;
  const reported = new Set();
  for (const [event, groups] of Object.entries(hookObject)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
      const matcher = group.matcher ?? '*';
      if (!Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) {
        if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
        const args = Array.isArray(h.args) ? h.args.map(String) : [];
        const command = String(h.command || h.url || h.prompt || (h.server ? `${h.server}.${h.tool}` : '') || '');
        const commandLine = [command, ...args].join(' ');
        const hookType = h.type || 'command';
        const scriptRefs = hookType === 'command' ? extractScriptRefs(command, args) : [];
        const states = scriptRefs.map(s => scriptState(s, pluginRoot));
        const scriptState_ = states.includes('missing') ? 'missing' : states.includes('unknown') ? 'unknown' : 'ok';
        if (scriptState_ === 'missing') {
          for (const [i, s] of scriptRefs.entries()) {
            if (states[i] !== 'missing' || reported.has(s)) continue;
            reported.add(s);
            findings.push(err('hook-script-missing',
              `a ${event} hook in ${scope} settings runs ${s}, which does not exist — the hook fails every time it fires and enforces nothing`));
          }
        }
        hooks.push({
          id: hooks.length,
          event, matcher: String(matcher),
          matcherNames: splitMatcher(String(matcher)),
          type: hookType,
          command: commandLine,
          scripts: scriptRefs.map(s => s.split(/[/\\]/).pop()),
          lane: dispatcherLane(command, args, scriptRefs),
          scriptState: scriptState_,
          scope, managedPlugin,
        });
      }
    }
  }
}

function collectPermissions(perms, scope, permissions, findings) {
  for (const list of ['deny', 'ask', 'allow']) {
    const configured = perms && typeof perms === 'object' && Array.isArray(perms[list]) ? perms[list] : [];
    for (const rule of configured) {
      const m = String(rule).match(/^([\w-]+)\((.*)\)$/);
      const tool = m ? m[1] : String(rule);
      const pattern = m ? m[2] : '';
      const inert = !!INERT_PATH_TOOLS[tool] && pattern.trim() !== '' && pattern.trim() !== '*';
      if (inert) {
        const fix = `${INERT_PATH_TOOLS[tool]}(${pattern})`;
        const msg = `${list} rule ${rule} in ${scope} settings never matches — Claude Code checks file access against Edit(...) and Read(...) rules only; use ${fix}`;
        findings.push(list === 'allow' ? warn('inert-permission', msg) : err('inert-permission', msg));
      }
      permissions.push({ list, rule: String(rule), tool, pattern, scope, inert });
    }
  }
}

function splitMatcher(matcher) {
  if (!matcher || matcher === '*') return ['*'];
  // exact-string list grammar: letters/digits/_/-/space/,/| — else regex
  if (/^[\w\s,|-]+$/.test(matcher)) return matcher.split(/[|,]/).map(s => s.trim()).filter(Boolean);
  return [matcher]; // regex; matched by substring test later
}

// Scripts a command runs. Text an echo/printf prints is not run.
function extractScriptRefs(command, args = []) {
  return uniq([...shellWords(stripEchoes(command)), ...args].filter(arg => /\.(?:mjs|cjs|js|sh|ps1|py|rb)$/i.test(arg)));
}

// Words of a shell command; unquoted ; | & ( ) separate words the way whitespace does.
function shellWords(command) {
  const words = []; let word = ''; let quote = null;
  for (let i = 0; i <= command.length; i++) {
    const c = command[i];
    if (i === command.length || (!quote && /[\s;|&()]/.test(c))) {
      if (word) words.push(word);
      word = '';
    } else if ((c === '"' || c === "'") && command[i - 1] !== '\\') {
      quote = quote === c ? null : quote || c;
    } else word += c;
  }
  return words;
}

// 'ok' | 'missing' | 'unknown' (a path this audit cannot expand, such as $HOME
// or an unset plugin root, is unknown — never reported as missing)
function scriptState(script, pluginRoot = null) {
  let candidate = script.replace(/^['"]|['"]$/g, '');
  const placeholders = { CLAUDE_PROJECT_DIR: ROOT, ...(pluginRoot ? { CLAUDE_PLUGIN_ROOT: pluginRoot } : {}) };
  for (const [name, value] of Object.entries(placeholders)) {
    candidate = candidate.replace(new RegExp(`^(?:\\$\\{${name}\\}|\\$${name}|%${name}%)(?=[/\\\\]|$)`, 'i'), value);
  }
  candidate = candidate.replace(/^(?:\$\{HOME\}|\$HOME|%USERPROFILE%)(?=[/\\]|$)/i, homedir());
  if (/\$|%\w+%/.test(candidate)) return 'unknown';
  if (candidate.startsWith('~')) candidate = expandHome(candidate);
  if (!isAbsolute(candidate)) candidate = resolve(ROOT, candidate);
  return tryStat(candidate)?.isFile() ? 'ok' : 'missing';
}

// A dispatcher hook runs one script with a lane name: `node adapter.mjs askgate`.
// The lane, not the shared script, is the mechanism's identity.
function dispatcherLane(command, args, scriptRefs) {
  if (!scriptRefs.length) return null;
  const words = [...shellWords(command), ...args];
  const at = words.findIndex(w => scriptRefs.includes(w));
  const next = at === -1 ? null : words[at + 1];
  return next && /^[A-Za-z][\w-]*$/.test(next) ? next : null;
}

// ---------- directive extraction ----------
const HARD_MARKERS = [
  /\bnever\b/i, /\balways\b/i, /\bmust(?:\s+not)?\b/i, /\bdo not\b/i, /\bdon't\b/i,
  /\bforbidden\b/i, /\bbanned\b/i, /\boff[- ]limits\b/i, /\bnot allowed\b/i,
  /\brequired?\b/i, /\brequires\b/i, /\bread[- ]only\b/i, /\bblock(?:ed|s)?\b/i,
  /\bdeny\b/i, /\bno\s+\w+ing\b/i, /\bonly\s+(?:use|do|if|when|edit|write|read)\b/i,
  /\bprohibit(?:s|ed)?\b/i, /\brefuses?\b/i, /\bmay not\b/i, /\bnot permitted\b/i, /\bdisallowed\b/i,
];
const SOFT_MARKERS = [
  /\bshould(?:\s+not)?\b/i, /\bprefer\b/i, /\bavoid\b/i, /\brecommended\b/i,
  /\bask\s+(?:first|before)\b/i, /\bplease\b/i, /\bcannot\b/i,
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
    const masked = maskCode(processComments(text), { inline: false });
    const rawLines = text.split('\n');
    const lines = masked.split('\n');

    for (const unit of units(lines)) {
      const raw = unit.lines.map(i => rawLines[i]).join(' ').trim();
      const clean = unit.lines.map(i => lines[i]).join(' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/[*_#>`]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const annotation = findAnnotation(rawLines, unit.lines);
      if (clean.length < 8 && !annotation) continue;
      const hard = HARD_MARKERS.some(re => re.test(clean));
      const soft = !hard && SOFT_MARKERS.some(re => re.test(clean));
      if (!hard && !soft && !annotation) continue;
      directives.push({
        id: `d${++id}`,
        file: f.path,
        line: unit.lines[0] + 1,
        text: clean,
        raw,
        strength: hard || annotation ? 'hard' : 'soft',
        annotation,
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
//   <!-- enforced-by: deny Edit(./protected/**) -->
//   <!-- enforced-by: script subagent-guard.mjs -->
//   <!-- enforced-by: none -->
// Attach it at the end of the rule's line or on the line directly below.
function findAnnotation(rawLines, unitLineIdxs) {
  const last = unitLineIdxs[unitLineIdxs.length - 1];
  const scan = [...unitLineIdxs];
  const next = rawLines[last + 1];
  if (next !== undefined && /^\s*<!--/.test(next)) scan.push(last + 1);
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
  const parts = splitClaims(body);
  const claims = (parts.length ? parts : ['']).map(claim => {
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

function splitClaims(body) {
  const out = []; let depth = 0; let quote = null; let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const c = body[i];
    if ((c === '"' || c === "'") && body[i - 1] !== '\\') quote = quote === c ? null : quote || c;
    if (!quote && c === '(') depth++;
    if (!quote && c === ')' && depth > 0) depth--;
    if ((c === ',' && depth === 0 && !quote) || i === body.length) {
      const part = body.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }
  return out;
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
      const hit = surface.permissions.find(p => p.list === c.list && p.rule === c.rule.trim());
      const live = hit && !hit.inert;
      results.push({ claim: c, ok: !!live, evidence: live
        ? `${hit.list} rule ${hit.rule} in ${hit.scope} settings`
        : hit ? `${hit.list} rule ${hit.rule} exists in ${hit.scope} settings but never matches (use ${INERT_PATH_TOOLS[hit.tool]}(${hit.pattern}))`
        : `no ${c.list} rule ${c.rule} in any settings file` });
      continue;
    }
    if (c.type === 'script') {
      const name = c.name.split(/[/\\]/).pop().toLowerCase();
      const hit = surface.hooks.find(h => h.scripts.some(s => s.toLowerCase() === name) || (h.lane || '').toLowerCase() === name);
      results.push({ claim: c, ok: !!hit, hook: hit || null, evidence: hit
        ? `${c.name} runs in a ${hit.event} hook (matcher: ${hit.matcher}, ${hit.scope} settings)`
        : `${c.name} does not appear in any active hook command` });
    }
  }
  return results;
}

// ---------- heuristic enforcement matching ----------
const TOOL_NAMES = ['Bash', 'PowerShell', 'Edit', 'Write', 'Read', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task', 'Agent', 'Workflow', 'Skill',
  'AskUserQuestion', 'TodoWrite'];
// Tool names that are also English words count only when written as a tool:
// `Read`, Read(...), "the Read tool", or inside a matcher list like Edit|Write.
const AMBIGUOUS_TOOLS = new Set(['Edit', 'Write', 'Read', 'Glob', 'Task', 'Agent', 'Workflow', 'Skill']);
function toolsNamedIn(raw) {
  const found = new Set();
  for (const t of TOOL_NAMES) {
    const re = AMBIGUOUS_TOOLS.has(t)
      ? new RegExp(`\`${t}[\`(]|(?<![\\w-])${t}\\(|(?<![\\w-])${t}\\s+tools?\\b|(?<![\\w-])${t}\\|\\w|\\w\\|${t}(?![\\w-])`)
      : new RegExp(`(?<![\\w-])${t}(?![\\w-])`);
    if (re.test(raw)) found.add(t);
  }
  return found;
}
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

// Rule-side path tokens, each kept with whether it reads as a path (has a
// slash, a dot-file, or an extension). Bare backticked words such as `main`
// are kept for nothing: they are names, not paths.
function pathTokens(text) {
  const out = [];
  // backticked spans in the raw text are the strongest path signals
  for (const m of text.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  // bare tokens that look like paths or globs
  for (const m of text.matchAll(/(?:^|\s)((?:[\w.*-]+\/)+[\w.*-]*|\.\w[\w.]*|[\w-]+\.(?:json|md|env|txt|yml|yaml|lock))(?=\s|$|[,.;:])/g)) {
    out.push(m[1]);
  }
  return uniq(out.filter(looksLikePath).map(normPath).filter(t => t.length >= 3 && !NOT_PATHS.has(t)));
}
function looksLikePath(t) {
  return /[/\\]/.test(t) || /^\.\w/.test(t) || /\w\.[a-z]{1,5}$/i.test(t);
}
function normPath(t) {
  return t.toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\*+/g, '').replace(/\/+$/, '').replace(/\/+/g, '/').trim();
}
function segments(p) {
  return normPath(p).split('/').filter(s => s && s !== '.');
}
// true when one path's segments appear contiguously inside the other's:
// `protected/` ~ Edit(./protected/**), `scripts/a.mjs` ~ E:/repo/scripts/a.mjs
function pathOverlap(a, b) {
  const [x, y] = [segments(a), segments(b)];
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((s, j) => long[i + j] === s)) return true;
  }
  return false;
}

// echo/printf text is what a hook says, not what it touches
function stripEchoes(command) {
  return command.replace(/\b(?:echo|printf)\b(?:\s+(?:-\w+|"(?:[^"\\]|\\.)*"|'[^']*'))+/g, ' ');
}
function commandPaths(h) {
  return shellWords(stripEchoes(h.command)).map(w => w.replace(/^['"]|['"]$/g, '')).filter(looksLikePath);
}

function contentWords(text) {
  return uniq((text.toLowerCase().match(/[a-z][a-z-]{3,}/g) || []).filter(w => !STOPWORDS.has(w)));
}
// exact word, or a plural of it: "subagents" ~ subagent; "record" !~ recorder
function sameWord(a, b) {
  return a === b || a === b + 's' || b === a + 's' || a === b + 'es' || b === a + 'es';
}
function mechanismWords(h) {
  const names = h.lane ? [h.lane] : h.scripts.map(s => s.replace(/\.\w+$/, ''));
  return uniq(names.flatMap(n => n.toLowerCase().split(/[-_.]/)).filter(w => w.length >= 6));
}
function hookLabel(h) {
  const name = h.lane ? `${h.scripts[0] || ''} ${h.lane}`.trim() : h.scripts.join(', ');
  return name ? ` (${name})` : '';
}

// Score each mechanism (one hook entry or one permission rule) on its own and
// take the best one. Signals from one mechanism add up; repeats of a weak
// signal across many mechanisms do not.
function matchDirective(d, surface) {
  const mechanisms = new Map(); // key -> {score, evidence[], hook}
  const bump = (key, points, evidence, hook = null) => {
    const m = mechanisms.get(key) || { score: 0, evidence: [], hook };
    m.score += points;
    m.evidence.push(evidence);
    mechanisms.set(key, m);
  };
  const dText = d.text;
  // the project root (or a folder above it) names everything and nothing
  const rootSegments = segments(ROOT);
  const dPaths = pathTokens(d.raw).filter(p => {
    const s = segments(p);
    return !(s.length <= rootSegments.length && s.every((x, i) => rootSegments[i] === x));
  });
  const dWords = contentWords(dText);
  const enforcing = surface.hooks.filter(h => ENFORCING_EVENTS.has(h.event));

  // signal 1: path overlap with a deny/ask rule or a path a hook command names (strong).
  // A path every other hook names (a repo root, a scripts folder) says nothing.
  const common = p => enforcing.length >= 4 && enforcing.filter(h => commandPaths(h).some(c => pathOverlap(p, c))).length / enforcing.length >= 0.5;
  for (const p of dPaths) {
    for (const perm of surface.permissions) {
      if (perm.list === 'allow' || perm.inert || !perm.pattern) continue;
      if (pathOverlap(p, perm.pattern)) {
        bump(`perm:${perm.list}:${perm.rule}:${perm.scope}`, 3, `rule mentions \`${p}\`; ${perm.list} rule ${perm.rule} covers it (${perm.scope} settings)`);
      }
    }
    if (common(p)) continue;
    for (const h of enforcing) {
      if (commandPaths(h).some(c => pathOverlap(p, c))) {
        bump(`hook:${h.id}`, 3, `rule mentions \`${p}\`; a ${h.event} hook${hookLabel(h)} passes that path (matcher: ${h.matcher})`, h);
      }
    }
  }

  // signal 2: tool names (explicit, or via concept words like "subagent").
  // Only tool events carry tool matchers; a PostToolUse hook acts after the fact.
  const toolsInRule = toolsNamedIn(d.raw);
  for (const [word, tools] of Object.entries(CONCEPT_TOOLS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(dText)) tools.forEach(t => toolsInRule.add(t));
  }
  for (const h of enforcing) {
    if (!TOOL_EVENTS.has(h.event)) continue;
    const overlap = [...toolsInRule].filter(n => matcherMatchesTool(h.matcher, n));
    if (overlap.length) {
      bump(`hook:${h.id}`, PREVENTING_EVENTS.has(h.event) ? 2 : 1,
        `rule concerns ${overlap.join('/')}; a ${h.event} hook${hookLabel(h)} matches ${h.matcher}`, h);
    }
  }
  for (const perm of surface.permissions) {
    if (perm.list !== 'allow' && !perm.inert && toolsInRule.has(perm.tool)) {
      bump(`perm:${perm.list}:${perm.rule}:${perm.scope}`, 1, `rule concerns ${perm.tool}; ${perm.list} rule ${perm.rule} exists`);
    }
  }

  // signal 3: shared words with the mechanism's name (subagent-guard.mjs → subagent;
  // adapter.mjs askgate → askgate). 6-char minimum: guard, vault, gate match everything.
  for (const h of enforcing) {
    const shared = mechanismWords(h).filter(w => dWords.some(dw => sameWord(dw, w)));
    if (shared.length) {
      bump(`hook:${h.id}`, Math.min(shared.length, 2),
        `shares "${shared.join('", "')}" with hook${hookLabel(h)} (${h.event}, matcher: ${h.matcher})`, h);
    }
  }

  const ranked = [...mechanisms.values()].sort((a, b) => b.score - a.score);
  const score = ranked.length ? ranked[0].score : 0;
  const verdict = score >= 3 ? 'likely' : score >= 2 ? 'possible' : 'prose';
  // every hook that contributed counts toward coverage once the rule itself is enforced
  const hooksHit = new Set(ranked.filter(m => m.hook).map(m => m.hook));
  // show the deciding mechanism, plus any other that scores at least "possible"
  const shown = ranked.filter((m, i) => i === 0 || m.score >= 2);
  return { verdict, score, evidence: uniq(shown.flatMap(m => m.evidence)).slice(0, 4), hooksHit };
}

function matcherMatchesTool(matcher, tool) {
  if (!matcher || matcher === '*') return true;
  if (/^[\w\s,|-]+$/.test(matcher)) return splitMatcher(matcher).some(n => n === tool);
  try { return new RegExp(matcher).test(tool); } catch { return false; }
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
  // Only enforcing events count; context injection and observers enforce nothing.
  const seen = new Set();
  for (const h of surface.hooks) {
    if (hooksCovered.has(h) || !ENFORCING_EVENTS.has(h.event)) continue;
    const key = `${h.event}|${h.matcher}|${h.scripts.join(',')}|${h.lane || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = h.lane ? `${h.scripts[0]} ${h.lane}` : h.scripts.join(', ');
    findings.push(info('unwritten-hook',
      `a ${h.event} hook (matcher: ${h.matcher}${name ? `, ${name}` : ''}, ${h.scope} settings) can enforce something no memory-file rule describes — document it or remove it`));
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
      if (jac >= 0.4 && oppositePolarity(A.text, B.text)) {
        findings.push(warn('contradiction-candidate',
          `possible contradiction (a judgment call, not a verdict): ${rel(A.file)}:${A.line} vs ${rel(B.file)}:${B.line} — same subject, opposite polarity`));
      } else if (jac >= 0.65) {
        findings.push(warn('duplicate',
          `${A.text === B.text ? 'duplicate' : 'near-duplicate'} rules: ${rel(A.file)}:${A.line} and ${rel(B.file)}:${B.line} say close to the same thing — pick one home`));
      }
    }
  }
}

function oppositePolarity(a, b) {
  const neg = /\b(never|do not|don't|not allowed|forbidden|banned|prohibited|no)\b/i;
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
    if (depth > SCAN_DIR_DEPTH || count > SCAN_FILE_CAP) continue;
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
  const source = glob.split('\\').join('/');
  const value = path.split('\\').join('/');
  try { return new RegExp('^' + globRegex(source) + '$').test(value); } catch { return false; }
}

function globRegex(source) {
  let re = '';
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '*' && source[i + 1] === '*') {
      i++;
      if (source[i + 1] === '/') { i++; re += '(?:.*/)?'; }
      else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = source.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        let cls = source.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else if (c === '{') {
      const end = source.indexOf('}', i + 1);
      if (end === -1) re += '\\{';
      else {
        const options = source.slice(i + 1, end).split(',').map(globRegex);
        re += '(?:' + options.join('|') + ')';
        i = end;
      }
    } else re += /[.+^$()|{}\\]/.test(c) ? '\\' + c : c;
  }
  return re;
}

function checkLocalGitignore(files, findings) {
  const local = files.find(f => f.kind === 'local');
  if (!local) return;
  const gi = tryRead(join(ROOT, '.gitignore'));
  if (gi !== null && !gitignoreCovers(gi, 'CLAUDE.local.md')) {
    findings.push(warn('local-not-ignored',
      'CLAUDE.local.md exists but .gitignore does not cover it — personal instructions will end up in the repo'));
  }
}

function gitignoreCovers(text, path) {
  let ignored = false;
  for (const raw of text.split('\n')) {
    let pattern = raw.trim();
    if (!pattern || pattern.startsWith('#')) continue;
    const negated = pattern.startsWith('!');
    if (negated) pattern = pattern.slice(1);
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    const match = pattern.includes('/') ? globMatch(pattern, path) : globMatch(pattern, path.split('/').pop());
    if (match) ignored = !negated;
  }
  return ignored;
}

// ---------- context cost ----------
// What hooks inject. SessionStart output joins every session's context and
// UserPromptSubmit output joins every prompt. This audit never runs hooks, so
// it counts what it can read (echo/printf literals, files a hook cats) and
// names the scripts whose stdout reaches the model unmeasured.
function hookContext(hooks) {
  const out = {};
  for (const [key, event] of [['sessionStart', 'SessionStart'], ['userPromptSubmit', 'UserPromptSubmit']]) {
    const list = hooks.filter(h => h.event === event && h.type === 'command');
    let chars = 0; let unmeasuredHooks = 0;
    const unmeasured = new Set();
    for (const h of list) {
      for (const m of h.command.matchAll(/\b(?:echo|printf)\b((?:\s+(?:-\w+|"(?:[^"\\]|\\.)*"|'[^']*'))+)/g)) {
        for (const q of m[1].matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) chars += (q[1] ?? q[2]).length + 1;
      }
      const words = shellWords(h.command).map(w => w.replace(/^['"]|['"]$/g, ''));
      words.forEach((w, i) => {
        const next = words[i + 1];
        if (w !== 'cat' || !next || next.includes('$') || !looksLikePath(next)) return;
        const text = tryRead(resolve(ROOT, next));
        if (text !== null) chars += text.length;
      });
      const loud = h.command.split(/;|&&|\|\|/).filter(seg => extractScriptRefs(seg).length &&
        !/(?:^|\s)1?>\s*(?:\/dev\/null|\$null|nul)(?:\s|$)/i.test(seg) && !/\|\s*Out-Null/i.test(seg));
      if (loud.length) {
        unmeasuredHooks++;
        for (const seg of loud) for (const s of extractScriptRefs(seg)) unmeasured.add(s.replace(/^['"]|['"]$/g, '').split(/[/\\]/).pop());
      }
    }
    out[key] = { count: list.length, staticEstTokens: Math.ceil(chars / TOKEN_DIVISOR), unmeasured: [...unmeasured], unmeasuredHooks };
  }
  return out;
}

function contextCost(files, surface, findings) {
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
  const hooks = hookContext(surface.hooks);
  const s = hooks.sessionStart;
  if (s.unmeasuredHooks) {
    findings.push(info('hook-context',
      `${s.unmeasuredHooks} SessionStart hook command${s.unmeasuredHooks === 1 ? '' : 's'} print script output into every session (${s.unmeasured.join(', ')}) — this audit never runs hooks, so that context is not in the estimate`));
  }
  return {
    method: `chars / ${TOKEN_DIVISOR}, HTML comments stripped first (the loader strips them too). An estimate, not a tokenizer.`,
    launch, onDemand, hooks,
    launchTokens: launch.reduce((sum, f) => sum + f.estTokens, 0),
    onDemandTokens: onDemand.reduce((sum, f) => sum + f.estTokens, 0),
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

  const t = cost.launchTokens + cost.hooks.sessionStart.staticEstTokens;
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
  const ss = cost.hooks.sessionStart;
  if (ss.count) {
    out.push(`  ${C.bold('plus SessionStart hooks:')} ${ss.count} command${ss.count === 1 ? '' : 's'}, ${fmtTokens(ss.staticEstTokens)} tokens of literal text` +
      (ss.unmeasuredHooks ? C.dim(`; ${ss.unmeasuredHooks} print script output this audit cannot measure (${clip(ss.unmeasured.join(', '), 60)})`) : ''));
  }
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
  const surface = discoverSettings(findings);
  OPTS.excludes = surface.excludes;
  const files = discoverMemoryFiles(findings);
  const directives = extractDirectives(files);
  const map = buildEnforcementMap(directives, surface, findings);
  checkDuplication(directives, findings);
  checkClarity(files, directives, findings);
  checkScopedRules(files, findings);
  checkLocalGitignore(files, findings);
  const cost = contextCost(files, surface, findings);
  const score = scoreReport(map, cost, findings);

  const report = {
    version: VERSION, root: ROOT.split(sep).join('/'),
    score, cost, map, findings,
    surface: {
      hooks: surface.hooks.map(h => ({ event: h.event, matcher: h.matcher, type: h.type, scripts: h.scripts, lane: h.lane, scope: h.scope })),
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
