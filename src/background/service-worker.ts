import {
  getSettings,
  getAllResumes,
  getJobEvaluation,
  saveJobEvaluation,
  getVisitedCompaniesMap,
  recordVisitedCompanyVisit,
} from '../lib/db';
import { evaluateJob, PROVIDER_MODELS } from '../lib/llm';
import type { JobData, EvaluationResult, ApiProvider } from '../lib/types';

// Open side panel when user clicks the extension icon (no popup = stays open when clicking elsewhere)
chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

const PENDING_JOB_KEY = 'pendingJobChange';

const PROVIDER_ROTATION_KEY = 'jobEvalProviderRotation';

/**
 * Rate-limit strategy for 3–20 jobs (OpenRouter + Groq).
 * - OpenRouter: per-model limits, DDoS protection; spreading across providers helps.
 *   https://openrouter.ai/docs/api/reference/limits
 * - Groq: e.g. 30 RPM on free tier; RPD/TPM also apply.
 *   https://console.groq.com/docs/rate-limits
 * Strategy: turn-based rotation, max 4 in-flight per provider, stagger starts (0/5/10/15s)
 * so we stay under ~30 RPM per provider; rest wait in queue for a slot.
 */
const MAX_PER_PROVIDER = 4;
const DELAY_STEP_MS = 5000;
const DELAY_CAP_MS = 15000;
/** Groq free tier ~30 RPM → 1 req per 2s; min interval between starts per provider. */
const MIN_INTERVAL_BETWEEN_STARTS_MS = 2000;

interface EvalTask {
  job: JobData;
  resumeIds: string[] | undefined;
  cacheKey: string;
  senderTabId: number | undefined;
  tabUrl: string | undefined;
}
let inFlightCount = 0;
const pendingQueue: EvalTask[] = [];
const providerInFlightCount: Partial<Record<ApiProvider, number>> = {};

/** Get all configured providers (those with API keys, or ollama if available). */
function getConfiguredProviders(settings: { apiKeys: Partial<Record<ApiProvider, string>>; apiProvider: ApiProvider; activeProviders?: ApiProvider[] }): ApiProvider[] {
  if (settings.activeProviders && settings.activeProviders.length > 0) {
    return settings.activeProviders.filter((p) => {
      if (p === 'ollama') return true;
      const key = settings.apiKeys[p];
      return key && key.trim();
    });
  }
  const providers: ApiProvider[] = [];
  const allProviders: ApiProvider[] = ['ollama', 'openai', 'anthropic', 'openrouter', 'google', 'groq'];
  for (const provider of allProviders) {
    if (provider === 'ollama') {
      providers.push(provider);
    } else {
      const key = settings.apiKeys[provider];
      if (key && key.trim()) {
        providers.push(provider);
      }
    }
  }
  return providers.length > 0 ? providers : [settings.apiProvider];
}

/** Peek next provider in rotation without advancing (for slot check). */
async function peekNextProvider(configuredProviders: ApiProvider[]): Promise<ApiProvider> {
  if (configuredProviders.length === 1) return configuredProviders[0];
  const stored = await chrome.storage.local.get(PROVIDER_ROTATION_KEY);
  let lastIndex = typeof stored[PROVIDER_ROTATION_KEY] === 'number' ? stored[PROVIDER_ROTATION_KEY] : -1;
  if (lastIndex >= configuredProviders.length || lastIndex < 0) lastIndex = -1;
  const nextIndex = (lastIndex + 1) % configuredProviders.length;
  return configuredProviders[nextIndex];
}

/** Get next provider in rotation and advance. */
async function getNextProvider(configuredProviders: ApiProvider[]): Promise<ApiProvider> {
  if (configuredProviders.length === 1) return configuredProviders[0];
  const stored = await chrome.storage.local.get(PROVIDER_ROTATION_KEY);
  let lastIndex = typeof stored[PROVIDER_ROTATION_KEY] === 'number' ? stored[PROVIDER_ROTATION_KEY] : -1;
  if (lastIndex >= configuredProviders.length || lastIndex < 0) lastIndex = -1;
  const nextIndex = (lastIndex + 1) % configuredProviders.length;
  await chrome.storage.local.set({ [PROVIDER_ROTATION_KEY]: nextIndex });
  return configuredProviders[nextIndex];
}

/** Start one task from queue if the next provider has a free slot. Advance rotation when assigning to avoid race. */
async function tryStartNext(): Promise<void> {
  if (pendingQueue.length === 0) return;
  const settings = await getSettings();
  const configured = getConfiguredProviders(settings);
  if (configured.length === 0) return;
  const nextProvider = await peekNextProvider(configured);
  if ((providerInFlightCount[nextProvider] ?? 0) >= MAX_PER_PROVIDER) return;
  const task = pendingQueue.shift()!;
  const provider = await getNextProvider(configured);
  runEvalTask(task, provider);
}

function isJobListPage(url: string | undefined): boolean {
  if (!url) return false;
  return /^https:\/\/www\.linkedin\.com\/jobs\/search\//.test(url) || /^https:\/\/www\.linkedin\.com\/jobs\/collections\//.test(url);
}

function runEvalTask(task: EvalTask, assignedProvider: ApiProvider): void {
  const provider = assignedProvider;
  inFlightCount++;
  (async () => {
    let result: EvaluationResult | null = null;
    let error: string | undefined;
    let raw: string | undefined;
    try {
      const settings = await getSettings();
      const count = providerInFlightCount[provider] ?? 0;
      providerInFlightCount[provider] = count + 1;
      const delayMs = Math.min(
        Math.max(count * DELAY_STEP_MS, count > 0 ? MIN_INTERVAL_BETWEEN_STARTS_MS : 0),
        DELAY_CAP_MS
      );
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      let resumes = await getAllResumes();
      if (provider === 'ollama') {
        resumes = [];
      } else if (task.resumeIds && task.resumeIds.length > 0) {
        const idSet = new Set(task.resumeIds);
        resumes = resumes.filter((r) => idSet.has(r.id));
      } else {
        resumes = [];
      }
      const effectiveModel =
        provider === 'ollama'
          ? (settings.ollamaModel || settings.providerModels?.ollama || PROVIDER_MODELS.ollama).trim() ||
            PROVIDER_MODELS.ollama
          : (settings.providerModels?.[provider]?.trim() || PROVIDER_MODELS[provider]);
      result = await evaluateJob(
        task.job,
        resumes,
        settings.profileIntent,
        settings.skillsTechStack,
        settings.negativeFilters,
        provider,
        settings.apiKeys?.[provider] ?? '',
        effectiveModel
      );
      await saveJobEvaluation(task.cacheKey, result);
      if (task.senderTabId != null && isJobListPage(task.tabUrl)) {
        try {
          await chrome.tabs.sendMessage(task.senderTabId, {
            type: 'SET_JOB_SCORES',
            scores: { [task.job.id]: result!.score },
          });
        } catch {
          /* tab closed or context invalid */
        }
      }
    } catch (e) {
      const err = e as Error;
      error = err.message || 'Evaluation failed.';
      raw = err.message;
      if (error === 'Rate limited.') {
        pendingQueue.push(task);
      }
    } finally {
      const n = (providerInFlightCount[provider] ?? 1) - 1;
      if (n <= 0) delete providerInFlightCount[provider];
      else providerInFlightCount[provider] = n;
      chrome.runtime.sendMessage({
        type: 'EVALUATION_COMPLETE',
        cacheKey: task.cacheKey,
        jobId: task.job.id,
        senderTabId: task.senderTabId,
        result: result ?? undefined,
        error,
        raw,
      }).catch(() => {});
      inFlightCount--;
      tryStartNext();
    }
  })();
}

chrome.runtime.onMessage.addListener(
  (
    msg: {
      type: string;
      job?: JobData;
      resumeIds?: string[];
      cacheKey?: string;
      senderTabId?: number;
      tabUrl?: string;
      url?: string;
      jobIds?: string[];
      company?: string;
    },
    sender: chrome.runtime.MessageSender,
    sendResponse: (
      r:
        | { error?: string; raw?: string; pending?: boolean; scores?: Record<string, number>; visitedCompanies?: Record<string, number>; ok?: boolean }
        | EvaluationResult
    ) => void
  ) => {
    if (msg.type === 'JOB_PAGE_CHANGED' && sender.tab?.id != null && msg.url) {
      sendResponse({});
      return false;
    }
    if (msg.type === 'GET_VISITED_COMPANIES') {
      (async () => {
        const visitedCompanies = await getVisitedCompaniesMap().catch(() => ({}));
        sendResponse({ visitedCompanies });
      })();
      return true;
    }
    if (msg.type === 'RECORD_VISITED_COMPANY' && typeof msg.company === 'string') {
      (async () => {
        await recordVisitedCompanyVisit(msg.company!).catch(() => {});
        sendResponse({ ok: true });
      })();
      return true;
    }
    if (msg.type === 'GET_CACHED_SCORES_FOR_JOBS' && Array.isArray(msg.jobIds)) {
      (async () => {
        const scores: Record<string, number> = {};
        for (const id of msg.jobIds!) {
          const rec = await getJobEvaluation(id).catch(() => null);
          if (rec != null) scores[id] = rec.score;
        }
        sendResponse({ scores });
      })();
      return true;
    }
    if (msg.type !== 'EVALUATE_JOB' || !msg.job) {
      sendResponse({ error: 'Missing job data.' });
      return false;
    }
    const cacheKey = msg.cacheKey ?? msg.job.id;
    const task: EvalTask = {
      job: msg.job,
      resumeIds: msg.resumeIds,
      cacheKey,
      senderTabId: msg.senderTabId,
      tabUrl: msg.tabUrl,
    };
    pendingQueue.push(task);
    tryStartNext();
    sendResponse({ pending: true });
    return false;
  }
);
