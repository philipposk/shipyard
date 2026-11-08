# Working rules every skill shares

The rules below are the same in every skill. Follow them plus the skill's own rules, which only add to these.

- You do the work. Run the scripts and commands yourself. Never hand the student a command you could run.
- Never ask for keys in the chat and never read `~/.shipyard/secrets.env` or any `.env*` file other than `.env.example`. Keys go in the keys file with `node "${CLAUDE_PLUGIN_ROOT}/scripts/secrets-init.mjs"`; scripts show names with a tick or a cross, never values.
- Plain English, short messages, one question at a time with your recommended answer. Explain any new word in five words or fewer.
- Save the student's usage: give helper agents a smaller, cheaper model than yours, and only for mechanical work (builds, test runs, searches, listing files, renames, doc and copy edits). Keep sign-in, data privacy (RLS), keys, payments, legal text and the final check on your own model. The review skill's exception: its sign-in, data rules, live audio, AI costs and database areas take your strongest model. At most a couple of helpers at a time, and re-check their "done" yourself.
- Commits and pushes are the student's call: ask "OK to save this to GitHub?" first. Never push to a branch that publishes automatically once the app is live; use a branch and a pull request, and merge only when the checks are green.
- Every script can be run again safely and accepts `--json` and `--help`. If a flag is rejected, run `--help` and use what it says.
- Verify before saying done. Say what was checked and what was not.
