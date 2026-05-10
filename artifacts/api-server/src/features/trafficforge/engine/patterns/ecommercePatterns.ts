import type { DetectedBug, DetectorContext, PatternMatcher } from '../../types/bug.js';

export const ecommercePatterns: PatternMatcher = {
  name: 'ecommerce',
  detect(ctx: DetectorContext): DetectedBug[] {
    if (ctx.appType !== 'ecommerce') return [];
    const bugs: DetectedBug[] = [];

    const cartActions = ctx.events.filter((e) => {
      const t = e.action.selector ?? e.action.url ?? '';
      return /cart|checkout|add-to-cart/.test(t);
    });

    const failed = cartActions.filter((e) => e.result === 'failed');
    if (failed.length > 0) {
      bugs.push({
        id: `ecom-cart-${Date.now()}`,
        type: 'data_inconsistency',
        severity: 'high',
        title: 'Cart inconsistency',
        description: `${failed.length} cart operations failed`,
        evidence: failed.slice(0, 3).map((e) => ({
          type: 'event' as const,
          description: e.errorMessage ?? 'Cart op failed',
          events: [e],
          timestamp: e.timestamp,
        })),
        confidence: 0.8,
        appType: 'ecommerce',
        detectedAt: Date.now(),
      });
    }
    return bugs;
  },
};
