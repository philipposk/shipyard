# Lessons from Sparks notes and available development chats

These are demonstrated integration and UX failures, not a request to add every
Sparks feature to every app. Apply the rules when the app has the relevant flow.

- Inspect the live integration/help page, current remote branch and existing
  agent setup before building a connector. An old local checkout or an interop
  manifest may omit a working MCP server. Reuse OAuth and native tools first.
- Treat account identity as part of offline data integrity. With shared login
  cookies, another app can change the account underneath an open tab. Pin sync
  requests to the verified owner of the local copy; never prune one user's
  cached rows using another user's empty list. Recover locally missing server
  rows on a later pull. Test two different accounts, not only a fresh account.
- Offline creates return local IDs before the server has the rows. Any direct
  online write referencing those IDs must wait for its dependencies to sync,
  or join the same durable dependency-aware queue. Test create-folder → link
  note with deliberately slow writes and reconnects. Preserve failed work.
- A foreign-key error is not a missing-table error. Distinguish database error
  codes, log only safe context, and show the person what to do rather than raw
  table/constraint names.
- Separate data changes from sync-status changes. Coalesce focus/visibility
  refreshes, bound polling, and avoid a flashing queue count on every autosave.
  Show slow/stuck saves clearly; keep fast successful saves quiet.
- Record an agent's identity from its authenticated connection when it creates
  content. Do not ask the person to recognise generic labels like “another app”.
  Do not invent provenance for legacy records that did not capture it.
- Keep list filters/search in the URL and preserve the list address for Back.
  If the list is offline-first, filter changes must not require a server visit.
- Validate phone keyboard behaviour on a real device when that is the reported
  failure. A focused textarea in an emulated browser does not prove iOS opened
  the keyboard. Avoid delayed code-driven focus that steals or traps it.
- Use available desktop width for lists/editors while keeping readable text
  measures. Theme packs need both light and dark variants and a separate mode
  choice. A component existing in the repo does not prove the screen uses it.
- Distinguish imported messages, extracted action items, manual note links and
  semantic AI connections in product copy. One does not prove the others exist.
- Read full notes and subtask trees. Separate partially completed requests,
  duplicates, explicit holds and account/device actions before making changes.
  Mark done only after the promised delivery and verification, recording what
  remains when one part is complete.
- Keep signing-in separate from password-entry troubleshooting. Repeated
  direct Keychain reads can prompt the user on each process access. Prefer the
  host's native authenticated connector. If a user requests another credential
  store, use its documented setting, explain protection differences, preserve
  the login, and never print tokens.

Evidence: Sparks notes reviewed through its existing MCP on 8 Nov 2026; local
Sparks development chats concerning the account-switch incident, agent
connection, task import, project logos and desktop layouts; current source and
regression checks. No claim of access to every external bot's conversations.
