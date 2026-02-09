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

export function extractJobData(): JobData | null {
  // Title: common patterns on job view page
  const titleSelectors = [
    '.job-details-jobs-unified-top-card__job-title',
    'h1.t-24',
    '[data-job-id] h1',
    '.jobs-unified-top-card__job-title',
    'h1',
  ];
  const titleEl = queryOne(titleSelectors);
  const title = getText(titleEl ?? document.querySelector('h1'));

  // Description: main job description body
  const descSelectors = [
    '.jobs-description__content',
    '.jobs-description-content__text',
    '[data-job-id] .jobs-box__html-content',
    '.show-more-less-html',
    '.jobs-box .jobs-box__html-content',
  ];
  const descEl = queryOne(descSelectors) ?? document.querySelector('.jobs-description__content');
  const description = getDescriptionText(descEl);

  // Location: often in top card or sidebar
  const locationSelectors = [
    '.job-details-jobs-unified-top-card__primary-description-container',
    '.jobs-unified-top-card__primary-description',
    '.job-details-how-you-match__secondary-description',
    '[data-job-id] span[class*="primary-description"]',
  ];
  const locationEl = queryOne(locationSelectors);
  let location = getText(locationEl);
  if (!location) {
    const locSpan = document.querySelector('.jobs-unified-top-card__bullet');
    if (locSpan) location = getText(locSpan.parentElement);
  }

  if (!title && !description) return null;
  return {
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
