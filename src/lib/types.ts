/** Job data read from the current LinkedIn job page (visible DOM only). */
export interface JobData {
  title: string;
  description: string;
  location: string;
}

/** One resume stored locally (parsed text + label). */
export interface ResumeRecord {
  id: string;
  label: string;
  text: string;
  createdAt: number;
}

/** Settings stored in IndexedDB (key-value by key). */
export interface SettingsRecord {
  profileIntent: string;
  skillsTechStack: string;
  negativeFilters: string;
  apiKey: string;
  apiProvider: ApiProvider;
}

export type ApiProvider = 'ollama' | 'openai' | 'anthropic' | 'openrouter' | 'google';

/** Default settings keys and values. */
export const DEFAULT_SETTINGS: Omit<SettingsRecord, 'apiKey'> & { apiKey?: string } = {
  profileIntent: '',
  skillsTechStack: '',
  negativeFilters: '',
  apiKey: '',
  apiProvider: 'ollama',
};

/** Result of the evaluation (from LLM, parsed JSON). */
export interface EvaluationResult {
  score: number;
  verdict: 'worth' | 'maybe' | 'not_worth';
  hardRejectionReason: string | null;
  matchBullets: string[];
  riskBullets: string[];
  bestResumeLabel: string | null;
  explanation: string;
}

/** Raw LLM response shape (before mapping to EvaluationResult). */
export interface EvaluationResultRaw {
  score: number;
  verdict: 'worth' | 'maybe' | 'not_worth';
  hardRejectionReason?: string | null;
  matchBullets?: string[];
  riskBullets?: string[];
  bestResumeLabel?: string | null;
  explanation?: string;
}
