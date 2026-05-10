import type { DetectedBug, DetectorContext, PatternMatcher } from '../../types/bug.js';

export const chatPatterns: PatternMatcher = {
  name: 'chat',
  detect(ctx: DetectorContext): DetectedBug[] {
    if (ctx.appType !== 'chat' && ctx.appType !== 'web') return [];
    const bugs: DetectedBug[] = [];

    const fillEvents = ctx.events.filter((e) => e.action.type === 'fill');
    const slowFills = fillEvents.filter((e) => e.duration > 2000);

    if (slowFills.length > 0) {
      bugs.push({
        id: `chat-delivery-${Date.now()}`,
        type: 'realtime_sync_failure',
        severity: 'high',
        title: 'Slow message delivery',
        description: `${slowFills.length} message sends took longer than 2 seconds`,
        evidence: slowFills.slice(0, 3).map((e) => ({
          type: 'timing' as const,
          description: `Send took ${e.duration}ms`,
          events: [e],
          timestamp: e.timestamp,
        })),
        confidence: 0.75,
        appType: 'chat',
        detectedAt: Date.now(),
      });
    }
    return bugs;
  },
};
