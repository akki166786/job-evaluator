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

function getJobIdFromUrl(): string | null {
  const match = window.location.href.match(/\/jobs\/view\/(\d+)/);
  return match ? match[1] : null;
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
  // Title: common patterns on job view page
  const titleSelectors = [
    '.job-details-jobs-unified-top-card__job-title',
    'h1.t-24',
    '[data-job-id] h1',
    '.jobs-unified-top-card__job-title',
    'h1',
  ];
  const titleEl = queryOne(titleSelectors);
  const title = getText(titleEl ?? document.querySelector('h1')) || jsonLd?.title || getMetaContent('og:title');

  // Description: main job description body
  const descSelectors = [
    '.jobs-description__content',
    '.jobs-description-content__text',
    '[data-job-id] .jobs-box__html-content',
    '.show-more-less-html',
    '.jobs-box .jobs-box__html-content',
  ];
  const descEl = queryOne(descSelectors) ?? document.querySelector('.jobs-description__content');
  const description =
    getDescriptionText(descEl) ||
    jsonLd?.description ||
    getMetaContent('description');

  // Location: often in top card or sidebar
  const locationSelectors = [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.jobs-unified-top-card__primary-description',
    '.job-details-how-you-match__secondary-description',
    '[data-job-id] span[class*="primary-description"]',
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

// Listen for message from popup / service worker
chrome.runtime.onMessage.addListener(
  (
    msg: { type: string },
    _sender: chrome.runtime.MessageSender,
    sendResponse: (r: { ok: boolean; job?: JobData; error?: string }) => void
  ) => {
    if (msg.type === 'GET_JOB_DATA') {
      try {
        const job = extractJobData();
        if (job) sendResponse({ ok: true, job });
        else sendResponse({ ok: false, error: 'Could not read job details from this page.' });
      } catch (e) {
        sendResponse({ ok: false, error: (e as Error).message });
      }
    }
    return true; // keep channel open for async sendResponse
  }
);
