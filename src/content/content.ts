/**
 * Reads job title, description, and location from the current LinkedIn job page.
 * LinkedIn's DOM changes often; when specific selectors fail, broad heuristic
 * fallbacks scan the page for the largest text block that looks like a job description.
 */

import type { JobData } from '../lib/types';

/* ── helpers ─────────────────────────────────────────────────────────── */

function getText(el: Element | null): string {
  if (!el) return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Return the first element (from a list of selectors) whose textContent is non-empty. */
function queryOne(selectors: string[]): Element | null {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && getText(el).length > 0) return el;
    } catch {
      // invalid selector — skip
    }
  }
  return null;
}

function getMetaContent(name: string): string {
  const el =
    document.querySelector(`meta[name="${name}"]`) ??
    document.querySelector(`meta[property="${name}"]`);
  return el?.getAttribute('content')?.trim() ?? '';
}

/* ── job ID ───────────────────────────────────────────────────────────── */

/**
 * Extract job ID from the URL.
 *   /jobs/view/12345              → 12345
 *   /jobs/collections/...?currentJobId=12345 → 12345
 *   /jobs/search/...?currentJobId=12345      → 12345
 */
function getJobIdFromUrl(): string | null {
  const url = new URL(window.location.href);
  const viewMatch = url.pathname.match(/\/jobs\/view\/(\d+)/);
  if (viewMatch) return viewMatch[1];
  const cid = url.searchParams.get('currentJobId');
  if (cid && /^\d+$/.test(cid)) return cid;
  return null;
}

function getJobIdFromDom(): string | null {
  const el = document.querySelector('[data-job-id], [data-entity-urn]');
  const jobId = el?.getAttribute('data-job-id');
  if (jobId) return jobId;
  const urn = el?.getAttribute('data-entity-urn');
  if (!urn) return null;
  const m = urn.match(/:jobPosting:(\d+)/);
  return m ? m[1] : null;
}

/* ── JSON-LD ──────────────────────────────────────────────────────────── */

function parseJsonLdJob(): Partial<JobData> | null {
  const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
  for (const script of scripts) {
    try {
      const json = JSON.parse(script.textContent ?? '');
      const nodes = Array.isArray(json) ? json : [json];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const t = (node as Record<string, unknown>)['@type'];
        if (t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'))) {
          const p = node as Record<string, unknown>;
          const loc = p.jobLocation as Record<string, unknown> | undefined;
          const addr = loc?.address as Record<string, string> | undefined;
          const locationParts = [addr?.addressLocality, addr?.addressRegion, addr?.addressCountry].filter(Boolean);
          return {
            title: ((p.title as string) ?? '').trim(),
            description: ((p.description as string) ?? '').replace(/\s+/g, ' ').trim(),
            location: locationParts.join(', '),
            id: ((p.identifier as Record<string, string>)?.value) ?? '',
          };
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

/* ── heuristic fallback: find the largest text block on the page ───── */

/**
 * Walk the visible DOM and return the element whose textContent is the longest
 * paragraph-like block (>100 chars). This catches job descriptions even when
 * LinkedIn changes class names, as long as the text is in the DOM.
 */
function findLargestTextBlock(minLength = 100): Element | null {
  // Candidate containers — elements that commonly hold the description
  const candidates = document.querySelectorAll(
    'section, article, div[class*="description"], div[class*="details"], div[class*="content"], div[class*="jobs-box"], main'
  );
  let best: Element | null = null;
  let bestLen = minLength;
  candidates.forEach((el) => {
    const t = getText(el);
    // Ignore if it's the entire page body (too broad) or very short
    if (el === document.body || el.tagName === 'HTML') return;
    // Prefer elements that are deeper in the tree (more specific)
    if (t.length > bestLen && t.length < 15_000) {
      // Check this isn't a navigation/header/footer
      const tag = el.tagName.toLowerCase();
      if (tag === 'nav' || tag === 'header' || tag === 'footer') return;
      best = el;
      bestLen = t.length;
    }
  });
  return best;
}

/* ── main extraction ──────────────────────────────────────────────────── */

// Title selectors (ordered most-specific → least-specific)
const TITLE_SELECTORS = [
  '.job-details-jobs-unified-top-card__job-title a',
  '.job-details-jobs-unified-top-card__job-title',
  '.jobs-details-top-card__job-title',
  '.t-24.job-details-jobs-unified-top-card__job-title',
  '.jobs-search__job-details h2.t-24',
  '.jobs-details h2.t-24',
  'h1.t-24',
  'h1.job-title',
  '[data-job-id] h1',
  '.jobs-unified-top-card__job-title',
  '.job-details h1',
  '.jobs-search__job-details h1',
  'h1.top-card-layout__title',
  'h2.top-card-layout__title',
  'h1',
];

// Description selectors
const DESC_SELECTORS = [
  '.jobs-description__content .show-more-less-html__markup',
  '.jobs-description__content',
  '.jobs-description-content__text',
  '#job-details',
  '.jobs-description .show-more-less-html__markup',
  '.show-more-less-html__markup',
  '.jobs-search__job-details .jobs-box__html-content',
  '.jobs-details .jobs-box__html-content',
  'article .show-more-less-html__markup',
  '[data-job-id] .jobs-box__html-content',
  '.jobs-description',
  '.show-more-less-html',
  '.jobs-box .jobs-box__html-content',
  '.description__text',
  '.top-card-layout .description',
];

// Location selectors
const LOCATION_SELECTORS = [
  '.job-details-jobs-unified-top-card__primary-description-container',
  '.job-details-jobs-unified-top-card__bullet',
  '.jobs-unified-top-card__primary-description',
  '.jobs-details-top-card__company-info',
  '.job-details-how-you-match__secondary-description',
  '[data-job-id] span[class*="primary-description"]',
  '.jobs-search__job-details .jobs-unified-top-card__subtitle',
  '.jobs-unified-top-card__bullet',
  '.top-card-layout__second-subline',
  '.topcard__flavor--bullet',
];

export function extractJobData(): JobData | null {
  const jsonLd = parseJsonLdJob();
  const jobId = getJobIdFromDom() ?? getJobIdFromUrl() ?? jsonLd?.id ?? '';
<<<<<<< Updated upstream

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
=======

  // ── Title ──
  const titleEl = queryOne(TITLE_SELECTORS);
  const title =
    getText(titleEl) ||
    jsonLd?.title ||
    getMetaContent('og:title') ||
    document.title.replace(/\s*\|.*$/, '').replace(/\s*[-–].*LinkedIn.*$/i, '').trim();

  // ── Description ──
  const descEl = queryOne(DESC_SELECTORS);
  let description = getText(descEl) || jsonLd?.description || '';

  // Heuristic fallback: if selectors found nothing, scan for the biggest text block
  if (!description || description.length < 50) {
    const fallbackEl = findLargestTextBlock(100);
    if (fallbackEl) {
      const fallbackText = getText(fallbackEl);
      if (fallbackText.length > (description?.length ?? 0)) {
        description = fallbackText;
      }
    }
  }

  // Last resort: try the meta description tag
  if (!description || description.length < 50) {
    description = description || getMetaContent('description') || getMetaContent('og:description');
  }

  // ── Location ──
  const locationEl = queryOne(LOCATION_SELECTORS);
  let location = getText(locationEl) || jsonLd?.location || getMetaContent('og:location') || '';
>>>>>>> Stashed changes
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

<<<<<<< Updated upstream
/**
 * Retry extractJobData with delays — on collections/search pages the job detail
 * pane loads asynchronously, so the DOM may not be ready on the first attempt.
 */
async function extractJobDataWithRetry(maxRetries = 5, delayMs = 600): Promise<JobData | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const job = extractJobData();
    if (job && (job.title !== 'Unknown title' || job.description)) return job;
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  // Final attempt — return whatever we got (may be null)
  return extractJobData();
}

// Listen for message from popup / service worker
=======
/* ── retry with polling ───────────────────────────────────────────────── */

/**
 * Poll extractJobData with delays. LinkedIn loads job detail panes
 * asynchronously on collections/search and even on /jobs/view/ when
 * navigating via saved-jobs links.
 */
async function extractJobDataWithRetry(maxRetries = 8, delayMs = 500): Promise<JobData | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const job = extractJobData();
    if (job && job.description.length > 30) return job;
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  // Return whatever we have, even if thin
  return extractJobData();
}

/* ── message listener ─────────────────────────────────────────────────── */

>>>>>>> Stashed changes
chrome.runtime.onMessage.addListener(
  (
    msg: { type: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: { ok: boolean; job?: JobData; error?: string }) => void
  ) => {
    if (msg.type === 'GET_JOB_DATA') {
<<<<<<< Updated upstream
      // Use retry to handle async-loaded detail panes on collections/search pages
      extractJobDataWithRetry()
        .then((job) => {
          if (job) sendResponse({ ok: true, job });
          else sendResponse({ ok: false, error: 'Could not read job details from this page. Make sure a job is selected.' });
=======
      extractJobDataWithRetry()
        .then((job) => {
          if (job) {
            sendResponse({ ok: true, job });
          } else {
            sendResponse({
              ok: false,
              error:
                'Could not read job details from this page. ' +
                'Make sure a job is selected and the page has finished loading. ' +
                'URL: ' + window.location.href,
            });
          }
>>>>>>> Stashed changes
        })
        .catch((e) => {
          sendResponse({ ok: false, error: (e as Error).message });
        });
    }
    return true;
  }
);
