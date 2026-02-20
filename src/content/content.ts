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

/** Text content of container excluding the subtree matching excludeSelector (e.g. our badge). */
function getTextExcluding(container: Element | null, excludeSelector: string): string {
  if (!container) return '';
  const clone = container.cloneNode(true) as Element;
  const exclude = clone.querySelector(excludeSelector);
  if (exclude) exclude.remove();
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
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

/**
 * Heuristic fallback: find the largest visible text block likely containing a job description.
 * This keeps extraction resilient when LinkedIn changes class names.
 */
function findLargestTextBlock(minLength = 100): Element | null {
  const candidates = document.querySelectorAll(
    'section, article, div[class*="description"], div[class*="details"], div[class*="content"], div[class*="jobs-box"], main'
  );
  let best: Element | null = null;
  let bestLen = minLength;
  candidates.forEach((el) => {
    const t = getText(el);
    if (el === document.body || el.tagName === 'HTML') return;
    if (t.length > bestLen && t.length < 15_000) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'nav' || tag === 'header' || tag === 'footer') return;
      best = el;
      bestLen = t.length;
    }
  });
  return best;
}

/**
 * Fallback: find the "About the job" h2 and extract description from its sibling/parent.
 * LinkedIn's 2025+ /jobs/view/ layout uses h2 headings instead of class-based containers.
 */
function extractDescriptionFromAboutSection(): string {
  const headings = document.querySelectorAll('h2');
  for (const h2 of headings) {
    const text = (h2.textContent ?? '').trim().toLowerCase();
    if (text === 'about the job') {
      // Description is usually in the next sibling element or in the parent container after the h2
      let sibling = h2.nextElementSibling;
      while (sibling) {
        const t = getText(sibling);
        if (t.length > 50) return t;
        sibling = sibling.nextElementSibling;
      }
      // Try parent container (h2 might be inside a header within a section)
      const parent = h2.parentElement;
      if (parent) {
        const t = getText(parent);
        if (t.length > 80) return t.replace(/^about the job\s*/i, '').trim();
      }
      // Try grandparent
      const grandparent = parent?.parentElement;
      if (grandparent) {
        const t = getText(grandparent);
        if (t.length > 80) return t.replace(/^about the job\s*/i, '').trim();
      }
    }
  }
  return '';
}

/**
 * Fallback: find the job title from the page when no h1 or known selectors match.
 * On the 2025+ /jobs/view/ layout, the title may be in an a tag inside the top card,
 * or in an h2 that's the first heading near the top of main content.
 */
function extractTitleFallback(): string {
  // Try: link to the same /jobs/view/ page (LinkedIn often wraps the title in a self-link)
  const jobId = getJobIdFromUrl();
  if (jobId) {
    const selfLinks = document.querySelectorAll(`a[href*="/jobs/view/${jobId}"]`);
    for (const link of selfLinks) {
      const t = (link.textContent ?? '').trim();
      if (t.length > 3 && t.length < 200) return t;
    }
  }
  // Try: first non-nav h2 that looks like a title (short, near top of main)
  const skipH2 = ['about the job', 'set alert', 'similar jobs', 'people also viewed', 'use ai', 'notifications', 'top job picks', 'recent job searches', 'put your best foot forward', 'application status', 'people you can reach out'];
  const main = document.querySelector('main');
  if (main) {
    const h2s = main.querySelectorAll('h2');
    for (const h2 of h2s) {
      const t = (h2.textContent ?? '').trim();
      if (t.length > 3 && t.length < 120 && !skipH2.some(s => t.toLowerCase().includes(s))) {
        return t;
      }
    }
  }
  // Try: any element with aria-label or role="heading" that contains the job title
  const headingEls = document.querySelectorAll('[role="heading"]');
  for (const el of headingEls) {
    const t = (el.textContent ?? '').trim();
    if (t.length > 3 && t.length < 200) return t;
  }
  return '';
}

/**
 * Fallback: find company name when class-based selectors fail.
 */
function extractCompanyFallback(): string {
  // Try: any link to /company/ in the main content area
  const main = document.querySelector('main') ?? document.body;
  const companyLinks = main.querySelectorAll('a[href*="/company/"]');
  for (const link of companyLinks) {
    const t = (link.textContent ?? '').trim();
    if (t.length > 1 && t.length < 100) return t;
  }
  return '';
}

/**
 * Fallback: find location info from the page when class-based selectors fail.
 */
function extractLocationFallback(): string {
  // LinkedIn often has a span with location near the company name in the top card
  const main = document.querySelector('main') ?? document.body;
  const spans = main.querySelectorAll('span');
  for (const span of spans) {
    const t = (span.textContent ?? '').trim();
    // Location patterns: "City, State", "City, Country", "Remote"
    if (t.length > 2 && t.length < 100 && /(?:remote|hybrid|on-site|,\s*\w)/i.test(t) && !t.includes('ago') && !t.includes('applicant')) {
      return t;
    }
  }
  return '';
}

export function extractJobData(): JobData | null {
  const jsonLd = parseJsonLdJob();
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
  const title = getText(titleEl ?? document.querySelector('h1'))
    || jsonLd?.title
    || getMetaContent('og:title')
    || document.title.replace(/\s*\|.*$/, '').replace(/\s*[-].*LinkedIn.*$/i, '').trim()
    || extractTitleFallback();

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
    '.jobs-search__job-details .jobs-description-content', // search detail variant
    '.jobs-details .jobs-description-content',             // collections detail variant
    '.scaffold-layout__detail .jobs-box__html-content',    // scaffold layout detail pane
    '.job-view-layout .jobs-description__content',         // new job-view layout
  ];
  const descEl = queryOne(descSelectors) ?? document.querySelector('.jobs-description__content');
  let description =
    getDescriptionText(descEl)
    || jsonLd?.description
    || '';

  // Heuristic fallback: if selectors found little/no text, scan for the biggest text block.
  if (!description || description.length < 50) {
    const fallbackEl = findLargestTextBlock(100);
    if (fallbackEl) {
      const fallbackText = getText(fallbackEl);
      if (fallbackText.length > (description?.length ?? 0)) {
        description = fallbackText;
      }
    }
  }

  // Last resort metadata/fallbacks.
  if (!description || description.length < 50) {
    description =
      description
      || getMetaContent('description')
      || getMetaContent('og:description')
      || extractDescriptionFromAboutSection();
  }

  // Location selectors — top card metadata area or sidebar
  const locationSelectors = [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.jobs-unified-top-card__primary-description',
    '.jobs-details-top-card__company-info',
    '.job-details-how-you-match__secondary-description',
    '[data-job-id] span[class*="primary-description"]',
    '.jobs-search__job-details .jobs-unified-top-card__subtitle',
  ];
  const locationEl = queryOne(locationSelectors);
  let location = getText(locationEl) || jsonLd?.location || getMetaContent('og:location');
  if (!location) {
    const locSpan = document.querySelector('.jobs-unified-top-card__bullet');
    if (locSpan) location = getText(locSpan.parentElement);
  }
  if (!location) location = extractLocationFallback();

  // Company — scoped to job detail pane (right side / main content), not left list
  const companySelectors = [
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-search__job-details .artdeco-entity-lockup__subtitle',
    '.jobs-details .artdeco-entity-lockup__subtitle',
    '.jobs-search__job-details .jobs-unified-top-card__subtitle',
    '.job-details-jobs-unified-top-card a[href*="/company/"]',
    '.jobs-details-top-card__company-info',
    '.jobs-unified-top-card__subtitle',
  ];
  let company = '';
  for (const sel of companySelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const t = getText(el).trim();
      if (t && t.length < 200) {
        company = t;
        break;
      }
    }
  }
  if (!company) {
    const companyLink = document.querySelector('.jobs-unified-top-card__subtitle a[href*="/company/"], .job-details-jobs-unified-top-card a[href*="/company/"]');
    if (companyLink) company = getText(companyLink).trim();
  }
  if (!company) company = extractCompanyFallback();

  // #region agent log
  const _dbg = {
    url: window.location.href,
    jobIdFromUrl: getJobIdFromUrl(),
    jobIdFromDom: getJobIdFromDom(),
    jsonLdId: jsonLd?.id ?? null,
    jsonLdTitle: jsonLd?.title?.slice(0, 80) ?? null,
    jsonLdDescLen: jsonLd?.description?.length ?? 0,
    titleText: (title || '').slice(0, 80),
    descLen: (description || '').length,
    titleElTag: titleEl?.tagName ?? null,
    titleElClass: titleEl?.className?.slice?.(0, 100) ?? null,
    descElTag: descEl?.tagName ?? null,
    descElClass: (descEl as HTMLElement)?.className?.slice?.(0, 100) ?? null,
    h1Count: document.querySelectorAll('h1').length,
    h1Texts: Array.from(document.querySelectorAll('h1')).map(e => (e.textContent ?? '').trim().slice(0, 60)),
    h2Count: document.querySelectorAll('h2').length,
    h2Texts: Array.from(document.querySelectorAll('h2')).slice(0, 5).map(e => (e.textContent ?? '').trim().slice(0, 60)),
    metaOgTitle: getMetaContent('og:title').slice(0, 80),
    metaDesc: getMetaContent('description').slice(0, 80),
    company,
    readyState: document.readyState,
    bodyChildCount: document.body?.children?.length ?? -1,
    totalElements: document.querySelectorAll('*').length,
    bodyTextLen: (document.body?.innerText ?? '').length,
    isTopFrame: typeof window !== 'undefined' && window === window.top,
    articleCount: document.querySelectorAll('article').length,
    mainCount: document.querySelectorAll('main').length,
    sectionCount: document.querySelectorAll('section').length,
    bodyClassList: document.body?.className?.slice(0, 200) ?? '',
    firstClasses: Array.from(document.body?.children ?? []).slice(0, 5).map(e => (e as HTMLElement).className?.slice(0, 80) ?? ''),
  };
  (window as any).__jobEvalDebug = _dbg;
  // #endregion
  if (!title && !description) return null;
  return {
    id: jobId || `${title}-${location}`.trim() || 'unknown',
    title: title || 'Unknown title',
    description: description || '',
    location: location || '',
    ...(company ? { company: company.trim() } : {}),
  };
}

/**
 * Retry extractJobData with delays — LinkedIn is an SPA so the job detail pane
 * loads asynchronously. On /jobs/view/ pages the entire content may take several
 * seconds to render. Uses exponential backoff + a MutationObserver fallback so
 * we don't give up too early.
 */
function isUsableJob(job: JobData | null): boolean {
  if (!job) return false;
  return !!(job.description && job.description.length > 50);
}

async function extractJobDataWithRetry(maxRetries = 12, initialDelayMs = 200): Promise<JobData | null> {
  let lastJob: JobData | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const job = extractJobData();
    if (job) lastJob = job;
    if (isUsableJob(job)) return job;
    if (attempt < maxRetries) {
      const delay = Math.min(initialDelayMs * Math.pow(1.3, attempt), 1500);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Last resort: wait for meaningful DOM content via MutationObserver (up to 8s)
  const observed = await new Promise<JobData | null>((resolve) => {
    const OBSERVER_TIMEOUT_MS = 8000;
    let resolved = false;
    const done = (result: JobData | null) => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(result);
    };
    const observer = new MutationObserver(() => {
      const job = extractJobData();
      if (isUsableJob(job)) done(job);
    });
    observer.observe(document.body || document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
    const timer = setTimeout(() => {
      const final = extractJobData();
      done(isUsableJob(final) ? final : lastJob);
    }, OBSERVER_TIMEOUT_MS);
    const immediate = extractJobData();
    if (isUsableJob(immediate)) done(immediate);
  });
  return observed;
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
  '[data-occludable-job-id].job-card-container',
  '[data-job-id][class*="jobs-search-two-pane__job-card-container"]',
  '[data-occludable-job-id][class*="jobs-search-two-pane__job-card-container"]',
  '[data-job-id][class*="job-card-list"]',
  '[data-occludable-job-id][class*="job-card-list"]',
  'li[class*="jobs-search-results__list-item"]',
  '.scaffold-layout__list-item',
];

/** Job card / title selectors within a card. */
const JOB_CARD_TITLE_SELECTORS = [
  '.job-card-list__title',
  '.job-card-list__title--link',
  '.job-card-container__link',
  '[class*="job-card"][class*="title"]',
  'a[href*="/jobs/view/"]',
];

/** Company name on a job card (under the title). */
const JOB_CARD_COMPANY_SELECTORS = [
  '.artdeco-entity-lockup__subtitle',
  '[class*="job-card"][class*="subtitle"]',
];

export interface LeftPaneJob {
  id: string;
  title: string;
  company: string;
}

function extractJobIdFromElement(el: Element | null): string | null {
  if (!el) return null;
  const selfAttrs = [
    el.getAttribute('data-job-id'),
    el.getAttribute('data-occludable-job-id'),
  ];
  for (const raw of selfAttrs) {
    const id = raw?.trim();
    if (id && /^\d+$/.test(id)) return id;
  }
  const selfUrn = el.getAttribute('data-entity-urn');
  const selfUrnMatch = selfUrn?.match(/:jobPosting:(\d+)/);
  if (selfUrnMatch) return selfUrnMatch[1];

  const nested = el.querySelector('[data-job-id], [data-occludable-job-id], [data-entity-urn]');
  if (nested) {
    const nestedAttrs = [
      nested.getAttribute('data-job-id'),
      nested.getAttribute('data-occludable-job-id'),
    ];
    for (const raw of nestedAttrs) {
      const id = raw?.trim();
      if (id && /^\d+$/.test(id)) return id;
    }
    const nestedUrn = nested.getAttribute('data-entity-urn');
    const nestedUrnMatch = nestedUrn?.match(/:jobPosting:(\d+)/);
    if (nestedUrnMatch) return nestedUrnMatch[1];
  }

  const link = el.matches('a[href*="/jobs/view/"]')
    ? (el as HTMLAnchorElement)
    : el.querySelector<HTMLAnchorElement>('a[href*="/jobs/view/"]');
  const href = link?.href ?? link?.getAttribute('href') ?? '';
  const hrefMatch = href.match(/\/jobs\/view\/(\d+)/);
  if (hrefMatch) return hrefMatch[1];
  return null;
}

function normalizeCardRoot(el: Element): HTMLElement {
  const root = el.closest<HTMLElement>(
    '.job-card-container, [class*="jobs-search-two-pane__job-card-container"], [class*="job-card-list"], li[class*="jobs-search-results__list-item"], .scaffold-layout__list-item'
  );
  return (root ?? el) as HTMLElement;
}

function collectCardCandidatesFromContainer(container: Element): Element[] {
  const explicit = Array.from(
    container.querySelectorAll(
      '[data-job-id], [data-occludable-job-id], [data-entity-urn*="jobPosting"], .job-card-container, [class*="jobs-search-two-pane__job-card-container"], [class*="job-card-list"], li[class*="jobs-search-results__list-item"], .scaffold-layout__list-item'
    )
  );
  const fromLinks: Element[] = [];
  container.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/view/"]').forEach((a) => {
    const root = normalizeCardRoot(a);
    fromLinks.push(root);
  });
  return [...explicit, ...fromLinks];
}

function getLeftPaneJobs(): LeftPaneJob[] {
  let cards: Element[] = [];
  let listContainer: Element | null = null;
  for (const sel of LEFT_PANE_LIST_SELECTORS) {
    listContainer = document.querySelector(sel);
    if (listContainer) {
      cards = collectCardCandidatesFromContainer(listContainer);
      if (cards.length > 0) break;
    }
  }
  // Fallback: LinkedIn may not use a recognizable list container; query list-style cards directly.
  if (cards.length === 0) {
    for (const sel of LEFT_PANE_CARD_SELECTORS) {
      cards = Array.from(document.querySelectorAll(sel));
      if (cards.length > 0) break;
    }
  }
  const seen = new Set<string>();
  const jobs: LeftPaneJob[] = [];
  cards.forEach((candidate) => {
    const el = normalizeCardRoot(candidate);
    const id = extractJobIdFromElement(el);
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
    let company = '';
    for (const subSel of JOB_CARD_COMPANY_SELECTORS) {
      const sub = el.querySelector(subSel);
      if (sub && getText(sub)) {
        company = getTextExcluding(sub, '.job-eval-recently-visited-badge').trim().slice(0, 120);
        break;
      }
    }
    jobs.push({ id, title, company });
  });
  return jobs;
}

function getLeftPaneCardElement(jobId: string): HTMLElement | null {
  for (const sel of LEFT_PANE_LIST_SELECTORS) {
    const list = document.querySelector(sel);
    if (!list) continue;
    const attrMatch = list.querySelector<HTMLElement>(
      `[data-job-id="${jobId}"], [data-occludable-job-id="${jobId}"], [data-entity-urn*="jobPosting:${jobId}"]`
    );
    if (attrMatch) return normalizeCardRoot(attrMatch);
    const link = list.querySelector<HTMLAnchorElement>(`a[href*="/jobs/view/${jobId}"]`);
    if (link) return normalizeCardRoot(link);
  }
  // Fallback: find card by id (same card selectors as getLeftPaneJobs).
  const direct = document.querySelector<HTMLElement>(
    `[data-job-id="${jobId}"], [data-occludable-job-id="${jobId}"], [data-entity-urn*="jobPosting:${jobId}"], a[href*="/jobs/view/${jobId}"]`
  );
  return direct ? normalizeCardRoot(direct) : null;
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
const JOB_EVAL_RATE_LIMITED_CLASS = 'job-eval-rate-limited';
const JOB_EVAL_RECENTLY_VISITED_CLASS = 'job-eval-recently-visited-badge';
/** Set true to log badge apply/observer/schedule to console for flicker debugging. */
const DEBUG_RECENTLY_VISITED = true;
const RECENTLY_VISITED_DAYS = 30;
/** Evict from storage companies older than this (days). */
const VISITED_STORAGE_MAX_AGE_DAYS = 7;

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
    font-variant-numeric: tabular-nums;
  }
  .${JOB_EVAL_WIDGET_CLASS}.${JOB_EVAL_RATE_LIMITED_CLASS} { background: #e67e22; color: #fff; }
  @keyframes job-eval-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .${JOB_EVAL_RECENTLY_VISITED_CLASS} {
    display: inline-flex; align-items: center;
    margin-left: 6px; font-size: 10px; font-weight: 600;
    color: #666; background: #e8e8e8; padding: 1px 6px; border-radius: 4px;
    white-space: nowrap;
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
const rateLimitedJobIds = new Set<string>();
/** jobId -> startedAt (ms) for timer in evaluating badge. */
const evaluatingJobStartedAt = new Map<string, number>();

/** Company name (normalized) -> last visit timestamp. Loaded from storage, updated when we record a visit. */
let visitedCompaniesMap: Record<string, number> = {};

function normalizeCompany(name: string): string {
  return (name || '').trim();
}

function pruneVisitedCompaniesOlderThanWeek(): void {
  const cutoff = Date.now() - VISITED_STORAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  Object.entries(visitedCompaniesMap).forEach(([key, ts]) => {
    if (ts < cutoff) delete visitedCompaniesMap[key];
  });
}

function loadVisitedCompanies(cb?: () => void) {
  try {
    chrome.runtime.sendMessage({ type: 'GET_VISITED_COMPANIES' }, (result: { visitedCompanies?: Record<string, number> }) => {
      try {
        const raw = result?.visitedCompanies;
        visitedCompaniesMap = typeof raw === 'object' && raw !== null ? raw : {};
        pruneVisitedCompaniesOlderThanWeek();
      } catch {
        visitedCompaniesMap = {};
      }
      cb?.();
    });
  } catch {
    visitedCompaniesMap = {};
    cb?.();
  }
}

function recordVisitedCompany(company: string) {
  const key = normalizeCompany(company);
  if (!key) return;
  visitedCompaniesMap[key] = Date.now();
  pruneVisitedCompaniesOlderThanWeek();
  try {
    chrome.runtime.sendMessage({ type: 'RECORD_VISITED_COMPANY', company: key }, () => {});
  } catch {
    // ignore
  }
}

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
  const allIds = new Set([...jobScores.keys(), ...evaluatingJobIds, ...rateLimitedJobIds]);
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
    } else if (rateLimitedJobIds.has(jobId)) {
      badge.textContent = 'Rate limited';
      badge.className = `${JOB_EVAL_WIDGET_CLASS} ${JOB_EVAL_RATE_LIMITED_CLASS}`;
    } else if (evaluatingJobIds.has(jobId)) {
      const startedAt = evaluatingJobStartedAt.get(jobId) ?? Date.now();
      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
      badge.textContent = `Evaluating… ${elapsedSec}s`;
      badge.className = `${JOB_EVAL_WIDGET_CLASS} ${JOB_EVAL_EVALUATING_CLASS}`;
    }
  });
  // Recently-visited badges are applied only by the dedicated interval (and once on load) to avoid flicker from repeated runs
}

function applyRecentlyVisitedBadgesImmediate(reason = 'unknown') {
  ensureScoreWidgetStyles();
  const jobs = getLeftPaneJobs();
  const cutoff = Date.now() - RECENTLY_VISITED_DAYS * 24 * 60 * 60 * 1000;
  let added = 0;
  let removed = 0;
  let skippedNoCard = 0;
  let skippedNoSubtitle = 0;
  let skippedNoCompany = 0;
  jobs.forEach((job) => {
    const card = getLeftPaneCardElement(job.id);
    if (!card) {
      skippedNoCard++;
      return;
    }
    const subtitle = card.querySelector('.artdeco-entity-lockup__subtitle');
    if (!subtitle) {
      skippedNoSubtitle++;
      return;
    }
    let badge = subtitle.querySelector(`.${JOB_EVAL_RECENTLY_VISITED_CLASS}`);
    const key = normalizeCompany(job.company);
    const ts = key ? visitedCompaniesMap[key] : undefined;
    const show = ts != null && ts >= cutoff;
    if (!key) skippedNoCompany++;
    if (show) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = JOB_EVAL_RECENTLY_VISITED_CLASS;
        badge.setAttribute('aria-label', 'Recently visited company');
        badge.textContent = 'Recently visited';
        subtitle.appendChild(badge);
        added++;
      }
    } else if (badge && key) {
      badge.remove();
      removed++;
    }
  });
  if (DEBUG_RECENTLY_VISITED) {
    console.log(
      '[job-eval] recently-visited badges',
      `reason=${reason}`,
      `jobs=${jobs.length}`,
      `added=${added}`,
      `removed=${removed}`,
      `skipped(noCard/noSub/noCompany)=${skippedNoCard}/${skippedNoSubtitle}/${skippedNoCompany}`
    );
  }
}

function setJobScores(scores: Record<string, number>) {
  Object.entries(scores).forEach(([id, score]) => {
    jobScores.set(id, score);
    evaluatingJobIds.delete(id);
    rateLimitedJobIds.delete(id);
  });
  applyBadges();
}

let evaluatingTimerIntervalId: ReturnType<typeof setInterval> | null = null;

function setEvaluatingJobs(jobs: Array<{ jobId: string; startedAt: number }>) {
  evaluatingJobIds.clear();
  evaluatingJobStartedAt.clear();
  jobs.forEach(({ jobId, startedAt }) => {
    evaluatingJobIds.add(jobId);
    evaluatingJobStartedAt.set(jobId, startedAt);
  });
  applyBadges();
  if (evaluatingTimerIntervalId != null) {
    clearInterval(evaluatingTimerIntervalId);
    evaluatingTimerIntervalId = null;
  }
  if (evaluatingJobIds.size > 0) {
    evaluatingTimerIntervalId = setInterval(() => {
      if (evaluatingJobIds.size === 0) {
        if (evaluatingTimerIntervalId != null) clearInterval(evaluatingTimerIntervalId);
        evaluatingTimerIntervalId = null;
        return;
      }
      applyBadges();
    }, 1000);
  }
}

function setRateLimitedJobs(jobIds: string[]) {
  jobIds.forEach((id) => {
    rateLimitedJobIds.add(id);
    evaluatingJobIds.delete(id);
  });
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

function getJobListContainer(): Element | null {
  for (const sel of LEFT_PANE_LIST_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

let recentlyVisitedBadgeDebounceId: ReturnType<typeof setTimeout> | null = null;
const RECENTLY_VISITED_BADGE_DEBOUNCE_MS = 200;
let jobListObserver: MutationObserver | null = null;

function scheduleRecentlyVisitedBadgesOnce(caller = 'observer') {
  if (DEBUG_RECENTLY_VISITED) console.log('[job-eval] scheduleRecentlyVisitedBadgesOnce', { caller });
  if (recentlyVisitedBadgeDebounceId != null) clearTimeout(recentlyVisitedBadgeDebounceId);
  recentlyVisitedBadgeDebounceId = setTimeout(() => {
    recentlyVisitedBadgeDebounceId = null;
    if (contextInvalidated || !isJobListPage()) return;
    applyRecentlyVisitedBadgesImmediate(`debounce(${caller})`);
  }, RECENTLY_VISITED_BADGE_DEBOUNCE_MS);
}

function attachJobListObserver() {
  const list = getJobListContainer();
  if (!list || jobListObserver != null) return;
  if (DEBUG_RECENTLY_VISITED) console.log('[job-eval] attachJobListObserver: attached');
  jobListObserver = new MutationObserver((mutations) => {
    const hasAdditions = mutations.some((m) => m.addedNodes.length > 0);
    if (hasAdditions && DEBUG_RECENTLY_VISITED) {
      const addCount = mutations.reduce((n, m) => n + m.addedNodes.length, 0);
      console.log('[job-eval] observer: mutations', { mutations: mutations.length, addedNodes: addCount });
    }
    if (hasAdditions) scheduleRecentlyVisitedBadgesOnce('observer');
  });
  jobListObserver.observe(list, { childList: true, subtree: true });
}

function cleanupAfterInvalidation() {
  document.removeEventListener('click', onJobListClick, true);
  if (jobPollIntervalId !== null) {
    clearInterval(jobPollIntervalId);
    jobPollIntervalId = null;
  }
  if (recentlyVisitedBadgeDebounceId != null) {
    clearTimeout(recentlyVisitedBadgeDebounceId);
    recentlyVisitedBadgeDebounceId = null;
  }
  if (jobListObserver != null) {
    jobListObserver.disconnect();
    jobListObserver = null;
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

// Badge/polling/observer logic runs ONLY in the top frame to avoid duplicate work
const isTopFrame = typeof window !== 'undefined' && window === window.top;
if (isTopFrame && isExtensionContextValid()) {
  loadVisitedCompanies(() => {
    applyBadges();
    applyRecentlyVisitedBadgesImmediate('load');
    attachJobListObserver();
  });
  refreshScoresOnLoad();
  const LOAD_DELAYS_MS = [300, 1000];
  LOAD_DELAYS_MS.forEach((delay) => {
    setTimeout(() => {
      refreshScoresOnLoad();
      applyBadges();
      attachJobListObserver();
      scheduleRecentlyVisitedBadgesOnce('timeout');
    }, delay);
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
}

// Message listener runs in ALL frames (including iframes) so that on collections/search
// pages where the job detail pane is in an iframe, we can still extract job data.
if (isExtensionContextValid()) {
  chrome.runtime.onMessage.addListener(
    (
      msg: { type: string; jobId?: string; scores?: Record<string, number>; jobIds?: string[] },
      _sender: chrome.runtime.MessageSender,
      sendResponse: (r: { ok: boolean; job?: JobData; jobs?: LeftPaneJob[]; error?: string }) => void
    ) => {
      try {
        if (contextInvalidated || !isExtensionContextValid()) {
          contextInvalidated = true;
          if (isTopFrame) cleanupAfterInvalidation();
          return false;
        }
      } catch {
        contextInvalidated = true;
        if (isTopFrame) cleanupAfterInvalidation();
        return false;
      }
      if (msg.type === 'GET_JOB_DATA') {
        extractJobDataWithRetry()
          .then((job) => {
            if (contextInvalidated) return;
            try {
              if (!isExtensionContextValid()) {
                contextInvalidated = true;
                if (isTopFrame) cleanupAfterInvalidation();
                return;
              }
              // #region agent log
              const _dbgData = (window as any).__jobEvalDebug ?? null;
              // #endregion
              if (job) {
                if (isTopFrame && job.company) recordVisitedCompany(job.company);
                sendResponse({ ok: true, job, _dbg: _dbgData });
              } else {
                sendResponse({ ok: false, error: 'Could not read job details from this page. Make sure a job is selected.', _dbg: _dbgData });
              }
            } catch {
              contextInvalidated = true;
              if (isTopFrame) cleanupAfterInvalidation();
            }
          })
          .catch((e) => {
            if (!contextInvalidated) {
              try {
                sendResponse({ ok: false, error: (e as Error).message });
              } catch {
                contextInvalidated = true;
                if (isTopFrame) cleanupAfterInvalidation();
              }
            }
          });
        return true;
      }
      // Badge/score handlers only make sense in the top frame
      if (!isTopFrame) return false;
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
      if (msg.type === 'SET_EVALUATING_JOBS') {
        try {
          const jobs = Array.isArray(msg.jobs)
            ? msg.jobs
            : (Array.isArray(msg.jobIds) ? msg.jobIds : []).map((jobId: string) => ({ jobId, startedAt: Date.now() }));
          setEvaluatingJobs(jobs);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        return false;
      }
      if (msg.type === 'SET_RATE_LIMITED_JOBS' && Array.isArray(msg.jobIds)) {
        try {
          setRateLimitedJobs(msg.jobIds);
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: (e as Error).message });
        }
        return false;
      }
      return false;
    }
  );
} else if (!isTopFrame) {
  contextInvalidated = true;
}
