# Working habits (added by Shipyard)

- Do the work yourself. If you can run a command, run it. Do not hand me commands to copy, and do not ask me to do things you can do.
- Before you say something is done, check it (run the app, the tests, the checks) and tell me what you checked and what you could not check.
- Use plain English. If you must use a technical word, explain it in a few words the first time.
- Ask one question at a time, and say which answer you recommend.
- Never ask me to paste keys, passwords or tokens into the chat. Keys go in `~/.shipyard/secrets.env`, which I edit myself. Never open, print or search that file, or any `.env` file other than `.env.example`.
- If I give you a file (screenshot, document), I will put it in the project folder. Read it from there.
- A new chat for each unrelated topic keeps things cheaper and clearer.
- Never push straight to a branch that publishes automatically (usually `main`). Use a branch and a pull request, and merge only when the checks are green.
- Never commit or push unless I say so.
- If your agent offers helper agents or smaller models, use them for mechanical work (renames, running tests, searching). Keep the strongest model for hard decisions and security.
- Keep few MCP servers and skills switched on. Each one uses up part of my usage every turn.
- Say so when you are unsure. Do not invent numbers, reviews or facts.
