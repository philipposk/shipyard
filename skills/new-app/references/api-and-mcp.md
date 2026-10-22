# Letting other tools use the app (API, webhooks, MCP)

Many apps are more useful when the owner's other tools and AI agents can read and write in them (for example a notes app that an agent can add notes to). Ask once in the interview if it fits: "Should other apps or your AI assistant be able to use this app?" If yes, or the app is a list, notes, tasks, bookings or a log, plan it as a "later" feature and build it after the first version is live.

Build in this order, each step only when needed:

1. **A small JSON API** under `src/app/api/v1/`: list, read, create, update for the main item. Same rules as every route: check the user, rate limit, validate input (`src/lib/validate.mjs`), and only the person's own rows (row level security does the real check).
2. **Personal access tokens** so a script or agent can call the API without a browser: a `api_tokens` table (store only a hash of the token, show the token once, let the person name and revoke tokens on the Settings page). Add the route prefix to `BEARER_API_PREFIXES` in `src/proxy.ts` and check the token in the route. Never accept the Supabase secret key from outside.
3. **Webhooks out**: when something happens (an item is added or done), POST a small JSON body to a web address the person saves in Settings, signed with an HMAC secret in a header so the receiver can trust it. Retry a few times, then show the failure in Settings.
4. **An MCP server** so AI assistants can use the app as tools: a route at `src/app/api/mcp/route.ts` that speaks MCP over HTTP (the official `@modelcontextprotocol/sdk`), authenticated with the same personal tokens. One tool per action the person would ask for ("list notes", "add a note", "mark done"), with short plain descriptions and input limits. Add a "Connect an AI assistant" box in Settings with the address and how to add it.

Every one of these gets tests (token hashing and revoking, signature of webhooks, each MCP tool refuses other people's data) and an entry in `HANDOFF.md`.
