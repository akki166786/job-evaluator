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
import type { ResumeRecord, EvaluationResult, ApiProvider, JobData } from '../lib/types';

// --- Tab switching (main = resume checkboxes + evaluate; settings / resumes = panels) ---
document.querySelectorAll('.tab-link').forEach((el) => {
  el.addEventListener('click', () => {
    const tab = (el as HTMLElement).dataset.tab!;
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    document.getElementById(`panel-${tab}`)?.classList.add('active');
  });
});

// --- Settings ---
const profileIntentEl = document.getElementById('profileIntent') as HTMLTextAreaElement;
const skillsTechStackEl = document.getElementById('skillsTechStack') as HTMLTextAreaElement;
const negativeFiltersEl = document.getElementById('negativeFilters') as HTMLTextAreaElement;
const apiProviderEl = document.getElementById('apiProvider') as HTMLSelectElement;
const apiKeyWrap = document.getElementById('apiKeyWrap')!;
const apiKeyEl = document.getElementById('apiKey') as HTMLInputElement;
const apiKeyLabelEl = document.getElementById('apiKeyLabel')!;
const ollamaModelWrap = document.getElementById('ollamaModelWrap')!;
const ollamaModelEl = document.getElementById('ollamaModel') as HTMLInputElement;
const saveSettingsBtn = document.getElementById('saveSettings')!;
let apiKeys: Partial<Record<ApiProvider, string>> = {};

const PROVIDER_LABELS: Record<ApiProvider, string> = {
  ollama: 'Ollama',
  groq: 'Groq',
  google: 'Google',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
};

function showApiKeyField() {
  const provider = apiProviderEl.value as ApiProvider;
  const needKey = provider !== 'ollama';
  apiKeyWrap.classList.toggle('hidden', !needKey);
  apiKeyEl.value = apiKeys[provider] ?? '';
  apiKeyLabelEl.textContent = `${PROVIDER_LABELS[provider]} API key`;
  ollamaModelWrap.classList.toggle('hidden', provider !== 'ollama');
}

apiProviderEl.addEventListener('change', showApiKeyField);

saveSettingsBtn.addEventListener('click', async () => {
  const provider = apiProviderEl.value as ApiProvider;
  const trimmedKey = apiKeyEl.value.trim();
  const nextApiKeys = { ...apiKeys };
  if (trimmedKey) {
    nextApiKeys[provider] = trimmedKey;
  } else {
    delete nextApiKeys[provider];
  }
  await saveSettings({
    profileIntent: profileIntentEl.value.trim(),
    skillsTechStack: skillsTechStackEl.value.trim(),
    negativeFilters: negativeFiltersEl.value.trim(),
    apiProvider: provider,
    apiKeys: nextApiKeys,
    ollamaModel: ollamaModelEl.value.trim(),
  });
  apiKeys = nextApiKeys;
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
  apiKeys = s.apiKeys ?? {};
  ollamaModelEl.value = s.ollamaModel || 'llama3.1:8b';
  showApiKeyField();
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
  resumeCheckboxesEl.innerHTML = list
    .map(
      (r) =>
        `<div class="resume-checkbox-item">
          <input type="checkbox" id="resume-${r.id}" value="${escapeHtml(r.id)}" />
          <label for="resume-${r.id}">${escapeHtml(r.label)}</label>
        </div>`
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
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.mjs');
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer, useSystemFonts: true }).promise;
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

addResumeBtn.addEventListener('click', async () => {
  const label = resumeLabelEl.value.trim();
  const file = resumeFileEl.files?.[0];
  resumeErrorEl.classList.add('hidden');
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
  try {
    const buf = await file.arrayBuffer();
    const text = ext === '.pdf' ? await parsePdfToText(buf) : await parseDocxToText(buf);
    if (!text || text.length < 50) {
      resumeErrorEl.textContent = 'Could not extract enough text from the file.';
      resumeErrorEl.classList.remove('hidden');
      return;
    }
    await addResume({
      id: generateResumeId(),
      label,
      text,
    });
    resumeLabelEl.value = '';
    resumeFileEl.value = '';
    renderResumes();
    renderResumeCheckboxes();
  } catch (e) {
    resumeErrorEl.textContent = (e as Error).message;
    resumeErrorEl.classList.remove('hidden');
  }
});

// --- Evaluate ---
const evaluateBtn = document.getElementById('evaluateBtn')!;
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

const LINKEDIN_JOB_VIEW = /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+/;
const LINKEDIN_JOB_COLLECTIONS = /^https:\/\/www\.linkedin\.com\/jobs\/collections\//;
const LINKEDIN_JOBS_SEARCH = /^https:\/\/www\.linkedin\.com\/jobs\/search\//;
function isLinkedInJobPage(url: string | undefined): boolean {
  return !!(url && (LINKEDIN_JOB_VIEW.test(url) || LINKEDIN_JOB_COLLECTIONS.test(url) || LINKEDIN_JOBS_SEARCH.test(url)));
}

async function updateEvaluateButtonState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onJobPage = isLinkedInJobPage(tab?.url);
  const settings = await getSettings();
  const needKey = settings.apiProvider !== 'ollama';
  const hasKey = !!settings.apiKeys?.[settings.apiProvider]?.trim();
  evaluateBtn.disabled = !onJobPage || (needKey && !hasKey);
  evalHint.textContent = !onJobPage
    ? 'Open a LinkedIn job page, then click to evaluate.'
    : needKey && !hasKey
      ? 'Set your API key in Settings.'
      : 'Click to evaluate this job.';
}

evaluateBtn.addEventListener('click', async () => {
  resultWrap.classList.add('hidden');
  errorWrap.classList.add('hidden');
  loadingWrap.classList.remove('hidden');
  cacheWrap.classList.add('hidden');
  errorText.textContent = '';
  evaluateBtn.disabled = true;
  evalHint.classList.add('hidden');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !isLinkedInJobPage(tab.url)) {
    loadingWrap.classList.add('hidden');
    await updateEvaluateButtonState();
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
      loadingWrap.classList.add('hidden');
      await updateEvaluateButtonState();
      evalHint.classList.remove('hidden');
      errorText.textContent = response?.error ?? 'Could not read job details from this page.';
      errorWrap.classList.remove('hidden');
      return;
    }
    const job = response.job;
    const selectedIds = getSelectedResumeIds();
    const cached = await getJobEvaluation(job.id);
    if (cached) {
      loadingWrap.classList.add('hidden');
      evaluateBtn.disabled = false;
      await updateEvaluateButtonState();
      evalHint.classList.remove('hidden');
      cacheText.textContent = `Already evaluated. Cached match score: ${cached.score}/100.`;
      cacheWrap.classList.remove('hidden');
      pendingJobForRerun = {
        jobId: job.id,
        job,
        resumeIds: selectedIds.length > 0 ? selectedIds : undefined,
        cachedScore: cached.score,
      };
      return;
    }
    const result = await chrome.runtime.sendMessage({
      type: 'EVALUATE_JOB',
      job,
      resumeIds: selectedIds.length > 0 ? selectedIds : undefined,
    });
    loadingWrap.classList.add('hidden');
    evaluateBtn.disabled = false;
    await updateEvaluateButtonState();
    evalHint.classList.remove('hidden');
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
    await saveJobEvaluation(job.id, (result as EvaluationResult).score);
    resultWrap.classList.remove('hidden');
  } catch (e) {
    loadingWrap.classList.add('hidden');
    evaluateBtn.disabled = false;
    await updateEvaluateButtonState();
    evalHint.classList.remove('hidden');
    errorText.textContent = (e as Error).message;
    errorWrap.classList.remove('hidden');
  }
});

useCacheBtn.addEventListener('click', () => {
  if (!pendingJobForRerun) return;
  const { jobId, cachedScore } = pendingJobForRerun;
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
loadSettings();
renderResumes();
renderResumeCheckboxes();
updateEvaluateButtonState();
chrome.tabs.onActivated.addListener(updateEvaluateButtonState);
chrome.tabs.onUpdated.addListener(updateEvaluateButtonState);
