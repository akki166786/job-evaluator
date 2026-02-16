import type { JobData, ResumeRecord, EvaluationResult, EvaluationResultRaw, ApiProvider } from './types';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompts';

const OLLAMA_ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60_000;
const OLLAMA_TIMEOUT_MS = 180_000; // local model can be slow on CPU

/** Default model per provider; used when user does not set a custom model. */
export const PROVIDER_MODELS: Record<ApiProvider, string> = {
  ollama: 'llama3.1:8b',
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  openrouter: 'tngtech/deepseek-r1t2-chimera:free',
  google: 'gemini-3-flash-preview',
  groq: 'openai/gpt-oss-120b',
};

const PROVIDER_ENDPOINTS: Record<ApiProvider, string> = {
  ollama: OLLAMA_ENDPOINT,
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  google: 'https://generativelanguage.googleapis.com/v1beta/models',
  groq: 'https://api.groq.com/openai/v1/chat/completions',
};

function getAuthHeader(provider: ApiProvider, apiKey: string): Record<string, string> {
  if (provider === 'ollama') return {};
  if (provider === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    };
  }
  if (provider === 'google') {
    return { 'x-goog-api-key': apiKey };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Parse LLM JSON output; tolerate trailing commas, newlines in strings, and surrounding text.
 */
const KNOWN_RESULT_KEYS = new Set([
  'score',
  'verdict',
  'hardRejectionReason',
  'matchBullets',
  'riskBullets',
  'bestResumeLabel',
  'explanation',
  'extraInfo',
]);

function collectExtraInfo(raw: Record<string, unknown>): Record<string, unknown> | null {
  const extra: Record<string, unknown> = {};
  const existing = raw.extraInfo;
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    Object.assign(extra, existing as Record<string, unknown>);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!KNOWN_RESULT_KEYS.has(key)) {
      extra[key] = value;
    }
  }
  return Object.keys(extra).length > 0 ? extra : null;
}

function parseJsonFromResponse(text: string): EvaluationResultRaw {
  let cleaned = text.trim();
  // Strip markdown code fences
  const codeFence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;
  const m = cleaned.match(codeFence);
  if (m) cleaned = m[1].trim();
  // Extract a single JSON object (in case there's extra text before/after)
  const firstBrace = cleaned.indexOf('{');
  if (firstBrace !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = firstBrace; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end !== -1) cleaned = cleaned.slice(firstBrace, end + 1);
  }
  // Remove trailing commas before } or ] (invalid in JSON, common in LLM output)
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');
  const repairOrder = [(s: string) => s, fixNewlinesInsideJsonStrings, coerceSmartQuotes, coerceSingleQuotes];
  for (const repair of repairOrder) {
    try {
      const parsed = JSON.parse(repair(cleaned)) as EvaluationResultRaw;
      if (parsed != null && typeof parsed === 'object' && 'verdict' in parsed) {
        const extraInfo = collectExtraInfo(parsed as unknown as Record<string, unknown>);
        if (extraInfo) parsed.extraInfo = extraInfo;
        return parsed;
      }
    } catch {
      continue;
    }
  }
  // Last resort: extract key fields with regex and build minimal result
  const fallback = extractResultFromBrokenJson(cleaned);
  if (fallback) return fallback;
  throw new Error(
    'The model returned invalid JSON. Try "Evaluate this job" again; if it keeps failing, the model may be overloaded.'
  );
}

/** Fix literal newlines inside JSON string values (iterate and track in/out of strings). */
function fixNewlinesInsideJsonStrings(json: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < json.length) {
    const c = json[i];
    if (escape) {
      out += c;
      escape = false;
      i++;
      continue;
    }
    if (c === '\\') {
      out += c;
      escape = true;
      i++;
      continue;
    }
    if (inString) {
      if (c === '"') {
        inString = false;
        out += c;
      } else if (c === '\n' || c === '\r') {
        out += '\\n';
        if (c === '\r' && json[i + 1] === '\n') i++;
      } else {
        out += c;
      }
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else {
      out += c;
    }
    i++;
  }
  return out;
}

function coerceSmartQuotes(json: string): string {
  return json.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
}

function coerceSingleQuotes(json: string): string {
  return json.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_, inner) => `"${inner.replace(/"/g, '\\"')}"`);
}

/** Try to extract score, verdict, explanation from broken JSON for a minimal result. */
function extractResultFromBrokenJson(text: string): EvaluationResultRaw | null {
  const scoreMatch = text.match(/"score"\s*:\s*(\d+)/);
  const verdictMatch = text.match(/"verdict"\s*:\s*"(worth|maybe|not_worth)"/);
  const score = scoreMatch ? Math.max(0, Math.min(100, parseInt(scoreMatch[1], 10))) : 50;
  const verdict = (verdictMatch?.[1] as 'worth' | 'maybe' | 'not_worth') ?? 'maybe';
  const explanationMatch = text.match(/"explanation"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const explanation = explanationMatch ? explanationMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : '';
  const matchBullets: string[] = [];
  const riskBullets: string[] = [];
  const bulletRegex = /"(?:matchBullets|riskBullets)"\s*:\s*\[\s*((?:"(?:[^"\\]|\\.)*"\s*,?\s*)*)\]/g;
  let bulletMatch;
  while ((bulletMatch = bulletRegex.exec(text)) !== null) {
    const key = bulletMatch[0].includes('matchBullets') ? 'match' : 'risk';
    const inner = bulletMatch[1];
    const items = inner.match(/"((?:[^"\\]|\\.)*)"/g);
    if (items) {
      for (const item of items) {
        const unescaped = item.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
        if (key === 'match') matchBullets.push(unescaped);
        else riskBullets.push(unescaped);
      }
    }
  }
  const bestMatch = text.match(/"bestResumeLabel"\s*:\s*(?:"([^"]*)"|null)/);
  const bestResumeLabel = bestMatch ? (bestMatch[1] ?? null) : null;
  const hardMatch = text.match(/"hardRejectionReason"\s*:\s*(?:"((?:[^"\\]|\\.)*)"|null)/);
  const hardRejectionReason = hardMatch ? (hardMatch[1] ?? null) : null;
  // Cap raw text for debugging; avoid bloating storage/UI with full LLM responses
  const MAX_RAW_TEXT_LEN = 500;
  const extraInfo = text
    ? { rawText: text.length > MAX_RAW_TEXT_LEN ? text.slice(0, MAX_RAW_TEXT_LEN) + '…' : text }
    : null;
  return {
    score,
    verdict,
    hardRejectionReason,
    matchBullets,
    riskBullets,
    bestResumeLabel,
    explanation,
    extraInfo,
  };
}

function normalizeResult(raw: EvaluationResultRaw): EvaluationResult {
  const verdict = raw.verdict === 'worth' || raw.verdict === 'maybe' || raw.verdict === 'not_worth'
    ? raw.verdict
    : 'maybe';
  return {
    score: typeof raw.score === 'number' ? Math.max(0, Math.min(100, raw.score)) : 50,
    verdict,
    hardRejectionReason: raw.hardRejectionReason ?? null,
    matchBullets: Array.isArray(raw.matchBullets) ? raw.matchBullets : [],
    riskBullets: Array.isArray(raw.riskBullets) ? raw.riskBullets : [],
    bestResumeLabel: raw.bestResumeLabel ?? null,
    explanation: typeof raw.explanation === 'string' ? raw.explanation : '',
    extraInfo: raw.extraInfo ?? null,
  };
}

/** Call the LLM and return a structured evaluation. */
export async function evaluateJob(
  job: JobData,
  resumes: ResumeRecord[],
  profileIntent: string,
  skillsTechStack: string,
  negativeFilters: string,
  provider: ApiProvider,
  apiKey: string,
  model: string
): Promise<EvaluationResult> {
  if (provider !== 'ollama' && !apiKey) {
    throw new Error('API key required for this provider.');
  }

  const endpoint = PROVIDER_ENDPOINTS[provider];
  const userPrompt = buildUserPrompt(job, profileIntent, skillsTechStack, negativeFilters, resumes);

  if (provider === 'anthropic') {
    const body = {
      model: model || PROVIDER_MODELS[provider],
      max_tokens: 1024,
      messages: [
        { role: 'user', content: `${SYSTEM_PROMPT}\n\n${userPrompt}` },
      ],
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: getAuthHeader(provider, apiKey),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      if ((e as Error).name === 'AbortError') {
        throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Try again.`);
      }
      throw e;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(res.status === 401 ? 'Invalid API key.' : res.status === 429 ? 'Rate limited.' : t || res.statusText);
    }
    const data = await res.json();
    const text = data.content?.[0]?.text ?? data.content ?? '';
    const raw = parseJsonFromResponse(text);
    return normalizeResult(raw);
  }

  if (provider === 'google') {
    const effectiveModel = model || PROVIDER_MODELS[provider];
    const googleEndpoint = `${PROVIDER_ENDPOINTS[provider]}/${effectiveModel}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: 1024 },
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(googleEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeader(provider, apiKey),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      if ((e as Error).name === 'AbortError') {
        throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Try again.`);
      }
      throw e;
    }
    clearTimeout(timeout);
    if (!res.ok) {
      const t = await res.text();
      throw new Error(res.status === 401 ? 'Invalid API key.' : res.status === 429 ? 'Rate limited.' : t || res.statusText);
    }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const raw = parseJsonFromResponse(text);
    return normalizeResult(raw);
  }

  // OpenAI-compatible (Ollama, OpenAI, Groq, OpenRouter)
  const effectiveModel = model || PROVIDER_MODELS[provider];
  const body = {
    model: effectiveModel,
    max_tokens: 1024,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  };
  const timeoutMs = provider === 'ollama' ? OLLAMA_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeader(provider, apiKey),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    if ((e as Error).name === 'AbortError') {
      throw new Error(
        provider === 'ollama'
          ? `Request timed out after ${timeoutMs / 1000}s. Ollama may be slow on CPU—try again or keep the panel open longer.`
          : `Request to ${provider} timed out after ${timeoutMs / 1000}s. The API may be overloaded—try again.`
      );
    }
    throw e;
  }
  clearTimeout(timeout);
  if (!res.ok) {
    const t = await res.text();
    if (provider === 'ollama') {
      if (res.status === 0 || res.type === 'opaque') {
        throw new Error('Could not reach Ollama. Is it running? (e.g. ollama serve or Docker.)');
      }
      if (res.status === 403 || res.status === 401) {
        throw new Error(
          'Ollama rejected the request (CORS). Quit the Ollama app completely, then in a terminal run: OLLAMA_ORIGINS=* ollama serve'
        );
      }
    }
    throw new Error(res.status === 401 ? 'Invalid API key.' : res.status === 429 ? 'Rate limited.' : t || res.statusText);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const raw = parseJsonFromResponse(text);
  return normalizeResult(raw);
}
