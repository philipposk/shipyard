---
name: idea
description: "Capture an idea for improving the Shipyard plugin in one step, without leaving the current work: files a GitHub issue labelled idea on the plugin repository, with the app it came from and one sentence of context. Falls back to a local file when GitHub is out of reach. Use for \"/shipyard:idea\", \"add this to the plugin\", \"Shipyard should do this in every app\", \"note this idea for Shipyard\". Not for building the idea now (that is a separate task)."
---

# Shipyard idea

> Part of the Shipyard plugin. It needs the full plugin installed (https://github.com/philipposk/shipyard/blob/main/INSTALL.md): its scripts and key guard do not work on their own.

Read `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md` now, before any other step, and follow it. The rules below only add to it.

The student had a thought about the plugin while doing something else. Your whole job is to write it down where it will be found, in a few seconds, and hand the session straight back. Do not plan, build, research or open a pull request for the idea.

## Steps

1. **The idea** is the text after `/shipyard:idea`. If there is none, take the idea from the student's last message. Keep their words; fix only obvious typos. If it is really unclear, ask one short question, then file.
2. **The context** is one plain sentence, from this conversation, on what the student was working on when the idea came up ("Adding a booking calendar to the salon app"). Do not read files or run anything else to write it.
3. **Keep private things out.** The issue may be public. No keys, passwords, customer names, email addresses, private web addresses or business numbers in the idea or the context. If the idea needs one, describe it instead ("the client's shop").
4. **File it with one command**, from the folder you are working in:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/idea.mjs" "<the idea>" --context "<one sentence>"
   ```

   The script adds the app name, repository and branch itself, labels the issue `idea` (making the label if it is missing) and prints the link. Without the GitHub CLI, or when it is not signed in, it saves the idea to `~/.shipyard/ideas.md` instead.
5. **Answer in one line** and go back to what you were doing: "Filed as an idea: <link>". If it was saved locally, say where, and that `node "${CLAUDE_PLUGIN_ROOT}/scripts/idea.mjs" --send-saved` files the saved ideas once `gh auth login` works.

## Rules

- One command, one line of reply. Never more than a minute of the student's time.
- Never open a pull request, change the plugin or change the app for an idea. Ideas are sorted later, all together.
- Several ideas in one message: one command per idea.
- `--repo owner/name` (or `SHIPYARD_IDEA_REPO`) files somewhere else, for someone who keeps their own fork.
