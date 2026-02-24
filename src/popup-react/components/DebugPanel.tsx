import { useState, useRef, useEffect } from 'react';
import { Home, RefreshCw } from 'lucide-react';
import { Button } from './ui/button';

type DebugEntry = { ts: string; msg: string; level: 'info' | 'warn' | 'error' };

type QueueSnapshot = {
  queueLength: number;
  queueJobIds: string[];
  inFlightPerProvider: Record<string, number>;
  configured: string[];
  activeProviders: string[] | null;
} | null;

export function DebugPanel({
  entries,
  onClear,
  onBack,
}: {
  entries: DebugEntry[];
  onClear: () => void;
  onBack: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [queueSnapshot, setQueueSnapshot] = useState<QueueSnapshot>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);

  const refreshQueue = () => {
    chrome.runtime.sendMessage({ type: 'GET_QUEUE_DEBUG' }, (res: QueueSnapshot) => {
      if (chrome.runtime.lastError) setQueueSnapshot(null);
      else setQueueSnapshot(res ?? null);
    });
  };

  return (
    <div className="flex flex-col p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700">Debug log</span>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={onClear}>
            Clear
          </Button>
          <Button variant="outline" size="sm" onClick={onBack}>
            <Home className="mr-1 h-4 w-4" />
            Home
          </Button>
        </div>
      </div>

      <div className="mb-3 rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-medium text-gray-700">Queue state</span>
          <Button variant="ghost" size="sm" onClick={refreshQueue} className="h-7 px-2">
            <RefreshCw className="mr-1 h-3 w-3" />
            Refresh
          </Button>
        </div>
        {queueSnapshot == null ? (
          <p className="text-gray-500">Click Refresh to load.</p>
        ) : (
          <div className="space-y-0.5 text-gray-800">
            <div>Waiting: {queueSnapshot.queueLength} {queueSnapshot.queueJobIds.length ? `[${queueSnapshot.queueJobIds.join(', ')}]` : ''}</div>
            <div>In-flight: {Object.entries(queueSnapshot.inFlightPerProvider).length ? Object.entries(queueSnapshot.inFlightPerProvider).map(([p, n]) => `${p}: ${n}`).join(', ') : '0'}</div>
            <div>Configured: [{queueSnapshot.configured.join(', ')}]</div>
            {queueSnapshot.activeProviders != null && queueSnapshot.activeProviders.length > 0 && (
              <div>Active agents: [{queueSnapshot.activeProviders.join(', ')}]</div>
            )}
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        className="max-h-[300px] overflow-auto rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs"
        role="log"
      >
        {entries.length === 0 && <p className="text-gray-500">No entries yet.</p>}
        {entries.map((e, i) => (
          <div
            key={i}
            className={`flex gap-2 py-0.5 ${
              e.level === 'error' ? 'text-red-700' : e.level === 'warn' ? 'text-amber-700' : 'text-gray-800'
            }`}
          >
            <span className="shrink-0 text-gray-500">{e.ts}</span>
            <span>{e.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
