# LinkedIn Job Eval

Chrome extension (MVP) that answers: **"Is this job worth my time to apply?"**  
Uses an LLM (local via Ollama or cloud via Groq, OpenAI, Anthropic, Google Gemini, OpenRouter) for conservative, explainable verdicts. No auto-apply, no scraping—you stay in control.

---

## Supported providers

| Provider | Model (default) | API key required? |
|---|---|---|
| **Ollama (local)** | `llama3.1:8b` (configurable in Settings) | No |
| **Groq** | `llama-3.1-8b-instant` | Yes — [console.groq.com](https://console.groq.com) |
| **OpenAI** | `gpt-4o-mini` | Yes — [platform.openai.com](https://platform.openai.com) |
| **Anthropic** | `claude-3-haiku-20240307` | Yes — [console.anthropic.com](https://console.anthropic.com) |
| **Google (Gemini)** | `gemini-3-flash-preview` | Yes — [aistudio.google.dev](https://aistudio.google.dev) |
| **OpenRouter** | `openai/gpt-4o-mini` | Yes — [openrouter.ai](https://openrouter.ai) |

Each provider has its own API key slot in Settings—switching providers remembers each key separately.

---

## 1. Run Ollama (local LLM) — optional

Skip this section if you only plan to use a cloud provider.

The extension talks to Ollama at `http://localhost:11434`. You need Ollama running and a model pulled.

### Option A: Docker

```bash
# Start Ollama in a container (port 11434).
# OLLAMA_ORIGINS=* is required so the Chrome extension (chrome-extension:// origin) can call the API.
docker run -d -p 11434:11434 -e OLLAMA_ORIGINS=* --name ollama ollama/ollama

# Pull the default model (8B; better context and reasoning; needs ~5 GB RAM)
docker exec -it ollama ollama pull llama3.1:8b
```

If you already have a container without `OLLAMA_ORIGINS`, remove it and recreate:

```bash
docker stop ollama && docker rm ollama
docker run -d -p 11434:11434 -e OLLAMA_ORIGINS=* --name ollama ollama/ollama
docker exec -it ollama ollama pull llama3.1:8b
```

Keep the container running. To stop/start later:

```bash
docker stop ollama
docker start ollama
```

### Option B: Native install

1. Install Ollama: [https://ollama.com](https://ollama.com)
2. Start it with extension access (so the Chrome extension can call the API):

   ```bash
   OLLAMA_ORIGINS=* ollama serve
   ```

   Or set the env var in your shell profile so it's used every time.
3. Pull the model:

```bash
ollama pull llama3.1:8b
```

Check that it's running:

```bash
curl http://localhost:11434/api/tags
```

You should see `llama3.1:8b` in the list. If you have less RAM (~4 GB), use `ollama pull qwen2.5:3b` and change the model in the extension's Settings panel (no need to edit code).

---

## 2. Load the extension in Chrome

1. **Build** (if you haven't):

   ```bash
   cd /path/to/Linkedin-Helper
   npm install
   npm run build
   ```

2. Open Chrome and go to: **chrome://extensions**
3. Turn **Developer mode** on (top-right).
4. Click **Load unpacked**.
5. Choose the **`dist`** folder inside this project  
   (e.g. `Linkedin-Helper/dist`).
6. The "LinkedIn Job Eval" extension should appear and be enabled.

The UI opens in the **side panel** (not a popup): click the extension icon to open it. The panel stays open when you click elsewhere or switch tabs; close it via the panel's close control or by opening/closing the side panel.

---

## 3. Use the extension

1. **Configure once**
   - Click the extension icon to open the side panel.
   - **Settings**:
     - **Profile & role intent**: who you are, what roles you want (e.g. "Senior frontend, remote Netherlands").
     - **Skills / tech stack**: your skills and tech (e.g. "React, Next.js, Node.js, TypeScript").
     - **Negative filters**: deal-breakers (e.g. "No Java-only, no on-site-only, no fluent Dutch/German").
     - **Provider**: choose one of Ollama, Groq, OpenAI, Anthropic, Google (Gemini), or OpenRouter. Each cloud provider needs an API key (entered below the dropdown). Keys are stored per-provider—switching providers loads the matching key automatically.
     - **Ollama model** (shown when Ollama is selected): override the default model name (e.g. `qwen2.5:3b`).
   - Click **Save settings**.
   - **Resumes**: add 1–5 resumes (PDF or DOCX) with labels for use with **cloud** providers. For Ollama, resumes are ignored—only profile intent, skills/tech stack, and negative filters are sent.

2. **Evaluate a job**
   - Open a **LinkedIn job page** in the same browser. Supported URL patterns:
     - `linkedin.com/jobs/view/...` (direct job view)
     - `linkedin.com/jobs/collections/...` (collections with a selected job)
     - `linkedin.com/jobs/search/...` (search results with a selected job)
   - Click the extension icon to open the side panel.
   - On the main view: **resume checkboxes** control which resumes are sent (cloud providers only). For **Ollama** only your **profile intent** and **skills/tech stack** are sent—no resumes (faster and simpler).
   - Click **Evaluate this job**. The button is disabled while the request runs. The panel stays open so you can switch tabs or windows.
   - When it finishes, you'll see a score (0–100), verdict (Worth applying / Maybe / Not worth applying), bullets for match/risks, and optionally which resume fits best (cloud only).
   - If the job was already evaluated, you'll be offered the **cached score** or the option to **re-evaluate**.

If the button is disabled, you're not on a LinkedIn job page or (for cloud providers) the API key isn't set.

---

## Troubleshooting

- **"Forbidden" (403) — Ollama only**  
  Ollama blocks requests from the Chrome extension by default. Start Ollama with `OLLAMA_ORIGINS=*`:  
  Docker: `docker run -d -p 11434:11434 -e OLLAMA_ORIGINS=* --name ollama ollama/ollama`  
  Native: `OLLAMA_ORIGINS=* ollama serve`

- **"Could not reach Ollama"**  
  Ollama isn't running or not on port 11434. Start Ollama (Docker or native) and run `ollama pull llama3.1:8b` if you haven't.

- **"Invalid API key" (cloud providers)**  
  Double-check the API key for the selected provider in Settings. Make sure it matches the provider (e.g. a Groq key for Groq, not for OpenAI).

- **"Rate limited"**  
  The provider is rate-limiting your requests. Wait a moment and try again, or switch to a different provider.

- **"Could not read job details from this page"**  
  The extension couldn't find title/description on the page. Make sure you're on a LinkedIn job page (see supported URLs above). If LinkedIn changed their layout, the extension may need selector updates.

- **Evaluation is slow / "signal is aborted"**  
  Local models (e.g. 8B on CPU) can take 1–3 minutes. The extension waits up to 3 minutes for Ollama and 1 minute for cloud providers. Keep the panel open until the result appears; closing it cancels the request. If it still times out, try again or use a machine with more CPU/GPU.

- **"model requires more system memory" — Ollama only**  
  Use a smaller model: `ollama pull qwen2.5:3b` (~4 GB RAM). Change the model in the extension's Settings panel (Ollama model field).

---

## Tech

- **Chrome Extension** (Manifest v3), TypeScript, esbuild, IndexedDB (resumes + settings + cached evaluations), no backend.
- **LLM providers**: Ollama (local, OpenAI-compatible API), Groq, OpenAI, Anthropic, Google Gemini, OpenRouter.
- Default Ollama model: **llama3.1:8b** (configurable in Settings without editing code).
- API keys are stored in IndexedDB within the extension's isolated origin—never sent to any server other than the selected provider. Use provider-specific keys with minimal scope and revoke them if the device is shared.
- All data stays on your machine when using Ollama.
