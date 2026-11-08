# First: which app is this?

Every app skill starts with the same preflight. When the current folder is an app that already exists, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/which-app.mjs" <app folder>` before the skill's steps.

- The output says `shipyard`: the folder was made by Shipyard. Follow the skill's normal steps for a Shipyard app.
- The output says `general`: an existing app Shipyard did not make. Do not stop. Do the asked task only, plus the checks it needs, with the app's own tools. Shipyard's scripts need a Shipyard app and will refuse; that refusal is expected. Offer the full upgrade (`upgrade.md`) separately: it proposes a real look and brings secrets, sign-in, data isolation, costs, tests, deploys, legal pages and the other build rules up to the same standard. Start it only on a yes.
- The output says `damaged`: `.shipyard-app.json` is here but broken. Say so. Do not treat the folder as a general app.
