/**
 * Reads job title, description, and location from the current LinkedIn job view page.
 * LinkedIn's DOM changes over time; if extraction fails, selectors may need updating.
 */

import type { JobData } from '../lib/types';

// Block and log any request to chrome-extension://invalid (debug: find source of ERR_FAILED)
(function () {
  const invalid = 'chrome-extension://invalid';
  const origFetch = typeof window !== 'undefined' ? window.fetch : null;
  if (origFetch) {
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : (input as URL).href;
      if (url.startsWith(invalid) || url.includes(invalid)) {
        console.error('[job-eval CONTENT] BLOCKED fetch:', url, new Error().stack);
        return Promise.reject(new Error('Blocked invalid extension URL'));
      }
      return origFetch.call(this, input as RequestInfo, init);
    };
  }
  const OrigWorker = typeof window !== 'undefined' ? window.Worker : null;
  if (OrigWorker) {
    (window as any).Worker = function (scriptURL: string | URL, options?: WorkerOptions) {
      const url = typeof scriptURL === 'string' ? scriptURL : scriptURL.href;
      if (url.startsWith(invalid) || url.includes(invalid)) {
        console.error('[job-eval CONTENT] BLOCKED Worker:', url, new Error().stack);
        throw new Error('Blocked invalid extension URL');
      }
      return new OrigWorker(scriptURL, options);
    };
  }
})();

function getText(el: Element | null): string {
  if (!el) return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Try multiple selectors; return first non-empty. */
function queryOne(selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el && getText(el)) return el;
  }
  return null;
}

/** Collect text from a container that may have "Show more" (expand first if needed). */
function getDescriptionText(container: Element | null): string {
  if (!container) return '';
  // LinkedIn often wraps long text in show-more-less-html; use the full container text
  return getText(container);
}

/**
 * Extract job ID from the URL.
 * Supports:
 *   - /jobs/view/12345...         (direct job view)
 *   - /jobs/collections/...?currentJobId=12345  (collections)
 *   - /jobs/search/...?currentJobId=12345       (search results)
 */
function getJobIdFromUrl(): string | null {
  const url = new URL(window.location.href);
  // Direct job view page: /jobs/view/<id>
  const viewMatch = url.pathname.match(/\/jobs\/view\/(\d+)/);
  if (viewMatch) return viewMatch[1];
  // Collections or search: ?currentJobId=<id>
  const currentJobId = url.searchParams.get('currentJobId');
  if (currentJobId && /^\d+$/.test(currentJobId)) return currentJobId;
  return null;
}

function getJobIdFromDom(): string | null {
  const el = document.querySelector('[data-job-id], [data-entity-urn]');
  const jobId = el?.getAttribute('data-job-id');
  if (jobId) return jobId;
  const urn = el?.getAttribute('data-entity-urn');
  if (!urn) return null;
  const urnMatch = urn.match(/:jobPosting:(\d+)/);
  return urnMatch ? urnMatch[1] : null;
}

function getMetaContent(name: string): string {
  const el = document.querySelector(`meta[name="${name}"]`) ?? document.querySelector(`meta[property="${name}"]`);
  return el?.getAttribute('content')?.trim() ?? '';
}

function parseJsonLdJob(): Partial<JobData> | null {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    try {
      const json = JSON.parse(script.textContent ?? '');
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const type = (node as { ['@type']?: string })['@type'];
        if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) {
          const posting = node as {
            title?: string;
            description?: string;
            jobLocation?: { address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string } };
            datePosted?: string;
            identifier?: { value?: string };
          };
          const locationParts = [
            posting.jobLocation?.address?.addressLocality,
            posting.jobLocation?.address?.addressRegion,
            posting.jobLocation?.address?.addressCountry,
          ].filter(Boolean);
          return {
            title: posting.title?.trim() ?? '',
            description: posting.description?.replace(/\s+/g, ' ').trim() ?? '',
            location: locationParts.join(', '),
            id: posting.identifier?.value ?? '',
          };
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function extractJobData(): JobData | null {
  const jsonLd = parseJsonLdJob();
  // Prefer URL job id so cache key is stable (URL is source of truth for which job is open).
  const jobId = getJobIdFromUrl() ?? getJobIdFromDom() ?? jsonLd?.id ?? '';

  // Title selectors — /jobs/view, /jobs/search, /jobs/collections detail pane
  const titleSelectors = [
    '.job-details-jobs-unified-top-card__job-title',       // /jobs/view (2024+ layout)
    '.jobs-search__job-details h2.t-24',                   // /jobs/search detail pane heading
    '.jobs-details h2.t-24',                               // /jobs/collections detail pane heading
    '.jobs-details-top-card__job-title',                   // collections/search top card
    'h1.t-24',                                             // older /jobs/view layout
    '[data-job-id] h1',                                    // generic fallback with data attr
    '.jobs-unified-top-card__job-title',                   // legacy /jobs/view
    '.job-details h1',                                     // generic detail pane
    '.jobs-search__job-details h1',                        // search detail pane h1
    'h1',                                                  // last resort
  ];
  const titleEl = queryOne(titleSelectors);
  const title = getText(titleEl ?? document.querySelector('h1')) || jsonLd?.title || getMetaContent('og:title');

  // Description selectors — /jobs/view main body, search/collections detail pane
  const descSelectors = [
    '.jobs-description__content',                          // /jobs/view primary
    '.jobs-description-content__text',                     // /jobs/view variant
    '.jobs-search__job-details .jobs-box__html-content',   // search detail pane
    '.jobs-details .jobs-box__html-content',               // collections detail pane
    '#job-details',                                        // common detail container ID
    '[data-job-id] .jobs-box__html-content',               // detail pane with data attr
    '.jobs-description',                                   // generic description container
    '.show-more-less-html',                                // expandable description wrapper
    '.jobs-box .jobs-box__html-content',                   // legacy fallback
  ];
  const descEl = queryOne(descSelectors) ?? document.querySelector('.jobs-description__content');
  const description =
    getDescriptionText(descEl) ||
    jsonLd?.description ||
    getMetaContent('description');

  // Location selectors — top card metadata area or sidebar
  const locationSelectors = [
    '.job-details-jobs-unified-top-card__primary-description-container', // /jobs/view (2024+)
    '.jobs-unified-top-card__primary-description',                      // legacy /jobs/view
    '.jobs-details-top-card__company-info',                             // collections top card
    '.job-details-how-you-match__secondary-description',                // match section
    '[data-job-id] span[class*="primary-description"]',                 // generic fallback
    '.jobs-search__job-details .jobs-unified-top-card__subtitle',       // search detail pane
  ];
  const locationEl = queryOne(locationSelectors);
  let location = getText(locationEl) || jsonLd?.location || getMetaContent('og:location');
  if (!location) {
    const locSpan = document.querySelector('.jobs-unified-top-card__bullet');
    if (locSpan) location = getText(locSpan.parentElement);
  }

  if (!title && !description) return null;
  return {
    id: jobId || `${title}-${location}`.trim() || 'unknown',
    title: title || 'Unknown title',
    description: description || '',
    location: location || '',
  };
}

/**
 * Retry extractJobData with delays — on collections/search pages the job detail
 * pane loads asynchronously, so the DOM may not be ready on the first attempt.
 * Uses a delay between retries to avoid hammering the main thread.
 */
async function extractJobDataWithRetry(maxRetries = 5, delayMs = 150): Promise<JobData | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const job = extractJobData();
    if (job && (job.title !== 'Unknown title' || job.description)) return job;
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return extractJobData();
}

// Notify extension when the selected job changes. Use click on job card as primary signal.
function getCurrentUrl(): string {
  try {
    if (typeof window !== 'undefined' && window.top && window.top.location) return window.top.location.href;
  } catch {
    // cross-origin or restricted
  }
  return window.location.href;
}

/** Get job ID from a node (self or ancestor with data-job-id, or from a link href /jobs/view/ID). */
function getJobIdFromNode(node: Node): string | null {
  let el: Element | null = node instanceof Element ? node : node.parentElement;
  while (el) {
    const id = el.getAttribute?.('data-job-id');
    if (id && /^\d+$/.test(id)) return id;
    if (el.tagName === 'A') {
      const href = (el as HTMLAnchorElement).href;
      const m = href?.match(/\/jobs\/view\/(\d+)/);
      if (m) return m[1];
    }
    el = el.parentElement;
  }
  return null;
}

/** Get job ID from the currently active job card in the DOM. */
function getActiveJobIdFromDom(): string | null {
  const selectors = [
    '[data-job-id].jobs-search-results-list__list-item--active',
    '.job-card-container[aria-current="page"]',
    '[data-job-id].job-card-list--active',
    '.jobs-search-results-list__list-item--active [data-job-id]',
    '[data-job-id].jobs-search-two-pane__job-card-container--active',
  ];
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) {
      const id = el.getAttribute('data-job-id') ?? el.querySelector('[data-job-id]')?.getAttribute('data-job-id');
      if (id && /^\d+$/.test(id)) return id;
    }
  }
  return null;
}

function getJobIdFromUrlString(): string | null {
  const u = getCurrentUrl();
  try {
    const url = new URL(u);
    const viewMatch = url.pathname.match(/\/jobs\/view\/(\d+)/);
    if (viewMatch) return viewMatch[1];
    const cj = url.searchParams.get('currentJobId');
    if (cj && /^\d+$/.test(cj)) return cj;
  } catch {
    // ignore
  }
  return null;
}

// --- Batch mode: left pane job list and score widgets ---
const JOB_EVAL_WIDGET_CLASS = 'job-eval-score-badge';
const JOB_EVAL_WIDGET_CONTAINER = 'job-eval-score-container';

/** Left-pane list container selectors (order matters). LinkedIn may change these. */
const LEFT_PANE_LIST_SELECTORS = [
  '.jobs-search-results-list',
  '.jobs-search-two-pane__results-list',
  '.scaffold-layout__list-container',
  '[class*="jobs-search-results"]',
  '[class*="scaffold-layout__list"]',
];

/** Selectors for job cards when no list container is found (cards in the left pane). */
const LEFT_PANE_CARD_SELECTORS = [
  '[data-job-id].job-card-container',
  '[data-job-id][class*="jobs-search-two-pane__job-card-container"]',
  '[data-job-id][class*="job-card-list"]',
];

/** Job card / title selectors within a card. */
const JOB_CARD_TITLE_SELECTORS = [
  '.job-card-list__title',
  '.job-card-list__title--link',
  '.job-card-container__link',
  '[class*="job-card"][class*="title"]',
  'a[href*="/jobs/view/"]',
];

export interface LeftPaneJob {
  id: string;
  title: string;
}

function getLeftPaneJobs(): LeftPaneJob[] {
  let cards: NodeListOf<Element> | Element[] = [];
  let listContainer: Element | null = null;
  for (const sel of LEFT_PANE_LIST_SELECTORS) {
    listContainer = document.querySelector(sel);
    if (listContainer) {
      cards = listContainer.querySelectorAll('[data-job-id]');
      if (cards.length > 0) break;
    }
  }
  // Fallback: LinkedIn may not use a recognizable list container; query list-style cards directly.
  if (cards.length === 0) {
    for (const sel of LEFT_PANE_CARD_SELECTORS) {
      cards = document.querySelectorAll(sel);
      if (cards.length > 0) break;
    }
  }
  const seen = new Set<string>();
  const jobs: LeftPaneJob[] = [];
  cards.forEach((el) => {
    const id = el.getAttribute('data-job-id');
    if (!id || !/^\d+$/.test(id) || seen.has(id)) return;
    seen.add(id);
    let title = '';
    for (const titleSel of JOB_CARD_TITLE_SELECTORS) {
      const t = el.querySelector(titleSel);
      if (t && getText(t)) {
        title = getText(t).slice(0, 80);
        break;
      }
    }
    if (!title) title = getText(el).slice(0, 80) || id;
    jobs.push({ id, title });
  });
  return jobs;
}

function getLeftPaneCardElement(jobId: string): HTMLElement | null {
  for (const sel of LEFT_PANE_LIST_SELECTORS) {
    const list = document.querySelector(sel);
    if (!list) continue;
    const el = list.querySelector<HTMLElement>(`[data-job-id="${jobId}"]`);
    if (el) return el;
  }
  // Fallback: find card by id (same card selectors as getLeftPaneJobs).
  const direct = document.querySelector<HTMLElement>(
    `[data-job-id="${jobId}"].job-card-container, [data-job-id="${jobId}"][class*="jobs-search-two-pane__job-card-container"], [data-job-id="${jobId}"][class*="job-card-list"]`
  );
  return direct;
}

function selectJobById(jobId: string): boolean {
  const el = getLeftPaneCardElement(jobId);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  el.click();
  return true;
}

const JOB_EVAL_CARD_CLASS = 'job-eval-card-anchor';
const JOB_EVAL_EVALUATING_CLASS = 'job-eval-evaluating';
const jobScoreWidgetStyles = `
  .${JOB_EVAL_CARD_CLASS} { position: relative; }
  .${JOB_EVAL_WIDGET_CONTAINER} {
    position: absolute; bottom: 6px; right: 8px;
    display: inline-flex; align-items: center;
  }
  .${JOB_EVAL_WIDGET_CLASS} {
    font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 4px;
    white-space: nowrap;
  }
  .${JOB_EVAL_WIDGET_CLASS}.job-eval-high { background: #0d6832; color: #fff; }
  .${JOB_EVAL_WIDGET_CLASS}.job-eval-mid { background: #b38600; color: #fff; }
  .${JOB_EVAL_WIDGET_CLASS}.job-eval-low { background: #b32d0e; color: #fff; }
  .${JOB_EVAL_WIDGET_CLASS}.${JOB_EVAL_EVALUATING_CLASS} { background: #5c6bc0; color: #fff; }
  .${JOB_EVAL_WIDGET_CLASS}.${JOB_EVAL_EVALUATING_CLASS} {
    animation: job-eval-pulse 1.2s ease-in-out infinite;
  }
  @keyframes job-eval-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;

let injectedStyles = false;
function ensureScoreWidgetStyles() {
  if (injectedStyles) return;
  const style = document.createElement('style');
  style.textContent = jobScoreWidgetStyles;
  style.id = 'job-eval-extension-styles';
  (document.head || document.documentElement).appendChild(style);
  injectedStyles = true;
}

const jobScores = new Map<string, number>();
const evaluatingJobIds = new Set<string>();

function scoreClass(score: number): string {
  if (score >= 75) return 'job-eval-high';
  if (score >= 50) return 'job-eval-mid';
  return 'job-eval-low';
}

let applyBadgesScheduled = false;
function applyBadges() {
  if (applyBadgesScheduled) return;
  applyBadgesScheduled = true;
  requestAnimationFrame(() => {
    applyBadgesScheduled = false;
    applyBadgesImmediate();
  });
}

function applyBadgesImmediate() {
  ensureScoreWidgetStyles();
  const allIds = new Set([...jobScores.keys(), ...evaluatingJobIds]);
  allIds.forEach((jobId) => {
    const card = getLeftPaneCardElement(jobId);
    if (!card) return;
    card.classList.add(JOB_EVAL_CARD_CLASS);
    let container = card.querySelector(`.${JOB_EVAL_WIDGET_CONTAINER}`);
    if (!container) {
      container = document.createElement('span');
      container.className = JOB_EVAL_WIDGET_CONTAINER;
      card.appendChild(container);
    }
    let badge = container.querySelector(`.${JOB_EVAL_WIDGET_CLASS}`);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = JOB_EVAL_WIDGET_CLASS;
      container.appendChild(badge);
    }
    const score = jobScores.get(jobId);
    if (score != null) {
      const rounded = Math.round(score);
      badge.textContent = `Score: ${rounded}/100`;
      badge.className = `${JOB_EVAL_WIDGET_CLASS} ${scoreClass(score)}`;
    } else if (evaluatingJobIds.has(jobId)) {
      badge.textContent = 'Evaluating…';
      badge.className = `${JOB_EVAL_WIDGET_CLASS} ${JOB_EVAL_EVALUATING_CLASS}`;
    }
  });
}

function setJobScores(scores: Record<string, number>) {
  Object.entries(scores).forEach(([id, score]) => {
    jobScores.set(id, score);
    evaluatingJobIds.delete(id);
  });
  applyBadges();
}

function setEvaluatingJobs(jobIds: string[]) {
  evaluatingJobIds.clear();
  jobIds.forEach((id) => evaluatingJobIds.add(id));
  applyBadges();
}

const NOTIFY_THROTTLE_MS = 400;
let lastNotifyTime = 0;
let contextInvalidated = false;

/** Returns false if extension context is invalid (e.g. after reload). Avoids throwing. */
function isExtensionContextValid(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function notifyJobChanged(jobId: string) {
  try {
    if (contextInvalidated) return;
    if (!isExtensionContextValid()) {
      contextInvalidated = true;
      cleanupAfterInvalidation();
      return;
    }
    const now = Date.now();
    if (jobId === lastNotifiedJobId && now - lastNotifyTime < NOTIFY_THROTTLE_MS) return;
    lastNotifiedJobId = jobId;
    lastNotifyTime = now;
    const url = getCurrentUrl();
    const payload = { type: 'JOB_PAGE_CHANGED' as const, jobId, url };
    // Defer sendMessage to next tick so any "context invalidated" throw is caught in this frame
    setTimeout(() => {
      try {
        if (contextInvalidated) return;
        chrome.runtime.sendMessage(payload, () => {});
      } catch {
        contextInvalidated = true;
        cleanupAfterInvalidation();
      }
    }, 0);
  } catch {
    contextInvalidated = true;
    cleanupAfterInvalidation();
  }
}

function cleanupAfterInvalidation() {
  document.removeEventListener('click', onJobListClick, true);
  if (jobPollIntervalId !== null) {
    clearInterval(jobPollIntervalId);
    jobPollIntervalId = null;
  }
}

let lastNotifiedJobId: string | null = getActiveJobIdFromDom() ?? getJobIdFromUrlString();
const JOB_POLL_MS = 600;
let jobPollIntervalId: ReturnType<typeof setInterval> | null = null;

function isJobListPage(): boolean {
  const u = getCurrentUrl();
  return u.includes('/jobs/view/') || u.includes('/jobs/search') || u.includes('/jobs/collections');
}

function onJobListClick(e: Event) {
  try {
    if (contextInvalidated || !isJobListPage()) return;
    const jobId = getJobIdFromNode(e.target as Node);
    if (jobId != null && jobId !== lastNotifiedJobId) {
      notifyJobChanged(jobId);
    }
  } catch {
    contextInvalidated = true;
    cleanupAfterInvalidation();
  }
}

/** Request cached scores from background and apply them so tags show on page load/reload. */
function refreshScoresOnLoad() {
  try {
    if (contextInvalidated || !isJobListPage() || !isExtensionContextValid()) return;
    const jobs = getLeftPaneJobs();
    if (jobs.length === 0) return;
    const jobIds = jobs.map((j) => j.id);
    chrome.runtime.sendMessage(
      { type: 'GET_CACHED_SCORES_FOR_JOBS', jobIds },
      (response: { scores?: Record<string, number> }) => {
        try {
          if (contextInvalidated) return;
          if (response?.scores && Object.keys(response.scores).length > 0) {
            setJobScores(response.scores);
          }
        } catch {
          contextInvalidated = true;
          cleanupAfterInvalidation();
        }
      }
    );
  } catch {
    contextInvalidated = true;
    cleanupAfterInvalidation();
  }
}

// Only register in top frame so we don't run N copies (main + iframes) that all throw when context invalidates
const isTopFrame = typeof window !== 'undefined' && window === window.top;
if (isTopFrame && isExtensionContextValid()) {
  // Show cached score tags on page load/reload (job list may render after a delay)
  refreshScoresOnLoad();
  const LOAD_DELAYS_MS = [300, 1000];
  LOAD_DELAYS_MS.forEach((delay) => {
    setTimeout(refreshScoresOnLoad, delay);
  });
  document.addEventListener('click', onJobListClick, true);
  jobPollIntervalId = setInterval(() => {
    try {
      if (contextInvalidated || !isJobListPage()) return;
      if (!isExtensionContextValid()) {
        contextInvalidated = true;
        cleanupAfterInvalidation();
        return;
      }
      const activeJobId = getActiveJobIdFromDom();
      const urlJobId = getJobIdFromUrlString();
      const jobId = activeJobId ?? urlJobId;
      if (jobId != null && jobId !== lastNotifiedJobId) {
        notifyJobChanged(jobId);
      }
    } catch {
      contextInvalidated = true;
      cleanupAfterInvalidation();
    }
  }, JOB_POLL_MS);

  chrome.runtime.onMessage.addListener(
    (
      msg: { type: string; jobId?: string; scores?: Record<string, number>; jobIds?: string[] },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (r: { ok: boolean; job?: JobData; jobs?: LeftPaneJob[]; error?: string }) => void
    ) => {
      try {
        if (contextInvalidated || !isExtensionContextValid()) {
          contextInvalidated = true;
          cleanupAfterInvalidation();
          return false;
        }
      } catch {
        contextInvalidated = true;
        cleanupAfterInvalidation();
        return false;
      }
      if (msg.type === 'GET_JOB_DATA') {
        extractJobDataWithRetry()
          .then((job) => {
            if (contextInvalidated) return;
            try {
              if (!isExtensionContextValid()) {
                contextInvalidated = true;
                cleanupAfterInvalidation();
                return;
              }
              if (job) sendResponse({ ok: true, job });
              else sendResponse({ ok: false, error: 'Could not read job details from this page. Make sure a job is selected.' });
            } catch {
              contextInvalidated = true;
              cleanupAfterInvalidation();
            }
          })
          .catch((e) => {
            if (!contextInvalidated) {
              try {
                sendResponse({ ok: false, error: (e as Error).message });
              } catch {
                contextInvalidated = true;
                cleanupAfterInvalidation();
              }
            }
          });
        return true;
      }
      if (msg.type === 'GET_LEFT_PANE_JOBS') {
        try {
          const jobs = getLeftPaneJobs();
          sendResponse({ ok: true, jobs });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        return false;
      }
      if (msg.type === 'SELECT_JOB' && msg.jobId) {
        try {
          const ok = selectJobById(msg.jobId);
          sendResponse({ ok });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        return false;
      }
      if (msg.type === 'SET_JOB_SCORES' && msg.scores) {
        try {
          setJobScores(msg.scores);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        return false;
      }
      if (msg.type === 'SET_EVALUATING_JOBS' && Array.isArray(msg.jobIds)) {
        try {
          setEvaluatingJobs(msg.jobIds);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        return false;
      }
      return false;
    }
  );
} else {
  contextInvalidated = true;
}
