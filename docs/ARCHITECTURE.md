# Shipyard architecture

## Current shape

Shipyard is organized around reusable plugin assets and an operational script layer.

```text
.claude-plugin/   Claude plugin metadata and marketplace configuration
.cursor-plugin/   Cursor integration
hooks/            Agent lifecycle hooks
modules/          Reusable application modules
shells/           Application shell variants
presets/          Configuration presets
skills/           Agent skills
starter/          Starter assets
template/         Application template
scripts/          CLI, provisioning, design, security, ops, and verification logic
tests/            Unit, integration, contract, and workflow tests
```

## Core recommendation

Treat `scripts/` as an implementation layer, not the product’s public interface. Introduce one stable CLI entry point and organize features into self-contained command modules.

Recommended structure:

```text
bin/
  shipyard.mjs
commands/
  scaffold/
  design/
  provision/
  launch/
  ops/
  verify/
  video/
lib/
  fs.mjs
  git.mjs
  logging.mjs
  secrets.mjs
  supabase.mjs
  vercel.mjs
templates/
tests/
```

## Command map

The public interface should be stable and discoverable:

```text
shipyard scaffold <app>
shipyard add-module <module>
shipyard add-shell <shell>
shipyard design <subcommand>
shipyard provision <subcommand>
shipyard launch <subcommand>
shipyard ops <subcommand>
shipyard verify <subcommand>
shipyard secrets <subcommand>
shipyard video <subcommand>
```

Every command should support:

- `--help`
- `--dry-run` where side effects are possible
- `--json` for machine-readable output
- consistent exit codes
- consistent logging
- clear confirmation prompts for destructive operations

## Consolidation targets

| Current pattern | Recommended pattern |
|---|---|
| `scripts/verify.mjs` plus `scripts/verify/` | One `verify` command module |
| `scripts/launch-*.mjs` plus `scripts/launch/` | One `launch` command module |
| `scripts/ops-*.mjs` plus `scripts/ops/` | One `ops` command module |
| `scripts/video-*.mjs` plus `scripts/video/` | One `video` command module |
| `scripts/provision-*.mjs` plus `scripts/provision/` | One `provision` command module |
| `scripts/design-*.mjs` plus `scripts/design/` | One `design` command module |

## Refactoring rules

1. Preserve existing command names and outputs during the first refactor.
2. Move code before changing behavior.
3. Add characterization tests before splitting large scripts.
4. Keep security guards independent from feature logic.
5. Make every external side effect explicit and testable.
6. Prefer small pure functions for parsing, validation, redaction, and template generation.
