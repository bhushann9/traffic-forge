/**
 * Reporter — generates structured bug analysis reports using any supported LLM.
 *
 * Provider-agnostic via the LLMClient abstraction (default: Ollama, free
 * fallbacks: Groq, Anthropic). Configure via LLM_PROVIDER env var.
 *
 * Features:
 *  - Tool use for structured JSON output (no regex parsing)
 *  - Per-bug analysis with detailed heuristic fallback
 *  - Cross-provider fallback chain
 *  - Per-request cost tracking (zero for free providers)
 */
import type { TestReport, BugReport, ReportMetrics, ReporterInput } from '../types/report.js';
import type { DetectedBug, BugType } from '../types/bug.js';
import type { AgentEvent } from './agentExecutor.js';
import {
  getLLMClient,
  type LLMClient,
  type ToolSchema,
  zeroUsage,
  LLMProviderError,
  type TokenUsage,
} from '../../../shared/llm/index.js';

// ─── Cost Tracking (re-exported for backwards compatibility) ─────────────────

export interface ReporterCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
}

function addCost(a: ReporterCost, b: TokenUsage): ReporterCost {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimatedUsd: a.estimatedUsd + b.estimatedUsd,
  };
}

// ─── Static System Prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert web application security and reliability engineer.
Your job is to perform root cause analysis on bugs detected during concurrent load testing.

For each bug, you must:
1. Identify the precise root cause — what in the server/database/networking causes this
2. Provide a concrete, actionable fix — specific code patterns or architectural changes
3. List reproduction steps — exact actions a developer can take to reproduce the bug
4. Assess exploitability — whether this is a data integrity risk or a UX degradation

Common bug patterns and their root causes:
- race_condition: Missing serialization (mutex, transaction, optimistic locking) on shared state
- persistence_failure: Async write not awaited before read, or missing write confirmation
- realtime_sync_failure: WebSocket fan-out failure, dropped pub/sub events, or missing heartbeats
- data_inconsistency: Cache staleness, missing cache invalidation, or split-brain state
- order_violation: Client-side ordering without server timestamp, or missing ORDER BY clause
- visibility_failure: Missing broadcast after write, or subscriber not receiving events

Your analysis must be specific to the app type and concrete about the fix.`;

// ─── Tool Schema ──────────────────────────────────────────────────────────────

const ANALYZE_BUG_TOOL: ToolSchema = {
  name: 'analyze_bug',
  description: 'Perform root cause analysis on a detected bug from load testing',
  parameters: {
    type: 'object',
    properties: {
      rootCause: {
        type: 'string',
        description: 'Precise technical root cause (1-3 sentences, specific to the bug type and app)',
      },
      suggestedFix: {
        type: 'string',
        description: 'Concrete actionable fix with specific code patterns or architecture changes',
      },
      reproductionSteps: {
        type: 'array',
        items: { type: 'string' },
        description: '3-5 concrete steps to reproduce the bug in development',
      },
      severity: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Reassessed severity based on analysis',
      },
    },
    required: ['rootCause', 'suggestedFix', 'reproductionSteps', 'severity'],
  },
};

// ─── Reporter ─────────────────────────────────────────────────────────────────

export class Reporter {
  private readonly llm: LLMClient;

  constructor(opts: { llm?: LLMClient } = {}) {
    this.llm = opts.llm ?? getLLMClient();
  }

  async generateReport(input: ReporterInput): Promise<TestReport & { cost: ReporterCost }> {
    let totalCost: ReporterCost = zeroUsage();
    const enrichedBugs: BugReport[] = [];

    for (const bug of input.bugs) {
      const { analysis, cost } = await this.analyzeBug(bug, input);
      enrichedBugs.push({ bug, ...analysis });
      totalCost = addCost(totalCost, cost);
    }

    const metrics = this.computeMetrics(input.events);
    const summary = this.buildSummary(input, enrichedBugs);
    const recommendations = this.deduplicateRecommendations(enrichedBugs);

    return {
      id: `report-${Date.now()}`,
      url: input.url,
      appType: input.appType,
      summary,
      bugs: enrichedBugs,
      metrics,
      recommendations,
      generatedAt: Date.now(),
      cost: totalCost,
    };
  }

  // ─── Private: Bug Analysis ────────────────────────────────────────────────

  private async analyzeBug(
    bug: DetectedBug,
    input: ReporterInput,
  ): Promise<{
    analysis: { rootCause: string; suggestedFix: string; reproductionSteps: string[] };
    cost: TokenUsage;
  }> {
    if (!this.llm.available) {
      return { analysis: this.buildHeuristicAnalysis(bug), cost: zeroUsage() };
    }

    try {
      const evidenceSummary = bug.evidence
        .slice(0, 3)
        .map((e) => `- ${e.type}: ${e.description}`)
        .join('\n');

      const userPrompt = `Analyze this bug detected during concurrent load testing:

Bug Title: ${bug.title}
Bug Type: ${bug.type}
Severity: ${bug.severity}
Confidence: ${Math.round(bug.confidence * 100)}%
Description: ${bug.description}

App Type: ${input.appType}
URL: ${input.url}

Evidence:
${evidenceSummary || 'No evidence collected'}`;

      const { result, usage } = await this.llm.generateWithTool<{
        rootCause: string;
        suggestedFix: string;
        reproductionSteps: string[];
        severity: 'high' | 'medium' | 'low';
      }>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        tool: ANALYZE_BUG_TOOL,
        maxTokens: 1_024,
      });

      return {
        analysis: {
          rootCause: result.rootCause,
          suggestedFix: result.suggestedFix,
          reproductionSteps: result.reproductionSteps,
        },
        cost: usage,
      };
    } catch (err) {
      if (err instanceof LLMProviderError) {
        // eslint-disable-next-line no-console
        console.warn(`[Reporter] LLM ${err.provider} failed [${err.code}]; using heuristic`);
      }
      return { analysis: this.buildHeuristicAnalysis(bug), cost: zeroUsage() };
    }
  }

  // ─── Heuristic Fallback ───────────────────────────────────────────────────

  private buildHeuristicAnalysis(bug: DetectedBug): {
    rootCause: string;
    suggestedFix: string;
    reproductionSteps: string[];
  } {
    const heuristics: Record<BugType, { rootCause: string; suggestedFix: string }> = {
      race_condition: {
        rootCause:
          'Concurrent writes without proper synchronization — multiple requests modify the same resource without serialization, causing lost updates or corrupt state.',
        suggestedFix:
          'Wrap the critical section in a database transaction with SELECT FOR UPDATE, or use optimistic locking with version numbers to detect and reject stale writes.',
      },
      persistence_failure: {
        rootCause:
          'Async write not awaited before the next read — the server responds with a 200 before the write has committed, causing the subsequent read to see stale data.',
        suggestedFix:
          'Ensure all writes are awaited and flushed before responding. Use RETURNING clauses in SQL or MongoDB\'s { writeConcern: { w: "majority" } } to confirm persistence.',
      },
      realtime_sync_failure: {
        rootCause:
          'WebSocket broadcast not triggered after write, or pub/sub subscriber missing the event due to a race between subscription and publish.',
        suggestedFix:
          'Broadcast the updated state inside the same transaction that commits the write. Add message delivery acknowledgment and retry logic for dropped events.',
      },
      data_inconsistency: {
        rootCause:
          'Cache not invalidated after write — clients see stale data because the cache TTL has not expired and no explicit invalidation was triggered on mutation.',
        suggestedFix:
          'Implement cache invalidation on write: either delete the cache key immediately after the write succeeds, or use write-through caching.',
      },
      order_violation: {
        rootCause:
          'Items ordered by client-side timestamp instead of server timestamp — clients submit events with their local clock, which can be skewed or out of order.',
        suggestedFix:
          'Use a server-assigned timestamp or auto-increment ID for ordering. Add ORDER BY server_timestamp DESC in all queries that return ordered lists.',
      },
      visibility_failure: {
        rootCause:
          'Update not broadcast to all connected clients — the write succeeds but the pub/sub fan-out fails or the subscriber was not registered before the event fired.',
        suggestedFix:
          'Move the broadcast call to after the database write succeeds. Use a message queue (Redis Streams, SQS) to decouple broadcast from the write path.',
      },
      unknown: {
        rootCause: 'Root cause could not be determined from available evidence. More instrumentation is needed to isolate the failure.',
        suggestedFix:
          'Add structured logging around the failing operation, capture request correlation IDs, and replay the load test with verbose logging enabled.',
      },
    };

    const h = heuristics[bug.type] ?? heuristics.unknown;
    return {
      ...h,
      reproductionSteps: [
        `Open ${bug.appType ?? 'the application'} in multiple browser tabs simultaneously`,
        `Perform the action described in: "${bug.title}"`,
        `Compare state across tabs after the concurrent operations complete`,
        `Check server logs for errors during the concurrent window`,
      ],
    };
  }

  // ─── Metrics & Summary ────────────────────────────────────────────────────

  private computeMetrics(events: AgentEvent[]): ReportMetrics {
    const failed = events.filter((e) => e.result === 'failed').length;
    const totalDuration = events.reduce((sum, e) => sum + (e.duration ?? 0), 0);
    const start = events.length ? Math.min(...events.map((e) => e.timestamp)) : 0;
    const end = events.length ? Math.max(...events.map((e) => e.timestamp)) : 0;

    return {
      totalEvents: events.length,
      failedEvents: failed,
      avgDuration: events.length ? Math.round(totalDuration / events.length) : 0,
      uniqueAgents: 0, // populated by caller who has agent context
      testDurationMs: end - start,
    };
  }

  private buildSummary(input: ReporterInput, bugs: BugReport[]): string {
    const high = bugs.filter((b) => b.bug.severity === 'high').length;
    const medium = bugs.filter((b) => b.bug.severity === 'medium').length;
    const low = bugs.filter((b) => b.bug.severity === 'low').length;
    const total = bugs.length;

    if (total === 0) {
      return `No bugs detected on ${input.url} (${input.appType}) during concurrent load testing.`;
    }

    const severityStr = [
      high > 0 ? `${high} high` : '',
      medium > 0 ? `${medium} medium` : '',
      low > 0 ? `${low} low` : '',
    ]
      .filter(Boolean)
      .join(', ');

    return `Detected ${total} issue${total !== 1 ? 's' : ''} on ${input.url} (${input.appType}): ${severityStr} severity. Immediate attention required for high-severity bugs.`;
  }

  private deduplicateRecommendations(bugs: BugReport[]): string[] {
    const seen = new Set<string>();
    const recs: string[] = [];
    for (const b of bugs) {
      if (b.suggestedFix && !seen.has(b.suggestedFix)) {
        seen.add(b.suggestedFix);
        recs.push(b.suggestedFix);
      }
    }
    return recs;
  }
}
