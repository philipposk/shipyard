# Checked facts and decisions (8 Nov 2026)

Live-checked on 8 Nov 2026. When a number here changes, update this file and the reference that used it.

## Platform facts (checked 8 Nov 2026)

| What | Value | Source |
|---|---|---|
| `vercel` npm CLI, latest | 65.12.1 (Shipyard pins `vercel@65.12.1` since 8 Nov 2026) | registry.npmjs.org/vercel/latest |
| Vercel Hobby | Free, non-commercial only, ~100 deploys/day, 4 Active CPU-hours/month (unchanged) | vercel.com/docs/plans/hobby |
| Vercel Pro | $20 per user/month | vercel.com/pricing |
| Supabase free | Projects pause after ~1 week of inactivity | supabase.com/pricing |
| Supabase Pro | $25/month | supabase.com/pricing |
| Apple Developer Program | $99/year (individual) | developer.apple.com/support/compare-memberships |
| Google Play developer | $25 one-time; new personal accounts need a closed test with 12 testers opted in for the prior 14 days | support.google.com/googleplay/android-developer/answer/6112435 |
| Instagram carousel | Up to 20 images per post (in-app) | creators.instagram.com |
| YouTube Shorts | Up to 3 minutes | support.google.com/youtube/answer/10059070 |
| Remotion licence | Free for individuals and companies up to 3 people | remotion.dev/docs/license/pricing |
| ElevenLabs | Free plan: no commercial licence; cheapest paid = Starter $6/month | elevenlabs.io/pricing |
| Gemini API free tier | Tight daily quotas, shown per project in AI Studio; about 10 voice requests/day is the measured ballpark, not a documented universal quota | ai.google.dev/gemini-api/docs/rate-limits |
| OpenAI API billing | Prepaid: minimum initial purchase $5 (default $10) | help.openai.com/en/articles/8264778 |
| ImprovMX free | Forwarding only, 1 domain, 25 aliases, ~500 emails/day | improvmx.com/pricing |
| .com registrations | Wholesale rose 1 Nov 2026: Cloudflare Registrar ~$11.2/yr, Porkbun ~$11.8/yr (at cost) | porkbun.com/about/domain-cost-calculator |
| Node.js | Node 20 EOL April 2026. Node 22 EOL 30 Apr 2027. **Node 26 "Lithium" is the Active LTS since 28 Oct 2026** (Node 24 is Maintenance LTS). Shipyard's floor is Node 22 LTS per the owner's 8 Nov 2026 decision; revisit toward Node 26 when convenient | nodejs.org/en/about/previous-releases |
| Deepgram | Free tier: $200 credit, no card; paid: usage-based Pay As You Go | deepgram.com/pricing |

## Contradiction decisions (8 Nov 2026)

- **Touch targets: 44px baseline** (matches the shipped template's `.btn`, `template/DESIGN.md`, `design-md.mjs` and `template/AGENTS.md`; WCAG 2.5.8 Target Size (Minimum) is 24 CSS pixels at AA, and WCAG 2.5.5 Target Size (Enhanced) is 44 CSS pixels at AAA; Shipyard keeps 44 because the template's buttons are already 44). Exceptions: 24px hit area for small controls (checkboxes, calendar cells, `build-rules.md`); inputs stay at 16px.
- **Helper models:** helpers get a smaller, cheaper model for mechanical work. Bounded exception (declared in `scripts/agents/header.md` and the shared working rules): the review skill's security areas (sign-in, data rules, live audio, AI costs, the database) take the strongest model.
- **Design vs UX:** a look changes how things look; navigation is a separate setting. `apply-design` runs with `--keep-layout` unless the student asked for the look's own layout too.
- **Video order:** the product is registered in `products.json`/`products.ts` before the voice step (step 2), so a voiced script is never skipped.
- **Video cleanup:** old renders are deleted, but the `--youtube` master is kept until the student uploads it.
- **"live" wording:** an app on a `*.vercel.app` address is "deployed"; "live" means `/shipyard:launch` has put it on the student's own domain.
- **Vercel CLI pin:** bumped 64.3.1 → 65.12.1 on 8 Nov 2026 after the unit-test run; the live login/link/deploy check described in `scripts/lib/vercel.mjs` still needs real credentials before the next student run.
