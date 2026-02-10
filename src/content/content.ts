/**
 * Reads job title, description, and location from the current LinkedIn job view page.
 * LinkedIn's DOM changes over time; if extraction fails, selectors may need updating.
 */

import type { JobData } from '../lib/types';

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
  const jobId = getJobIdFromDom() ?? getJobIdFromUrl() ?? jsonLd?.id ?? '';

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
chrome.runtime.onMessage.addListener(
  (
    msg: { type: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: { ok: boolean; job?: JobData; error?: string }) => void
  ) => {
    if (msg.type === 'GET_JOB_DATA') {
      // Use retry to handle async-loaded detail panes on collections/search pages
      extractJobDataWithRetry()
        .then((job) => {
          if (job) sendResponse({ ok: true, job });
          else sendResponse({ ok: false, error: 'Could not read job details from this page. Make sure a job is selected.' });
        })
        .catch((e) => {
          sendResponse({ ok: false, error: (e as Error).message });
        });
    }
    return true; // keep channel open for async sendResponse
  }
);
