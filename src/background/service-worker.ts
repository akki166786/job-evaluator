import { getSettings, getAllResumes } from '../lib/db';
import { evaluateJob } from '../lib/llm';
import type { JobData, EvaluationResult } from '../lib/types';

// Open side panel when user clicks the extension icon (no popup = stays open when clicking elsewhere)
chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId != null) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.runtime.onMessage.addListener(
  (
    msg: { type: string; job?: JobData; resumeIds?: string[] },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: { error?: string; raw?: string } | EvaluationResult) => void
  ) => {
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
        const result = await evaluateJob(
          msg.job!,
          resumes,
          settings.profileIntent,
          settings.skillsTechStack,
          settings.negativeFilters,
          settings.apiProvider,
          settings.apiKey
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
