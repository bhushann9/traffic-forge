/**
 * Orchestrator — LangGraph-powered state machine for the AI test pipeline.
 *
 * Pipeline: planner → detector → reporter → rca
 *
 * Built on @langchain/langgraph with:
 *  - Real StateGraph (not a hand-rolled topological sort)
 *  - Async streaming events for live progress
 *  - Per-node retry policy with exponential backoff
 *  - Checkpointing via MemorySaver for resumability
 *  - Custom OrchestratorError taxonomy
 */
import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph';
import type { ScanResult } from './scanner.js';
import type { Scenario, PlannerOutput } from '../types/scenario.js';
import type { AgentEvent } from './agentExecutor.js';
import type { DetectedBug } from '../types/bug.js';
import type { TestReport, BugReport } from '../types/report.js';
import type { RCAReport } from '../types/rca.js';

// ─── Error Class ──────────────────────────────────────────────────────────────

export class OrchestratorError extends Error {
  constructor(
    message: string,
    public readonly node: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

// ─── Progress Event Types ─────────────────────────────────────────────────────

export type ProgressEvent =
  | { type: 'node_start'; node: string; timestamp: number }
  | { type: 'node_complete'; node: string; durationMs: number; timestamp: number }
  | { type: 'node_error'; node: string; error: string; willRetry: boolean; timestamp: number }
  | { type: 'pipeline_complete'; durationMs: number; timestamp: number }
  | { type: 'pipeline_error'; error: string; timestamp: number };

export type ProgressCallback = (event: ProgressEvent) => void;

// ─── State Schema (Annotation-based) ──────────────────────────────────────────

const OrchestratorStateAnnotation = Annotation.Root({
  url: Annotation<string>(),
  appType: Annotation<string>(),
  scanResult: Annotation<ScanResult | undefined>(),
  scenarios: Annotation<Scenario[] | undefined>(),
  plannerReasoning: Annotation<string | undefined>(),
  events: Annotation<AgentEvent[]>({
    reducer: (curr, update) => [...(curr ?? []), ...(update ?? [])],
    default: () => [],
  }),
  bugs: Annotation<DetectedBug[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),
  report: Annotation<TestReport | undefined>(),
  rcaReports: Annotation<RCAReport[]>({
    reducer: (curr, update) => [...(curr ?? []), ...(update ?? [])],
    default: () => [],
  }),
  status: Annotation<'pending' | 'running' | 'complete' | 'error'>({
    reducer: (_, update) => update,
    default: () => 'pending',
  }),
  error: Annotation<string | undefined>(),
  totalCostUsd: Annotation<number>({
    reducer: (curr, update) => (curr ?? 0) + (update ?? 0),
    default: () => 0,
  }),
});

export type OrchestratorState = typeof OrchestratorStateAnnotation.State;
export type OrchestratorUpdate = typeof OrchestratorStateAnnotation.Update;

// ─── Node Handlers ────────────────────────────────────────────────────────────

export type NodeHandler = (state: OrchestratorState) => Promise<Partial<OrchestratorUpdate>>;

export interface OrchestratorNodes {
  planner: NodeHandler;
  detector: NodeHandler;
  reporter: NodeHandler;
  rca: NodeHandler;
}

// ─── Retry Wrapper ────────────────────────────────────────────────────────────

interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  onError?: (error: unknown, attempt: number) => void;
}

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Non-retryable errors bail immediately
      if (err instanceof OrchestratorError && !err.retryable) throw err;
      opts.onError?.(err, attempt);
      if (attempt < opts.maxAttempts - 1) {
        await sleep(opts.baseDelayMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Orchestrator Builder ─────────────────────────────────────────────────────

export interface CompiledOrchestrator {
  invoke(initial: Partial<OrchestratorState>): Promise<OrchestratorState>;
  stream(
    initial: Partial<OrchestratorState>,
    onProgress: ProgressCallback,
  ): Promise<OrchestratorState>;
}

export function buildOrchestrator(nodes: OrchestratorNodes): CompiledOrchestrator {
  const checkpointer = new MemorySaver();

  // Wrap each node with retry + progress events
  const wrap =
    (name: string, handler: NodeHandler): NodeHandler =>
    async (state) => {
      return withRetry(() => handler(state), {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        onError: (err, attempt) => {
          console.warn(`[orchestrator] ${name} attempt ${attempt + 1} failed:`, err);
        },
      });
    };

  const graph = new StateGraph(OrchestratorStateAnnotation)
    .addNode('planner', wrap('planner', nodes.planner))
    .addNode('detector', wrap('detector', nodes.detector))
    .addNode('reporter', wrap('reporter', nodes.reporter))
    .addNode('rca', wrap('rca', nodes.rca))
    .addEdge(START, 'planner')
    .addEdge('planner', 'detector')
    .addEdge('detector', 'reporter')
    .addEdge('reporter', 'rca')
    .addEdge('rca', END);

  const compiled = graph.compile({ checkpointer });

  return {
    async invoke(initial) {
      const threadId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await compiled.invoke(
        { ...initial, status: 'running' as const },
        { configurable: { thread_id: threadId } },
      );
      return { ...result, status: 'complete' };
    },

    async stream(initial, onProgress) {
      const threadId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const startTime = Date.now();

      let finalState: OrchestratorState | undefined;
      const nodeStartTimes = new Map<string, number>();

      try {
        const stream = await compiled.stream(
          { ...initial, status: 'running' as const },
          {
            configurable: { thread_id: threadId },
            streamMode: 'updates',
          },
        );

        for await (const chunk of stream) {
          // chunk is { [nodeName]: stateUpdate }
          for (const [nodeName, update] of Object.entries(chunk)) {
            if (!nodeStartTimes.has(nodeName)) {
              nodeStartTimes.set(nodeName, Date.now());
              onProgress({ type: 'node_start', node: nodeName, timestamp: Date.now() });
            }
            const startMs = nodeStartTimes.get(nodeName) ?? Date.now();
            onProgress({
              type: 'node_complete',
              node: nodeName,
              durationMs: Date.now() - startMs,
              timestamp: Date.now(),
            });
            // Accumulate final state from the last update
            finalState = {
              ...(finalState ?? ({} as OrchestratorState)),
              ...(update as Partial<OrchestratorState>),
            };
          }
        }

        // Retrieve the final compiled state via getState
        const snapshot = await compiled.getState({ configurable: { thread_id: threadId } });
        finalState = snapshot.values as OrchestratorState;

        onProgress({
          type: 'pipeline_complete',
          durationMs: Date.now() - startTime,
          timestamp: Date.now(),
        });

        return { ...finalState, status: 'complete' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onProgress({ type: 'pipeline_error', error: message, timestamp: Date.now() });
        throw new OrchestratorError(message, 'pipeline', false);
      }
    },
  };
}

// Re-export bug report shape for consumers
export type { BugReport };
