/**
 * TestPlanner — generates concurrent test scenarios using any supported LLM.
 *
 * Provider-agnostic via the LLMClient abstraction (Anthropic, Groq,
 * Cerebras, Ollama, OpenRouter, DeepSeek). Default: Ollama for free local
 * inference. Configure via LLM_PROVIDER env var.
 *
 * Features:
 *  - Tool use for structured JSON output (no regex parsing)
 *  - Provider-side prompt caching where supported
 *  - Cross-provider fallback chain (e.g., Groq → Anthropic → Ollama)
 *  - Per-request cost tracking (zero for free providers)
 *  - Template fallback when no provider is reachable
 */
import type { Scenario, PlannerInput, PlannerOutput } from '../types/scenario.js';
import type { ScanResult } from './scanner.js';
import {
  getLLMClient,
  type LLMClient,
  type ToolSchema,
  zeroUsage,
  LLMProviderError,
} from '../../../shared/llm/index.js';

// ─── Error Class ──────────────────────────────────────────────────────────────

export class PlannerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PlannerError';
  }
}

// ─── Cost Tracking (re-exported for backwards compatibility) ─────────────────

export interface PlannerCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedUsd: number;
}

// ─── Static System Prompt ─────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert load testing scenario planner for web applications.
Your mission is to generate realistic, concurrent test scenarios that expose race conditions,
real-time sync failures, and performance bottlenecks under load.

Guidelines for scenario generation:
- Design multiple agents with distinct roles (chatter, commenter, monitor) acting concurrently
- Target shared-state operations: checkout flows, form submissions, live feeds, messaging
- Include at least one monitor agent to observe system responses
- Keep actions realistic (navigate → fill → click → verify pattern)
- For e-commerce: focus on cart/checkout concurrency and inventory consistency
- For SaaS/dashboards: focus on real-time data sync under concurrent writers
- For blogs/forums: focus on comment ordering and content rendering race conditions
- Expose WHY each scenario is dangerous in expectedOutcomes

Available action types:
  navigate  – { type: 'navigate', url: string }
  click     – { type: 'click', selector: string, timeout?: number }
  fill      – { type: 'fill', selector: string, text: string, timeout?: number }
  wait      – { type: 'wait', timeout: number }
  verify    – { type: 'verify', assertion: string, timeout?: number }
  screenshot – { type: 'screenshot' }`;

// ─── Tool Schema ──────────────────────────────────────────────────────────────

const SCENARIOS_TOOL: ToolSchema = {
  name: 'generate_test_scenarios',
  description: 'Generate concurrent load test scenarios for the web application',
  parameters: {
    type: 'object',
    properties: {
      scenarios: {
        type: 'array',
        description: '2-4 test scenarios targeting race conditions and sync issues',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique scenario ID (e.g. scenario-1)' },
            name: { type: 'string', description: 'Short scenario title' },
            description: { type: 'string', description: 'What this tests and why it matters' },
            appType: { type: 'string', description: 'App type matching the input' },
            agents: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  role: { type: 'string', enum: ['chatter', 'commenter', 'monitor'] },
                  count: { type: 'integer', minimum: 1, maximum: 10 },
                  actions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: {
                          type: 'string',
                          enum: ['navigate', 'click', 'fill', 'wait', 'verify', 'screenshot'],
                        },
                        url: { type: 'string' },
                        selector: { type: 'string' },
                        text: { type: 'string' },
                        timeout: { type: 'integer' },
                        assertion: { type: 'string' },
                      },
                      required: ['type'],
                    },
                  },
                },
                required: ['role', 'count', 'actions'],
              },
            },
            expectedOutcomes: {
              type: 'array',
              items: { type: 'string' },
              description: 'Bugs/issues this scenario is designed to expose',
            },
          },
          required: ['id', 'name', 'description', 'appType', 'agents', 'expectedOutcomes'],
        },
      },
      reasoning: {
        type: 'string',
        description: 'Why these scenarios were chosen for this specific app',
      },
    },
    required: ['scenarios', 'reasoning'],
  },
};

// ─── Planner ─────────────────────────────────────────────────────────────────

export class TestPlanner {
  private readonly llm: LLMClient;

  constructor(opts: { llm?: LLMClient } = {}) {
    this.llm = opts.llm ?? getLLMClient();
  }

  /** Convert a ScanResult into the planner's input format. */
  fromScanResult(scan: ScanResult): PlannerInput {
    return {
      url: scan.url,
      appType: scan.appType.detectedType,
      discoveredPaths: scan.discoveredPaths,
      forms: Object.entries(scan.forms.types).map(([type, count]) => ({ type, count })),
      features: scan.suggestedBehaviors.map((b) => b.description),
    };
  }

  /**
   * Generate test scenarios. Falls back to templates if no provider works.
   * Returns the output plus a cost breakdown for observability.
   */
  async generateScenarios(
    input: PlannerInput,
  ): Promise<PlannerOutput & { cost: PlannerCost }> {
    if (!this.llm.available) {
      return { ...this.buildTemplateScenarios(input), cost: zeroUsage() };
    }

    try {
      const { result, usage } = await this.llm.generateWithTool<{
        scenarios: Scenario[];
        reasoning: string;
      }>({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: this.buildUserPrompt(input),
        tool: SCENARIOS_TOOL,
        maxTokens: 4_096,
      });

      if (!Array.isArray(result.scenarios) || result.scenarios.length === 0) {
        throw new PlannerError('Provider returned zero scenarios', 'EMPTY_SCENARIOS', false);
      }

      return { scenarios: result.scenarios, reasoning: result.reasoning, cost: usage };
    } catch (err) {
      if (err instanceof LLMProviderError) {
        // eslint-disable-next-line no-console
        console.error(
          `[TestPlanner] LLM (${err.provider}) failed [${err.code}], using templates:`,
          err.message,
        );
      } else {
        // eslint-disable-next-line no-console
        console.error('[TestPlanner] Unexpected error, using templates:', err);
      }
      return { ...this.buildTemplateScenarios(input), cost: zeroUsage() };
    }
  }

  // ─── Private: Prompt Building ─────────────────────────────────────────────

  private buildUserPrompt(input: PlannerInput): string {
    const paths = input.discoveredPaths.slice(0, 15).join(', ') || '/';
    const forms = input.forms.map((f) => `${f.type}(×${f.count})`).join(', ') || 'none';
    const features = input.features.slice(0, 6).join('; ') || 'none';

    return `Generate load test scenarios for this web application:

URL: ${input.url}
App Type: ${input.appType}
Discovered Paths (${input.discoveredPaths.length} total): ${paths}
Form Types: ${forms}
Detected Features: ${features}

Generate 2-4 scenarios. Each must have multiple concurrent agents.
Focus on where concurrent actions would expose race conditions or sync bugs.`;
  }

  // ─── Template Fallback ────────────────────────────────────────────────────

  private buildTemplateScenarios(input: PlannerInput): PlannerOutput {
    const templates: Record<string, () => Scenario> = {
      ecommerce: () => this.ecommerceTemplate(input),
      saas: () => this.saasTemplate(input),
      blog: () => this.blogTemplate(input),
      web: () => this.genericTemplate(input),
    };

    const builder = templates[input.appType] ?? templates.web;
    return {
      scenarios: [builder()],
      reasoning: `Template-based fallback scenario for ${input.appType} application`,
    };
  }

  private ecommerceTemplate(input: PlannerInput): Scenario {
    return {
      id: `s-ecom-${Date.now()}`,
      name: 'Concurrent checkout race',
      description:
        'Multiple users add the same item and check out simultaneously, exposing inventory race conditions',
      appType: 'ecommerce',
      agents: [
        {
          role: 'chatter',
          count: 4,
          actions: [
            { type: 'navigate', url: input.url },
            { type: 'wait', timeout: 500 },
            { type: 'click', selector: '.add-to-cart, button[data-action="add"], [href*="cart"]' },
            { type: 'navigate', url: `${input.url}/checkout` },
          ],
        },
        {
          role: 'monitor',
          count: 1,
          actions: [
            { type: 'navigate', url: input.url },
            { type: 'screenshot' },
          ],
        },
      ],
      expectedOutcomes: [
        'Overselling beyond available inventory',
        'Cart state desync between concurrent sessions',
        'Checkout total inconsistency under concurrent updates',
      ],
    };
  }

  private saasTemplate(input: PlannerInput): Scenario {
    return {
      id: `s-saas-${Date.now()}`,
      name: 'Concurrent dashboard writes',
      description:
        'Multiple users update shared resources concurrently, exposing real-time sync gaps',
      appType: 'saas',
      agents: [
        {
          role: 'chatter',
          count: 3,
          actions: [
            { type: 'navigate', url: input.url },
            { type: 'wait', timeout: 1_000 },
            {
              type: 'click',
              selector: 'button[type="submit"], .save-btn, [data-action="save"]',
            },
          ],
        },
        {
          role: 'monitor',
          count: 1,
          actions: [
            { type: 'navigate', url: input.url },
            { type: 'wait', timeout: 2_000 },
            { type: 'screenshot' },
          ],
        },
      ],
      expectedOutcomes: [
        'Lost updates from concurrent saves',
        'Stale data visible to other users after write',
        'WebSocket event ordering violations',
      ],
    };
  }

  private blogTemplate(input: PlannerInput): Scenario {
    return {
      id: `s-blog-${Date.now()}`,
      name: 'Concurrent comment storm',
      description: 'Many users submit comments simultaneously, testing ordering and persistence',
      appType: 'blog',
      agents: [
        {
          role: 'commenter',
          count: 5,
          actions: [
            { type: 'navigate', url: input.url },
            { type: 'wait', timeout: 300 },
            {
              type: 'fill',
              selector: 'textarea, input[name="comment"], .comment-box',
              text: 'Test comment from agent',
            },
            { type: 'click', selector: 'button[type="submit"], .post-comment' },
          ],
        },
        {
          role: 'monitor',
          count: 1,
          actions: [
            { type: 'navigate', url: input.url },
            { type: 'wait', timeout: 3_000 },
            { type: 'screenshot' },
          ],
        },
      ],
      expectedOutcomes: [
        'Comment ordering violations (newer appears before older)',
        'Duplicate comment submission on double-click',
        'Missing comments from concurrent writers',
      ],
    };
  }

  private genericTemplate(input: PlannerInput): Scenario {
    return {
      id: `s-generic-${Date.now()}`,
      name: 'Concurrent navigation load',
      description: 'Multiple users navigate the site simultaneously under load',
      appType: 'web',
      agents: [
        {
          role: 'chatter',
          count: 3,
          actions: [
            { type: 'navigate', url: input.url },
            { type: 'wait', timeout: 500 },
          ],
        },
        {
          role: 'monitor',
          count: 1,
          actions: [
            { type: 'navigate', url: input.url },
            { type: 'screenshot' },
          ],
        },
      ],
      expectedOutcomes: [
        'Page load degradation under concurrent requests',
        'Session isolation failures',
      ],
    };
  }
}
