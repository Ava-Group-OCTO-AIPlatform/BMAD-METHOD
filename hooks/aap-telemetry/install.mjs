#!/usr/bin/env node
// Installs the Intelligence Hub telemetry hooks of this fork (bmad.telemetry.contract = 1).
//
//   npx -y github:Ava-Group-OCTO-AIPlatform/BMAD-METHOD            # this repository + Claude Code (user)
//   npx -y github:Ava-Group-OCTO-AIPlatform/BMAD-METHOD --repo     # this repository only
//   npx -y github:Ava-Group-OCTO-AIPlatform/BMAD-METHOD --user     # Claude Code (user) only
//   npx -y github:Ava-Group-OCTO-AIPlatform/BMAD-METHOD --uninstall
//
// --repo  copies the hook into <repo>/.github/hooks/ (GitHub Copilot CLI and VS Code
//         agent hooks read it there); commit it once and the whole team has it.
// --user  copies the hook to ~/.aap-bmad/hook.mjs and registers it in
//         ~/.claude/settings.json (Claude Code, every repository), for the stock
//         bmad-code-org BMAD install (npx skills add, bmad-plugins marketplace or v6 installer). Skip it when BMAD is installed
//         from this fork's marketplace: the fork plugin already runs the hook.
//         Existing settings are kept; a backup is written next to the file first.
//
// It only copies files and edits those two settings: no download, no token.
// The token comes from the Intelligence Hub IDE setup script (run it first).

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK_SOURCE = path.join(HERE, 'hook.mjs');
const README_SOURCE = path.join(HERE, 'README.md');
const MARKER = 'aap-bmad-telemetry';
const EVENTS = { SessionStart: 'sessionStart', UserPromptSubmit: 'userPromptSubmit', PostToolUse: 'postToolUse', SessionEnd: 'sessionEnd' };
const POST_TOOL_MATCHER = 'Write|Edit|MultiEdit|Skill|Task|Agent';

const args = new Set(process.argv.slice(2));
const uninstall = args.has('--uninstall');
const onlyRepo = args.has('--repo');
const onlyUser = args.has('--user');
const doRepo = !onlyUser;
const doUser = !onlyRepo;

const say = (line) => process.stdout.write(`${line}\n`);

function repoRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function copilotHooksJson() {
  const run = (event) => ({
    type: 'command',
    bash: `node .github/hooks/aap-telemetry/hook.mjs ${event}`,
    powershell: `node .github/hooks/aap-telemetry/hook.mjs ${event}`,
    timeoutSec: 10,
  });
  return {
    version: 1,
    hooks: {
      sessionStart: [run('sessionStart')],
      userPromptSubmitted: [run('userPromptSubmit')],
      postToolUse: [run('postToolUse')],
      sessionEnd: [run('sessionEnd')],
    },
  };
}

function installRepo(root) {
  const dir = path.join(root, '.github', 'hooks', 'aap-telemetry');
  const config = path.join(root, '.github', 'hooks', 'aap-telemetry.json');
  if (uninstall) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(config, { force: true });
    say(`Repository: removed the hooks from ${path.join(root, '.github', 'hooks')}`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(HOOK_SOURCE, path.join(dir, 'hook.mjs'));
  if (existsSync(README_SOURCE)) copyFileSync(README_SOURCE, path.join(dir, 'README.md'));
  writeFileSync(config, `${JSON.stringify(copilotHooksJson(), null, 2)}\n`);
  say(`Repository: hooks written to ${path.relative(process.cwd(), config) || config} (commit them so the team has them)`);
}

/** Our entries carry the marker in their command, so a re-run replaces them and --uninstall finds them. */
function withoutOurs(list) {
  return (Array.isArray(list) ? list : [])
    .map((group) => ({ ...group, hooks: (group?.hooks ?? []).filter((h) => !String(h?.command ?? '').includes(MARKER)) }))
    .filter((group) => group.hooks.length > 0);
}

function installUser() {
  const home = path.join(homedir(), '.aap-bmad');
  const hook = path.join(home, 'hook.mjs');
  const settingsFile = path.join(homedir(), '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsFile)) {
    try {
      settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    } catch {
      say(`Claude Code: ${settingsFile} is not valid JSON; left untouched.`);
      return;
    }
    writeFileSync(`${settingsFile}.aap-bmad-backup.json`, JSON.stringify(settings, null, 2));
  } else if (uninstall) {
    return;
  }
  const hooks = { ...(settings.hooks ?? {}) };
  for (const event of Object.keys(EVENTS)) {
    hooks[event] = withoutOurs(hooks[event]);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (!uninstall) {
    mkdirSync(home, { recursive: true });
    copyFileSync(HOOK_SOURCE, hook);
    for (const [event, arg] of Object.entries(EVENTS)) {
      // The trailing comment marks our entries for a re-run or --uninstall.
      const command = `node "${hook.replaceAll('\\', '/')}" ${arg} # ${MARKER}`;
      const group = { ...(event === 'PostToolUse' ? { matcher: POST_TOOL_MATCHER } : {}), hooks: [{ type: 'command', command, timeout: 10 }] };
      hooks[event] = [...(hooks[event] ?? []), group];
    }
  }
  const next = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  mkdirSync(path.dirname(settingsFile), { recursive: true });
  writeFileSync(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
  if (uninstall) rmSync(hook, { force: true });
  say(`Claude Code: hooks ${uninstall ? 'removed from' : 'registered in'} ${settingsFile}`);
}

function main() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    say('Node 18 or newer is needed.');
    process.exit(1);
  }
  if (doRepo) {
    const root = repoRoot();
    if (root) installRepo(root);
    else if (onlyRepo) {
      say('Not inside a git repository: run it from the repository root.');
      process.exit(1);
    } else say('Repository: not inside a git repository, skipped.');
  }
  if (doUser) installUser();
  if (!uninstall) {
    say('');
    say('Next: run the IDE setup script from your Intelligence Hub project link (if you have not),');
    say('then restart VS Code / Claude Code. Opt out any time with AAP_BMAD_TELEMETRY=off.');
  }
}

main();
