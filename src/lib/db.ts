import type { ResumeRecord, SettingsRecord, ApiProvider } from './types';
import { DEFAULT_SETTINGS } from './types';

const DB_NAME = 'linkedin-job-eval-db';
const DB_VERSION = 2;
const RESUMES_STORE = 'resumes';
const SETTINGS_STORE = 'settings';
const JOB_EVALS_STORE = 'job_evaluations';
const MAX_RESUMES = 5;
const MAX_JOB_EVALS = 1000;

const SETTINGS_KEYS = [
  'profileIntent',
  'skillsTechStack',
  'negativeFilters',
  'apiKey',
  'apiProvider',
  'ollamaModel',
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
  const [profileIntent, skillsTechStack, negativeFilters, apiKey, apiProvider, ollamaModel] = await Promise.all([
    getSetting('profileIntent'),
    getSetting('skillsTechStack'),
    getSetting('negativeFilters'),
    getSetting('apiKey'),
    getSetting('apiProvider'),
    getSetting('ollamaModel'),
  ]);
  return { profileIntent, skillsTechStack, negativeFilters, apiKey, apiProvider, ollamaModel };
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
      index.openCursor().onsuccess = (event) => {
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
    };
    countReq.onerror = () => reject(countReq.error);
  });
}

export async function saveJobEvaluation(jobId: string, score: number): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(JOB_EVALS_STORE, 'readwrite');
    const req = t.objectStore(JOB_EVALS_STORE).put({ jobId, score, evaluatedAt: Date.now() });
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
