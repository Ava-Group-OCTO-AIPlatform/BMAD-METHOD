# Intelligence Hub telemetry hooks (Avanade fork)

These hooks send BMAD Method usage to the Intelligence Hub collector (Governance › SDLC ›
Developers › BMAD Method, and the SDD & Skills group of each SDLC project), under the
contract `bmad.telemetry.contract = 1`. They are the only change of this fork against
`bmad-code-org/BMAD-METHOD`, kept in their own files so upstream syncs merge cleanly.

| File | Host |
|---|---|
| `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json` | Claude Code marketplace `bmad-avanade` (plugin `bmad-method`, the `skills/` of this repository) |
| `hooks/hooks.json` | Claude Code, when BMAD is installed from this fork's marketplace |
| `hooks/aap-telemetry/hook.mjs` | the hook itself (Node 18+, no dependencies) |
| `hooks/aap-telemetry/install.mjs` | the one-command installer (`npx`), for GitHub Copilot or a stock BMAD install |
| `package.json` | the `npx` entry point only (BMAD itself is not an npm package on this branch) |

## Setup

1. Run the IDE setup script from the project's link page in the Intelligence Hub. It sets
   `OTEL_EXPORTER_OTLP_ENDPOINT` and `OTEL_EXPORTER_OTLP_HEADERS` (the `dtl_` token) that the
   hook reads. Without them the hook does nothing (Claude Code on the web uses the relay the
   Hub cloud setup script starts on `127.0.0.1:4318`).
2. Claude Code (desktop, VS Code extension or web): install BMAD from this fork, which already
   runs the hooks:

   ```bash
   claude plugin marketplace add Ava-Group-OCTO-AIPlatform/BMAD-METHOD
   claude plugin install bmad-method@bmad-avanade
   ```

   Then ask the `bmad` skill to run `bmad setup` in the project, as upstream documents.
   Remove the upstream plugin first if you had it (`claude plugin uninstall bmad-method@bmad`).
3. GitHub Copilot (CLI or VS Code agent hooks), or BMAD installed the upstream way
   (`npx skills add bmad-code-org/BMAD-METHOD`, `npx bmad-method install` for v6.12): from the
   repository root (Node 18+):

   ```bash
   npx -y github:Ava-Group-OCTO-AIPlatform/BMAD-METHOD            # this repository + Claude Code (user)
   npx -y github:Ava-Group-OCTO-AIPlatform/BMAD-METHOD --repo     # this repository only (commit .github/hooks)
   npx -y github:Ava-Group-OCTO-AIPlatform/BMAD-METHOD --user     # Claude Code, every repository
   npx -y github:Ava-Group-OCTO-AIPlatform/BMAD-METHOD --uninstall
   ```

   Do not use `--user` together with the fork plugin of step 2: both would send each event.
4. Restart the IDE so the hooks and the environment are picked up.

Opt out at any time with `AAP_BMAD_TELEMETRY=off`. Failed sends wait in `~/.aap-bmad/outbox.jsonl`
(at most 1000 events) and go with the next hook.

## What is sent

Only hashes, enums and names: the session id and a document id are SHA-256 of the repository
and the id or relative path, cut to 32 hex; skills only when they are BMAD names (`bmad`,
`bmad-*`); artifacts as a kind. No prompt, path, file name or text.

| Event | When |
|---|---|
| `bmad.session.start` / `bmad.session.end` | the session starts / ends (duration, end reason) |
| `bmad.skill.invoke` | a BMAD skill runs: typed as a command (`/bmad-build ...`, only the name is read), loaded by the model (`Skill`), or started as a subagent; `bmad.invoke.via` says which |
| `bmad.artifact.write` | a file is written in the BMAD output folder (`output_folder` of `_bmad/config.toml`, default `_bmad-output/`), as a kind: `brief`, `prfaq`, `brainstorm`, `research`, `prd`, `ux`, `architecture`, `adr`, `initiative`, `intent`, `epic`, `story`, `spec`, `sprint-status`, `project-context`, `retrospective`, `review`, `test`, `plan` or `other`; once per file and session |

The resource carries `bmad.version` (plugin `skills/bmod-method/bmod.toml`, or the project's
`_bmad/_config/manifest.yaml` for v6), `bmad.host` and `vcs.repository.name`.
The full contract is in the Intelligence Hub repository, `src/features/dev-telemetry/bmad/contract.ts`.
