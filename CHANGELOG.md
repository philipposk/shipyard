# Changelog

Release notes, newest first. Moved out of README.md on 8 Nov 2026; add a new section per release.

## What changed in 0.9.0

- New `ai-visibility` skill and `scripts/ai-visibility.mjs`: audit llms.txt, JSON-LD, OG and robots for AI crawlers; OpenRouter baseline for whether models name the app; honest directory draft playbook.
- `theme-picker` skill (per-user colours from Catchy). Publication gate across new-app, launch and review. Sign-out uses local scope on shared Supabase. Review speed tab-switch checklist; ux-redesign v2 phone lessons. Verify hygiene warns on top-level SDK clients and Vercel `api/` limits.

## What changed in 0.8.12

- The server-key check no longer allows every file under a shared folder name. An app that needs the key lists an exact file.
- Saving a new profile always leaves the page with a full load. Starter sign-up confirms the account, then sets the password, and deletes the user if the password step fails.
- Shared-project auth checks list trigger names from the health script. They do not read the keys file or print addresses.
- Skill rules that every skill shares have to be read before the skill's own steps. The video skill still includes a real screen recording when the student asks.

## What changed in 0.8.11

- New apps fail closed when the shared database stops answering: `/api/health` reads one database row with a 5 second limit (503 on failure), sign-in gives up after about 20 seconds instead of spinning (the proxy and server checks after 3-5 s), and every new table needs an explicit grant. `verify` checks the guards, and `scripts/supabase-health.mjs` checks a project's database, sign-in and data API. See `skills/ops/references/db-outage.md`.
- Skills cleanup: the full upgrade is proposed and waits for a yes; design, launch, ops and video do the asked task on an existing app and offer the upgrade separately; the review skill's default is the small review (changed files plus the security-first areas). Repeated rules now live once each (`working-rules.md`, `which-app.md`, theme packs, `apply-design` options, the voice guide) with pointers where the copies were. Touch targets are 44px everywhere (24px small-controls exception), Node 22 LTS is the floor, model names are described by tier, and the Vercel CLI pin is 65.12.1. Platform facts were live-checked on 8 Nov 2026 and recorded in `skills/setup/references/checked-facts.md`.

## What changed in 0.8.10

- Apps that share one sign-in across subdomains and keep data on the device (offline copies, queued writes) get the rules from a real data-loss bug. Signing in as someone else in one app switched the session under an open tab of another, and that tab's sync wiped its offline copy. `shared-sign-in.md` now covers the fix: check the account before each sync, send requests as the checked account, heal missing rows, and reset one app without "Clear site data". It also covers two accounts for one person. new-app's lessons carry the short version.
- `review` has a new `offline-sync` area and lessons for reviewing sync code. They also say to check another agent's diagnosis with a real request before acting on it.

## What changed in 0.8.9

- New `look-packs` skill: give any app switchable looks. Three ready packs (Studio, Glass, Sunny), each with a light and a dark version, or new ones in the same spirit, compared side by side before anything is built. It carries the lessons from making them on a real app.
- `theme-packs.mjs rules` fails a dark version that is nearly black or whose cards melt into the page.

## What changed in 0.8.8

- `design` can draw a real logo: a light and a dark version in one `icon.svg`, so the browser tab follows the device setting. The new `references/logos.md` holds the method, including what went wrong on real logos and what follows the device once an app is installed.
- `design-logo.mjs` makes every icon from an approved pair (tab, phone, maskable, iPhone and one-colour icons, and a dark twin of the manifest) and draws a review sheet to show first. It also works on sites Shipyard did not make, and `design-icons.mjs` leaves those icons alone.
- Nothing in a new app changes unless someone asks for a logo.

## What changed in 0.8.7

- `video-render.mjs --youtube` renders a YouTube master: the loudness YouTube expects and 1440p, which YouTube plays back with a better codec, so the app's text stays sharp. A render that runs out of memory is tried once more by itself, one frame at a time.
- The YouTube guide covers drafts, the AI-use question (an AI voice counts), the low quality YouTube shows until its HD processing finishes, and automatic subtitles that appear only later.
- Voice by ear: cut one long pause out of a liked take instead of re-voicing it (dropping a comma made Greek sound foreign), never paste a word in from another take, and judge a line's start with the sound before it. The music stays down between voices less than 0.7 s apart. Voice and music tips from real videos: which ElevenLabs voices were picked over a slow-sounding OpenAI style, and where Mixkit keeps its tracks.

## What changed in 0.8.6

- Privacy rules (RLS) that run once per row are caught: the template's `schema-rules` test flags a bare `auth.uid()` or a function given a column in a policy, the template's own policies use `(select auth.uid())`, and `skills/review/references/rls-speed.mjs` lists per-row policies and the Supabase performance advisor's findings for a live project. new-app runs it after verify, and the speed guide shows the `col in (select allowed_ids())` pattern and how to prove access did not change.

## What changed in 0.8.5

- New `review` skill: the full review, fix and ship process from a real 282-file release (148 findings, 117 confirmed and fixed, 14 regressions caught by the second review, shipped as 5 stacked pull requests). Four helper workflows (`review.js`, `content-gaps.js`, `fix-waves.js`, `diff-review.js`) for Claude Code's Workflow tool, with the same steps written out for Codex and Cursor; 17 example review areas for a Next.js and Supabase app; and three scripts: `scripts/review/plan-waves.mjs` (fix batches that never share a file), `scripts/review/split-stack.mjs` (one big branch into stacked branches that each pass the type check and tests, under the 150-file limit) and `scripts/review/voice-test.mjs` (two voices through the speakers for a live microphone test).
- New apps get `docs/RELEASE-CHECKS.md` (before a pull request, after each deploy, the live voice test), a `knip.json` that fits Next.js with `npm run knip`, the 150-file pull request rule in `AGENTS.md`, and API rules from the review (no redirects for signed-out API calls, allowlisted AI models, rate limits and body caps, `Object.hasOwn`, quotas that survive deletes, saves that flush when the tab closes). API calls get JSON when the database is not set up, and an unused email lookup helper is gone.
- `verify` checks that a signed-out API call gets 401 JSON on the live app (not a redirect to sign-in), that CI type-checks (`next build` checks test files that `node --test` does not), and that no script still calls `next lint`. The build rules, lessons and upgrade audit carry the rest of the review's lessons.

## What changed in 0.8.4

- `video` can record a real run (Mac): a screen recording of something really happening, such as an agent fixing and deploying a demo site, edited with cuts and marked speed-ups. A new guide covers the demo site, the student's part, the take and honest editing.
- Voices: ElevenLabs (`--provider eleven`, `--speed`), the voices of people inside the video with word times (`--clips`), and pacing tips (no mid-phrase commas, two short samples to pick from).
- Real-app footage can show the real web address while the local app answers, and use a tall second take for the phone cut.
- `--loudnorm` makes a master as loud as YouTube expects. Renders wait while another video render runs on the computer and never remove its files. Recording falls back to a headless browser shell only.
- The engine moves to a newer pinned version with these tools and the same recorder fixes in its studio mode.

## What changed in 0.8.3

- `video` can show the real app: practice pages with made-up data (no sign-in, no database) are recorded with the new `video-capture.mjs`, which starts the app, records it and always stops it again, and the recording plays inside the same scenes. The engine moves to a newer pinned version with the recorder fixes: sharp big recordings, the right frames in long ones, a picture that lines up with the clicks, captions in any alphabet.
- Voice: pick key lines by ear (`--takes`), fix one line without the rest (`say`, `style`, `pauseCap`, `leadIn`, `take`), other languages (`--lang`, `--wpm`, `--style`), and Gemini's free-tier limit explained.
- Renders stop early on a nearly full disk, clean up Remotion's working folders, and `--low-memory` handles long footage. Publishing sets the captions language (`--lang`). A new YouTube guide: Private first, subtitles, never delete a video for the student. Scripts are benefits-only.
- The video works on apps Shipyard did not make once the upgrade guide is done (`--general`). new-app, launch and the upgrade guide offer the video at the end, with its time and cost.

## What changed in 0.8.2

- `launch` gains a full App Store and Google Play guide from shipping a real app: a store-readiness audit (account deletion in the app and on the web, Sign in with Apple, OAuth in the system browser, permission strings, Apple 4.2, a privacy policy that matches the data, a reviewer password login and demo account), the Capacitor 7 wrapper, signing an Android AAB on Linux, iOS screenshots on a Mac, panoramic Playwright screenshots, listing text with App Privacy and Data safety answers, Apple and Google account types, and the gotchas that cost hours.

## What changed in 0.8.1

- Security from the CommitR review: the app template's "finished profile" cookie is now signed and tied to the person (a typed-in value no longer skips setup), and API routes refuse people who have not finished setup (403 `onboarding_required`). Existing apps keep working: old cookies are checked once against the database and replaced.
- New lessons and build rules: server-checked setup flags and protected billing/counter columns, safe outgoing webhooks (no calls to private addresses), token lifetimes and rate limits for agents, payment webhooks that record the event only after saving, analytics only after consent, and "Coming soon" instead of a checkout that cannot finish.

## What changed in 0.8.0

- New `email` skill: ImprovMX catch-all to Gmail, Gmail "Send mail as" through Resend SMTP (smtp.gmail.com fails DMARC), SPF/DKIM/DMARC, Papaki and Cloudflare DNS steps, `email-check.mjs` (reads public DNS, no keys) and `notify.mjs` (the "<App> is live" email from 6x7-app-factory, with the app as sender, a "why you got this" line and `--dry-run`).
- New `apis` skill: key guide for 13 services; `secrets-check.mjs --live` now also tests ElevenLabs, Gemini, Brave, Serper, SerpAPI and Upstash (NVIDIA by format). Web search, voice, AI router and Upstash rate-limit guides are marked new, untested in production.
- `new-skill` points to good existing skills (find-skills, superpowers, caveman, compound-engineering, Anthropic's skill-creator and engineering skills) instead of copying them.
- `launch` gains a search-engine and speed checklist from the 6x7 launches.

## What changed in 0.7.1

- Phone-first apps use the whole screen on computers (left rail, full-width pages), and tab switches show the next page's outline at once. Existing apps keep their look until you bring the change in.
- `scripts/app-keys.mjs` gives one app the service keys it needs; Groq and Deepgram keys are known to setup.
- `scripts/build-story.mjs` writes a "how this app was made" record from the Claude Code chats.
- New guides: AI features and feature ideas, API / webhooks / MCP for apps, and Gmail "send as" with a junk-folder checklist.

## What changed in 0.7.0

- New skill `new-skill`: build and publish your own skills and plugins. `scripts/skill-scaffold.mjs` writes a skill or plugin that works in Claude Code, Codex, Cursor and agents that read `~/.agents/skills`, and checks any skill folder (name, trigger words in the description, no placeholders). Codex and Cursor get it as `shipyard-new-skill` after `install-agents.mjs --update`.

## What changed in 0.6.2

- Sign-in links from emails now open a short page with a Continue button instead of signing in straight away, so mail scanners can't use them up and a forwarded link can't sign someone into the wrong account.
- New apps get a paging helper for long lists (the database returns at most 1000 rows at a time), a fix for sticky headers, and written rules in `AGENTS.md` and the build rules from the 6x7 launches: no changes on a plain link visit, server-side scores, offline cache for static files only, and a second review of fixed code before launch.

## What changed in 0.6.1

- One-prompt install for Codex, Cursor and Claude Code: [INSTALL.md](INSTALL.md). In Codex, setup now starts with a guard check, and `--check` says whether Codex has a trust record for the hook (it only reads Codex's files, it never writes trust).

## What changed in 0.6.0

- Shipyard runs in Codex and Cursor (beta), installed with `scripts/install-agents.mjs`. Nothing changes for Claude Code.
- New apps get a `.cursorignore` that keeps `.env` files away from Cursor, and their `AGENTS.md` gains a rule never to open keys files plus two reworded lines (which agents read it, and the design skill's name in each agent). Auto-merge now waits for you on changes to `.cursor/`, `.codex/`, `.agents/`, `.cursorignore` and `.cursorrules`.
