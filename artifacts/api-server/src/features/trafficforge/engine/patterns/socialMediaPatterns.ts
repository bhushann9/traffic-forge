import type { DetectedBug, DetectorContext, PatternMatcher } from '../../types/bug.js';

export const socialMediaPatterns: PatternMatcher = {
  name: 'socialMedia',
  detect(ctx: DetectorContext): DetectedBug[] {
    if (ctx.appType !== 'social_media' && ctx.appType !== 'web') return [];
    const bugs: DetectedBug[] = [];

    const navigations = ctx.events.filter((e) => e.action.type === 'navigate');
    const sortedByTime = [...navigations].sort((a, b) => a.timestamp - b.timestamp);

    if (sortedByTime.length >= 2) {
      const orderViolations = sortedByTime.filter((event, i) => {
        if (i === 0) return false;
        return event.timestamp < sortedByTime[i - 1].timestamp;
      });

      if (orderViolations.length > 0) {
        bugs.push({
          id: `sm-order-${Date.now()}`,
          type: 'order_violation',
          severity: 'high',
          title: 'Post ordering violation',
          description: 'Posts appear out of chronological order',
          evidence: orderViolations.slice(0, 3).map((e) => ({
            type: 'event' as const,
            description: 'Post out of order',
            events: [e],
            timestamp: e.timestamp,
          })),
          confidence: 0.7,
          appType: 'social_media',
          detectedAt: Date.now(),
        });
      }
    }
    return bugs;
  },
};
