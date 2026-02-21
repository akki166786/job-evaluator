import { useState, useEffect } from 'react';
import { Home } from 'lucide-react';
import { Button } from './ui/button';
import { getSettings, saveSettings } from '@/lib/db';
import { PROVIDER_MODELS } from '@/lib/llm';
import type { ApiProvider, SettingsRecord } from '@/lib/types';

const ALL_PROVIDERS: ApiProvider[] = ['ollama', 'groq', 'google', 'openai', 'anthropic', 'openrouter'];

const PROVIDER_LABELS: Record<ApiProvider, string> = {
  ollama: 'Ollama (local)',
  groq: 'Groq',
  google: 'Google (Gemini)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
};

export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const [profileIntent, setProfileIntent] = useState('');
  const [skillsTechStack, setSkillsTechStack] = useState('');
  const [negativeFilters, setNegativeFilters] = useState('');
  const [apiProvider, setApiProvider] = useState<ApiProvider>('ollama');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [apiKeys, setApiKeys] = useState<Partial<Record<ApiProvider, string>>>({});
  const [providerModels, setProviderModels] = useState<Partial<Record<ApiProvider, string>>>({});
  const [activeProviders, setActiveProviders] = useState<ApiProvider[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getSettings().then((s: SettingsRecord) => {
      setProfileIntent(s.profileIntent);
      setSkillsTechStack(s.skillsTechStack);
      setNegativeFilters(s.negativeFilters);
      setApiProvider(s.apiProvider);
      setApiKeys(s.apiKeys ?? {});
      setProviderModels(s.providerModels ?? {});
      setActiveProviders(s.activeProviders ?? []);
      setApiKey(s.apiKeys?.[s.apiProvider] ?? '');
      setModel(s.providerModels?.[s.apiProvider] ?? '');
    });
  }, []);

  useEffect(() => {
    setApiKey(apiKeys[apiProvider] ?? '');
    setModel(providerModels[apiProvider] ?? '');
  }, [apiProvider]);

  const needApiKey = apiProvider !== 'ollama';

  const handleSave = async () => {
    const nextApiKeys = { ...apiKeys };
    if (apiKey.trim()) nextApiKeys[apiProvider] = apiKey.trim();
    else delete nextApiKeys[apiProvider];
    const nextProviderModels = { ...providerModels };
    if (model.trim()) nextProviderModels[apiProvider] = model.trim();
    else delete nextProviderModels[apiProvider];

    await saveSettings({
      profileIntent: profileIntent.trim(),
      skillsTechStack: skillsTechStack.trim(),
      negativeFilters: negativeFilters.trim(),
      apiProvider,
      apiKeys: nextApiKeys,
      ollamaModel: nextProviderModels.ollama ?? 'llama3.1:8b',
      providerModels: nextProviderModels,
      activeProviders: activeProviders.length > 0 ? activeProviders : [],
    });
    setApiKeys(nextApiKeys);
    setProviderModels(nextProviderModels);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="space-y-4 p-4">
      <label className="block text-sm font-medium text-gray-700">Profile & role intent</label>
      <textarea
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        rows={4}
        placeholder="Who you are, what roles you target…"
        value={profileIntent}
        onChange={(e) => setProfileIntent(e.target.value)}
      />

      <label className="block text-sm font-medium text-gray-700">Skills / tech stack</label>
      <textarea
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        rows={3}
        placeholder="e.g. React, Next.js, TypeScript"
        value={skillsTechStack}
        onChange={(e) => setSkillsTechStack(e.target.value)}
      />

      <label className="block text-sm font-medium text-gray-700">Negative filters (deal-breakers)</label>
      <textarea
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        rows={3}
        placeholder="What you are NOT looking for"
        value={negativeFilters}
        onChange={(e) => setNegativeFilters(e.target.value)}
      />

      <label className="block text-sm font-medium text-gray-700">Provider</label>
      <select
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        value={apiProvider}
        onChange={(e) => setApiProvider(e.target.value as ApiProvider)}
      >
        {Object.entries(PROVIDER_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <div>
        <label className="block text-sm font-medium text-gray-700">Model (optional)</label>
        <input
          type="text"
          className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder={`e.g. ${PROVIDER_MODELS[apiProvider]}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>

      {needApiKey && (
        <div>
          <label className="block text-sm font-medium text-gray-700">{PROVIDER_LABELS[apiProvider]} API key</label>
          <input
            type="password"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            placeholder="Your API key"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
      )}

      <hr className="border-gray-200" />

      <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
        <label className="block text-sm font-medium text-gray-700">Active agents (for rotation)</label>
        <p className="mt-0.5 mb-2 text-xs text-gray-500">
          Select providers to rotate between. If none selected, all configured providers are used.
        </p>
        <div className="flex flex-col gap-2">
          {ALL_PROVIDERS.map((provider) => (
            <label key={provider} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={activeProviders.includes(provider)}
                onChange={(e) => {
                  if (e.target.checked) {
                    setActiveProviders((prev) => (prev.includes(provider) ? prev : [...prev, provider]));
                  } else {
                    setActiveProviders((prev) => prev.filter((p) => p !== provider));
                  }
                }}
                className="h-4 w-4 rounded border-gray-300"
              />
              {PROVIDER_LABELS[provider]}
            </label>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <Button onClick={handleSave}>{saved ? 'Saved' : 'Save settings'}</Button>
        <Button variant="outline" size="sm" onClick={onBack}>
          <Home className="mr-1 h-4 w-4" />
          Home
        </Button>
      </div>
    </div>
  );
}
