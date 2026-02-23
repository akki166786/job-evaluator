import { useState, useEffect, useCallback } from 'react';
import { Settings, FileText, Bug, Info } from 'lucide-react';
import { JobIntelligencePanel } from './components/JobIntelligencePanel';
import { SettingsPanel } from './components/SettingsPanel';
import { ResumesPanel } from './components/ResumesPanel';
import { DebugPanel } from './components/DebugPanel';
import { Button } from './components/ui/button';
import { cn } from './lib/utils';
import { getAllResumes } from '@/lib/db';

const MAX_DEBUG_ENTRIES = 200;
type DebugEntry = { ts: string; msg: string; level: 'info' | 'warn' | 'error' };

export type TabId = 'main' | 'settings' | 'resumes' | 'debug';

export default function App() {
  const [tab, setTab] = useState<TabId>('main');
  const [selectedResumeIds, setSelectedResumeIds] = useState<string[]>([]);
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [version, setVersion] = useState('');

  useEffect(() => {
    try {
      const manifest = chrome.runtime.getManifest();
      setVersion(manifest.version ? `v${manifest.version}` : '');
    } catch {
      setVersion('');
    }
  }, []);

  useEffect(() => {
    getAllResumes()
      .then((list) => {
        if (list.length === 0) setSelectedResumeIds([]);
        else if (list.length === 1) setSelectedResumeIds([list[0].id]);
        else
          setSelectedResumeIds((prev) =>
            prev.length === 0 ? [list[0].id] : prev.filter((id) => list.some((r) => r.id === id))
          );
      })
      .catch(() => setSelectedResumeIds([]));
  }, [tab === 'resumes']);
  useEffect(() => {
    getAllResumes()
      .then((list) => {
        if (list.length === 1) setSelectedResumeIds([list[0].id]);
        else if (list.length > 1) setSelectedResumeIds((prev) => (prev.length === 0 ? [list[0].id] : prev));
      })
      .catch(() => {});
  }, []);

  const addDebugLog = useCallback((msg: string, level: 'info' | 'warn' | 'error' = 'info') => {
    const ts = new Date().toISOString().slice(11, 23);
    setDebugEntries((prev) => {
      const next = [...prev, { ts, msg, level }];
      if (next.length > MAX_DEBUG_ENTRIES) return next.slice(-MAX_DEBUG_ENTRIES);
      return next;
    });
  }, []);

  const clearDebugLog = useCallback(() => setDebugEntries([]), []);

  // Listen for debug messages from background (queue / model calls)
  useEffect(() => {
    const listener = (msg: { type?: string; msg?: string; level?: 'info' | 'warn' | 'error' }) => {
      if (msg?.type === 'DEBUG_LOG' && typeof msg.msg === 'string') {
        addDebugLog(msg.msg, msg.level ?? 'info');
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [addDebugLog]);

  return (
    <div className="flex min-h-[400px] flex-col bg-gray-100">
      <header className="flex shrink-0 items-center justify-between border-b border-gray-200 bg-white px-3 py-2">
        <button
          type="button"
          onClick={() => setTab('main')}
          className="text-left text-sm font-semibold text-gray-900 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-gray-300 rounded"
          aria-label="Go to Home"
        >
          AI Job Evaluator {version && <span className="text-gray-500">{version}</span>}
        </button>
        <nav className="flex items-center gap-1">
          <Button
            variant={tab === 'settings' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTab('settings')}
            aria-label="Settings"
          >
            <Settings className="h-4 w-4" />
          </Button>
          <Button
            variant={tab === 'resumes' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTab('resumes')}
            aria-label="Resumes"
          >
            <FileText className="h-4 w-4" />
          </Button>
          <Button
            variant={tab === 'debug' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setTab('debug')}
            aria-label="Debug"
          >
            <Bug className="h-4 w-4" />
          </Button>
          <a
            href="https://github.com/akki166786/job-evaluator/blob/main/README.md"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            aria-label="Setup guide / Help"
            onClick={(e) => {
              e.preventDefault();
              chrome.tabs.create({ url: 'https://github.com/akki166786/job-evaluator/blob/main/README.md' });
            }}
          >
            <Info className="h-4 w-4" />
          </a>
        </nav>
      </header>

      <main className="min-h-0 flex-1 overflow-auto">
        {tab === 'main' && (
          <JobIntelligencePanel
            selectedResumeIds={selectedResumeIds}
            setSelectedResumeIds={setSelectedResumeIds}
            onDebugLog={addDebugLog}
          />
        )}
        {tab === 'settings' && <SettingsPanel onBack={() => setTab('main')} />}
        {tab === 'resumes' && (
          <ResumesPanel
            onBack={() => setTab('main')}
            onResumesChange={() => {
              getAllResumes().then((list) => {
                if (list.length === 1) setSelectedResumeIds([list[0].id]);
                else setSelectedResumeIds((prev) => prev.filter((id) => list.some((r) => r.id === id)));
              });
            }}
          />
        )}
        {tab === 'debug' && (
          <DebugPanel entries={debugEntries} onClear={clearDebugLog} onBack={() => setTab('main')} />
        )}
      </main>

      <footer className="shrink-0 border-t border-gray-200 bg-white px-3 py-2">
        <a
          href="https://buymeacoffee.com/coachakshaytiwari"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 text-xs text-gray-600 hover:text-gray-900"
          onClick={(e) => {
            e.preventDefault();
            chrome.tabs.create({ url: 'https://buymeacoffee.com/coachakshaytiwari' });
          }}
        >
          <span aria-hidden className="text-base font-semibold text-amber-700/90">☕</span>
          <span>Buy me a coffee</span>
        </a>
      </footer>
    </div>
  );
}
