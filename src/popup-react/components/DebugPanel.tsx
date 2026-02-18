import { useRef, useEffect } from 'react';
import { Home } from 'lucide-react';
import { Button } from './ui/button';

type DebugEntry = { ts: string; msg: string; level: 'info' | 'warn' | 'error' };

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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [entries.length]);

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
      <div
        ref={scrollRef}
        className="max-h-[360px] overflow-auto rounded border border-gray-200 bg-gray-50 p-2 font-mono text-xs"
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
