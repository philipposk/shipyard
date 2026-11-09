---
name: apis
description: "Add outside services to an app the safe way: one guide and checker for every API key (where to get it, its name, where it lives, a cheap test), web search (Brave, Serper, SerpAPI with fallbacks), voice (Deepgram speech-to-text, ElevenLabs text-to-speech), an AI model router (OpenRouter, Groq, OpenAI, Gemini, NVIDIA) and rate limits with Upstash Redis. Use for \"API key\", \"check my keys\", \"add search\", \"Brave\", \"Serper\", \"SerpAPI\", \"speech to text\", \"text to speech\", \"Deepgram\", \"ElevenLabs\", \"which AI model\", \"OpenRouter\", \"Groq\", \"NVIDIA\", \"Gemini\", \"rate limit\", \"Upstash\", \"Redis\", or \"/shipyard:apis\"."
---

# Shipyard APIs

> Part of the Shipyard plugin. It needs the full plugin installed (https://github.com/philipposk/shipyard/blob/main/INSTALL.md): its scripts and key guard do not work on their own.

You add outside services (APIs: other companies' tools an app calls) to a Shipyard app without leaking keys or running up a bill. You run every script. The student only makes accounts, creates keys in the provider's dashboard and pastes them into the keys file.

## Rules (always)

Read `${CLAUDE_PLUGIN_ROOT}/skills/new-app/references/working-rules.md` now, before any other step, and follow it. The rules below only add to it.

- Every call to a paid API runs on the server (a route under `src/app/api/`), checks the signed-in user, has a rate limit and an input size limit, and the app still works when the call fails.
- Say which parts are proven and which are **new, untested in production** (marked in the references). Do not present the second kind as tested.

## 1. Ask one question

"What should the app do?" Read the matching reference, then follow it:

1. **Add or check a key** -> `references/api-keys.md`
2. **Search the web** -> `references/web-search.md`
3. **Speech to text or a voice** -> `references/voice.md`
4. **AI text features, pick a model** -> `references/ai-router.md` (and new-app's `references/ai-and-keys.md`)
5. **Limit abuse or cache answers** -> `references/rate-limit.md`

## Scripts

- `secrets-check.mjs [--live]` checks every key's format; `--live` makes one cheap call per provider (Brave and Serper use one search credit each; NVIDIA is format-only).
- `app-keys.mjs <appDir> NAME ...` gives one app the keys it needs (Vercel and `.env.local`) without printing them. Then `provision-vercel.mjs` and redeploy.
