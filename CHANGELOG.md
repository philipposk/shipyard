# Changelog

All notable changes to Shipyard will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added `AUDIT.md` containing a full repository audit, findings, severity ratings, and remediation plan.
- Added `docs/SECURITY.md` describing the secret-guard model, threat model, and recommended security policies.
- Added `docs/ARCHITECTURE.md` describing the current structure and a plan for consolidating duplicated script entry points.

### Planned

- Add a root `package.json` with reproducible development, test, lint, verification, and release workflows.
- Add CI checks for tests, linting, plugin-manifest validation, dependency auditing, and third-party secret scanning.
- Consolidate duplicate flat scripts and feature directories into stable command modules.
- Add performance and failure-mode tests for `guard-secrets.mjs`.
- Split the largest security and installer scripts into smaller, independently testable modules.
- Split the long README into focused installation, security, command, and troubleshooting guides.

## [0.8.6]

### Known state

- Claude Code plugin metadata, hooks, scripts, templates, modules, shells, presets, skills, starter assets, and tests are present.
- The plugin targets Next.js, Supabase, and Vercel application development.
