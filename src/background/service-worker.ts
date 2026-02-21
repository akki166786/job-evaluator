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

interface EvalTask {
  job: JobData;
  resumeIds: string[] | undefined;
  cacheKey: string;
  senderTabId: number | undefined;
  tabUrl: string | undefined;
}

const RATE_LIMIT_RETRY_MS = 10_000;
const TASK_FAIL_TIMEOUT_MS = 2 * 60 * 1000;

let pendingQueue: EvalTask[] = [];
let inFlight: { task: EvalTask; provider: ApiProvider } | null = null;
let lastProviderIndex = -1;

function debugLog(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  chrome.runtime.sendMessage({ type: 'DEBUG_LOG', msg, level }).catch(() => {});
}

/** Get all configured providers (those with API keys, or ollama if available). */
function getConfiguredProviders(settings: { apiKeys: Partial<Record<ApiProvider, string>>; apiProvider: ApiProvider; activeProviders?: ApiProvider[] }): ApiProvider[] {
  const hasKey = (p: ApiProvider) => p === 'ollama' || !!(settings.apiKeys[p] && settings.apiKeys[p]!.trim());

  if (settings.activeProviders && settings.activeProviders.length > 0) {
    const fromActive = settings.activeProviders.filter(hasKey);
    if (fromActive.length > 0) return fromActive;
    // Active agents set but none have keys → fall back to default so we don't get stuck
  }
  const providers: ApiProvider[] = [];
  const allProviders: ApiProvider[] = ['ollama', 'openai', 'anthropic', 'openrouter', 'google', 'groq'];
  for (const provider of allProviders) {
    if (hasKey(provider)) providers.push(provider);
  }
  return providers.length > 0 ? providers : [settings.apiProvider];
}

/** Round-robin: next provider index. */
function getNextProvider(configured: ApiProvider[]): ApiProvider {
  if (configured.length === 0) throw new Error('no providers');
  lastProviderIndex = (lastProviderIndex + 1) % configured.length;
  return configured[lastProviderIndex];
}

/** Start the next queued task only when no task is in flight. One at a time, round-robin provider. */
async function tryStartNext(): Promise<void> {
  if (inFlight != null) return;
  if (pendingQueue.length === 0) return;
  const settings = await getSettings();
  const configured = getConfiguredProviders(settings);
  if (configured.length === 0) {
    debugLog('[queue] skip: no configured providers', 'warn');
    return;
  }
  const task = pendingQueue.shift()!;
  const provider = getNextProvider(configured);
  inFlight = { task, provider };
  debugLog(`[queue] starting jobId=${task.job.id} provider=${provider} queueLen=${pendingQueue.length}`);
  runEvalTask(task, provider);
}

function isJobListPage(url: string | undefined): boolean {
  if (!url) return false;
  return /^https:\/\/www\.linkedin\.com\/jobs\/search\//.test(url) || /^https:\/\/www\.linkedin\.com\/jobs\/collections\//.test(url);
}

function runEvalTask(task: EvalTask, assignedProvider: ApiProvider, retryAttempt = 0): void {
  const provider = assignedProvider;
  const taskStartedAt = Date.now();

  function done(result: EvaluationResult | undefined, error: string | undefined, raw: string | undefined) {
    inFlight = null;
    chrome.runtime.sendMessage({
      type: 'EVALUATION_COMPLETE',
      cacheKey: task.cacheKey,
      jobId: task.job.id,
      senderTabId: task.senderTabId,
      result,
      error,
      raw,
      provider,
    }).catch(() => {});
    tryStartNext();
  }

  (async () => {
    let result: EvaluationResult | null = null;
    let error: string | undefined;
    let raw: string | undefined;
    try {
      const settings = await getSettings();
      let resumes = await getAllResumes();
      if (provider === 'ollama') {
        resumes = [];
      } else if (task.resumeIds?.length) {
        const idSet = new Set(task.resumeIds);
        resumes = resumes.filter((r) => idSet.has(r.id));
      } else {
        resumes = [];
      }
      const effectiveModel =
        provider === 'ollama'
          ? (settings.ollamaModel || settings.providerModels?.ollama || PROVIDER_MODELS.ollama).trim() || PROVIDER_MODELS.ollama
          : (settings.providerModels?.[provider]?.trim() || PROVIDER_MODELS[provider]);
      const apiKey = settings.apiKeys?.[provider] ?? '';
      debugLog(`[model] jobId=${task.job.id} provider=${provider} model=${effectiveModel}`);
      const startMs = Date.now();
      const evalPromise = evaluateJob(
        task.job,
        resumes,
        settings.profileIntent,
        settings.skillsTechStack,
        settings.negativeFilters,
        provider,
        apiKey,
        effectiveModel
      );
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout (2 min)')), TASK_FAIL_TIMEOUT_MS)
      );
      const evalOut = await Promise.race([evalPromise, timeoutPromise]);
      result = evalOut.result;
      const elapsedMs = Date.now() - startMs;
      debugLog(`[model] reply jobId=${task.job.id} provider=${provider} score=${result.score} (${elapsedMs}ms)`);
      await saveJobEvaluation(task.cacheKey, result);
      if (task.senderTabId != null && isJobListPage(task.tabUrl)) {
        try {
          await chrome.tabs.sendMessage(task.senderTabId, {
            type: 'SET_JOB_SCORES',
            scores: { [task.job.id]: result!.score },
          });
        } catch {
          /* tab closed */
        }
      }
      done(result, undefined, undefined);
    } catch (e) {
      const err = e as Error;
      error = err.message || 'Evaluation failed.';
      raw = err.message;
      debugLog(`[model] jobId=${task.job.id} provider=${provider} error=${error}`, 'warn');
      if (error === 'Rate limited.') {
        const elapsed = Date.now() - taskStartedAt;
        const retryCount = retryAttempt + 1;
        chrome.runtime.sendMessage({
          type: 'EVALUATION_RATE_LIMITED',
          cacheKey: task.cacheKey,
          jobId: task.job.id,
          senderTabId: task.senderTabId,
          retryCount,
          provider,
        }).catch(() => {});
        if (elapsed >= TASK_FAIL_TIMEOUT_MS) {
          debugLog(`[queue] jobId=${task.job.id} gave up after 2 min (rate limited)`);
          done(undefined, error, raw);
        } else {
          debugLog(`[queue] jobId=${task.job.id} rate limited, retry #${retryCount} in 10s`);
          setTimeout(() => runEvalTask(task, provider, retryCount), RATE_LIMIT_RETRY_MS);
        }
      } else {
        done(undefined, error, raw);
      }
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
    if (msg.type === 'GET_QUEUE_DEBUG') {
      (async () => {
        const settings = await getSettings();
        const configured = getConfiguredProviders(settings);
        sendResponse({
          queueLength: pendingQueue.length,
          queueJobIds: pendingQueue.map((t) => t.job.id),
          inFlightPerProvider: inFlight ? { [inFlight.provider]: 1 } : {},
          configured,
          activeProviders: settings.activeProviders ?? null,
        });
      })();
      return true;
    }
    if (msg.type === 'EVALUATE_JOB' && msg.job) {
      const cacheKey = msg.cacheKey ?? msg.job.id;
      const task: EvalTask = {
        job: msg.job,
        resumeIds: msg.resumeIds,
        cacheKey,
        senderTabId: msg.senderTabId,
        tabUrl: msg.tabUrl,
      };
      pendingQueue.push(task);
      debugLog(`[queue] enqueued jobId=${task.job.id} queueLen=${pendingQueue.length}`);
      tryStartNext();
      sendResponse({ pending: true });
      return false;
    }
    sendResponse({ error: 'Missing job data.' });
    return false;
  }
);
