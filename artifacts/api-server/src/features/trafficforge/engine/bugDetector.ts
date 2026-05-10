/**
 * Bug Detector — finds race conditions, persistence issues, and sync failures
 * using real distributed-systems algorithms instead of magic-number heuristics.
 *
 * Algorithms:
 *  - Vector clocks for true causal concurrency detection (Fidge/Mattern 1988-1989)
 *  - Lamport timestamps for total ordering of events
 *  - Bayesian inference for confidence scoring (no more 0.75 magic numbers)
 *  - Welch's t-test for statistical detection of latency anomalies
 *  - Median Absolute Deviation for outlier detection
 *
 * Each detector returns DetectedBug objects with mathematically grounded
 * confidence scores derived from compounded evidence.
 */
import type { DetectedBug, DetectorContext, PatternMatcher, BugEvidence } from '../types/bug.js';
import type { AgentEvent } from './agentExecutor.js';
import { VectorClock, lamportTimestamp } from './algorithms/vectorClock.js';
import {
  compoundEvidence,
  featureToLikelihood,
  type BugTypeKey,
  type EvidenceLikelihood,
} from './algorithms/bayesian.js';
import { describe, welchTTest, findOutliers } from './algorithms/statistics.js';

// ─── Error Class ──────────────────────────────────────────────────────────────

export class BugDetectorError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'BugDetectorError';
  }
}

// ─── Internal Types ───────────────────────────────────────────────────────────

type EnrichedEvent = Omit<AgentEvent, 'vectorClock' | 'lamport' | 'agentId'> & {
  agentId: string;
  vectorClock: VectorClock;
  lamport: number;
};

/** Strip the rich VectorClock instance back to a plain record before exposing. */
function toAgentEvent(e: EnrichedEvent): AgentEvent {
  const { vectorClock, ...rest } = e;
  return { ...rest, vectorClock: vectorClock.snapshot() };
}

// ─── Detector ─────────────────────────────────────────────────────────────────

export class BugDetector {
  private patterns: PatternMatcher[] = [];

  registerPattern(pattern: PatternMatcher): this {
    this.patterns.push(pattern);
    return this;
  }

  /**
   * Run all detectors against the event stream. Each detector contributes
   * candidate bugs scored via Bayesian inference; deduplication merges
   * detectors that agree on the same bug type+target.
   */
  detectAll(ctx: DetectorContext): DetectedBug[] {
    const enriched = this.enrichWithClocks(ctx.events);

    const bugs: DetectedBug[] = [
      ...this.detectRaceConditions(enriched, ctx),
      ...this.detectOrderViolations(enriched, ctx),
      ...this.detectPersistenceIssues(enriched, ctx),
      ...this.detectSyncFailures(enriched, ctx),
      ...this.detectDataInconsistencies(enriched, ctx),
      ...this.detectVisibilityFailures(enriched, ctx),
    ];

    for (const pattern of this.patterns) {
      try {
        bugs.push(...pattern.detect(ctx));
      } catch (err) {
        // Patterns are external; isolate their failures

        console.error(`Pattern ${pattern.name} failed:`, err);
      }
    }

    return this.deduplicateBugs(bugs);
  }

  // ─── Vector Clock Enrichment ──────────────────────────────────────────────

  /**
   * Assign each event a vector clock and Lamport timestamp.
   *
   * Each agent maintains its own logical clock that increments per action.
   * In a load test, agents act independently (they don't observe each
   * other's responses) — so cross-agent events are naturally concurrent
   * by their vector clocks unless a verify action reads back state.
   *
   * Verify actions perform a causal merge with the target's last writer
   * clock — modeling "this agent has observed that earlier write".
   */
  private enrichWithClocks(events: AgentEvent[]): EnrichedEvent[] {
    if (events.length === 0) return [];

    const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);

    const agentClocks = new Map<string, VectorClock>();
    // Track only writer clocks per target so verify actions can observe them
    const targetWriterClocks = new Map<string, VectorClock>();

    const result: EnrichedEvent[] = [];

    for (const event of sorted) {
      const agentId = event.agentId ?? this.inferAgentId(event);
      const target = this.eventTarget(event);

      let clock = agentClocks.get(agentId);
      if (!clock) {
        clock = new VectorClock();
        agentClocks.set(agentId, clock);
      }

      // Causal merge ONLY for verify (read) actions — they observe state
      if (event.action.type === 'verify') {
        const writerClock = targetWriterClocks.get(target);
        if (writerClock) clock.merge(writerClock);
      }

      clock.tick(agentId);

      // Writes update the per-target last-writer clock
      if (this.isWriteAction(event)) {
        targetWriterClocks.set(target, clock.clone());
      }

      result.push({
        ...event,
        agentId,
        vectorClock: clock.clone(),
        lamport: lamportTimestamp(clock, agentId),
      });
    }
    return result;
  }

  private inferAgentId(event: AgentEvent): string {
    return event.agentId ?? `agent-${Math.floor(event.timestamp / 1000)}`;
  }

  private eventTarget(event: AgentEvent | EnrichedEvent): string {
    return event.action.selector ?? event.action.url ?? `${event.action.type}:unknown`;
  }

  // ─── Race Condition Detection (vector clocks) ─────────────────────────────

  private detectRaceConditions(events: EnrichedEvent[], ctx: DetectorContext): DetectedBug[] {
    const bugs: DetectedBug[] = [];
    const writes = events.filter((e) => this.isWriteAction(e));

    // Group writes by target
    const writesByTarget = new Map<string, EnrichedEvent[]>();
    for (const e of writes) {
      const target = this.eventTarget(e);
      if (!writesByTarget.has(target)) writesByTarget.set(target, []);
      writesByTarget.get(target)!.push(e);
    }

    for (const [target, group] of writesByTarget) {
      if (group.length < 2) continue;

      // Find pairs of writes that are *truly concurrent* per their vector clocks
      const concurrentPairs: Array<[EnrichedEvent, EnrichedEvent]> = [];
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          if (group[i].agentId === group[j].agentId) continue;
          if (group[i].vectorClock.isConcurrentWith(group[j].vectorClock)) {
            concurrentPairs.push([group[i], group[j]]);
          }
        }
      }

      if (concurrentPairs.length === 0) continue;

      // Bayesian confidence: more concurrent pairs = more evidence
      const evidenceList: EvidenceLikelihood[] = [
        featureToLikelihood(concurrentPairs.length, 1, 0.1),
        featureToLikelihood(group.filter((e) => e.result === 'failed').length, 0.1, 0.05),
      ];
      const confidence = compoundEvidence('race_condition', evidenceList);

      const evidence: BugEvidence[] = concurrentPairs.slice(0, 3).map(([a, b]) => ({
        type: 'event' as const,
        description: `Concurrent writes from ${a.agentId} and ${b.agentId} to ${target} (vector clocks: [${formatClock(a.vectorClock)}] vs [${formatClock(b.vectorClock)}])`,
        events: [toAgentEvent(a), toAgentEvent(b)],
        timestamp: Math.min(a.timestamp, b.timestamp),
      }));

      bugs.push({
        id: `race-${hashTarget(target)}-${Date.now()}`,
        type: 'race_condition',
        severity: confidence > 0.8 ? 'high' : confidence > 0.5 ? 'medium' : 'low',
        title: `Race condition on ${truncate(target, 40)}`,
        description: `${concurrentPairs.length} concurrent write pair${concurrentPairs.length !== 1 ? 's' : ''} detected via vector clock analysis (${concurrentPairs.length}/${(group.length * (group.length - 1)) / 2} pairs concurrent)`,
        evidence,
        confidence,
        appType: ctx.appType,
        detectedAt: Date.now(),
      });
    }
    return bugs;
  }

  // ─── Order Violation Detection (Lamport) ──────────────────────────────────

  private detectOrderViolations(events: EnrichedEvent[], ctx: DetectorContext): DetectedBug[] {
    if (events.length < 5) return [];

    const bugs: DetectedBug[] = [];

    // Detect when wall-clock ordering disagrees with Lamport ordering
    // — that's the signature of clock-skew-driven order violations.
    const sortedByTime = [...events].sort((a, b) => a.timestamp - b.timestamp);
    let inversions = 0;
    const samples: EnrichedEvent[] = [];

    for (let i = 1; i < sortedByTime.length; i++) {
      const prev = sortedByTime[i - 1];
      const curr = sortedByTime[i];
      // If wall-clock says prev < curr but Lamport says prev > curr, we have
      // an inversion (the events were causally reversed but timestamps lie).
      if (prev.lamport > curr.lamport && prev.agentId !== curr.agentId) {
        inversions++;
        if (samples.length < 3) samples.push(curr);
      }
    }

    if (inversions === 0) return [];

    const inversionRate = inversions / (sortedByTime.length - 1);
    const confidence = compoundEvidence('order_violation', [
      featureToLikelihood(inversionRate, 0.05, 0.02),
      featureToLikelihood(inversions, 3, 0.05),
    ]);

    if (confidence < 0.4) return [];

    bugs.push({
      id: `order-${Date.now()}`,
      type: 'order_violation',
      severity: confidence > 0.75 ? 'high' : 'medium',
      title: 'Causal ordering violation detected',
      description: `${inversions} timestamp/Lamport inversions (${(inversionRate * 100).toFixed(1)}% of adjacent pairs). Suggests events ordered by client clock instead of server-side sequence.`,
      evidence: samples.map((e) => ({
        type: 'timing' as const,
        description: `Event from ${e.agentId} at ${e.timestamp}ms had Lamport=${e.lamport} (out of order)`,
        events: [toAgentEvent(e)],
        timestamp: e.timestamp,
      })),
      confidence,
      appType: ctx.appType,
      detectedAt: Date.now(),
    });

    return bugs;
  }

  // ─── Persistence Failure Detection (Bayesian) ─────────────────────────────

  private detectPersistenceIssues(events: EnrichedEvent[], ctx: DetectorContext): DetectedBug[] {
    const writes = events.filter((e) => this.isWriteAction(e));
    if (writes.length === 0) return [];

    const failures = writes.filter((e) => e.result === 'failed');
    if (failures.length === 0) return [];

    const failureRate = failures.length / writes.length;
    const confidence = compoundEvidence('persistence_failure', [
      featureToLikelihood(failureRate, 0.05, 0.02),
      featureToLikelihood(failures.length, 3, 0.05),
    ]);

    if (confidence < 0.45) return [];

    return [
      {
        id: `persist-${Date.now()}`,
        type: 'persistence_failure',
        severity: failureRate > 0.2 ? 'high' : confidence > 0.7 ? 'medium' : 'low',
        title: 'Persistence failures under load',
        description: `${failures.length}/${writes.length} writes failed (${(failureRate * 100).toFixed(1)}%). P(real bug | evidence) = ${(confidence * 100).toFixed(0)}%.`,
        evidence: failures.slice(0, 5).map((e) => ({
          type: 'event' as const,
          description: e.errorMessage ?? 'Write failed without error message',
          events: [toAgentEvent(e)],
          timestamp: e.timestamp,
        })),
        confidence,
        appType: ctx.appType,
        detectedAt: Date.now(),
      },
    ];
  }

  // ─── Sync Failure Detection (Welch's t-test) ──────────────────────────────

  private detectSyncFailures(events: EnrichedEvent[], ctx: DetectorContext): DetectedBug[] {
    if (ctx.agentCount < 2 || events.length < 10) return [];

    const bugs: DetectedBug[] = [];

    // Compare durations across two halves of the test — if the second half
    // is statistically significantly slower, real-time sync is degrading.
    const sortedByTime = [...events].sort((a, b) => a.timestamp - b.timestamp);
    const half = Math.floor(sortedByTime.length / 2);
    const firstDurations = sortedByTime.slice(0, half).map((e) => e.duration);
    const secondDurations = sortedByTime.slice(half).map((e) => e.duration);

    const tTest = welchTTest(firstDurations, secondDurations);
    const firstStats = describe(firstDurations);
    const secondStats = describe(secondDurations);

    // Detect significant degradation (one-sided: second is slower)
    const meanRatio = secondStats.mean / Math.max(1, firstStats.mean);
    if (tTest.significant && meanRatio > 1.3) {
      const confidence = compoundEvidence('realtime_sync_failure', [
        featureToLikelihood(meanRatio, 1.5, 0.1),
        featureToLikelihood(1 - tTest.pValue, 0.95, 0.5),
      ]);

      bugs.push({
        id: `sync-${Date.now()}`,
        type: 'realtime_sync_failure',
        severity: meanRatio > 2 ? 'high' : 'medium',
        title: 'Real-time sync degrading under load',
        description: `Second half of test is ${meanRatio.toFixed(2)}× slower than first half (Welch's t=${tTest.t.toFixed(2)}, p=${tTest.pValue.toFixed(4)}). Real-time channels are not keeping up with writes.`,
        evidence: [
          {
            type: 'timing' as const,
            description: `First half: mean=${firstStats.mean.toFixed(0)}ms, p95=${firstStats.p95.toFixed(0)}ms (n=${firstStats.count})`,
            timestamp: firstDurations.length > 0 ? sortedByTime[0].timestamp : Date.now(),
          },
          {
            type: 'timing' as const,
            description: `Second half: mean=${secondStats.mean.toFixed(0)}ms, p95=${secondStats.p95.toFixed(0)}ms (n=${secondStats.count})`,
            timestamp: sortedByTime[sortedByTime.length - 1]?.timestamp ?? Date.now(),
          },
        ],
        confidence,
        appType: ctx.appType,
        detectedAt: Date.now(),
      });
    }

    // Outlier detection — events that took dramatically longer than the rest
    const allDurations = events.map((e) => e.duration);
    const outlierIndices = findOutliers(allDurations, 3.5);
    if (outlierIndices.length > Math.max(3, events.length * 0.05)) {
      const stats = describe(allDurations);
      const outliers = outlierIndices.map((i) => events[i]);
      const confidence = compoundEvidence('realtime_sync_failure', [
        featureToLikelihood(outlierIndices.length / events.length, 0.05, 0.02),
      ]);

      bugs.push({
        id: `outliers-${Date.now()}`,
        type: 'realtime_sync_failure',
        severity: outlierIndices.length > events.length * 0.15 ? 'high' : 'medium',
        title: 'Anomalous latency outliers',
        description: `${outlierIndices.length} events have latency >3.5σ above median (modified z-score). Median=${stats.median.toFixed(0)}ms but max=${stats.max.toFixed(0)}ms.`,
        evidence: outliers.slice(0, 3).map((e) => ({
          type: 'timing' as const,
          description: `Action '${e.action.type}' on ${e.agentId} took ${e.duration.toFixed(0)}ms (median ${stats.median.toFixed(0)}ms)`,
          events: [toAgentEvent(e)],
          timestamp: e.timestamp,
        })),
        confidence,
        appType: ctx.appType,
        detectedAt: Date.now(),
      });
    }

    return bugs;
  }

  // ─── Data Inconsistency (error pattern clustering) ────────────────────────

  private detectDataInconsistencies(events: EnrichedEvent[], ctx: DetectorContext): DetectedBug[] {
    const bugs: DetectedBug[] = [];
    const errorGroups = new Map<string, EnrichedEvent[]>();

    for (const e of events) {
      if (e.result !== 'failed' || !e.errorMessage) continue;
      const normalized = normalizeError(e.errorMessage);
      if (!errorGroups.has(normalized)) errorGroups.set(normalized, []);
      errorGroups.get(normalized)!.push(e);
    }

    for (const [errorPattern, group] of errorGroups) {
      if (group.length < 3) continue;

      // Check if errors are concentrated on specific agents (hot spot)
      const agentSet = new Set(group.map((e) => e.agentId));
      const agentConcentration = group.length / Math.max(1, agentSet.size);

      const confidence = compoundEvidence('data_inconsistency', [
        featureToLikelihood(group.length, 5, 0.1),
        featureToLikelihood(agentConcentration, 2, 0.05),
      ]);

      if (confidence < 0.4) continue;

      bugs.push({
        id: `inconsist-${hashTarget(errorPattern)}-${Date.now()}`,
        type: 'data_inconsistency',
        severity: confidence > 0.7 ? 'high' : 'medium',
        title: `Recurring error pattern: ${truncate(errorPattern, 60)}`,
        description: `${group.length} occurrences across ${agentSet.size} agent${agentSet.size !== 1 ? 's' : ''}. Pattern suggests state diverging across replicas or stale cache reads.`,
        evidence: group.slice(0, 3).map((e) => ({
          type: 'event' as const,
          description: e.errorMessage ?? errorPattern,
          events: [toAgentEvent(e)],
          timestamp: e.timestamp,
        })),
        confidence,
        appType: ctx.appType,
        detectedAt: Date.now(),
      });
    }

    return bugs;
  }

  // ─── Visibility Failure (write-without-broadcast) ─────────────────────────

  private detectVisibilityFailures(events: EnrichedEvent[], ctx: DetectorContext): DetectedBug[] {
    if (ctx.agentCount < 2) return [];

    // Visibility failure pattern: agent A writes, agent B reads same target
    // afterward, but B doesn't see A's write (verify fails or returns stale).
    const writes = events.filter((e) => this.isWriteAction(e) && e.result === 'success');
    const verifies = events.filter((e) => e.action.type === 'verify');

    if (writes.length === 0 || verifies.length === 0) return [];

    const failedVerifies = verifies.filter((e) => e.result === 'failed');
    if (failedVerifies.length === 0) return [];

    // Cross-agent verify failures that follow successful writes
    let crossAgentFailures = 0;
    const evidence: EnrichedEvent[] = [];
    for (const verify of failedVerifies) {
      const precedingWrites = writes.filter(
        (w) =>
          w.timestamp < verify.timestamp &&
          w.agentId !== verify.agentId &&
          verify.timestamp - w.timestamp < 5000,
      );
      if (precedingWrites.length > 0) {
        crossAgentFailures++;
        if (evidence.length < 3) evidence.push(verify);
      }
    }

    if (crossAgentFailures === 0) return [];

    const confidence = compoundEvidence('visibility_failure', [
      featureToLikelihood(crossAgentFailures, 2, 0.05),
      featureToLikelihood(crossAgentFailures / Math.max(1, failedVerifies.length), 0.5, 0.1),
    ]);

    if (confidence < 0.45) return [];

    return [
      {
        id: `visibility-${Date.now()}`,
        type: 'visibility_failure',
        severity: confidence > 0.75 ? 'high' : 'medium',
        title: 'Cross-agent visibility failure',
        description: `${crossAgentFailures} verify operations failed despite a preceding successful write from a different agent. Updates not propagating across sessions.`,
        evidence: evidence.map((e) => ({
          type: 'event' as const,
          description: `Verify failed for ${e.agentId} after write from another agent`,
          events: [toAgentEvent(e)],
          timestamp: e.timestamp,
        })),
        confidence,
        appType: ctx.appType,
        detectedAt: Date.now(),
      },
    ];
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private isWriteAction(event: AgentEvent | EnrichedEvent): boolean {
    return event.action.type === 'fill' || event.action.type === 'click';
  }

  /**
   * Deduplicate bugs of the same type+target. When two detectors fire on
   * the same underlying issue, keep the higher-confidence one.
   */
  private deduplicateBugs(bugs: DetectedBug[]): DetectedBug[] {
    const byKey = new Map<string, DetectedBug>();
    for (const bug of bugs) {
      const key = `${bug.type}:${bug.title.slice(0, 30)}`;
      const existing = byKey.get(key);
      if (!existing || existing.confidence < bug.confidence) {
        byKey.set(key, bug);
      }
    }
    // Sort by severity (high first), then confidence
    const order = { high: 0, medium: 1, low: 2 };
    return Array.from(byKey.values()).sort((a, b) => {
      const s = order[a.severity] - order[b.severity];
      if (s !== 0) return s;
      return b.confidence - a.confidence;
    });
  }
}

// ─── Local Helpers ────────────────────────────────────────────────────────────

function formatClock(clock: VectorClock): string {
  const snap = clock.snapshot();
  return Object.entries(snap)
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
}

function hashTarget(target: string): string {
  // FNV-1a hash — short, deterministic, no crypto overhead
  let h = 0x811c9dc5;
  for (let i = 0; i < target.length; i++) {
    h ^= target.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function normalizeError(message: string): string {
  // Strip volatile parts (timestamps, IDs, line numbers)
  return message
    .replace(/\d{10,}/g, '<TS>')
    .replace(/[a-f0-9]{8,}/gi, '<ID>')
    .replace(/:\d+:\d+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
