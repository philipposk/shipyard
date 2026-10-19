# Shipyard

A Claude Code plugin that helps a beginner build and publish real web apps. You set up your accounts once, then describe an app and Shipyard builds it with Next.js, Supabase (database and sign-in) and Vercel (hosting), and checks it before calling it done.

**Guide and course:** https://shipyard.6x7.gr (install, setup, ten short modules, costs, troubleshooting).

## Install

In Claude Code:

```
/plugin marketplace add philipposk/shipyard
/plugin install shipyard@shipyard
```

Then, once:

```
/shipyard:setup
```

And for every app:

```
/shipyard:new-app
```

When the app is live and you want a real address, emails, legal pages or payments:

```
/shipyard:launch
```

After installing, turn on updates: `/plugin`, then Marketplaces, then shipyard, then Enable auto-update.

## What you need

You can start with $0 besides Claude Code Pro (about $20 a month): a free GitHub account, a free Vercel account, a free Supabase account and Node.js from nodejs.org. Setup walks you through each one.

| Stage | Cost |
|---|---|
| Learning and demo apps | $0 |
| Your own web address (optional) | about $10 to $15 a year |
| AI features inside your app | $5 or more, once, to your AI provider |
| Taking payments | Vercel Pro, $20 a month, plus payment fees |
| Serious database with real users | Supabase Pro, $25 a month |
| Phone app stores | Apple $99 a year, Google $25 once |

Free Supabase allows 2 active projects and pauses a project after a week of no use (one click wakes it).

## What is in this release

- `setup`: checks your tools, connects GitHub, Vercel and Supabase, stores your keys safely, saves your defaults. You can stop and continue later.
- `new-app`: asks a few questions, writes a plan, builds the app, creates the database, puts the code on GitHub, publishes it and runs checks (pages, sign-in, data isolation between users, phone layout, leaked keys).
- A starter app with sign-in, light and dark mode, a phone-first, sidebar or top-links layout, installable as a phone shortcut (PWA), and a test gate that GitHub runs on every pull request.
- `design`: choose how your app looks. Pick a site or screenshots you like, a free design file, three directions drafted for your own app (with real screenshots of it), or one of 8 ready-made looks. A look sets colours, fonts, menu style (bottom tabs, left sidebar or top links), homepage style, card and button feel, text size and spacing, in light and dark, and is checked for readability. Run `/shipyard:design`.
- `launch`: go from a free test address to a real product. Your own web address and real sign-up emails (people confirm their email), privacy and terms pages written from the services your app uses (a draft: have it checked), a country checklist from official sources, payments with Stripe (test first, then live), an email list with one-click unsubscribe, phone and desktop app wrappers, and a go-live check. Run `/shipyard:launch`.
- `video`: make a product video of your app, built as code (not a screen recording): the script is approved before any voice cost, narration is timed to the words, and you get light and dark, wide and phone cuts. Web copy under 10 MB goes into your app. Needs ffmpeg (optional). Takes hours and uses a lot of your Claude allowance, so do it after launch. Run `/shipyard:video`.
- `ops`: keep a live app healthy. An error log and admin logs page with email alerts, health checks every 6 hours that open one GitHub issue when something is wrong, code review on every pull request (CodeRabbit, or `/code-review` for free), auto-merge for small safe changes (anything touching sign-in, data rules, payments or workflows waits for you), regular project reviews, backups kept on your own computer, and a clear loop for how problems get fixed. Run `/shipyard:ops`.
- A settings page: `/shipyard:setup settings`.

Optional extras for design (not installed for you): the free `frontend-design` plugin, and Impeccable for a polish pass on one page.

## Safety

- Your keys live in `~/.shipyard/secrets.env` on your computer. You paste them there yourself. Never paste keys into the chat.
- A guard hook blocks Claude from reading that file or your `.env` files. Shipyard scripts read keys directly and never print them.
- Every app gets a leaked-key scan before each push and in the pull request checks.
- Nothing is sent anywhere except to the services you sign up for (GitHub, Vercel, Supabase and any AI or email provider you add).

## Contributing

Issues and pull requests are welcome. Run `node --test tests/*.test.mjs` before you send one.

## License

MIT, see `LICENSE`.
