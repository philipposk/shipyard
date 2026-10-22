# Pick the AI provider and model per task

new-app's `references/ai-and-keys.md` has the proven default order (OpenRouter, then Groq, then OpenAI). This adds NVIDIA and Routeway and a small router. The router itself is **new, untested in production**.

All five speak the OpenAI chat format (`POST <base>/chat/completions`, header `Authorization: Bearer <key>`), so one function covers them:

| Provider | Env var | Base URL | Good for |
|---|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | one key, hundreds of models, cheap ones first |
| Groq | `GROQ_API_KEY` | `https://api.groq.com/openai/v1` | very fast, free tier, Whisper speech-to-text |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | best structured output and tools |
| NVIDIA | `NVIDIA_API_KEY` | `https://integrate.api.nvidia.com/v1` | free hosted open models for trials (rate-limited) |
| Routeway | `ROUTEWAY_API_KEY` | `https://api.routeway.ai/v1` | one key for 200+ models, also a `/v1/messages` endpoint |

Routeway: verified from docs.routeway.ai (October 2026): OpenAI-compatible base URL, Bearer key, `GET /v1/models` lists models with prices. The student wrote "routeaway.ai"; the service is routeway.ai. Prices and model names: check `/v1/models` before choosing; TODO: confirm which models the student's plan includes.

## Router shape

- `src/lib/ai.ts` with `chat(task, messages)` where `task` is `"cheap"`, `"fast"`, `"smart"` or `"json"`. A table maps each task to an ordered list of `{ provider, model }`; the first entry whose key is set is used, the next on timeout, 429 or 5xx.
- Suggested start (adjust with the student, write it in `SPEC.md`): `fast` Groq then OpenRouter; `cheap` OpenRouter (a small model) then NVIDIA; `smart` OpenAI then OpenRouter; `json` OpenAI (structured outputs) then OpenRouter.
- Log provider, model, tokens and duration per call (no prompt text), so cost per feature is visible in the admin logs.
- Never let a user pick an arbitrary model name; only the table's entries.
- Tests fake each provider and the fallback.
