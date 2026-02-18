import type { JobData } from './types';

const LINKEDIN_JOB_VIEW = /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+/;
const LINKEDIN_JOB_COLLECTIONS = /^https:\/\/www\.linkedin\.com\/jobs\/collections\//;
const LINKEDIN_JOBS_SEARCH = /^https:\/\/www\.linkedin\.com\/jobs\/search\//;

export function isLinkedInJobPage(url: string | undefined): boolean {
  return !!(url && (LINKEDIN_JOB_VIEW.test(url) || LINKEDIN_JOB_COLLECTIONS.test(url) || LINKEDIN_JOBS_SEARCH.test(url)));
}

export function isJobListPage(url: string | undefined): boolean {
  return !!(url && (LINKEDIN_JOBS_SEARCH.test(url) || LINKEDIN_JOB_COLLECTIONS.test(url)));
}

export function getJobIdFromUrl(url: string | undefined): string | null {
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

export function getCacheKeyForJob(job: JobData, tabUrl: string | undefined): string {
  if (isJobListPage(tabUrl)) return job.id;
  return getJobIdFromUrl(tabUrl) ?? job.id;
}
