# LinkedIn Job Eval

Chrome extension that answers: **“Is this job worth my time to apply?”**  
Supports local (Ollama) and cloud providers (OpenAI, Anthropic, OpenRouter, Google Gemini, Groq) for conservative, explainable verdicts. No auto-apply, no scraping—you stay in control.

---

## 1. Run Ollama (local LLM)

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

   Or set the env var in your shell profile so it’s used every time.
3. Pull the model:

```bash
ollama pull llama3.1:8b
```

Check that it’s running:

```bash
curl http://localhost:11434/api/tags
```

You should see `llama3.1:8b` in the list. If you have less RAM (~4 GB), use `ollama pull qwen2.5:3b` and change the extension’s default model in code (or use a smaller variant).

---

## 2. Load the extension in Chrome

1. **Build** (if you haven’t):

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
6. The “LinkedIn Job Eval” extension should appear and be enabled.

The UI opens in the **side panel** (not a popup): click the extension icon to open it. The panel stays open when you click elsewhere or switch tabs; close it via the panel’s close control or by opening/closing the side panel.

---

## 3. Use the extension

1. **Configure once**
   - Click the extension icon to open the side panel.
   - **Settings**:
     - **Profile & role intent**: who you are, what roles you want (e.g. “Senior frontend, remote Netherlands”).
     - **Skills / tech stack**: your skills and tech (e.g. “React, Next.js, Node.js, TypeScript”).
     - **Negative filters**: deal-breakers (e.g. “No Java-only, no on-site-only, no fluent Dutch/German”).
     - **Provider**: choose Ollama (local) or a cloud provider.
     - **API key**: stored per provider in extension settings.
   - Click **Save settings**.
   - **Resumes**: add 1–5 resumes (PDF or DOCX) with labels for use with **cloud** providers (OpenAI, etc.). For Ollama they are ignored.

2. **Evaluate a job**
   - Open a **LinkedIn job page** in the same browser (e.g. a `linkedin.com/jobs/view/...` URL).
   - Click the extension icon to open the side panel.
   - On the main view: **resume checkboxes** control which resumes are sent (only for cloud providers). For **Ollama (local)** the extension uses only your **profile intent** and **skills/tech stack**—no resumes are sent (faster and simpler).
   - Click **Evaluate this job**. The button is disabled and the hint is hidden while the request runs. The panel stays open so you can switch tabs or windows.
   - When it finishes, you’ll see a score (0–100), verdict (Worth applying / Maybe / Not worth applying), bullets for match/risks, and optionally which resume fits best (cloud only).

If the button is disabled, you’re not on a LinkedIn job view page or (for cloud providers) the API key isn’t set.

---

## Troubleshooting

- **“Forbidden” (403)**  
  Ollama blocks requests from the Chrome extension by default. Start Ollama with `OLLAMA_ORIGINS=*`:  
  Docker: `docker run -d -p 11434:11434 -e OLLAMA_ORIGINS=* --name ollama ollama/ollama`  
  Native: `OLLAMA_ORIGINS=* ollama serve`

- **“Could not reach Ollama”**  
  Ollama isn’t running or not on port 11434. Start Ollama (Docker or native) and run `ollama pull llama3.1:8b` if you haven’t.

- **“Could not read job details from this page”**  
  The extension couldn’t find title/description on the page. Make sure you’re on a **single job view** (e.g. `linkedin.com/jobs/view/123...`). If LinkedIn changed their layout, the extension may need selector updates.

- **Evaluation is slow / “signal is aborted”**  
  Local models (e.g. 8B on CPU) can take 1–3 minutes. The extension waits up to 3 minutes for Ollama. Keep the panel open until the result appears; closing it cancels the request. If it still times out, try again or use a machine with more CPU/GPU.

- **“model requires more system memory”**  
  Use a smaller model: `ollama pull qwen2.5:3b` (~4 GB RAM). The extension default is `llama3.1:8b` (~5 GB RAM); you can change it in `src/lib/llm.ts` (PROVIDER_MODELS.ollama).

---

## Tech

- **Chrome Extension** (Manifest v3), TypeScript, IndexedDB (resumes + settings), no backend.
- **Ollama** at `http://localhost:11434` (OpenAI-compatible API); default model: **llama3.1:8b**. For Ollama, only profile intent and skills/tech stack are sent (no resumes).
- All data stays on your machine when using Ollama.

---

## Chrome Web Store release notes (v1.0)

- Manifest and package version are now `1.0.0`.
- App/action/store icons are included under `assets/icons` and wired in `manifest.json`.
- Required host permissions for all supported providers are declared in `manifest.json`.

Before publishing, prepare:
- store screenshots (small + large), promotional tile assets,
- privacy policy URL,
- support contact,
- short and detailed listing description,
- zip the `dist/` output after `npm run build`.

- Icon PNG files are generated during build into `dist/assets/icons` to keep pull requests text-only.
