import {
  getSettings,
  saveSettings,
  getAllResumes,
  addResume,
  deleteResume,
  generateResumeId,
  getJobEvaluation,
  saveJobEvaluation,
} from '../lib/db';
import { PROVIDER_MODELS } from '../lib/llm';
import type { ResumeRecord, EvaluationResult, ApiProvider, JobData } from '../lib/types';

// --- Block chrome-extension://invalid requests (source of thousands of ERR_FAILED) ---
const INVALID_EXTENSION_PREFIX = 'chrome-extension://invalid';
function isInvalidExtensionUrl(url: string): boolean {
  return url.startsWith(INVALID_EXTENSION_PREFIX) || url.includes(INVALID_EXTENSION_PREFIX);
}
function logInvalidRequest(source: string, url: string) {
  console.error(`[job-eval] BLOCKED ${source}: ${url}`, new Error().stack);
}
(function installInvalidUrlGuard() {
  if (typeof window === 'undefined') return;
  const origFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href;
    if (isInvalidExtensionUrl(url)) {
      logInvalidRequest('fetch', url);
      return Promise.reject(new Error(`Blocked invalid extension URL: ${url}`));
    }
    return origFetch.call(this, input as RequestInfo, init);
  };
  const OrigWorker = window.Worker;
  window.Worker = function (this: Worker, scriptURL: string | URL, options?: WorkerOptions) {
    const url = typeof scriptURL === 'string' ? scriptURL : scriptURL.href;
    if (isInvalidExtensionUrl(url)) {
      logInvalidRequest('Worker', url);
      throw new Error(`Blocked invalid extension URL: ${url}`);
    }
    return new OrigWorker(scriptURL, options);
  } as any;
})();

// On load: if extension context is invalid, clear PDF.js workerSrc so no stale
// chrome-extension://invalid URL is ever used (e.g. by LinkedIn's fetch interceptor seeing a request).
(function clearPdfWorkerSrcIfInvalid() {
  try {
    let url = '';
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) url = chrome.runtime.getURL('x');
    if (url.includes('invalid')) {
      import('pdfjs-dist').then((pdfjs) => {
        pdfjs.GlobalWorkerOptions.workerSrc = '';
      }).catch(() => {});
    }
  } catch {
    // ignore
  }
})();

// --- Debug log ---
const MAX_DEBUG_ENTRIES = 200;
const debugEntries: { ts: string; msg: string; level: 'info' | 'warn' | 'error' }[] = [];
const debugLogEl = document.getElementById('debugLog')!;

function debugLog(msg: string, level: 'info' | 'warn' | 'error' = 'info') {
  const ts = new Date().toISOString().slice(11, 23);
  debugEntries.push({ ts, msg, level });
  if (debugEntries.length > MAX_DEBUG_ENTRIES) debugEntries.shift();
  renderDebugLog();
}

function renderDebugLog() {
  debugLogEl.innerHTML = debugEntries
    .map(
      (e) =>
        `<div class="debug-entry ${e.level}"><span class="debug-ts">${e.ts}</span>${escapeHtml(e.msg)}</div>`
    )
    .join('');
  debugLogEl.scrollTop = debugLogEl.scrollHeight;
}

document.getElementById('debugClear')!.addEventListener('click', () => {
  debugEntries.length = 0;
  renderDebugLog();
});

// --- Tab switching (main = resume checkboxes + evaluate; settings / resumes = panels) ---
document.querySelectorAll('.tab-link').forEach((el) => {
  el.addEventListener('click', () => {
    const tab = (el as HTMLElement).dataset.tab!;
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.getElementById(`panel-${tab}`)?.classList.add('active');
    if (tab === 'debug') renderDebugLog();
  });
});

// --- External links: open in new tab (extension popups need this) ---
document.querySelectorAll<HTMLAnchorElement>('.support-link, #helpLink').forEach((el) => {
  if (el?.href) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: el.href });
    });
  }
});

// --- Settings ---
const profileIntentEl = document.getElementById('profileIntent') as HTMLTextAreaElement;
const skillsTechStackEl = document.getElementById('skillsTechStack') as HTMLTextAreaElement;
const negativeFiltersEl = document.getElementById('negativeFilters') as HTMLTextAreaElement;
const apiProviderEl = document.getElementById('apiProvider') as HTMLSelectElement;
const apiKeyWrap = document.getElementById('apiKeyWrap')!;
const apiKeyEl = document.getElementById('apiKey') as HTMLInputElement;
const apiKeyLabelEl = document.getElementById('apiKeyLabel')!;
const modelWrap = document.getElementById('modelWrap')!;
const modelEl = document.getElementById('modelInput') as HTMLInputElement;
const saveSettingsBtn = document.getElementById('saveSettings')!;
let apiKeys: Partial<Record<ApiProvider, string>> = {};
let providerModels: Partial<Record<ApiProvider, string>> = {};

const PROVIDER_LABELS: Record<ApiProvider, string> = {
  ollama: 'Ollama',
  groq: 'Groq',
  google: 'Google',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
};

function showProviderFields() {
  const provider = apiProviderEl.value as ApiProvider;
  const needKey = provider !== 'ollama';
  apiKeyWrap.classList.toggle('hidden', !needKey);
  apiKeyEl.value = apiKeys[provider] ?? '';
  apiKeyLabelEl.textContent = `${PROVIDER_LABELS[provider]} API key`;
  modelEl.placeholder = `e.g. ${PROVIDER_MODELS[provider]}`;
  modelEl.value = providerModels[provider] ?? '';
}

apiProviderEl.addEventListener('change', () => {
  const prevProvider = (apiProviderEl.dataset.currentProvider ?? apiProviderEl.value) as ApiProvider;
  const nextProvider = apiProviderEl.value as ApiProvider;
  if (prevProvider && prevProvider !== nextProvider) {
    const trimmed = modelEl.value.trim();
    if (trimmed) providerModels[prevProvider] = trimmed;
    else delete providerModels[prevProvider];
  }
  apiProviderEl.dataset.currentProvider = nextProvider;
  showProviderFields();
});

saveSettingsBtn.addEventListener('click', async () => {
  const provider = apiProviderEl.value as ApiProvider;
  const trimmedKey = apiKeyEl.value.trim();
  const trimmedModel = modelEl.value.trim();
  const nextApiKeys = { ...apiKeys };
  if (trimmedKey) {
    nextApiKeys[provider] = trimmedKey;
  } else {
    delete nextApiKeys[provider];
  }
  const nextProviderModels = { ...providerModels };
  if (trimmedModel) {
    nextProviderModels[provider] = trimmedModel;
  } else {
    delete nextProviderModels[provider];
  }
  await saveSettings({
    profileIntent: profileIntentEl.value.trim(),
    skillsTechStack: skillsTechStackEl.value.trim(),
    negativeFilters: negativeFiltersEl.value.trim(),
    apiProvider: provider,
    apiKeys: nextApiKeys,
    ollamaModel: nextProviderModels.ollama ?? 'llama3.1:8b',
    providerModels: nextProviderModels,
  });
  apiKeys = nextApiKeys;
  providerModels = nextProviderModels;
  saveSettingsBtn.textContent = 'Saved';
  setTimeout(() => (saveSettingsBtn.textContent = 'Save settings'), 1500);
  const resumeHint = document.getElementById('resumeHint');
  if (resumeHint) {
    resumeHint.textContent =
      'Select resumes to include. If none selected, only your profile intent, skills/tech stack, and negative filters are sent.';
  }
});

async function loadSettings() {
  const s = await getSettings();
  profileIntentEl.value = s.profileIntent;
  skillsTechStackEl.value = s.skillsTechStack;
  negativeFiltersEl.value = s.negativeFilters;
  apiProviderEl.value = s.apiProvider;
  apiProviderEl.dataset.currentProvider = s.apiProvider;
  apiKeys = s.apiKeys ?? {};
  providerModels = s.providerModels ?? {};
  showProviderFields();
  const resumeHint = document.getElementById('resumeHint');
  if (resumeHint) {
    resumeHint.textContent =
      'Select resumes to include. If none selected, only your profile intent, skills/tech stack, and negative filters are sent.';
  }
}

// --- Resumes (panel for add/remove) ---
const resumeListEl = document.getElementById('resumeList')!;
const resumeLabelEl = document.getElementById('resumeLabel') as HTMLInputElement;
const resumeFileEl = document.getElementById('resumeFile') as HTMLInputElement;
const addResumeBtn = document.getElementById('addResume')!;
const resumeErrorEl = document.getElementById('resumeError')!;
const resumeLoadingEl = document.getElementById('resumeLoading')!;
const resumeLoadingTextEl = document.getElementById('resumeLoadingText')!;
const resumeResultsWrap = document.getElementById('resumeResultsWrap')!;
const resumeResultsMetaEl = document.getElementById('resumeResultsMeta')!;
const resumeResultsPreviewEl = document.getElementById('resumeResultsPreview')!;
const resumeSaveBtn = document.getElementById('resumeSaveBtn')!;
let pendingResume: { label: string; text: string } | null = null;

async function renderResumes() {
  const list = await getAllResumes();
  resumeListEl.innerHTML = list
    .map(
      (r) =>
        `<div class="resume-item" data-id="${r.id}">
          <span class="label">${escapeHtml(r.label)}</span>
          <button type="button" class="btn-delete" data-id="${r.id}">Remove</button>
        </div>`
    )
    .join('');
  resumeListEl.querySelectorAll('.btn-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteResume((btn as HTMLElement).dataset.id!);
      renderResumes();
      renderResumeCheckboxes();
    });
  });
}

// --- Main panel: resume checkboxes (which to include; none = all) ---
const resumeCheckboxesEl = document.getElementById('resumeCheckboxes')!;

async function renderResumeCheckboxes() {
  const list = await getAllResumes();
  if (list.length === 0) {
    resumeCheckboxesEl.innerHTML = '<p class="hint">No resumes yet. Add some in Resumes.</p>';
    return;
  }
  // Auto-check: if only one resume use it; if multiple, check the first
  resumeCheckboxesEl.innerHTML = list
    .map(
      (r, i) => {
        const checked = list.length === 1 || i === 0;
        return `<div class="resume-checkbox-item">
          <input type="checkbox" id="resume-${r.id}" value="${escapeHtml(r.id)}" ${checked ? 'checked' : ''} />
          <label for="resume-${r.id}">${escapeHtml(r.label)}</label>
        </div>`;
      }
    )
    .join('');
}

/** Get selected resume IDs; if none selected, return [] (no resumes sent). */
function getSelectedResumeIds(): string[] {
  const checked = resumeCheckboxesEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked');
  const ids = Array.from(checked).map((el) => el.value);
  return ids;
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

async function parsePdfToText(arrayBuffer: ArrayBuffer): Promise<string> {
  // Resolve worker URL only when extension context is valid. When invalid (e.g. after
  // reload), getURL returns chrome-extension://invalid/... and PDF.js would request it.
  let workerUrl = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      workerUrl = chrome.runtime.getURL('pdf.worker.mjs');
    }
  } catch (e) {
    debugLog('parsePdfToText: getURL threw ' + (e as Error).message, 'error');
    workerUrl = '';
  }
  const contextValid = workerUrl.length > 0 && !workerUrl.includes('invalid');
  debugLog(`parsePdfToText: workerUrl=${workerUrl.length > 60 ? workerUrl.slice(0, 60) + '...' : workerUrl} contextValid=${contextValid}`, 'info');
  if (!contextValid) {
    throw new Error(
      'PDF parsing is unavailable (extension context invalid). Close the side panel and reopen it from the toolbar, or use a DOCX resume.'
    );
  }
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  debugLog('parsePdfToText: set workerSrc, calling getDocument', 'info');
  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: arrayBuffer, useSystemFonts: true }).promise;
  } catch (e) {
    debugLog('parsePdfToText: getDocument failed ' + (e as Error).message, 'error');
    throw e;
  }
  const numPages = pdf.numPages;
  const parts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it: { str?: string }) => it.str ?? '').join(' ');
    parts.push(text);
  }
  return parts.join('\n').replace(/\s+/g, ' ').trim();
}

async function parseDocxToText(arrayBuffer: ArrayBuffer): Promise<string> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value.replace(/\s+/g, ' ').trim();
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

addResumeBtn.addEventListener('click', async () => {
  const label = resumeLabelEl.value.trim();
  const file = resumeFileEl.files?.[0];
  resumeErrorEl.classList.add('hidden');
  resumeResultsWrap.classList.add('hidden');
  pendingResume = null;
  if (!label) {
    resumeErrorEl.textContent = 'Enter a label.';
    resumeErrorEl.classList.remove('hidden');
    return;
  }
  if (!file) {
    resumeErrorEl.textContent = 'Choose a PDF or DOCX file.';
    resumeErrorEl.classList.remove('hidden');
    return;
  }
  const ext = file.name.toLowerCase().slice(-4);
  if (ext !== '.pdf' && file.name.toLowerCase().slice(-5) !== '.docx') {
    resumeErrorEl.textContent = 'Only PDF and DOCX are supported.';
    resumeErrorEl.classList.remove('hidden');
    return;
  }
  resumeLoadingTextEl.textContent = ext === '.pdf' ? 'Parsing PDF…' : 'Parsing DOCX…';
  resumeLoadingEl.classList.remove('hidden');
  addResumeBtn.disabled = true;
  try {
    const buf = await file.arrayBuffer();
    const text = ext === '.pdf' ? await parsePdfToText(buf) : await parseDocxToText(buf);
    if (!text || text.length < 50) {
      resumeLoadingEl.classList.add('hidden');
      addResumeBtn.disabled = false;
      resumeErrorEl.textContent = 'Could not extract enough text from the file.';
      resumeErrorEl.classList.remove('hidden');
      return;
    }
    resumeLoadingEl.classList.add('hidden');
    addResumeBtn.disabled = false;
    const chars = text.length;
    const words = wordCount(text);
    const previewLen = 220;
    const preview = text.trim().slice(0, previewLen) + (text.length > previewLen ? '…' : '');
    resumeResultsMetaEl.textContent = `"${label}" — ${chars.toLocaleString()} characters, ~${words.toLocaleString()} words extracted.`;
    resumeResultsPreviewEl.textContent = preview;
    pendingResume = { label, text };
    resumeResultsWrap.classList.remove('hidden');
    resumeSaveBtn.textContent = 'Save CV';
    resumeSaveBtn.disabled = false;
  } catch (e) {
    resumeLoadingEl.classList.add('hidden');
    addResumeBtn.disabled = false;
    resumeErrorEl.textContent = (e as Error).message;
    resumeErrorEl.classList.remove('hidden');
  }
});

resumeSaveBtn.addEventListener('click', async () => {
  if (!pendingResume) return;
  resumeErrorEl.classList.add('hidden');
  try {
    await addResume({
      id: generateResumeId(),
      label: pendingResume.label,
      text: pendingResume.text,
    });
    pendingResume = null;
    resumeLabelEl.value = '';
    resumeFileEl.value = '';
    resumeResultsWrap.classList.add('hidden');
    renderResumes();
    renderResumeCheckboxes();
    resumeSaveBtn.textContent = 'Saved ✓';
    resumeSaveBtn.disabled = true;
    const btn = resumeSaveBtn;
    setTimeout(() => {
      btn.textContent = 'Save CV';
      btn.disabled = false;
    }, 2000);
  } catch (e) {
    resumeErrorEl.textContent = (e as Error).message;
    resumeErrorEl.classList.remove('hidden');
  }
});

// --- Evaluate ---
const evalHint = document.getElementById('evalHint')!;
const resultWrap = document.getElementById('resultWrap')!;
const resultContent = document.getElementById('resultContent')!;
const resultRaw = document.getElementById('resultRaw')!;
const resultRawText = document.getElementById('resultRawText')!;
const loadingWrap = document.getElementById('loadingWrap')!;
const errorWrap = document.getElementById('errorWrap')!;
const errorText = document.getElementById('errorText')!;
const cacheWrap = document.getElementById('cacheWrap')!;
const cacheText = document.getElementById('cacheText')!;
const useCacheBtn = document.getElementById('useCacheBtn')!;
const rerunBtn = document.getElementById('rerunBtn')!;
let pendingJobForRerun: {
  jobId: string;
  job: JobData;
  resumeIds: string[] | undefined;
  cachedScore: number;
} | null = null;

/** Track which job we last showed so we can re-evaluate when user switches job. */
let lastShownJobId: string | null = null;
let lastShownTabId: number | null = null;
let jobCheckTimeoutId: ReturnType<typeof setTimeout> | null = null;
let isEvaluationRunning = false;

const LINKEDIN_JOB_VIEW = /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+/;
const LINKEDIN_JOB_COLLECTIONS = /^https:\/\/www\.linkedin\.com\/jobs\/collections\//;
const LINKEDIN_JOBS_SEARCH = /^https:\/\/www\.linkedin\.com\/jobs\/search\//;
function isLinkedInJobPage(url: string | undefined): boolean {
  return !!(url && (LINKEDIN_JOB_VIEW.test(url) || LINKEDIN_JOB_COLLECTIONS.test(url) || LINKEDIN_JOBS_SEARCH.test(url)));
}

/** True when on job search or collections (left pane with job cards). */
function isJobListPage(url: string | undefined): boolean {
  return !!(url && (LINKEDIN_JOBS_SEARCH.test(url) || LINKEDIN_JOB_COLLECTIONS.test(url)));
}

/** Extract job ID from LinkedIn job page URL (currentJobId param or /jobs/view/<id>). */
function getJobIdFromUrl(url: string | undefined): string | null {
  if (!url || !isLinkedInJobPage(url)) return null;
  try {
    const u = new URL(url);
    const viewMatch = u.pathname.match(/\/jobs\/view\/(\d+)/);
    if (viewMatch) return viewMatch[1];
    const currentJobId = u.searchParams.get('currentJobId');
    if (currentJobId && /^\d+$/.test(currentJobId)) return currentJobId;
  } catch {
    // ignore
  }
  return null;
}

/** Canonical cache key: on list pages use job.id (one key per job); on single-job view use URL id. */
function getCacheKeyForJob(job: JobData, tabUrl: string | undefined): string {
  if (isJobListPage(tabUrl)) return job.id;
  return getJobIdFromUrl(tabUrl) ?? job.id;
}

const JOB_CHANGE_DELAY_MS = 2200;
const JOB_CHECK_RETRY_DELAY_MS = 1000;
const JOB_CHECK_MAX_RETRIES = 6;

let scheduledJobId: string | null = null;
let scheduledTabId: number | null = null;

/**
 * When job ID changes, schedule a check after delay. Detail pane loads async so we wait and retry.
 */
function scheduleJobCheckIfJobChanged(tabId: number, jobIdOrUrl: string | undefined, fromActiveElement: boolean) {
  const jobId =
    typeof jobIdOrUrl === 'string' && /^\d+$/.test(jobIdOrUrl)
      ? jobIdOrUrl
      : getJobIdFromUrl(jobIdOrUrl);
  if (jobId == null) return;
  if (jobId === lastShownJobId && lastShownTabId === tabId) {
    debugLog('Job check skipped: same job');
    return;
  }
  if (scheduledJobId === jobId && scheduledTabId === tabId && jobCheckTimeoutId != null) {
    return;
  }
  if (jobCheckTimeoutId) clearTimeout(jobCheckTimeoutId);
  scheduledJobId = jobId;
  scheduledTabId = tabId;
  debugLog(
    `Job change scheduled in ${JOB_CHANGE_DELAY_MS}ms (job ${jobId}${fromActiveElement ? ' from active card' : ' from URL'})`
  );
  jobCheckTimeoutId = setTimeout(async () => {
    jobCheckTimeoutId = null;
    const expectedJobId = scheduledJobId;
    scheduledJobId = null;
    scheduledTabId = null;
    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab?.id !== tabId || !isLinkedInJobPage(activeTab?.url)) {
        debugLog('Job check skipped: tab not active or not LinkedIn');
        return;
      }
      const currentUrlJobId = getJobIdFromUrl(activeTab.url);
      if (expectedJobId != null && currentUrlJobId != null && currentUrlJobId !== expectedJobId) {
        debugLog('Job check: user switched job again, skipping');
        return;
      }
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
      } catch {
        // Script may already be injected
      }
      for (let attempt = 0; attempt < JOB_CHECK_MAX_RETRIES; attempt++) {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_JOB_DATA' });
        if (!response?.ok || !response.job) {
          debugLog('Job check: GET_JOB_DATA failed or no job', 'warn');
          return;
        }
        const domJobId = response.job.id;
        if (domJobId !== lastShownJobId || lastShownTabId !== tabId) {
          lastShownJobId = domJobId;
          lastShownTabId = tabId;
          debugLog(`Job changed → ${domJobId} — running evaluation`);
          runEvaluation();
          return;
        }
        if (expectedJobId != null && domJobId !== expectedJobId) {
          debugLog(`Job check: detail pane still old (${domJobId}), retry in ${JOB_CHECK_RETRY_DELAY_MS}ms`);
        } else if (attempt < JOB_CHECK_MAX_RETRIES - 1) {
          debugLog(`Job check: DOM still old job, retry in ${JOB_CHECK_RETRY_DELAY_MS}ms`);
        }
        if (attempt < JOB_CHECK_MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, JOB_CHECK_RETRY_DELAY_MS));
        } else {
          debugLog('Job check: detail pane did not update in time', 'warn');
        }
      }
    } catch (e) {
      debugLog('Job check error: ' + (e as Error).message, 'error');
    }
  }, JOB_CHANGE_DELAY_MS);
}

async function updateEvaluateHint() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onJobPage = isLinkedInJobPage(tab?.url);
  const settings = await getSettings();
  const needKey = settings.apiProvider !== 'ollama';
  const hasKey = !!settings.apiKeys?.[settings.apiProvider]?.trim();
  evalHint.textContent = !onJobPage
    ? 'Open a LinkedIn job page to evaluate.'
    : needKey && !hasKey
      ? 'Set your API key in Settings.'
      : 'Open a LinkedIn job page to evaluate.';
}

async function runEvaluation(): Promise<void> {
  if (isEvaluationRunning) {
    debugLog('Evaluation already in progress, skipping');
    return;
  }
  isEvaluationRunning = true;
  debugLog('Run evaluation');
  resultWrap.classList.add('hidden');
  errorWrap.classList.add('hidden');
  loadingWrap.classList.remove('hidden');
  cacheWrap.classList.add('hidden');
  errorText.textContent = '';
  evalHint.classList.add('hidden');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isLinkedInJobPage(tab.url)) {
    isEvaluationRunning = false;
    debugLog('Abort: not on a LinkedIn job page', 'warn');
    loadingWrap.classList.add('hidden');
    await updateEvaluateHint();
    evalHint.classList.remove('hidden');
    errorText.textContent = 'Open a LinkedIn job page first.';
    errorWrap.classList.remove('hidden');
    return;
  }

  try {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
    } catch {
      // Script may already be injected
    }
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_JOB_DATA' });
    if (!response?.ok || !response.job) {
      isEvaluationRunning = false;
      debugLog('GET_JOB_DATA failed: ' + (response?.error ?? 'no job'), 'error');
      loadingWrap.classList.add('hidden');
      await updateEvaluateHint();
      evalHint.classList.remove('hidden');
      errorText.textContent = response?.error ?? 'Could not read job details from this page.';
      errorWrap.classList.remove('hidden');
      return;
    }
    const job = response.job;
    const cacheKey = getCacheKeyForJob(job, tab.url);
    debugLog(`Job: ${job.id} (cache key: ${cacheKey}) — ${job.title || '(no title)'}`);
    lastShownJobId = job.id;
    lastShownTabId = tab.id;
    const selectedIds = getSelectedResumeIds();
    const cached = await getJobEvaluation(cacheKey);
    if (cached) {
      isEvaluationRunning = false;
      debugLog(`Using cached score: ${cached.score}/100`);
      loadingWrap.classList.add('hidden');
      await updateEvaluateHint();
      evalHint.classList.remove('hidden');
      cacheText.textContent = `Already evaluated. Cached match score: ${cached.score}/100.`;
      cacheWrap.classList.remove('hidden');
      pendingJobForRerun = {
        jobId: cacheKey,
        job,
        resumeIds: selectedIds.length > 0 ? selectedIds : undefined,
        cachedScore: cached.score,
      };
      return;
    }
    const settings = await getSettings();
    debugLog(`Provider: ${settings.apiProvider} (request via background)`);
    const result = await chrome.runtime.sendMessage({
      type: 'EVALUATE_JOB',
      job,
      resumeIds: selectedIds.length > 0 ? selectedIds : undefined,
    });
    isEvaluationRunning = false;
    loadingWrap.classList.add('hidden');
    await updateEvaluateHint();
    evalHint.classList.remove('hidden');
    if (result?.error) {
      debugLog('Error: ' + result.error, 'error');
      errorText.textContent = result.error;
      errorWrap.classList.remove('hidden');
      if (result.raw) {
        resultRaw.classList.remove('hidden');
        resultRawText.textContent = result.raw;
      }
      return;
    }
    debugLog(`Score: ${(result as EvaluationResult).score} — ${(result as EvaluationResult).verdict}`);
    showResult(result as EvaluationResult);
    await saveJobEvaluation(cacheKey, (result as EvaluationResult).score);
    if (isJobListPage(tab.url)) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'SET_JOB_SCORES',
          scores: { [job.id]: (result as EvaluationResult).score },
        });
      } catch {
        /* ignore */
      }
    }
    resultWrap.classList.remove('hidden');
  } catch (e) {
    const err = e as Error;
    isEvaluationRunning = false;
    debugLog('Exception: ' + err.message, 'error');
    loadingWrap.classList.add('hidden');
    await updateEvaluateHint();
    evalHint.classList.remove('hidden');
    errorText.textContent = err.message;
    errorWrap.classList.remove('hidden');
    lastShownJobId = null;
    lastShownTabId = null;
  }
}

useCacheBtn.addEventListener('click', async () => {
  if (!pendingJobForRerun) return;
  const { jobId, cachedScore } = pendingJobForRerun;
  lastShownJobId = jobId;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) lastShownTabId = tab.id;
  resultContent.innerHTML = `
    <div class="result-verdict maybe">ℹ️ Already evaluated</div>
    <div class="result-score">Score: ${cachedScore}/100</div>
    <div class="result-explanation">Cached result for job ID: ${escapeHtml(jobId)}</div>
  `;
  resultWrap.classList.remove('hidden');
  cacheWrap.classList.add('hidden');
  pendingJobForRerun = null;
});

rerunBtn.addEventListener('click', async () => {
  if (!pendingJobForRerun) return;
  cacheWrap.classList.add('hidden');
  loadingWrap.classList.remove('hidden');
  resultWrap.classList.add('hidden');
  errorWrap.classList.add('hidden');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'EVALUATE_JOB',
      job: pendingJobForRerun.job,
      resumeIds: pendingJobForRerun.resumeIds,
    });
    loadingWrap.classList.add('hidden');
    if (result?.error) {
      errorText.textContent = result.error;
      errorWrap.classList.remove('hidden');
      if (result.raw) {
        resultRaw.classList.remove('hidden');
        resultRawText.textContent = result.raw;
      }
      return;
    }
    showResult(result as EvaluationResult);
    await saveJobEvaluation(pendingJobForRerun.jobId, (result as EvaluationResult).score);
    resultWrap.classList.remove('hidden');
  } catch (e) {
    loadingWrap.classList.add('hidden');
    errorText.textContent = (e as Error).message;
    errorWrap.classList.remove('hidden');
  } finally {
    pendingJobForRerun = null;
  }
});

/** Load cached evaluation scores and send them to the content script so badges show for already-evaluated jobs. */
async function refreshCachedScoresOnPage(tabId: number, tabUrl: string | undefined): Promise<void> {
  if (!isJobListPage(tabUrl)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
    const listResp = await chrome.tabs.sendMessage(tabId, { type: 'GET_LEFT_PANE_JOBS' });
    if (!listResp?.ok || !listResp.jobs?.length) return;
    const scores: Record<string, number> = {};
    for (const j of listResp.jobs) {
      const cached = await getJobEvaluation(j.id);
      if (cached != null) scores[j.id] = cached.score;
    }
    if (Object.keys(scores).length > 0) {
      await chrome.tabs.sendMessage(tabId, { type: 'SET_JOB_SCORES', scores });
      debugLog(`Refreshed ${Object.keys(scores).length} cached score(s) on list page`);
    }
  } catch {
    // Tab closed, context invalid, or not a list page
  }
}

function showResult(r: EvaluationResult) {
  const verdictLabels = { worth: 'Worth applying', maybe: 'Maybe', not_worth: 'Not worth applying' };
  const verdictIcons = { worth: '✅', maybe: '⚠️', not_worth: '❌' };
  let html = `
    <div class="result-verdict ${r.verdict}">${verdictIcons[r.verdict]} ${verdictLabels[r.verdict]}</div>
    <div class="result-score">Score: ${r.score}/100</div>
  `;
  if (r.explanation) {
    html += `<div class="result-explanation">${escapeHtml(r.explanation)}</div>`;
  }
  if (r.matchBullets?.length) {
    html += '<p><strong>Matches:</strong></p><ul class="result-bullets">' + r.matchBullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('') + '</ul>';
  }
  if (r.riskBullets?.length) {
    html += '<p><strong>Risks / gaps:</strong></p><ul class="result-bullets">' + r.riskBullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('') + '</ul>';
  }
  if (r.bestResumeLabel) {
    html += `<div class="result-best-resume">Best resume: ${escapeHtml(r.bestResumeLabel)}</div>`;
  }
  if (r.extraInfo && Object.keys(r.extraInfo).length > 0) {
    html += `<details class="result-raw"><summary>Extra info</summary><pre>${escapeHtml(JSON.stringify(r.extraInfo, null, 2))}</pre></details>`;
  }
  resultContent.innerHTML = html;
  resultRaw.classList.add('hidden');
}

// --- Init ---
const versionDisplay = document.getElementById('versionDisplay');
if (versionDisplay) {
  const v = chrome.runtime.getManifest().version;
  versionDisplay.textContent = v ? `v${v}` : '';
}
debugLog('Extension loaded');
(async () => {
  await loadSettings();
  await renderResumes();
  await renderResumeCheckboxes();
  await updateEvaluateHint();
  chrome.storage.session.remove('pendingJobChange').catch(() => {});
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id && isLinkedInJobPage(tab.url)) {
    if (isJobListPage(tab.url)) {
      refreshCachedScoresOnPage(tab.id, tab.url).catch(() => {});
    }
    debugLog('Panel opened on job page — running evaluation');
    runEvaluation();
  }
})();
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await updateEvaluateHint();
  const tab = await chrome.tabs.get(activeInfo.tabId).catch(() => null);
  scheduleJobCheckIfJobChanged(activeInfo.tabId, tab?.url, false);
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await updateEvaluateHint();
  const url = changeInfo.url ?? tab.url;
  scheduleJobCheckIfJobChanged(tabId, url, false);
});
chrome.runtime.onMessage.addListener((msg: { type: string; jobId?: string; url?: string }, sender) => {
  if (msg.type !== 'JOB_PAGE_CHANGED' || !sender.tab?.id) return;
  if (msg.jobId) {
    debugLog('JOB_PAGE_CHANGED: job ' + msg.jobId + ' (from active card)');
    scheduleJobCheckIfJobChanged(sender.tab.id, msg.jobId, true);
    return;
  }
  (async () => {
    const tab = await chrome.tabs.get(sender.tab!.id!).catch(() => null);
    const url = tab?.url ?? msg.url;
    if (url) {
      debugLog('JOB_PAGE_CHANGED: tab URL ' + url);
      scheduleJobCheckIfJobChanged(sender.tab!.id!, url, false);
    }
  })();
});
