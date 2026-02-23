import { useState, useEffect, useRef } from 'react';
import { Check, Circle, ChevronDown, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from './ui/card';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Progress } from './ui/progress';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { useEvaluation, isJobFailed, isJobRetrying } from '../hooks/useEvaluation';
import { cn } from '../lib/utils';
import { getSettings, getJobEvaluationStats } from '@/lib/db';

const VERDICT_LABELS: Record<string, string> = {
  worth: 'Worth Reviewing',
  maybe: 'Maybe',
  not_worth: 'Not worth applying',
};

const MINUTES_SAVED_PER_JOB = 4;

function formatHoursSaved(totalJobs: number): string {
  const minutes = totalJobs * MINUTES_SAVED_PER_JOB;
  const hours = minutes / 60;
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  if (minutes >= 1) return `${minutes} min`;
  return '0 min';
}

function FooterStats({ onResultChange }: { onResultChange: unknown }) {
  const [stats, setStats] = useState<{ total: number; strongMatches: number } | null>(null);
  useEffect(() => {
    getJobEvaluationStats()
      .then(setStats)
      .catch(() => setStats(null));
  }, [onResultChange]);
  const total = stats?.total ?? 0;
  const strongMatches = stats?.strongMatches ?? 0;
  const hoursSaved = formatHoursSaved(total);
  return (
    <div className="rounded-lg bg-gray-200/60 px-3 py-2 text-center text-xs text-gray-600">
      {total} jobs evaluated • {strongMatches} strong matches • {hoursSaved} saved
    </div>
  );
}

export function JobIntelligencePanel({
  selectedResumeIds,
  setSelectedResumeIds,
  onDebugLog,
}: {
  selectedResumeIds: string[];
  setSelectedResumeIds: (ids: string[]) => void;
  onDebugLog?: (msg: string, level?: 'info' | 'warn' | 'error') => void;
}) {
  const [autoEvaluate, setAutoEvaluate] = useState(true);
  const [hint, setHint] = useState<string>('Open a LinkedIn job page to evaluate.');
  const [showMarkBadInput, setShowMarkBadInput] = useState(false);
  const [markBadReason, setMarkBadReason] = useState('');

  const {
    resumes,
    result,
    loading,
    error,
    jobTitle,
    runEvaluation,
    reRun,
    markAsBad,
    refetchResumes,
    processingJobs,
    removeFromProcessingList,
    retryJob,
  } = useEvaluation(selectedResumeIds, onDebugLog);

  useEffect(() => {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const onJobPage = tab?.url && /linkedin\.com\/jobs/.test(tab.url);
      if (!onJobPage) {
        setHint('Open a LinkedIn job page to evaluate.');
        return;
      }
      const settings = await getSettings();
      const needKey = settings.apiProvider !== 'ollama';
      const hasKey = !!settings.apiKeys?.[settings.apiProvider]?.trim();
      if (needKey && !hasKey) {
        setHint('Set your API key in Settings.');
        return;
      }
      setHint(jobTitle?.trim() || 'Open a LinkedIn job page to evaluate.');
    })();
  }, [jobTitle]);

  const runEvaluationRef = useRef(runEvaluation);
  runEvaluationRef.current = runEvaluation;
  // Auto-run when panel opens with Auto Evaluate on, or when user turns Auto Evaluate on
  useEffect(() => {
    if (!autoEvaluate) return;
    runEvaluationRef.current();
  }, [autoEvaluate]);

  // When user switches to a LinkedIn job tab (or navigates to one) and Auto Evaluate is on, run evaluation
  useEffect(() => {
    if (!autoEvaluate) return;
    const onActivated = (activeInfo: chrome.tabs.TabActiveInfo) => {
      chrome.tabs.get(activeInfo.tabId).then(
        (tab) => {
          if (tab?.url && /linkedin\.com\/jobs/.test(tab.url)) runEvaluationRef.current();
        },
        () => {}
      );
    };
    const onUpdated = (tabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (!changeInfo.url || !/linkedin\.com\/jobs/.test(changeInfo.url)) return;
      chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
        if (active?.id === tabId) runEvaluationRef.current();
      });
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, [autoEvaluate]);

  const toggleResume = (id: string) => {
    if (selectedResumeIds.includes(id)) {
      if (selectedResumeIds.length > 1) setSelectedResumeIds(selectedResumeIds.filter((x) => x !== id));
    } else {
      setSelectedResumeIds([...selectedResumeIds, id]);
    }
  };

  const confidenceLabel = result
    ? result.score >= 70
      ? 'High'
      : result.score >= 40
        ? 'Medium'
        : 'Low'
    : null;

  return (
    <div className="space-y-4 p-3">
      {/* Header */}
      <h1 className="text-lg font-bold">Job Intelligence</h1>

      {/* Active Context */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-normal">Active Context</CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Auto Evaluate</span>
            <Switch
              checked={autoEvaluate}
              onCheckedChange={(checked) => {
                setAutoEvaluate(checked);
                if (checked) runEvaluation();
              }}
            />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-gray-500">{hint}</p>
          {resumes.length > 0 && (
            <div className="flex flex-col gap-2">
              {resumes.map((r) => {
                const selected = selectedResumeIds.includes(r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => toggleResume(r.id)}
                    className={cn(
                      'flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors',
                      selected
                        ? 'border-blue-600 bg-blue-600 text-white'
                        : 'border-gray-200 bg-white text-gray-900 hover:bg-gray-50'
                    )}
                  >
                    {selected ? (
                      <Check className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <Circle className="mt-0.5 h-4 w-4 shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{r.label}</div>
                      <div className={cn('text-xs', selected ? 'text-blue-100' : 'text-gray-500')}>
                        {selected ? 'Resume Selected' : 'Resume Not Selected'}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {resumes.length === 0 && (
            <p className="text-xs text-gray-500">No resumes yet. Add some in Resumes.</p>
          )}
        </CardContent>
      </Card>

      {/* Processing jobs queue */}
      {processingJobs.length > 0 && (
        <Card>
          <CardHeader className="py-2">
            <CardTitle className="text-sm font-normal">Processing jobs</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 pt-0">
            {processingJobs.map((j) => (
              <div
                key={j.cacheKey}
                className="flex cursor-pointer items-center justify-between gap-2 rounded border border-gray-200 bg-white px-2 py-1.5 text-left text-sm hover:bg-gray-50"
                role="button"
                tabIndex={0}
                title="Click to focus this job on LinkedIn"
                onClick={async (e) => {
                  const target = e.target as HTMLElement;
                  if (target.closest('button')) return;
                  try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'SELECT_JOB', jobId: j.jobId });
                  } catch {
                    /* tab or content script unavailable */
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    (e.currentTarget as HTMLElement).click();
                  }
                }}
              >
                <span className="min-w-0 flex-1 truncate text-gray-800" title={j.title}>
                  {j.title}
                </span>
                {j.status === 'rate_limited' ? (
                  <span className="shrink-0 text-xs font-medium text-orange-600">Rate limited</span>
                ) : j.status === 'done' ? (
                  <span className="shrink-0 text-xs text-gray-500">{j.score != null ? `${j.score}/100` : '—'}</span>
                ) : isJobFailed(j) ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-xs font-medium text-gray-600">Failed</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-1.5 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        retryJob(j.cacheKey);
                      }}
                    >
                      Retry
                    </Button>
                  </span>
                ) : isJobRetrying(j) &&
                  (j.lastError?.toLowerCase().includes('rate limit') ?? false) ? (
                  <span className="shrink-0 text-xs text-amber-600">
                    Rate limit/Retry #{(j.retryCount ?? 1)}
                  </span>
                ) : isJobRetrying(j) ? (
                  <span className="shrink-0 text-xs text-amber-600">
                    Retrying{j.lastProvider ? ` with ${j.lastProvider}` : ''} ({(j.retryCount ?? 0)})
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-blue-600">Evaluating…</span>
                )}
                <button
                  type="button"
                  className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
                  aria-label="Remove from list"
                  title="Remove from list"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFromProcessingList(j.cacheKey);
                  }}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Loading / Error */}
      {loading && (
        <Card>
          <CardContent className="flex items-center gap-3 py-6">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
            <span className="text-sm text-gray-600">Evaluating job fit…</span>
          </CardContent>
        </Card>
      )}
      {error && (result || loading) && (
        <Card className="border-red-200 bg-red-50/50">
          <CardContent className="flex items-center justify-between gap-2 py-3">
            <p className="text-sm text-red-800">{error}</p>
            <Button variant="secondary" size="sm" onClick={() => runEvaluation()}>
              Retry
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Score / Worth Reviewing */}
      {result && !loading && (
        <>
          <Card>
            <CardContent className="pt-4">
              {jobTitle && (
                <p className="mb-2 truncate text-xs font-medium text-gray-600" title={jobTitle}>
                  {jobTitle}
                </p>
              )}
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold">{result.score}</span>
                <span className="text-sm text-gray-600">{VERDICT_LABELS[result.verdict] ?? result.verdict}</span>
              </div>
              {confidenceLabel && (
                <p className="mt-1 text-xs text-gray-500">
                  Confidence: {confidenceLabel} ({result.score}%)
                </p>
              )}
              <Progress value={result.score} className="mt-2 h-2" />
              <p className="mt-1 text-xs text-gray-500">Estimated time saved: ~3 min</p>
            </CardContent>
          </Card>

          {/* Strength & Risk Signals */}
          {(result.matchBullets?.length > 0 || result.riskBullets?.length > 0) && (
            <Collapsible defaultOpen={false}>
              <Card>
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between p-4 text-left hover:bg-gray-50"
                  >
                    <CardTitle className="text-sm font-normal">Strength & Risk Signals</CardTitle>
                    <ChevronDown className="h-4 w-4 shrink-0 text-gray-500" />
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent className="grid grid-cols-2 gap-4 pt-0">
                    <div>
                      <p className="mb-2 text-xs font-medium text-gray-600">Strength Signals</p>
                      <ul className="space-y-1.5">
                        {result.matchBullets?.map((b, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs text-gray-800">
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                            <span>{b}</span>
                          </li>
                        ))}
                        {(!result.matchBullets || result.matchBullets.length === 0) && (
                          <li className="text-xs text-gray-400">None</li>
                        )}
                      </ul>
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-medium text-gray-600">Risk Signals</p>
                      <ul className="space-y-1.5">
                        {result.riskBullets?.map((b, i) => (
                          <li key={i} className="flex items-start gap-2 text-xs text-gray-800">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                            <span>{b}</span>
                          </li>
                        ))}
                        {(!result.riskBullets || result.riskBullets.length === 0) && (
                          <li className="text-xs text-gray-400">None</li>
                        )}
                      </ul>
                    </div>
                  </CardContent>
                </CollapsibleContent>
              </Card>
            </Collapsible>
          )}

          {/* Evaluate the job button — after Strength & Risk block */}
          {!autoEvaluate && (
            <Button className="w-full" onClick={runEvaluation} disabled={loading}>
              Evaluate the job
            </Button>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={reRun}>
              Re-evaluate
            </Button>
            <button
              type="button"
              className="text-xs text-gray-500 underline underline-offset-2 hover:text-gray-700"
              onClick={() => setShowMarkBadInput((v) => !v)}
            >
              Mark as bad
            </button>
          </div>
          {showMarkBadInput && (
            <div className="flex items-start gap-2">
              <input
                type="text"
                placeholder="Why is this job bad? (optional)"
                value={markBadReason}
                onChange={(e) => setMarkBadReason(e.target.value)}
                className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1.5 text-xs focus:border-blue-500 focus:outline-none"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    markAsBad(markBadReason);
                    setMarkBadReason('');
                    setShowMarkBadInput(false);
                  }
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 text-xs"
                onClick={() => {
                  markAsBad(markBadReason);
                  setMarkBadReason('');
                  setShowMarkBadInput(false);
                }}
              >
                Save
              </Button>
            </div>
          )}
        </>
      )}

      {/* Empty state: no result, not loading — show Evaluate the job button (and show even if error so user can retry) */}
      {!result && !loading && (
        <Card>
          <CardContent className="py-6 text-center">
            {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
            <p className="text-sm text-gray-600">
              {error ? 'Fix the issue above, then click below.' : 'Open a LinkedIn job page and we’ll evaluate it here.'}
            </p>
            <Button className="mt-3" onClick={runEvaluation}>
              Evaluate the job
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Footer */}
      <FooterStats onResultChange={result} />
    </div>
  );
}
