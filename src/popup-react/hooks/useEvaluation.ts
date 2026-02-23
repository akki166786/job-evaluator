import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getJobEvaluation,
  saveJobEvaluation,
  getAllResumes,
  getSettings,
} from '@/lib/db';
import {
  getCacheKeyForJob,
  isLinkedInJobPage,
  isJobListPage,
} from '@/lib/linkedin';
import type { EvaluationResult, JobData, ResumeRecord } from '@/lib/types';

export type EvaluationState = {
  result: EvaluationResult | null;
  loading: boolean;
  error: string | null;
  jobTitle: string | null;
  cacheKey: string | null;
  pendingRerun: { cacheKey: string; job: JobData | null; resumeIds: string[] | undefined } | null;
};

export type ProcessingJob = {
  cacheKey: string;
  jobId: string;
  title: string;
  status: 'pending' | 'done' | 'rate_limited';
  score?: number;
  startedAt?: number;
  retryCount?: number;
  lastError?: string;
  lastProvider?: string;
};

const PROCESSING_TITLE_MAX = 45;
const RETRY_WINDOW_MS = 2 * 60 * 1000; // Show "Retrying" for 2 min, then "Failed"
const REMOVE_DONE_MS = 10 * 1000;
const HIGH_SCORE_KEEP = 75;

export function isJobFailed(j: ProcessingJob): boolean {
  if (j.status !== 'pending' || !j.lastError) return false;
  const startedAt = j.startedAt ?? 0;
  return Date.now() - startedAt >= RETRY_WINDOW_MS;
}

export function isJobRetrying(j: ProcessingJob): boolean {
  return j.status === 'pending' && !!j.lastError && !isJobFailed(j);
}

function shortenTitle(title: string): string {
  const t = (title || '').trim();
  if (t.length <= PROCESSING_TITLE_MAX) return t;
  return t.slice(0, PROCESSING_TITLE_MAX - 1) + '…';
}

export function useEvaluation(
  selectedResumeIds: string[],
  onDebugLog?: (msg: string, level?: 'info' | 'warn' | 'error') => void
) {
  const [resumes, setResumes] = useState<ResumeRecord[]>([]);
  const [state, setState] = useState<EvaluationState>({
    result: null,
    loading: false,
    error: null,
    jobTitle: null,
    cacheKey: null,
    pendingRerun: null,
  });
  const [processingJobs, setProcessingJobs] = useState<ProcessingJob[]>([]);
  const pendingTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const log = useCallback(
    (msg: string, level: 'info' | 'warn' | 'error' = 'info') => {
      onDebugLog?.(msg, level);
    },
    [onDebugLog]
  );

  useEffect(() => {
    getAllResumes().then(setResumes).catch(() => setResumes([]));
  }, []);

  type EvaluatingJobPayload = {
    jobId: string;
    startedAt: number;
    status: 'evaluating' | 'retrying' | 'failed';
    retryCount?: number;
    provider?: string;
    isRateLimit?: boolean;
  };

  const sendEvaluatingJobsToTab = useCallback(
    async (tabId?: number) => {
      const tab =
        tabId != null
          ? await chrome.tabs.get(tabId).catch(() => null)
          : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
      if (!tab?.id || !isLinkedInJobPage(tab.url)) return;
      const now = Date.now();
      const jobs: EvaluatingJobPayload[] = processingJobs
        .filter((j) => j.status === 'pending')
        .map((j) => {
          const startedAt = j.startedAt ?? now;
          const elapsed = now - startedAt;
          const hasError = !!j.lastError;
          const status: 'evaluating' | 'retrying' | 'failed' =
            hasError && elapsed >= RETRY_WINDOW_MS ? 'failed' : hasError ? 'retrying' : 'evaluating';
          const isRateLimit = j.lastError?.toLowerCase().includes('rate limit') ?? false;
          return {
            jobId: j.jobId,
            startedAt,
            status,
            retryCount: j.retryCount,
            provider: j.lastProvider,
            isRateLimit,
          };
        });
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'SET_EVALUATING_JOBS', jobs });
      } catch {
        /* tab or content script unavailable */
      }
    },
    [processingJobs]
  );

  const sendRateLimitedToTab = useCallback(async (jobIds: string[], tabId?: number) => {
    const tab =
      tabId != null
        ? await chrome.tabs.get(tabId).catch(() => null)
        : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !isLinkedInJobPage(tab.url)) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'SET_RATE_LIMITED_JOBS', jobIds });
    } catch {
      /* tab or content script unavailable */
    }
  }, []);

  useEffect(() => {
    sendEvaluatingJobsToTab();
  }, [processingJobs, sendEvaluatingJobsToTab]);

  const refreshCachedScoresOnPage = useCallback(async (tabId?: number, tabUrl?: string) => {
    const tab = tabId != null
      ? await chrome.tabs.get(tabId).catch(() => null)
      : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!tab?.id || !isJobListPage(tabUrl ?? tab.url)) return;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }).catch(() => {});
      const listResp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_LEFT_PANE_JOBS' });
      if (!listResp?.ok || !Array.isArray(listResp.jobs) || listResp.jobs.length === 0) return;
      const scores: Record<string, number> = {};
      for (const j of listResp.jobs) {
        const cached = await getJobEvaluation(j.id);
        if (cached != null) scores[j.id] = cached.score;
      }
      if (Object.keys(scores).length > 0) {
        await chrome.tabs.sendMessage(tab.id, { type: 'SET_JOB_SCORES', scores });
        log(`Refreshed ${Object.keys(scores).length} cached score(s) on list page`);
      }
    } catch {
      // Tab closed, context invalid, or content script unavailable
    }
  }, [log]);

  useEffect(() => {
    refreshCachedScoresOnPage().catch(() => {});
    const onActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      chrome.tabs.get(activeInfo.tabId).then((tab) => {
        refreshCachedScoresOnPage(tab?.id, tab?.url).catch(() => {});
      }).catch(() => {});
    };
    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      const url = changeInfo.url ?? tab.url;
      refreshCachedScoresOnPage(tabId, url).catch(() => {});
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [refreshCachedScoresOnPage]);

  // Background sends EVALUATION_RATE_LIMITED when rate limited (before 10s retry) so we can show "Rate limit/Retry #N"
  useEffect(() => {
    const listener = (msg: { type: string; cacheKey?: string; jobId?: string; retryCount?: number; provider?: string }) => {
      if (msg.type !== 'EVALUATION_RATE_LIMITED' || msg.cacheKey == null) return;
      setProcessingJobs((prev) =>
        prev.map((x) =>
          x.cacheKey === msg.cacheKey
            ? {
                ...x,
                lastError: 'Rate limited.',
                retryCount: msg.retryCount ?? (x.retryCount ?? 0) + 1,
                lastProvider: msg.provider,
              }
            : x
        )
      );
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  // When evaluation runs in background (pending: true), background sends EVALUATION_COMPLETE when done
  useEffect(() => {
    const listener = (
      msg: {
        type: string;
        cacheKey?: string;
        jobId?: string;
        result?: EvaluationResult;
        error?: string;
        raw?: string;
        senderTabId?: number;
        provider?: string;
      }
    ) => {
      if (msg.type !== 'EVALUATION_COMPLETE' || msg.cacheKey == null) return;
      const cacheKey = msg.cacheKey;
      const isRateLimited = typeof msg.error === 'string' && msg.error.toLowerCase().includes('rate limit');
      const id = pendingTimeoutsRef.current.get(cacheKey);
      if (id) clearTimeout(id);
      pendingTimeoutsRef.current.delete(cacheKey);

      if (isRateLimited && msg.jobId) {
        sendRateLimitedToTab([msg.jobId], msg.senderTabId);
      }

      setProcessingJobs((prev) => {
        const j = prev.find((x) => x.cacheKey === cacheKey);
        if (!j) return prev;
        if (isRateLimited) {
          return prev.map((x) =>
            x.cacheKey === cacheKey
              ? {
                  ...x,
                  status: 'rate_limited' as const,
                  score: undefined,
                  retryCount: (x.retryCount ?? 0) + 1,
                  lastError: msg.error,
                  lastProvider: msg.provider,
                }
              : x
          );
        }
        if (msg.error) {
          // Keep job in list as pending; show Retrying then Failed after 2 min (no auto-remove)
          return prev.map((x) =>
            x.cacheKey === cacheKey
              ? {
                  ...x,
                  status: 'pending' as const,
                  score: undefined,
                  retryCount: (x.retryCount ?? 0) + 1,
                  lastError: msg.error,
                  lastProvider: msg.provider,
                }
              : x
          );
        }
        if (msg.result) {
          log(`EVALUATION_COMPLETE: ${msg.result.score}/100 — ${msg.result.verdict}`);
          const next = prev.map((x) =>
            x.cacheKey === cacheKey ? { ...x, status: 'done' as const, score: msg.result!.score } : x
          );
          if (msg.result.score < HIGH_SCORE_KEEP) {
            setTimeout(() => setProcessingJobs((p) => p.filter((x) => x.cacheKey !== cacheKey)), REMOVE_DONE_MS);
          }
          return next;
        }
        return prev;
      });
      setState((s) => {
        if (s.cacheKey !== cacheKey) return s;
        if (msg.error) {
          log('Background eval error: ' + msg.error, 'error');
          return { ...s, loading: false, error: msg.error, result: null };
        }
        if (msg.result) {
          return { ...s, loading: false, result: msg.result, error: null };
        }
        return s;
      });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [log, sendRateLimitedToTab]);

  // When user switches to a LinkedIn job tab or navigates to one, clear "Open a LinkedIn page" error
  useEffect(() => {
    const clearErrorIfLinkedIn = (url: string | undefined) => {
      if (url && isLinkedInJobPage(url)) {
        setState((s) => (s.error === 'Open a LinkedIn job page first.' ? { ...s, error: null } : s));
      }
    };
    const onActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      chrome.tabs.get(activeInfo.tabId).then((tab) => clearErrorIfLinkedIn(tab?.url), () => {});
    };
    const onUpdated = (_tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (changeInfo.url) clearErrorIfLinkedIn(changeInfo.url);
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  const runEvaluation = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    log('Run evaluation');

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isLinkedInJobPage(tab.url)) {
      setState((s) => ({
        ...s,
        loading: false,
        error: 'Open a LinkedIn job page first.',
        result: null,
        jobTitle: null,
        cacheKey: null,
        pendingRerun: null,
      }));
      log('Abort: not on a LinkedIn job page', 'warn');
      return;
    }

    try {
      let scriptInjectError: string | null = null;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content.js'],
        });
      } catch (e) {
        scriptInjectError = (e as Error).message;
      }
      let response: any;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB_DATA' });
      } catch (e) {
        throw e;
      }
      if (!response?.ok || !response.job) {
        setState((s) => ({
          ...s,
          loading: false,
          error: response?.error ?? 'Could not read job details from this page.',
          result: null,
          jobTitle: null,
          cacheKey: null,
          pendingRerun: null,
        }));
        log('GET_JOB_DATA failed: ' + (response?.error ?? 'no job'), 'error');
        return;
      }

      const job = response.job as JobData;
      const cacheKey = getCacheKeyForJob(job, tab.url);
      log(`Job: ${job.id} (cache key: ${cacheKey}) — ${job.title || '(no title)'}`);

      const resumeIds = selectedResumeIds.length > 0 ? selectedResumeIds : undefined;
      const cached = await getJobEvaluation(cacheKey);

      if (cached) {
        const cachedResult: EvaluationResult = cached.result ?? {
          score: cached.score,
          verdict: 'maybe',
          hardRejectionReason: null,
          matchBullets: [],
          riskBullets: [],
          bestResumeLabel: null,
          explanation: 'Cached score (no full result saved).',
        };
        setState((s) => ({
          ...s,
          loading: false,
          result: cachedResult,
          error: null,
          jobTitle: job.title?.trim() || null,
          cacheKey,
          pendingRerun: {
            cacheKey,
            job,
            resumeIds,
          },
        }));
        log(`Using cached result: ${cached.score}/100`);
        return;
      }

      const result = await chrome.runtime.sendMessage({
        type: 'EVALUATE_JOB',
        job,
        resumeIds,
        cacheKey,
        senderTabId: tab.id,
        tabUrl: tab.url,
      });

      if (result?.error) {
        const isRateLimit = typeof result.error === 'string' && result.error.toLowerCase().includes('rate limit');
        if (isRateLimit && job.id) {
          sendRateLimitedToTab([job.id], tab.id);
        }
        setState((s) => ({
          ...s,
          loading: false,
          error: result.error,
          result: null,
          jobTitle: job.title?.trim() || null,
          cacheKey,
          pendingRerun: { cacheKey, job, resumeIds },
        }));
        log('Error: ' + result.error, 'error');
        return;
      }

      if ((result as { pending?: boolean }).pending) {
        setState((s) => ({
          ...s,
          loading: true,
          error: null,
          jobTitle: job.title?.trim() || null,
          cacheKey,
          pendingRerun: { cacheKey, job, resumeIds },
        }));
        setProcessingJobs((prev) => {
          const filtered = prev.filter((j) => j.cacheKey !== cacheKey);
          const entry: ProcessingJob = {
            cacheKey,
            jobId: job.id,
            title: shortenTitle(job.title || job.id),
            status: 'pending',
            startedAt: Date.now(),
          };
          return [entry, ...filtered];
        });
        log('Evaluation queued (pending)');
        return;
      }

      const evalResult = result as EvaluationResult;
      await saveJobEvaluation(cacheKey, evalResult);
      if (isJobListPage(tab.url)) {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: 'SET_JOB_SCORES',
            scores: { [job.id]: evalResult.score },
          });
        } catch {
          /* ignore */
        }
      }

      setState((s) => ({
        ...s,
        loading: false,
        result: evalResult,
        error: null,
        jobTitle: job.title?.trim() || null,
        cacheKey,
        pendingRerun: {
          cacheKey,
          job,
          resumeIds,
        },
      }));
      log(`Score: ${evalResult.score} — ${evalResult.verdict}`);
    } catch (e) {
      const err = e as Error;
      setState((s) => ({
        ...s,
        loading: false,
        error: err.message,
        result: null,
        jobTitle: null,
        cacheKey: null,
        pendingRerun: null,
      }));
      log('Exception: ' + err.message, 'error');
    }
  }, [selectedResumeIds, log, sendRateLimitedToTab, processingJobs]);

  const reRun = useCallback(async () => {
    const { pendingRerun } = state;
    if (!pendingRerun) return;
    setState((s) => ({ ...s, loading: true, error: null }));

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !isLinkedInJobPage(tab.url)) {
      setState((s) => ({ ...s, loading: false, error: 'Open the job page first.' }));
      return;
    }

    const job = pendingRerun.job ?? (await chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB_DATA' }))?.job;
    if (!job) {
      setState((s) => ({ ...s, loading: false, error: 'Could not read job from page.' }));
      return;
    }

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'EVALUATE_JOB',
        job,
        resumeIds: pendingRerun.resumeIds ?? (selectedResumeIds.length > 0 ? selectedResumeIds : undefined),
        cacheKey: pendingRerun.cacheKey,
        senderTabId: tab.id,
        tabUrl: tab.url,
      });

      if (result?.error) {
        setState((s) => ({ ...s, loading: false, error: result.error }));
        return;
      }
      if ((result as { pending?: boolean }).pending) {
        setState((s) => ({ ...s, loading: true }));
        return;
      }
      const evalResult = result as EvaluationResult;
      await saveJobEvaluation(pendingRerun.cacheKey, evalResult);
      setState((s) => ({
        ...s,
        loading: false,
        result: evalResult,
        error: null,
      }));
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
    }
  }, [state.pendingRerun, selectedResumeIds]);

  const markAsBad = useCallback(async (reason?: string) => {
    const { cacheKey } = state;
    if (!cacheKey) return;
    const explanation = reason?.trim() || 'Marked as bad by user.';
    const badResult: EvaluationResult = {
      score: 0,
      verdict: 'not_worth',
      hardRejectionReason: null,
      matchBullets: [],
      riskBullets: [],
      bestResumeLabel: null,
      explanation,
    };
    await saveJobEvaluation(cacheKey, badResult);
    setState((s) => ({
      ...s,
      result: badResult,
      error: null,
    }));
  }, [state.cacheKey]);

  const removeFromProcessingList = useCallback((cacheKey: string) => {
    const id = pendingTimeoutsRef.current.get(cacheKey);
    if (id) clearTimeout(id);
    pendingTimeoutsRef.current.delete(cacheKey);
    setProcessingJobs((prev) => prev.filter((j) => j.cacheKey !== cacheKey));
  }, []);

  const retryJob = useCallback(
    async (cacheKey: string) => {
      const j = processingJobs.find((x) => x.cacheKey === cacheKey);
      if (!j) return;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !isLinkedInJobPage(tab.url)) {
        log('Open the LinkedIn job page to retry.', 'warn');
        return;
      }
      let response: { ok?: boolean; job?: JobData } | undefined;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB_DATA' });
      } catch {
        log('Could not read job from page.', 'error');
        return;
      }
      if (!response?.ok || !response.job || response.job.id !== j.jobId) {
        log('Job on page does not match. Open the job and click Retry.', 'warn');
        return;
      }
      const job = response.job;
      const resumeIds = selectedResumeIds.length > 0 ? selectedResumeIds : undefined;
      setProcessingJobs((prev) =>
        prev.map((x) =>
          x.cacheKey === cacheKey
            ? { ...x, retryCount: 0, lastError: undefined, lastProvider: undefined, startedAt: Date.now() }
            : x
        )
      );
      try {
        await chrome.runtime.sendMessage({
          type: 'EVALUATE_JOB',
          job,
          resumeIds,
          cacheKey,
          senderTabId: tab.id,
          tabUrl: tab.url,
        });
      } catch (e) {
        log('Retry failed: ' + (e as Error).message, 'error');
      }
    },
    [processingJobs, selectedResumeIds, log]
  );

  return {
    resumes,
    ...state,
    runEvaluation,
    reRun,
    markAsBad,
    refetchResumes: () => getAllResumes().then(setResumes),
    processingJobs,
    removeFromProcessingList,
    retryJob,
  };
}
