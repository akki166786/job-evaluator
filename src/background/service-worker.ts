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

const MAX_CONCURRENT_EVALS = 10;
interface EvalTask {
  job: JobData;
  resumeIds: string[] | undefined;
  cacheKey: string;
  senderTabId: number | undefined;
  tabUrl: string | undefined;
}
let inFlightCount = 0;
const pendingQueue: EvalTask[] = [];

function isJobListPage(url: string | undefined): boolean {
  if (!url) return false;
  return /^https:\/\/www\.linkedin\.com\/jobs\/search\//.test(url) || /^https:\/\/www\.linkedin\.com\/jobs\/collections\//.test(url);
}

function runEvalTask(task: EvalTask): void {
  inFlightCount++;
  (async () => {
    let result: EvaluationResult | null = null;
    let error: string | undefined;
    let raw: string | undefined;
    try {
      const settings = await getSettings();
      let resumes = await getAllResumes();
      if (settings.apiProvider === 'ollama') {
        resumes = [];
      } else if (task.resumeIds && task.resumeIds.length > 0) {
        const idSet = new Set(task.resumeIds);
        resumes = resumes.filter((r) => idSet.has(r.id));
      } else {
        resumes = [];
      }
      const provider = settings.apiProvider as ApiProvider;
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
        settings.apiKeys?.[settings.apiProvider] ?? '',
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
    } finally {
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
      if (pendingQueue.length > 0 && inFlightCount < MAX_CONCURRENT_EVALS) {
        const next = pendingQueue.shift()!;
        runEvalTask(next);
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
    if (inFlightCount < MAX_CONCURRENT_EVALS) {
      runEvalTask(task);
    } else {
      pendingQueue.push(task);
    }
    sendResponse({ pending: true });
    return false;
  }
);
