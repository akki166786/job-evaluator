# LinkedIn Job Eval

**Is this job worth your time to apply?**

A Chrome extension that uses AI to evaluate LinkedIn job postings against your profile, skills, and preferences. Get a score (0--100), a clear verdict, and bullet-point reasoning -- all in seconds.

No auto-apply. No scraping. No data leaves your machine unless you choose a cloud provider.

---

## How it works

1. Open any LinkedIn job page.
2. Click the extension icon (opens in the side panel).
3. Hit **Evaluate this job**.
4. Get a structured verdict: score, match bullets, risk bullets, and a recommendation.

The extension reads the job title, description, and location from the page, combines it with your saved profile and skills, and sends it to the AI provider you chose. The model returns a conservative, explainable evaluation.

---

## Supported AI providers

| Provider | Default model | Cost | Get an API key |
|---|---|---|---|
| **Ollama (local)** | `llama3.1:8b` | Free — runs on your machine | Not needed |
| **Groq** ⭐ | `openai/gpt-oss-120b` | Free tier, no credit card | [console.groq.com](https://console.groq.com) |
| **OpenAI** | `gpt-4o-mini` | ~$0.15 / 1M input tokens | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic** | `claude-haiku-4-5` | ~$1.00 / 1M input tokens | [console.anthropic.com](https://console.anthropic.com) |
| **Google Gemini** | `gemini-3-flash-preview` | Free tier available | [aistudio.google.dev/apikey](https://aistudio.google.dev/apikey) |
| **OpenRouter** | `tngtech/deepseek-r1t2-chimera:free` | Free | [openrouter.ai/keys](https://openrouter.ai/keys) |

> **Groq** has been giving the fastest and best results in practice. Get your free key at [console.groq.com](https://console.groq.com) — sign up, generate a key, no credit card needed.

Each provider stores its own API key and model override separately. You can set a custom model per provider in **Settings > Model (optional)**; leave blank to use the default.

---

## Quick start

> **Tip:** The quickest way to get started is with an API key. Groq has been giving the fastest and best results — and it's free. See [Groq setup](#groq-setup) below.

### Option 1: Cloud provider (fastest setup)

1. Install the extension (see [Installation](#installation) below).
2. Open the side panel and go to **Settings**.
3. Pick a provider (e.g. **Groq** for free, fast evaluations).
4. Paste your API key and click **Save settings**.
5. Navigate to a LinkedIn job page and click **Evaluate this job**.

#### Groq setup

Groq offers a free tier with no credit card required. To get your API key:

1. Go to [console.groq.com](https://console.groq.com).
2. Sign up (or log in).
3. Create and copy your free API key from the dashboard.
4. Paste it in **Settings > API key** with Groq selected.

### Option 2: Ollama (fully local, no API key)

1. Install and start [Ollama](https://ollama.com):

   ```bash
   # Docker (recommended)
   docker run -d -p 11434:11434 -e OLLAMA_ORIGINS=* --name ollama ollama/ollama
   docker exec -it ollama ollama pull llama3.1:8b

   # — or — native install
   OLLAMA_ORIGINS=* ollama serve   # in one terminal
   ollama pull llama3.1:8b         # in another
   ```

   `OLLAMA_ORIGINS=*` is required so the Chrome extension can reach the local API.

2. Install the extension (see [Installation](#installation) below).
3. The default provider is already Ollama. Navigate to a LinkedIn job page and click **Evaluate this job**.

> **Low RAM?** Use `ollama pull qwen2.5:3b` (~4 GB) and change the model name in **Settings > Model (optional)**.

---

## Installation

### From source (developer)

```bash
git clone https://github.com/akki166786/job-evaluator.git
cd job-evaluator
npm install
npm run build
```

1. Open **chrome://extensions** in Chrome.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `dist` folder.
4. The **LinkedIn Job Eval** extension appears in your toolbar.

The UI opens in Chrome's **side panel** -- click the extension icon to toggle it. The panel stays open as you browse.

---

## Settings

Open the side panel and click **Settings**.

| Field | What to enter |
|---|---|
| **Profile & role intent** | Who you are and what you're looking for. *Example: "Senior frontend engineer, remote, EU time zones."* |
| **Skills / tech stack** | Your key skills. *Example: "React, TypeScript, Node.js, AWS, PostgreSQL."* |
| **Negative filters** | Hard deal-breakers. *Example: "No Java-only, no on-site US, no mandatory Dutch."* |
| **Provider** | Choose Ollama, Groq, OpenAI, Anthropic, Google Gemini, or OpenRouter. |
| **Model (optional)** | Override the default model for the selected provider. Leave blank to use the built-in default. |
| **API key** | Shown for cloud providers. Paste the key from your provider's dashboard. |

Click **Save settings**. Your configuration persists across browser restarts.

### Resumes

Go to the **Resumes** tab to upload up to 5 resumes (PDF or DOCX). Label each one (e.g. "Frontend", "Full-stack").

- **Cloud providers**: select which resumes to include in the evaluation. The model picks the best-matching one.
- **Ollama**: resumes are not sent (only profile intent, skills, and negative filters are used for faster local evaluation).

---

## Evaluation output

Each evaluation returns:

| Field | Description |
|---|---|
| **Score** | 0--100 (conservative; 75+ is a strong match) |
| **Verdict** | *Worth applying*, *Maybe*, or *Not worth applying* |
| **Hard rejection reason** | If a deal-breaker was found (e.g. "Requires fluent German") |
| **Match bullets** | What aligns with your profile |
| **Risk bullets** | Gaps or concerns |
| **Best resume** | Which of your resumes fits best (cloud only) |
| **Explanation** | One-sentence summary |

Results are cached per job. If you revisit the same job, you'll see the cached score with an option to re-evaluate.

---

## Supported LinkedIn pages

The extension works on:

- `linkedin.com/jobs/view/...` -- direct job page
- `linkedin.com/jobs/collections/...` -- saved/recommended jobs
- `linkedin.com/jobs/search/...` -- search results

It reads the selected job's details from whichever page you're on.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| **"Forbidden" (403)** | Ollama only. Start with `OLLAMA_ORIGINS=*` (see Quick Start). |
| **"Could not reach Ollama"** | Ollama isn't running. Start it and pull a model. |
| **"Invalid API key"** | Check the key matches the selected provider in Settings. |
| **"Rate limited"** | The provider is throttling you. Wait a moment or switch providers. |
| **"Could not read job details"** | You're not on a supported LinkedIn job page, or LinkedIn changed their DOM. |
| **Evaluation is slow** | Ollama on CPU can take 1--3 min. Cloud providers respond in seconds. Keep the panel open. |
| **"model requires more system memory"** | Switch to a smaller Ollama model (e.g. `qwen2.5:3b`). |
| **Button is disabled** | You're not on a LinkedIn job page, or the API key is missing for a cloud provider. |

---

## Support

If this extension helps you, consider [buying me a coffee](https://buymeacoffee.com/coachakshaytiwari) ☕ — it helps keep the project going.

---

## Privacy

- **No backend. No analytics. No telemetry.**
- All settings, resumes, and cached evaluations are stored locally in IndexedDB (extension-isolated origin).
- API keys never leave your device except when sent to the provider you selected.
- When using Ollama, **nothing leaves your machine**.
- See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for the full privacy policy.

---

## Development

```bash
npm install           # install dependencies
npm run build         # production build → dist/
npm run watch         # rebuild on file changes
npm run package       # build + zip for Chrome Web Store upload
```

The build script automatically syncs the version from `package.json` into `manifest.json`.

### Tech stack

- **Chrome Extension** -- Manifest v3, side panel UI
- **TypeScript** -- all source code, strict mode
- **esbuild** -- fast bundling
- **IndexedDB** -- local storage for settings, resumes, cached evaluations
- **pdfjs-dist** + **mammoth** -- client-side PDF and DOCX parsing

### Project structure

```
src/
  background/service-worker.ts   # Extension lifecycle, message routing
  content/content.ts             # LinkedIn DOM extraction
  lib/
    db.ts                        # IndexedDB operations
    llm.ts                       # LLM provider abstraction
    prompts.ts                   # System + user prompt construction
    types.ts                     # Shared TypeScript types
  popup/
    popup.ts                     # Side panel UI logic
    popup.html                   # Side panel markup
    popup.css                    # Styles
icons/                           # Extension icons (16/32/48/128px)
manifest.json                    # Chrome extension manifest
build.mjs                        # Build script (esbuild + asset copying)
```

---

## License

MIT
