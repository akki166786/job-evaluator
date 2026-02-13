/** Job data read from the current LinkedIn job page (visible DOM only). */
export interface JobData {
  id: string;
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
  apiProvider: ApiProvider;
  apiKeys: Partial<Record<ApiProvider, string>>;
  ollamaModel: string;
  /** Per-provider model override; when empty for a provider, app uses default model. */
  providerModels?: Partial<Record<ApiProvider, string>>;
}

export type ApiProvider = 'ollama' | 'openai' | 'anthropic' | 'openrouter' | 'google' | 'groq';

/** Default settings keys and values. */
export const DEFAULT_SETTINGS: SettingsRecord = {
  profileIntent: '',
  skillsTechStack: '',
  negativeFilters: '',
  apiProvider: 'ollama',
  apiKeys: {},
  ollamaModel: 'llama3.1:8b',
  providerModels: {},
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
  extraInfo?: Record<string, unknown> | null;
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
  extraInfo?: Record<string, unknown> | null;
}
