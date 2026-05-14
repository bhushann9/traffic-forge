import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Play,
  Square,
  CheckCircle,
  XCircle,
  Wrench,
  Bot,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';

// ─── Types (mirror server types) ─────────────────────────────────────────────

type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'healed' | 'skipped';
type ScenarioStatus = 'planning' | 'running' | 'passed' | 'failed' | 'aborted' | 'error';

interface StepAction {
  type: 'navigate' | 'click' | 'fill' | 'expect_text' | 'expect_url' | 'wait_for' | 'wait_ms';
  url?: string;
  role?: string;
  name?: string;
  value?: string;
  text?: string;
  pattern?: string;
  ms?: number;
}

interface TestPlanStep {
  index: number;
  description: string;
  action: StepAction;
  expected: string;
}

interface TestPlan {
  goal: string;
  rawMarkdown: string;
  steps: TestPlanStep[];
  dataRequirements: string[];
  generatedBy: string;
}

interface HealAttempt {
  reason: string;
  diagnosis: string;
  proposedAction: StepAction;
  succeeded: boolean;
  ledToError?: string;
}

interface StepResult {
  step: TestPlanStep;
  status: StepStatus;
  startedAt: number;
  finishedAt: number;
  error?: string;
  healAttempts?: HealAttempt[];
  screenshot?: string | null;
  url?: string;
  pageLoadMs?: number;
  consoleErrors?: string[];
  networkErrors?: { url: string; status: number }[];
}

interface ScenarioFailureNarrative {
  cause: string;
  fix: string;
  model: string;
}

interface ScenarioRunSummary {
  runId: string;
  goal: string;
  targetUrl: string;
  status: ScenarioStatus;
  plan: TestPlan | null;
  steps: StepResult[];
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  totalSteps: number;
  passedSteps: number;
  failedSteps: number;
  healedSteps: number;
  errorMessage?: string;
  failureNarrative?: ScenarioFailureNarrative;
}

interface ScenarioRunResponse {
  runId: string;
  status: 'running' | 'done' | 'planning';
  summary?: ScenarioRunSummary;
  startedAt?: number;
}

// ─── Status helpers ──────────────────────────────────────────────────────────

const STATUS_COLOR: Record<StepStatus, string> = {
  pending: 'text-muted-foreground',
  running: 'text-blue-400',
  passed: 'text-green-500',
  healed: 'text-amber-500',
  failed: 'text-red-500',
  skipped: 'text-muted-foreground',
};

const STATUS_BG: Record<StepStatus, string> = {
  pending: 'border-border bg-card',
  running: 'border-blue-500/30 bg-blue-500/5',
  passed: 'border-green-500/30 bg-green-500/5',
  healed: 'border-amber-500/30 bg-amber-500/5',
  failed: 'border-red-500/30 bg-red-500/5',
  skipped: 'border-border bg-card opacity-60',
};

function StatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'passed':
      return <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />;
    case 'healed':
      return <Wrench className="w-4 h-4 text-amber-500 shrink-0" />;
    case 'failed':
      return <XCircle className="w-4 h-4 text-red-500 shrink-0" />;
    case 'running':
      return <span className="w-3 h-3 rounded-full bg-blue-500 animate-pulse shrink-0" />;
    default:
      return <span className="w-3 h-3 rounded-full bg-muted shrink-0" />;
  }
}

function ActionPill({ action }: { action: StepAction }) {
  const summary = (() => {
    switch (action.type) {
      case 'navigate':
        return action.url ?? '';
      case 'click':
      case 'wait_for':
        return `${action.role}: "${action.name}"`;
      case 'fill':
        return `${action.role}: "${action.name}" ← "${action.value}"`;
      case 'expect_text':
        return `text contains "${action.text}"`;
      case 'expect_url':
        return `url ~ ${action.pattern}`;
      case 'wait_ms':
        return `${action.ms}ms`;
    }
  })();
  return (
    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
      {action.type} {summary}
    </span>
  );
}

// ─── Step row ────────────────────────────────────────────────────────────────

function ScenarioStepRow({ result }: { result: StepResult }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={`border rounded-lg mb-2 ${STATUS_BG[result.status]}`}>
      <button
        className="w-full text-left p-3 flex items-center gap-3"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="font-mono text-xs text-muted-foreground w-8 shrink-0">
          #{result.step.index + 1}
        </span>
        <StatusIcon status={result.status} />
        <span className="text-sm font-medium flex-1 truncate">{result.step.description}</span>
        <ActionPill action={result.step.action} />
        <span className={`text-xs font-medium ${STATUS_COLOR[result.status]}`}>
          {result.status}
        </span>
        {expanded ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-border pt-3 space-y-2">
          {result.step.expected && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Expected:</span> {result.step.expected}
            </div>
          )}
          {result.url && (
            <div className="text-xs text-muted-foreground font-mono truncate">{result.url}</div>
          )}
          {/* Performance metrics */}
          <div className="flex flex-wrap gap-3">
            <span className="text-xs text-muted-foreground">
              ⏱ Step: <span className="text-foreground font-mono">{result.finishedAt - result.startedAt}ms</span>
            </span>
            {result.pageLoadMs !== undefined && (
              <span className="text-xs text-muted-foreground">
                🌐 Page load: <span className="text-foreground font-mono">{result.pageLoadMs}ms</span>
              </span>
            )}
            {result.networkErrors && result.networkErrors.length > 0 && (
              <span className="text-xs text-amber-400">
                ⚠ {result.networkErrors.length} network error{result.networkErrors.length > 1 ? 's' : ''}
              </span>
            )}
            {result.consoleErrors && result.consoleErrors.length > 0 && (
              <span className="text-xs text-red-400">
                ✗ {result.consoleErrors.length} console error{result.consoleErrors.length > 1 ? 's' : ''}
              </span>
            )}
          </div>
          {result.networkErrors && result.networkErrors.length > 0 && (
            <div className="space-y-1">
              {result.networkErrors.slice(0, 5).map((ne, i) => (
                <div key={i} className="text-xs text-amber-400 font-mono bg-black/30 px-2 py-1 rounded truncate">
                  HTTP {ne.status} — {ne.url}
                </div>
              ))}
            </div>
          )}
          {result.consoleErrors && result.consoleErrors.length > 0 && (
            <div className="space-y-1">
              {result.consoleErrors.slice(0, 3).map((ce, i) => (
                <div key={i} className="text-xs text-red-400 font-mono bg-black/30 px-2 py-1 rounded">
                  {ce}
                </div>
              ))}
            </div>
          )}
          {result.error && (
            <div className="text-xs text-red-400 font-mono bg-black/40 p-2 rounded">
              {result.error}
            </div>
          )}
          {result.healAttempts && result.healAttempts.length > 0 && (
            <div className="space-y-2">
              {result.healAttempts.map((h, i) => (
                <div
                  key={i}
                  className={`border rounded p-2 text-xs ${h.succeeded ? 'border-green-500/30 bg-green-500/5' : 'border-amber-500/30 bg-amber-500/5'}`}
                >
                  <div className="flex items-center gap-1 mb-1 font-medium">
                    <Wrench className="w-3 h-3" /> Heal attempt {i + 1}
                    {h.succeeded && <span className="text-green-400">— succeeded</span>}
                  </div>
                  <div className="text-muted-foreground mb-1">
                    <span className="font-medium">Diagnosis:</span> {h.diagnosis}
                  </div>
                  <div className="text-muted-foreground mb-1">
                    <span className="font-medium">Proposed:</span>{' '}
                    <ActionPill action={h.proposedAction} />
                  </div>
                  {h.ledToError && (
                    <div className="text-red-400 font-mono">{h.ledToError}</div>
                  )}
                </div>
              ))}
            </div>
          )}
          {result.screenshot && (
            <img
              src={`data:image/png;base64,${result.screenshot}`}
              alt={`Step ${result.step.index + 1}`}
              className="w-full rounded border border-border max-h-72 object-contain bg-black/20"
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Plan view ───────────────────────────────────────────────────────────────

function PlanView({ plan }: { plan: TestPlan }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-primary/30 bg-primary/5 rounded-lg p-3 mb-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 text-left"
      >
        <Sparkles className="w-4 h-4 text-primary" />
        <span className="text-sm font-medium flex-1">
          Test plan ready — {plan.steps.length} steps
        </span>
        <span className="text-xs text-muted-foreground">via {plan.generatedBy}</span>
        {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
      {expanded && (
        <div className="mt-3 space-y-3">
          {plan.dataRequirements.length > 0 && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1">Data requirements</p>
              <ul className="text-xs space-y-0.5">
                {plan.dataRequirements.map((d, i) => (
                  <li key={i} className="text-muted-foreground">• {d}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Raw markdown</p>
            <pre className="text-[11px] bg-black/40 p-2 rounded font-mono whitespace-pre-wrap max-h-64 overflow-y-auto">
              {plan.rawMarkdown}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Start form ──────────────────────────────────────────────────────────────

function StartScenarioForm({ onStart }: { onStart: (runId: string) => void }) {
  const [goal, setGoal] = useState('');
  const [url, setUrl] = useState('');
  const [maxSteps, setMaxSteps] = useState(15);
  const [allowHealing, setAllowHealing] = useState(true);
  const [showBrowser, setShowBrowser] = useState(false);

  const start = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/scenario-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal,
          targetUrl: url,
          maxSteps,
          allowHealing,
          headless: !showBrowser,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      return res.json() as Promise<{ runId: string }>;
    },
    onSuccess: (data) => {
      const ids: string[] = JSON.parse(localStorage.getItem('scenario_run_ids') ?? '[]');
      if (!ids.includes(data.runId)) {
        localStorage.setItem(
          'scenario_run_ids',
          JSON.stringify([data.runId, ...ids].slice(0, 50)),
        );
      }
      onStart(data.runId);
    },
  });

  return (
    <div className="border rounded-lg bg-card p-6 max-w-lg">
      <div className="flex items-center gap-2 mb-4">
        <Bot className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">Start Multi-Agent Scenario</h2>
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Describe a user journey in plain English. The Planner generates a test plan, the Executor
        runs it, and the Healer recovers when UI changes.
      </p>
      <div className="space-y-3">
        <div>
          <label className="text-sm text-muted-foreground block mb-1">Goal</label>
          <textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Verify a guest user can search for a product, add it to cart, and reach the checkout page"
            rows={3}
            className="w-full border border-border rounded px-3 py-2 text-sm bg-background focus:outline-none focus:ring-2 focus:ring-primary resize-none"
          />
        </div>
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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm text-muted-foreground block mb-1">Max steps: {maxSteps}</label>
            <input
              type="range"
              min={3}
              max={40}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.target.value))}
              className="w-full"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={allowHealing}
                onChange={(e) => setAllowHealing(e.target.checked)}
              />
              Allow self-healing
            </label>
          </div>
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
          disabled={!goal || !url || start.isPending}
          className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground rounded px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          <Play className="w-4 h-4" />
          {start.isPending ? 'Starting…' : 'Run Scenario'}
        </button>
        {start.isError && (
          <div className="flex items-start gap-2 text-xs text-destructive p-2 border border-destructive/30 rounded">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{(start.error as Error).message}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main scenario-mode component ────────────────────────────────────────────

export default function ScenarioMode() {
  const [searchParams, setSearchParams] = useSearchParams();
  const runId = searchParams.get('runId');
  const liveSteps = useRef<StepResult[]>([]);
  const livePlan = useRef<TestPlan | null>(null);
  const [tick, setTick] = useState(0);

  const { data: runData } = useQuery<ScenarioRunResponse>({
    queryKey: ['scenario-run', runId],
    queryFn: async () => {
      const res = await fetch(`/api/scenario-runs/${runId}`);
      if (!res.ok) throw new Error('Run not found');
      return res.json();
    },
    enabled: !!runId,
    refetchInterval: (q) => (q.state.data?.status === 'running' || q.state.data?.status === 'planning' ? 1500 : false),
  });

  useEffect(() => {
    if (!runId) return;
    liveSteps.current = [];
    livePlan.current = null;
    setTick(0);

    const wsUrl = `ws://${window.location.host}/ws/live-metrics?runId=${runId}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.kind !== 'scenario_event') return;
        const evt = msg.event;
        if (evt.type === 'plan_ready') {
          livePlan.current = evt.plan;
          setTick((t) => t + 1);
        } else if (evt.type === 'step_end') {
          // Replace if step already in list (heal retry), else append
          const idx = liveSteps.current.findIndex((s) => s.step.index === evt.result.step.index);
          if (idx >= 0) liveSteps.current[idx] = evt.result;
          else liveSteps.current.push(evt.result);
          setTick((t) => t + 1);
        }
      } catch {
        /* ignore */
      }
    };

    return () => ws.close();
  }, [runId]);

  const stopMutation = useMutation({
    mutationFn: async () => {
      await fetch(`/api/scenario-runs/${runId}/stop`, { method: 'POST' });
    },
  });

  const summary = runData?.summary;
  const plan = summary?.plan ?? livePlan.current;
  const steps = summary?.steps ?? liveSteps.current;
  const isRunning = runData?.status === 'running' || runData?.status === 'planning';
  const _ = tick;

  if (!runId) {
    return (
      <div>
        <StartScenarioForm onStart={(id) => setSearchParams({ runId: id, mode: 'scenario' })} />
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
              Goal: <span className="text-foreground">{summary.goal}</span>
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {isRunning ? (
            <>
              <span className="flex items-center gap-1.5 text-sm text-green-400">
                <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                {runData?.status === 'planning' ? 'Planning' : 'Running'}
              </span>
              <button
                onClick={() => stopMutation.mutate()}
                className="flex items-center gap-1.5 bg-destructive text-destructive-foreground text-sm px-3 py-1.5 rounded hover:bg-destructive/90"
              >
                <Square className="w-3.5 h-3.5" /> Stop
              </button>
            </>
          ) : summary ? (
            <span className={`text-sm font-medium ${
              summary.status === 'passed' ? 'text-green-500' :
              summary.status === 'failed' ? 'text-red-500' :
              'text-muted-foreground'
            }`}>
              {summary.status.toUpperCase()}
            </span>
          ) : null}
          <button
            onClick={() => setSearchParams({ mode: 'scenario' })}
            className="text-sm text-muted-foreground hover:text-foreground border border-border rounded px-3 py-1.5"
          >
            New scenario
          </button>
        </div>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-4 gap-3 mb-6">
          <div className="p-3 border border-border rounded-lg bg-card">
            <p className="text-xs text-muted-foreground">Total steps</p>
            <p className="text-2xl font-bold mt-1">{summary.totalSteps}</p>
          </div>
          <div className="p-3 border border-green-500/30 rounded-lg bg-green-500/5">
            <p className="text-xs text-green-500">Passed</p>
            <p className="text-2xl font-bold mt-1">{summary.passedSteps}</p>
          </div>
          <div className="p-3 border border-amber-500/30 rounded-lg bg-amber-500/5">
            <p className="text-xs text-amber-500">Healed</p>
            <p className="text-2xl font-bold mt-1">{summary.healedSteps}</p>
          </div>
          <div className="p-3 border border-red-500/30 rounded-lg bg-red-500/5">
            <p className="text-xs text-red-500">Failed</p>
            <p className="text-2xl font-bold mt-1">{summary.failedSteps}</p>
          </div>
        </div>
      )}

      {summary?.errorMessage && (
        <div className="border border-red-500/30 bg-red-500/5 rounded-lg p-3 mb-4 text-sm text-red-400">
          {summary.errorMessage}
        </div>
      )}

      {summary?.failureNarrative && (
        <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-amber-500" />
            <span className="text-sm font-semibold text-amber-500">AI Fix Suggestion</span>
            <span className="text-xs text-muted-foreground ml-auto">via {summary.failureNarrative.model}</span>
          </div>
          <p className="text-sm mb-2">
            <span className="font-medium text-muted-foreground">Why it broke: </span>
            {summary.failureNarrative.cause}
          </p>
          <p className="text-sm">
            <span className="font-medium text-muted-foreground">Suggested fix: </span>
            {summary.failureNarrative.fix}
          </p>
        </div>
      )}

      {/* Plan */}
      {plan && <PlanView plan={plan} />}

      {/* Steps */}
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
        Execution
        {isRunning && <span className="ml-2 text-green-400">(live — {liveSteps.current.length} steps)</span>}
      </h2>
      {steps.length === 0 ? (
        <div className="border border-border rounded-lg p-8 text-center text-muted-foreground text-sm">
          {runData?.status === 'planning' ? 'Generating test plan…' : 'Waiting for execution…'}
        </div>
      ) : (
        <div>
          {steps.map((s) => (
            <ScenarioStepRow key={s.step.index} result={s} />
          ))}
        </div>
      )}
    </div>
  );
}
