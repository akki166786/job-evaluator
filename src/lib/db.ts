import type { ResumeRecord, SettingsRecord, ApiProvider } from './types';
import { DEFAULT_SETTINGS } from './types';

const DB_NAME = 'linkedin-job-eval-db';
const DB_VERSION = 1;
const RESUMES_STORE = 'resumes';
const SETTINGS_STORE = 'settings';
const MAX_RESUMES = 5;

const SETTINGS_KEYS = [
  'profileIntent',
  'skillsTechStack',
  'negativeFilters',
  'apiKey',
  'apiProvider',
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
  const [profileIntent, skillsTechStack, negativeFilters, apiKey, apiProvider] = await Promise.all([
    getSetting('profileIntent'),
    getSetting('skillsTechStack'),
    getSetting('negativeFilters'),
    getSetting('apiKey'),
    getSetting('apiProvider'),
  ]);
  return { profileIntent, skillsTechStack, negativeFilters, apiKey, apiProvider };
}

export async function saveSettings(settings: Partial<SettingsRecord>): Promise<void> {
  const keys = SETTINGS_KEYS.filter((k) => settings[k] !== undefined);
  await Promise.all(keys.map((k) => setSetting(k, settings[k]!)));
}

export function generateResumeId(): string {
  return `resume_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
