# Privacy Policy — LinkedIn Job Eval

**Last updated:** February 2026

## What this extension does

LinkedIn Job Eval is a Chrome extension that evaluates LinkedIn job postings to help you decide whether a job is worth applying to. It sends the job description and your profile information to an AI language model (LLM) and displays a structured verdict.

## Data we collect

**We do not collect, transmit, or store any of your data on our servers.** The extension has no backend, no analytics, and no telemetry.

## Data stored locally

The following data is stored **only on your device** using the browser's IndexedDB (within the extension's isolated origin):

- **Settings**: your profile intent, skills/tech stack, negative filters, selected provider, and Ollama model name.
- **API keys**: stored per-provider in IndexedDB. Keys never leave your device except when sent to the provider you selected.
- **Resumes**: parsed text from uploaded PDF/DOCX files, stored locally for evaluation. Original files are not retained.
- **Cached evaluations**: job ID and score for previously evaluated jobs (up to 1,000 entries, oldest auto-deleted).

You can clear all extension data at any time by removing the extension or clearing site data for the extension origin in Chrome settings.

## Data sent to third parties

When you click "Evaluate this job," the extension sends the following to **the LLM provider you selected** (and only that provider):

- The job title, description, and location (read from the LinkedIn page).
- Your profile intent, skills/tech stack, and negative filters (from Settings).
- Selected resume text (cloud providers only; Ollama sends no resumes).

### Supported providers and their privacy policies

| Provider | Data destination | Privacy policy |
|---|---|---|
| Ollama (local) | `localhost:11434` — never leaves your machine | N/A |
| Groq | `api.groq.com` | [groq.com/privacy](https://groq.com/privacy) |
| OpenAI | `api.openai.com` | [openai.com/privacy](https://openai.com/privacy) |
| Anthropic | `api.anthropic.com` | [anthropic.com/privacy](https://www.anthropic.com/privacy) |
| Google (Gemini) | `generativelanguage.googleapis.com` | [policies.google.com/privacy](https://policies.google.com/privacy) |
| OpenRouter | `openrouter.ai` | [openrouter.ai/privacy](https://openrouter.ai/privacy) |

**When using Ollama (local)**, all data stays on your machine. No network requests are made to external servers.

## Permissions explained

| Permission | Why it's needed |
|---|---|
| `activeTab` | Read job details from the current LinkedIn tab when you click "Evaluate." |
| `storage` | Not currently used (IndexedDB is used instead); reserved for future use. |
| `scripting` | Inject the content script to extract job data from LinkedIn pages. |
| `sidePanel` | Display the extension UI in Chrome's side panel. |
| Host permissions (LinkedIn) | Read job page content. |
| Host permissions (API endpoints) | Send evaluation requests to the selected LLM provider. |

## Security

- API keys are stored in IndexedDB within the extension's isolated origin, accessible only to this extension.
- We recommend using provider-specific API keys with minimal permissions and revoking them if the device is shared.
- The extension does not use `eval()`, remote code execution, or external script loading.

## Children's privacy

This extension is not directed at children under 13 and does not knowingly collect information from children.

## Changes to this policy

If this policy is updated, the new version will be published alongside the extension update. The "Last updated" date at the top will reflect the change.

## Contact

If you have questions about this privacy policy, please open an issue on the project's GitHub repository.
