import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Play,
  Square,
  AlertTriangle,
  CheckCircle,
  XCircle,
  MinusCircle,
  ChevronDown,
  ChevronRight,
  Zap,
  Globe,
  Wifi,
  Terminal,
  Navigation,
  Bot,
  Shuffle,
} from 'lucide-react';
import ScenarioMode from './ScenarioMode';

// ─── Types (mirror server types) ─────────────────────────────────────────────

type FailureSeverity = 'crash' | 'http_error' | 'network' | 'console_error' | 'navigation_failure' | 'slow';

interface ConsoleEntry { level: string; text: string; timestamp: number }
interface NetworkEntry { url: string; method: string; status: number | null; failed: boolean; failureReason?: string; durationMs: number }

interface StepEvidence {
  screenshotBefore: string | null;
  screenshotAfter: string | null;
  urlBefore: string;
  urlAfter: string;
  consoleLogs: ConsoleEntry[];
  networkRequests: NetworkEntry[];
  domMutated: boolean;
  networkFired: boolean;
}

interface DetectedFailure {
  type: FailureSeverity;
  message: string;
  fingerprint: string;
  elementText: string;
  evidence: StepEvidence;
  llmNarrative?: { cause: string; fix: string; model: string };
}

interface SwarmStep {
  index: number;
  elementSelector: string;
  elementText: string;
  actionType: string;
  timestamp: number;
  durationMs: number;
  evidence: StepEvidence;
  failures: DetectedFailure[];
  verificationResult: 'dom_changed' | 'network_fired' | 'url_changed' | 'no_change' | 'skipped';
}

interface SwarmRunSummary {
  runId: string;
  targetUrl: string;
  totalSteps: number;
  uniqueBugs: number;
  severityCounts: Record<FailureSeverity, number>;
  steps: SwarmStep[];
  failures: DetectedFailure[];
  durationMs: number;
}

interface SwarmRunResponse {
  runId: string;
  status: 'running' | 'done';
  startedAt?: number;
  summary?: SwarmRunSummary;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<FailureSeverity, string> = {
  crash: 'text-red-500',
  http_error: 'text-orange-500',
  network: 'text-yellow-500',
  console_error: 'text-amber-500',
  navigation_failure: 'text-purple-500',
  slow: 'text-blue-400',
};

const SEVERITY_BG: Record<FailureSeverity, string> = {
  crash: 'bg-red-500/10 border-red-500/30',
  http_error: 'bg-orange-500/10 border-orange-500/30',
  network: 'bg-yellow-500/10 border-yellow-500/30',
  console_error: 'bg-amber-500/10 border-amber-500/30',
  navigation_failure: 'bg-purple-500/10 border-purple-500/30',
  slow: 'bg-blue-500/10 border-blue-500/30',
};

const SEVERITY_LABEL: Record<FailureSeverity, string> = {
  crash: 'JS CRASH',
  http_error: 'HTTP ERROR',
  network: 'NETWORK',
  console_error: 'CONSOLE ERR',
  navigation_failure: 'NAV FAILURE',
  slow: 'SLOW',
};

const SEVERITY_ICON: Record<FailureSeverity, React.ReactNode> = {
  crash: <Zap className="w-3 h-3" />,
  http_error: <Globe className="w-3 h-3" />,
  network: <Wifi className="w-3 h-3" />,
  console_error: <Terminal className="w-3 h-3" />,
  navigation_failure: <Navigation className="w-3 h-3" />,
  slow: <MinusCircle className="w-3 h-3" />,
};

function VerificationBadge({ result }: { result: SwarmStep['verificationResult'] }) {
  if (result === 'url_changed' || result === 'dom_changed' || result === 'network_fired') {
    return (
      <span className="flex items-center gap-1 text-xs text-green-400">
        <CheckCircle className="w-3 h-3" />
        {result === 'url_changed' ? 'URL changed' : result === 'dom_changed' ? 'DOM changed' : 'Network fired'}
      </span>
    );
  }
  if (result === 'no_change') {
    return (
      <span className="flex items-center gap-1 text-xs text-yellow-400">
        <AlertTriangle className="w-3 h-3" /> No reaction
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <MinusCircle className="w-3 h-3" /> Skipped
    </span>
  );
}

function EvidenceAccordion({ evidence }: { evidence: StepEvidence }) {
  const [open, setOpen] = useState<null | 'screenshots' | 'console' | 'network'>(null);
  const toggle = (key: typeof open) => setOpen(open === key ? null : key);

  return (
    <div className="mt-3 space-y-1 border-t border-border pt-3">
      {(evidence.screenshotBefore || evidence.screenshotAfter) && (
        <div>
          <button
            onClick={() => toggle('screenshots')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full text-left"
          >
            {open === 'screenshots' ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Screenshots
          </button>
          {open === 'screenshots' && (
            <div className="flex gap-2 mt-2">
              {evidence.screenshotBefore && (
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground mb-1">Before</p>
                  <img
                    src={`data:image/png;base64,${evidence.screenshotBefore}`}
                    alt="before"
                    className="w-full rounded border border-border"
                  />
                </div>
              )}
              {evidence.screenshotAfter && (
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground mb-1">After</p>
                  <img
                    src={`data:image/png;base64,${evidence.screenshotAfter}`}
                    alt="after"
                    className="w-full rounded border border-border"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {evidence.consoleLogs.length > 0 && (
        <div>
          <button
            onClick={() => toggle('console')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full text-left"
          >
            {open === 'console' ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Console ({evidence.consoleLogs.length})
          </button>
          {open === 'console' && (
            <div className="mt-2 bg-black/40 rounded p-2 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
              {evidence.consoleLogs.map((l, i) => (
                <div key={i} className={l.level === 'error' ? 'text-red-400' : l.level === 'warn' ? 'text-yellow-400' : 'text-muted-foreground'}>
                  [{l.level}] {l.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {evidence.networkRequests.filter(r => r.failed || (r.status != null && r.status >= 400)).length > 0 && (
        <div>
          <button
            onClick={() => toggle('network')}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full text-left"
          >
            {open === 'network' ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            Network errors ({evidence.networkRequests.filter(r => r.failed || (r.status != null && r.status >= 400)).length})
          </button>
          {open === 'network' && (
            <div className="mt-2 bg-black/40 rounded p-2 font-mono text-xs space-y-1 max-h-40 overflow-y-auto">
              {evidence.networkRequests
                .filter(r => r.failed || (r.status != null && r.status >= 400))
                .map((r, i) => (
                  <div key={i} className="text-red-400">
                    {r.method} {r.url.slice(0, 80)} → {r.status ?? 'FAILED'} {r.failureReason ?? ''}
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ step }: { step: SwarmStep }) {
  const [expanded, setExpanded] = useState(false);
  const hasFailures = step.failures.length > 0;

  return (
    <div className={`border rounded-lg mb-2 ${hasFailures ? 'border-red-500/30 bg-red-500/5' : 'border-border bg-card'}`}>
      <button
        className="w-full text-left p-3 flex items-center gap-3"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="font-mono text-xs text-muted-foreground w-8 shrink-0">#{step.index + 1}</span>
        {hasFailures
          ? <XCircle className="w-4 h-4 text-red-500 shrink-0" />
          : <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />}
        <span className="text-sm font-medium flex-1 truncate">
          Clicked <span className="text-primary">"{step.elementText || step.elementSelector}"</span>
        </span>
        {hasFailures && (
          <span className="flex items-center gap-1">
            {step.failures.map((f, i) => (
              <span key={i} className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${SEVERITY_BG[f.type]} ${SEVERITY_COLOR[f.type]}`}>
                {SEVERITY_ICON[f.type]}
                {SEVERITY_LABEL[f.type]}
              </span>
            ))}
          </span>
        )}
        <VerificationBadge result={step.verificationResult} />
        <span className="text-xs text-muted-foreground shrink-0">{step.durationMs}ms</span>
        {expanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-border pt-3">
          <div className="text-xs text-muted-foreground mb-1 font-mono truncate">
            {step.elementSelector}
          </div>
          <div className="text-xs text-muted-foreground mb-2">
            {step.evidence.urlBefore}
            {step.evidence.urlAfter !== step.evidence.urlBefore && (
              <span className="ml-2 text-green-400">→ {step.evidence.urlAfter}</span>
            )}
          </div>

          {step.failures.map((f, i) => (
            <div key={i} className={`border rounded p-2 mb-2 ${SEVERITY_BG[f.type]}`}>
              <p className={`text-xs font-bold mb-1 flex items-center gap-1 ${SEVERITY_COLOR[f.type]}`}>
                {SEVERITY_ICON[f.type]} {SEVERITY_LABEL[f.type]}
              </p>
              <p className="text-xs text-foreground">{f.message}</p>
              {f.llmNarrative && (
                <div className="mt-2 space-y-1 border-t border-border/50 pt-2">
                  <p className="text-xs"><span className="text-muted-foreground">Why: </span>{f.llmNarrative.cause}</p>
                  <p className="text-xs"><span className="text-muted-foreground">Fix: </span>{f.llmNarrative.fix}</p>
                </div>
              )}
            </div>
          ))}

          <EvidenceAccordion evidence={step.evidence} />
        </div>
      )}
    </div>
  );
}

// ─── Start Swarm Form ─────────────────────────────────────────────────────────


function StartSwarmForm({ onStart }: { onStart: (runId: string) => void }) {
  const [url, setUrl] = useState('');
  const [steps, setSteps] = useState(50);
  const [showBrowser, setShowBrowser] = useState(false);

  const start = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/swarm-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl: url,
          maxSteps: steps,
          headless: !showBrowser,
        }),
      });
      if (!res.ok) throw new Error('Failed to start swarm');
      return res.json() as Promise<{ runId: string }>;
    },
    onSuccess: (data) => {
      // Persist run ID so Reports page can find it
      const ids: string[] = JSON.parse(localStorage.getItem('swarm_run_ids') ?? '[]');
      if (!ids.includes(data.runId)) {
        localStorage.setItem('swarm_run_ids', JSON.stringify([data.runId, ...ids].slice(0, 50)));
      }
      onStart(data.runId);
    },
  });

  return (
    <div className="border rounded-lg bg-card p-6 max-w-lg">
      <h2 className="text-lg font-semibold mb-4">Start Swarm Agent</h2>
      <div className="space-y-3">
        <div>
          <label className="text-sm text-muted-foreground block mb-1">Target URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-app.example.com"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
        <div>
          <label className="text-sm text-muted-foreground block mb-1">Max steps: {steps}</label>
          <input
            type="range"
            min={5}
            max={200}
            value={steps}
            onChange={(e) => setSteps(Number(e.target.value))}
            className="w-full"
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showBrowser}
            onChange={(e) => setShowBrowser(e.target.checked)}
          />
          Show browser window (watch the agent live in DevTools)
        </label>
        <button
          onClick={() => start.mutate()}
          disabled={!url || start.isPending}
          className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <Play className="w-4 h-4" />
          {start.isPending ? 'Starting…' : 'Launch Swarm'}
        </button>
        {start.isError && <p className="text-xs text-destructive">{String(start.error)}</p>}
      </div>
    </div>
  );
}

// ─── Swarm mode (existing — random monkey clicker) ───────────────────────────

function SwarmMode() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runId = searchParams.get('runId');
  const liveSteps = useRef<SwarmStep[]>([]);
  const [liveCount, setLiveCount] = useState(0);

  // Poll server for run status
  const { data: runData } = useQuery<SwarmRunResponse>({
    queryKey: ['swarm-run', runId],
    queryFn: async () => {
      const res = await fetch(`/api/swarm-runs/${runId}`);
      if (!res.ok) throw new Error('Run not found');
      return res.json();
    },
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1000 : false),
  });

  // WebSocket for live step events
  useEffect(() => {
    if (!runId) return;
    liveSteps.current = [];
    setLiveCount(0);

    const wsUrl = `ws://${window.location.host}/ws/live-metrics?runId=${runId}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.kind === 'swarm_event' && msg.event?.type === 'step') {
          liveSteps.current.push(msg.event.step as SwarmStep);
          setLiveCount((c) => c + 1);
        }
      } catch { /* ignore */ }
    };

    return () => ws.close();
  }, [runId]);

  const stopMutation = useMutation({
    mutationFn: async () => {
      await fetch(`/api/swarm-runs/${runId}/stop`, { method: 'POST' });
    },
  });

  const isRunning = runData?.status === 'running';
  const summary = runData?.summary;
  const displaySteps = summary?.steps ?? liveSteps.current;
  const _ = liveCount; // ensure re-render on live updates

  if (!runId) {
    return (
      <div>
        <StartSwarmForm onStart={(id) => setSearchParams({ runId: id, mode: 'swarm' })} />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          {summary && (
            <p className="text-sm text-muted-foreground">
              {summary.targetUrl} — {summary.totalSteps} steps in {(summary.durationMs / 1000).toFixed(1)}s
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isRunning ? (
            <>
              <span className="flex items-center gap-1.5 text-sm text-green-400">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                Live
              </span>
              <button
                onClick={() => stopMutation.mutate()}
                className="flex items-center gap-1.5 bg-destructive text-destructive-foreground text-sm px-3 py-1.5 rounded hover:bg-destructive/90"
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">● Completed</span>
          )}
          <button
            onClick={() => setSearchParams({ mode: 'swarm' })}
            className="text-sm text-muted-foreground hover:text-foreground border border-border rounded px-3 py-1.5"
          >
            New run
          </button>
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-5 gap-3 mb-6">
          {(Object.entries(summary.severityCounts) as [FailureSeverity, number][])
            .filter(([, v]) => v > 0)
            .map(([type, count]) => (
              <div key={type} className={`p-3 border rounded-lg ${SEVERITY_BG[type]}`}>
                <p className={`text-xs font-bold flex items-center gap-1 ${SEVERITY_COLOR[type]}`}>
                  {SEVERITY_ICON[type]} {SEVERITY_LABEL[type]}
                </p>
                <p className="text-2xl font-bold mt-1">{count}</p>
              </div>
            ))}
          <div className="p-3 border border-border rounded-lg bg-card">
            <p className="text-xs text-muted-foreground">Unique bugs</p>
            <p className="text-2xl font-bold mt-1">{summary.uniqueBugs}</p>
          </div>
        </div>
      )}

      {/* Step timeline */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Step Timeline
          {isRunning && <span className="ml-2 text-green-400">(live — {liveSteps.current.length} steps)</span>}
        </h2>
        {displaySteps.length === 0 ? (
          <div className="border border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
            {isRunning ? 'Waiting for first step…' : 'No steps recorded.'}
          </div>
        ) : (
          <div>
            {displaySteps.map((step) => (
              <StepRow key={step.index} step={step} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Mode toggle wrapper (top-level page) ────────────────────────────────────

type Mode = 'swarm' | 'scenario';

export default function AgentMonitor() {
  const [searchParams, setSearchParams] = useSearchParams();
  const mode: Mode = (searchParams.get('mode') as Mode) ?? 'swarm';

  const switchMode = (next: Mode) => {
    // Reset runId when switching modes — a swarm runId is not a scenario runId
    const params = new URLSearchParams();
    params.set('mode', next);
    setSearchParams(params);
  };

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Agent Monitor</h1>
        <div className="inline-flex border border-border rounded-lg p-0.5 bg-card">
          <button
            onClick={() => switchMode('swarm')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              mode === 'swarm'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Shuffle className="w-3.5 h-3.5" />
            Swarm
          </button>
          <button
            onClick={() => switchMode('scenario')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              mode === 'scenario'
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            Scenario
          </button>
        </div>
      </div>

      <div className="mb-6 text-xs text-muted-foreground">
        {mode === 'swarm' ? (
          <span>
            <strong className="text-foreground">Swarm:</strong> random monkey clicker. No LLM during run. Finds unknown bugs by chaos.
          </span>
        ) : (
          <span>
            <strong className="text-foreground">Scenario:</strong> goal-directed test runner. Planner → Executor → Healer. Verifies a specific user flow.
          </span>
        )}
      </div>

      {mode === 'swarm' ? <SwarmMode /> : <ScenarioMode />}
    </div>
  );
}
