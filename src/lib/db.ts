import type { ResumeRecord, SettingsRecord, ApiProvider, EvaluationResult } from './types';
import { DEFAULT_SETTINGS } from './types';

const DB_NAME = 'linkedin-job-eval-db';
const DB_VERSION = 2;
const RESUMES_STORE = 'resumes';
const SETTINGS_STORE = 'settings';
const JOB_EVALS_STORE = 'job_evaluations';
const MAX_RESUMES = 5;
const MAX_JOB_EVALS = 1000;
const VISITED_COMPANIES_SETTINGS_KEY = 'visitedCompanies';
const VISITED_COMPANIES_MAX = 500;
const VISITED_STORAGE_MAX_AGE_DAYS = 7;

const SETTINGS_KEYS = [
  'profileIntent',
  'skillsTechStack',
  'negativeFilters',
  'apiProvider',
  'apiKeys',
  'ollamaModel',
  'providerModels',
] as const;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(RESUMES_STORE)) {
        const r = db.createObjectStore(RESUMES_STORE, { keyPath: 'id' });
        r.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(JOB_EVALS_STORE)) {
        const evals = db.createObjectStore(JOB_EVALS_STORE, { keyPath: 'jobId' });
        evals.createIndex('evaluatedAt', 'evaluatedAt', { unique: false });
      }
    };
  });
}

export async function getAllResumes(): Promise<ResumeRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(RESUMES_STORE, 'readonly');
    const req = t.objectStore(RESUMES_STORE).getAll();
    req.onsuccess = () => {
      db.close();
      resolve((req.result as ResumeRecord[]).sort((a, b) => a.createdAt - b.createdAt));
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function addResume(record: Omit<ResumeRecord, 'createdAt'>): Promise<void> {
  const resumes = await getAllResumes();
  if (resumes.length >= MAX_RESUMES) {
    throw new Error(`Maximum ${MAX_RESUMES} resumes allowed. Remove one first.`);
  }
  const withTime = { ...record, createdAt: Date.now() };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(RESUMES_STORE, 'readwrite');
    const req = t.objectStore(RESUMES_STORE).add(withTime);
    req.onsuccess = () => {
      db.close();
      resolve();
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function deleteResume(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(RESUMES_STORE, 'readwrite');
    const req = t.objectStore(RESUMES_STORE).delete(id);
    req.onsuccess = () => {
      db.close();
      resolve();
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function getSetting<K extends (typeof SETTINGS_KEYS)[number]>(
  key: K
): Promise<SettingsRecord[K]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(SETTINGS_STORE, 'readonly');
    const req = t.objectStore(SETTINGS_STORE).get(key);
    req.onsuccess = () => {
      db.close();
      const row = req.result as { key: string; value: SettingsRecord[K] } | undefined;
      const val = row?.value;
      if (val !== undefined) resolve(val);
      else resolve((DEFAULT_SETTINGS as SettingsRecord)[key]);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function getLegacyApiKey(): Promise<string | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(SETTINGS_STORE, 'readonly');
    const req = t.objectStore(SETTINGS_STORE).get('apiKey');
    req.onsuccess = () => {
      db.close();
      const row = req.result as { key: string; value: string } | undefined;
      resolve(row?.value);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function setSetting<K extends (typeof SETTINGS_KEYS)[number]>(
  key: K,
  value: SettingsRecord[K]
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(SETTINGS_STORE, 'readwrite');
    const req = t.objectStore(SETTINGS_STORE).put({ key, value });
    req.onsuccess = () => {
      db.close();
      resolve();
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

/** Settings store uses key-value; we use a single object in API for convenience. */
export async function getSettings(): Promise<SettingsRecord> {
  const [
    profileIntent,
    skillsTechStack,
    negativeFilters,
    apiProvider,
    apiKeys,
    ollamaModel,
    providerModels,
    legacyApiKey,
  ] = await Promise.all([
    getSetting('profileIntent'),
    getSetting('skillsTechStack'),
    getSetting('negativeFilters'),
    getSetting('apiProvider'),
    getSetting('apiKeys'),
    getSetting('ollamaModel'),
    getSetting('providerModels').catch(() => undefined),
    getLegacyApiKey(),
  ]);
  // Migrate legacy single apiKey (v1) to per-provider apiKeys map (v2)
  const normalizedApiKeys = apiKeys && Object.keys(apiKeys).length > 0 ? apiKeys : {};
  if (legacyApiKey && !normalizedApiKeys[apiProvider]) {
    normalizedApiKeys[apiProvider] = legacyApiKey;
    await saveSettings({ apiKeys: normalizedApiKeys });
  }
  // Normalize providerModels (may be missing in old DB)
  const normalizedProviderModels =
    providerModels && typeof providerModels === 'object' ? { ...providerModels } : {};
  // Migrate ollamaModel into providerModels.ollama so one code path handles all providers
  if (ollamaModel && !normalizedProviderModels.ollama) {
    normalizedProviderModels.ollama = ollamaModel;
  }
  return {
    profileIntent,
    skillsTechStack,
    negativeFilters,
    apiProvider,
    apiKeys: normalizedApiKeys,
    ollamaModel,
    providerModels: normalizedProviderModels,
  };
}

export async function saveSettings(settings: Partial<SettingsRecord>): Promise<void> {
  const keys = SETTINGS_KEYS.filter((k) => settings[k] !== undefined);
  await Promise.all(keys.map((k) => setSetting(k, settings[k]!)));
}

export function generateResumeId(): string {
  return `resume_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export interface JobEvaluationRecord {
  jobId: string;
  score: number;
  evaluatedAt: number;
  /** Full result when available (explanation, bullets, verdict); older cache may have only score. */
  result?: EvaluationResult;
}

export async function getJobEvaluation(jobId: string): Promise<JobEvaluationRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(JOB_EVALS_STORE, 'readonly');
    const req = t.objectStore(JOB_EVALS_STORE).get(jobId);
    req.onsuccess = () => {
      db.close();
      resolve((req.result as JobEvaluationRecord) ?? null);
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export interface JobEvaluationStats {
  total: number;
  strongMatches: number;
}

export async function getJobEvaluationStats(): Promise<JobEvaluationStats> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(JOB_EVALS_STORE, 'readonly');
    const req = t.objectStore(JOB_EVALS_STORE).getAll();
    req.onsuccess = () => {
      db.close();
      const records = (req.result as JobEvaluationRecord[]) ?? [];
      const total = records.length;
      const strongMatches = records.filter((r) => r.result?.verdict === 'worth').length;
      resolve({ total, strongMatches });
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function trimJobEvaluations(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(JOB_EVALS_STORE, 'readwrite');
    const store = t.objectStore(JOB_EVALS_STORE);
    const index = store.index('evaluatedAt');
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count <= MAX_JOB_EVALS) {
        resolve();
        return;
      }
      const toDelete = count - MAX_JOB_EVALS;
      let deleted = 0;
      const cursorReq = index.openCursor();
      cursorReq.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor) {
          resolve();
          return;
        }
        store.delete(cursor.primaryKey);
        deleted++;
        if (deleted >= toDelete) {
          resolve();
          return;
        }
        cursor.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    };
    countReq.onerror = () => reject(countReq.error);
  });
}

export async function saveJobEvaluation(jobId: string, result: EvaluationResult): Promise<void> {
  const db = await openDB();
  const score = result.score;
  return new Promise((resolve, reject) => {
    const t = db.transaction(JOB_EVALS_STORE, 'readwrite');
    const req = t.objectStore(JOB_EVALS_STORE).put({
      jobId,
      score,
      evaluatedAt: Date.now(),
      result,
    });
    req.onsuccess = async () => {
      try {
        await trimJobEvaluations(db);
      } catch {
        // ignore cleanup errors
      } finally {
        db.close();
        resolve();
      }
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

function normalizeCompany(name: string): string {
  return (name || '').trim();
}

function pruneVisitedCompanies(map: Record<string, number>): Record<string, number> {
  const cutoff = Date.now() - VISITED_STORAGE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const pruned: Record<string, number> = {};
  for (const [k, ts] of Object.entries(map)) {
    if (typeof ts === 'number' && ts >= cutoff) pruned[k] = ts;
  }
  const entries = Object.entries(pruned);
  if (entries.length <= VISITED_COMPANIES_MAX) return pruned;
  const sorted = entries.sort((a, b) => a[1] - b[1]);
  const keep = sorted.slice(entries.length - VISITED_COMPANIES_MAX);
  return Object.fromEntries(keep);
}

async function readVisitedCompanies(): Promise<Record<string, number>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(SETTINGS_STORE, 'readonly');
    const req = t.objectStore(SETTINGS_STORE).get(VISITED_COMPANIES_SETTINGS_KEY);
    req.onsuccess = () => {
      db.close();
      const row = req.result as { key: string; value: Record<string, number> } | undefined;
      const raw = row?.value;
      resolve(raw && typeof raw === 'object' ? raw : {});
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

async function writeVisitedCompanies(map: Record<string, number>): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(SETTINGS_STORE, 'readwrite');
    const req = t.objectStore(SETTINGS_STORE).put({ key: VISITED_COMPANIES_SETTINGS_KEY, value: map });
    req.onsuccess = () => {
      db.close();
      resolve();
    };
    req.onerror = () => {
      db.close();
      reject(req.error);
    };
  });
}

export async function getVisitedCompaniesMap(): Promise<Record<string, number>> {
  const current = await readVisitedCompanies();
  const pruned = pruneVisitedCompanies(current);
  if (Object.keys(pruned).length !== Object.keys(current).length) {
    await writeVisitedCompanies(pruned).catch(() => {});
  }
  return pruned;
}

export async function recordVisitedCompanyVisit(company: string): Promise<void> {
  const key = normalizeCompany(company);
  if (!key) return;
  const current = await readVisitedCompanies();
  current[key] = Date.now();
  const pruned = pruneVisitedCompanies(current);
  await writeVisitedCompanies(pruned);
}
