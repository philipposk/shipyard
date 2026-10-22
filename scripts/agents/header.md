> Shipyard {{VERSION}} for Codex and Cursor, installed {{DATE}} from `{{ROOT}}`.
> - "Shipyard <name>" is one of Shipyard's skills. The student starts one by typing `$shipyard-<name>` in Codex or `/shipyard-<name>` in Cursor, or by saying "Shipyard <name>". When you tell them, use the form for the agent you are.
> - Shipyard's scripts are in `{{ROOT}}/scripts/`. Run them exactly as written, as `node "<path>"` with the quotes.
> - Never open, print or search `~/.shipyard/secrets.env`, `~/.shipyard/backups/` or any `.env` file other than `.env.example`.
> - Once per session, before the first step that touches keys or a `.env` file, run `node "{{ROOT}}/scripts/guard-check.mjs" start` and follow it. Its check file holds no key, so reading it is the one allowed exception. If verify says OFF and the fix does not help, tell the student plainly that only care protects their keys now, and continue only after they say yes.
> - Helper agents are optional. If you use one, give it a smaller, cheaper model and mechanical work only.
> - To check a picture, open the image file and look at it. If you cannot see images, say so and ask the student to look. Never pass an image check you did not see.
> - If a script fails for lack of network or file access, ask to run it again with that access and tell the student why. Never change sandbox or approval settings yourself.
> - To update Shipyard: `node "{{ROOT}}/scripts/install-agents.mjs" --update` in a terminal. Offer it once if the student asks, or if {{DATE}} is more than 30 days ago.
