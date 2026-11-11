#!/usr/bin/env node
// BMAD Method → Intelligence Hub telemetry hook (bmad.telemetry.contract = 1).
//
//   node hook.mjs <sessionStart|userPromptSubmit|postToolUse|sessionEnd>   (event JSON on stdin)
//
// Runs as a Claude Code hook (hooks/hooks.json of this fork's plugin, or the
// user settings the installer writes) or a GitHub Copilot hook (Copilot CLI and
// VS Code agent hooks, .github/hooks/aap-telemetry.json in a repository).
// It never blocks the agent: no output, always exit 0, 3 s network timeout.
//
// Sends OTLP/HTTP JSON logs to {OTEL_EXPORTER_OTLP_ENDPOINT}/v1/logs with the
// Authorization header of OTEL_EXPORTER_OTLP_HEADERS, which the Intelligence
// Hub IDE setup script already sets for Copilot and Claude Code (the dtl_
// token). In Claude Code on the web it falls back to the relay the Hub cloud
// setup script starts on 127.0.0.1:4318. Without either it does nothing.
// Opt out with AAP_BMAD_TELEMETRY=off.
//
// Privacy: no prompt, path, file name or text leaves the machine. Sessions
// and BMAD documents are SHA-256 hashes (with the repository) cut to 32 hex;
// skills only when they are BMAD names (bmad or bmad-*); artifacts as a kind.

import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK_VERSION = '0.1.0';
const CONTRACT = 1;
const TIMEOUT_MS = 3000;
const OUTBOX_MAX = 1000;
const HOME = process.env.AAP_BMAD_HOME || path.join(homedir(), '.aap-bmad');
const CLOUD_RELAY = 'http://127.0.0.1:4318';
const DEFAULT_OUTPUT = '_bmad-output';

// Artifact kinds by file name, first match wins. Only files in the BMAD output
// folder are classified, and only the kind leaves the machine.
const KIND_RULES = [
  [/^sprint-status/, 'sprint-status'],
  [/^project-context/, 'project-context'],
  [/(^|-)prfaq/, 'prfaq'],
  [/(^|-)(product-)?brief/, 'brief'],
  [/(^|-)brainstorm/, 'brainstorm'],
  [/(^|-)research/, 'research'],
  [/(^|-)prd(-|$)/, 'prd'],
  [/(^|-)(ux|experience|design)(-|$)/, 'ux'],
  [/(^|-)architecture/, 'architecture'],
  [/^adr(-|$)/, 'adr'],
  [/^initiative(-|$)/, 'initiative'],
  [/^intent(-|$)/, 'intent'],
  [/^epics?(-|$)/, 'epic'],
  [/^story(-|$)|^\d+-\d+(-|$)/, 'story'],
  [/(^|-)(tech-)?spec(-|$)/, 'spec'],
  [/(^|-)retro(spective)?(-|$)/, 'retrospective'],
  [/(^|-)(code-)?review(-|$)/, 'review'],
  [/(^|-)(test|qa|e2e)(-|$)/, 'test'],
  [/^plan(-|$)/, 'plan'],
];
/** Documents followed across sessions by a hash of their path. */
const DOC_KINDS = new Set(['prd', 'ux', 'architecture', 'adr', 'initiative', 'intent', 'epic', 'story', 'spec', 'brief']);

// ---------------------------------------------------------------------------

function quietly(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function sha(...parts) {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

function readText(file) {
  return quietly(() => readFileSync(file, 'utf8'), null);
}

function readJson(file, fallback) {
  return quietly(() => JSON.parse(readFileSync(file, 'utf8')), fallback);
}

function writeJson(file, value) {
  quietly(() => {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, file);
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return quietly(() => JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'), {});
}

/** `export KEY='value'` lines of the Copilot env file the setup script writes on macOS and Linux. */
function shellEnv(file) {
  const out = {};
  for (const line of (readText(file) ?? '').split('\n')) {
    const m = /^\s*export\s+([A-Z_][A-Z0-9_]*)=(?:'([^']*)'|"([^"]*)"|(\S*))\s*$/.exec(line);
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function isLoopback(endpoint) {
  const host = quietly(() => new URL(endpoint).hostname, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/**
 * Endpoint and headers, from where the Intelligence Hub setup script puts them:
 * the environment, ~/.claude/settings.json (Claude Code) and
 * ~/.claude/aap-copilot-env.sh (Copilot on macOS/Linux).
 */
function exporterConfig() {
  const claudeDir = path.join(homedir(), '.claude');
  const settingsEnv = readJson(path.join(claudeDir, 'settings.json'), {})?.env ?? {};
  const copilotEnv = shellEnv(path.join(claudeDir, 'aap-copilot-env.sh'));
  const pick = (key) => process.env[key] || settingsEnv[key] || copilotEnv[key] || '';
  const relay = process.env.CLAUDE_CODE_REMOTE === 'true' ? CLOUD_RELAY : '';
  const endpoint = (pick('AAP_BMAD_ENDPOINT') || pick('OTEL_EXPORTER_OTLP_ENDPOINT') || pick('COPILOT_OTEL_ENDPOINT') || relay).replace(/\/+$/, '');
  const headers = {};
  for (const pair of pick('OTEL_EXPORTER_OTLP_HEADERS').split(',')) {
    const at = pair.indexOf('=');
    if (at > 0) headers[decodeURIComponent(pair.slice(0, at).trim())] = decodeURIComponent(pair.slice(at + 1).trim());
  }
  const auth = Object.entries(headers).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
  if (!endpoint) return null;
  if (/^Bearer\s+dtl_/i.test(auth)) return { url: `${endpoint}/v1/logs`, auth };
  // Claude Code on the web: the cloud setup script's relay adds the token, so
  // the container holds none. Only a loopback endpoint goes without one.
  return isLoopback(endpoint) ? { url: `${endpoint}/v1/logs`, auth: '' } : null;
}

function git(cwd, ...args) {
  return quietly(() => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(), null);
}

function repositoryOf(cwd) {
  const m = /[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(git(cwd, 'remote', 'get-url', 'origin') ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

function hostOf(input) {
  if (process.env.AAP_BMAD_HOST) return process.env.AAP_BMAD_HOST;
  if ('hook_event_name' in input || 'tool_name' in input || 'session_id' in input) {
    return process.env.VSCODE_PID || process.env.TERM_PROGRAM === 'vscode' ? 'vscode' : 'claude-code';
  }
  return 'copilot-cli';
}

/** The folder holding `_bmad/`, from the working directory upward (how BMAD skills find the project). */
function projectRoot(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 20; i += 1) {
    if (existsSync(path.join(dir, '_bmad'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const VERSION_RE = /^\s*version\s*[=:]\s*["']?([0-9][0-9A-Za-z.+-]{0,39})["']?\s*$/m;

/** The BMAD version: this plugin (v7 skills/bmod-method/bmod.toml) or the project install (v6 manifest, v7 skills). */
function bmadVersion(root) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, '..', '..', 'skills', 'bmod-method', 'bmod.toml')];
  if (root) {
    candidates.push(
      path.join(root, '_bmad', '_config', 'manifest.yaml'),
      path.join(root, '.claude', 'skills', 'bmod-method', 'bmod.toml'),
      path.join(root, '.agents', 'skills', 'bmod-method', 'bmod.toml'),
      path.join(root, '.github', 'skills', 'bmod-method', 'bmod.toml'),
    );
  }
  for (const file of candidates) {
    const m = VERSION_RE.exec(readText(file) ?? '');
    if (m) return m[1];
  }
  return null;
}

/** BMAD output folder, absolute: `output_folder` of the project config, or `_bmad-output`. */
function outputFolder(root) {
  for (const rel of ['_bmad/custom/config.user.toml', '_bmad/custom/config.toml', '_bmad/config.toml', '_bmad/bmm/config.yaml', '_bmad/core/config.yaml', '_bmad/config.yaml']) {
    const m = /^\s*output_folder\s*[=:]\s*["']?([^"'\n#]+?)["']?\s*$/m.exec(readText(path.join(root, rel)) ?? '');
    if (m) return path.resolve(root, m[1].replace(/^\{project-root\}[\\/]?/, '').trim() || DEFAULT_OUTPUT);
  }
  return path.join(root, DEFAULT_OUTPUT);
}

// ---------------------------------------------------------------------------
// OTLP

function attr(key, value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  if (typeof value === 'number') return { key, value: { intValue: Math.max(0, Math.trunc(value)) } };
  return { key, value: { stringValue: String(value) } };
}

function record(eventName, sessionId, attrs) {
  return {
    timeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
    eventName,
    attributes: Object.entries({ 'bmad.event.id': randomUUID(), 'bmad.session.id': sessionId, ...attrs })
      .map(([k, v]) => attr(k, v))
      .filter(Boolean),
  };
}

function requestOf(records, resource) {
  return {
    resourceLogs: [
      {
        resource: { attributes: Object.entries(resource).map(([k, v]) => attr(k, v)).filter(Boolean) },
        scopeLogs: [{ scope: { name: 'avanade.bmad', version: '1' }, logRecords: records }],
      },
    ],
  };
}

async function send(config, body) {
  const res = await fetch(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(config.auth ? { authorization: config.auth } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // 4xx other than 429 will not get better on a retry: drop.
  return res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429);
}

/** Sends the new records plus whatever is queued; on failure everything goes back to the outbox. */
async function flush(config, resource, records) {
  const outbox = path.join(HOME, 'outbox.jsonl');
  const queued = quietly(() => readFileSync(outbox, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)), []);
  const all = [...queued, ...records].slice(-OUTBOX_MAX);
  if (all.length === 0) return;
  const ok = await send(config, requestOf(all, resource)).catch(() => false);
  quietly(() => {
    mkdirSync(HOME, { recursive: true });
    writeFileSync(outbox, ok ? '' : all.map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
}

// ---------------------------------------------------------------------------
// Sessions (Copilot CLI sends no session id: one is kept per working folder).
// The session file also remembers which artifacts were already reported, so a
// document written section by section counts once per session.

function sessionOf(input, cwd, repository, start) {
  const external = typeof input.session_id === 'string' && input.session_id ? input.session_id : null;
  const file = path.join(HOME, 'sessions', `${sha(external ?? cwd)}.json`);
  const known = readJson(file, null);
  if (known?.id && !(start && !external)) return { ...known, file };
  const fresh = { id: sha(repository ?? cwd, external ?? randomUUID()), startedAt: Date.now(), seen: [] };
  writeJson(file, fresh);
  return { ...fresh, file };
}

function remember(session, key) {
  const seen = new Set(session.seen ?? []);
  if (seen.has(key)) return false;
  seen.add(key);
  const { file, ...rest } = session;
  writeJson(file, { ...rest, seen: [...seen].slice(-500) });
  session.seen = [...seen];
  return true;
}

// ---------------------------------------------------------------------------
// Names and artifacts

/** `bmad-method:bmad-prd`, `/bmad-build`, `bmad_agent_pm` → the BMAD name, or null for anything else. */
function skillOf(raw) {
  if (typeof raw !== 'string') return null;
  let name = raw.trim().toLowerCase().replace(/^\/+/, '');
  name = name.slice(name.lastIndexOf(':') + 1).replaceAll(/[.:_\s]+/g, '-');
  return /^bmad(-[a-z0-9]+){0,8}$/.test(name) && name.length <= 80 ? name : null;
}

/** `/bmad-build fix the login` → bmad-build. Only the command name is read; the prompt is never kept. */
function promptSkill(input) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  const m = /^\s*\/((?:[a-z0-9-]+:)?bmad(?:-[a-z0-9-]+)?)(?=\s|$)/i.exec(prompt);
  return m ? skillOf(m[1]) : null;
}

function toolArgs(input) {
  const raw = input.toolArgs ?? input.tool_input ?? {};
  return typeof raw === 'string' ? quietly(() => JSON.parse(raw), {}) : raw;
}

function writtenPath(args) {
  for (const key of ['path', 'filePath', 'file_path', 'target_file', 'filename']) {
    if (typeof args?.[key] === 'string') return args[key];
  }
  return null;
}

function artifactKindOf(base) {
  const stem = base.toLowerCase().replace(/\.(md|markdown|ya?ml|toml|json)$/, '');
  for (const [re, kind] of KIND_RULES) if (re.test(stem)) return kind;
  return 'other';
}

function artifactRecord(session, cwd, repository, file) {
  const absolute = path.resolve(cwd, file);
  const root = projectRoot(path.dirname(absolute)) ?? projectRoot(cwd);
  if (!root) return null;
  const output = outputFolder(root);
  const inOutput = path.relative(output, absolute);
  if (!inOutput || inOutput.startsWith('..') || path.isAbsolute(inOutput)) return null;
  const parts = inOutput.replaceAll('\\', '/').split('/');
  // Party-mode memories and raw notes are scratch, not delivery artifacts.
  if (parts.includes('memories') || parts[0] === 'raw') return null;
  const kind = artifactKindOf(parts.at(-1) ?? '');
  const repoRoot = git(path.dirname(absolute), 'rev-parse', '--show-toplevel') ?? root;
  const relative = path.relative(repoRoot, absolute).replaceAll('\\', '/');
  if (!remember(session, `${kind}:${relative}`)) return null;
  const attrs = { 'bmad.artifact.kind': kind };
  if (DOC_KINDS.has(kind)) attrs['bmad.doc.id'] = sha(repository ?? repoRoot, relative);
  return record('bmad.artifact.write', session.id, attrs);
}

// ---------------------------------------------------------------------------

async function main() {
  if ((process.env.AAP_BMAD_TELEMETRY ?? '').toLowerCase() === 'off') return;
  const event = String(process.argv[2] ?? '').toLowerCase();
  const input = await readStdin();
  const config = exporterConfig();
  if (!config) return;

  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const repository = repositoryOf(cwd);
  const root = projectRoot(cwd);
  const resource = {
    'service.name': 'bmad-telemetry',
    'service.version': HOOK_VERSION,
    'bmad.telemetry.contract': CONTRACT,
    'bmad.version': bmadVersion(root),
    'bmad.host': hostOf(input),
    'bmad.project': root !== null,
    'vcs.repository.name': repository,
  };
  const records = [];

  if (event === 'sessionstart') {
    records.push(record('bmad.session.start', sessionOf(input, cwd, repository, true).id, {}));
  } else if (event === 'sessionend' || event === 'stop') {
    const session = sessionOf(input, cwd, repository, false);
    const duration = session.startedAt ? Math.round((Date.now() - session.startedAt) / 1000) : null;
    const reason = ['complete', 'error', 'abort', 'timeout', 'user_exit'].includes(input.reason) ? input.reason : 'other';
    records.push(record('bmad.session.end', session.id, { 'bmad.session.duration_s': duration, 'bmad.session.end_reason': reason }));
  } else if (event === 'userpromptsubmit' || event === 'userpromptsubmitted') {
    const skill = promptSkill(input);
    if (skill) records.push(record('bmad.skill.invoke', sessionOf(input, cwd, repository, false).id, { 'bmad.skill.name': skill, 'bmad.invoke.via': 'command' }));
  } else if (event === 'posttooluse') {
    const session = sessionOf(input, cwd, repository, false);
    const args = toolArgs(input);
    const tool = String(input.toolName ?? input.tool_name ?? '').toLowerCase();
    if (tool === 'skill') {
      const skill = skillOf(args.skill ?? args.name);
      if (skill) records.push(record('bmad.skill.invoke', session.id, { 'bmad.skill.name': skill, 'bmad.invoke.via': 'skill' }));
    } else if (tool === 'task' || tool === 'agent' || tool === 'runsubagent') {
      const skill = skillOf(args.subagent_type ?? args.agent_type ?? args.agentName ?? args.agent);
      if (skill) records.push(record('bmad.skill.invoke', session.id, { 'bmad.skill.name': skill, 'bmad.invoke.via': 'subagent' }));
    }
    const file = writtenPath(args);
    const artifact = file ? artifactRecord(session, cwd, repository, file) : null;
    if (artifact) records.push(artifact);
  }

  if (records.length > 0 || existsSync(path.join(HOME, 'outbox.jsonl'))) await flush(config, resource, records);
}

main()
  .catch((err) => quietly(() => appendFileSync(path.join(HOME, 'errors.log'), `${new Date().toISOString()} ${String(err?.message ?? err)}\n`)))
  .finally(() => process.exit(0));
