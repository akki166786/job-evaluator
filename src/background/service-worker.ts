import { getSettings, getAllResumes, getJobEvaluation } from '../lib/db';
import { evaluateJob, PROVIDER_MODELS } from '../lib/llm';
import type { JobData, EvaluationResult, ApiProvider } from '../lib/types';

// Open side panel when user clicks the extension icon (no popup = stays open when clicking elsewhere)
chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

const PENDING_JOB_KEY = 'pendingJobChange';

chrome.runtime.onMessage.addListener(
  (
    msg: {
      type: string;
      job?: JobData;
      resumeIds?: string[];
      url?: string;
      jobIds?: string[];
    },
    sender: chrome.runtime.MessageSender,
    sendResponse: (r: { error?: string; raw?: string; scores?: Record<string, number> } | EvaluationResult) => void
  ) => {
    if (msg.type === 'JOB_PAGE_CHANGED' && sender.tab?.id != null && msg.url) {
      chrome.storage.session.set({ [PENDING_JOB_KEY]: { tabId: sender.tab.id, url: msg.url } }).catch(() => {});
      sendResponse({});
      return false;
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
      return true;
    }
    (async () => {
      try {
        const settings = await getSettings();
        let resumes = await getAllResumes();
        // Send resumes only when at least one is selected; otherwise only profile intent and negative filters
        if (settings.apiProvider === 'ollama') {
          resumes = [];
        } else if (msg.resumeIds && msg.resumeIds.length > 0) {
          const idSet = new Set(msg.resumeIds);
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
        const result = await evaluateJob(
          msg.job!,
          resumes,
          settings.profileIntent,
          settings.skillsTechStack,
          settings.negativeFilters,
          provider,
          settings.apiKeys?.[settings.apiProvider] ?? '',
          effectiveModel
        );
        sendResponse(result);
      } catch (e) {
        const err = e as Error;
        sendResponse({
          error: err.message || 'Evaluation failed.',
          raw: err.message,
        });
      }
    })();
    return true; // keep channel open for async sendResponse
  }
);
