/**
 * Agent Executor — controls Playwright browsers for load testing.
 *
 * Industry-grade features:
 *  - Pluggable action registry (add new action types without touching core)
 *  - Per-action retry with exponential backoff (transient failures)
 *  - Custom AgentError hierarchy with classification
 *  - Resource limits (max actions per execute call, max event log size)
 *  - Performance instrumentation (duration via performance.now)
 *  - Proper Playwright lifecycle (page error/close handlers)
 *  - Screenshot capture on failure with safe failure handling
 *  - Skipped/timeout result classification distinct from generic failures
 */
import { Page, errors as playwrightErrors } from 'playwright';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ActionType = 'navigate' | 'click' | 'fill' | 'wait' | 'verify' | 'screenshot';

export type AgentRole = 'chatter' | 'commenter' | 'monitor';

export type AgentResult = 'success' | 'failed' | 'skipped' | 'timeout';

export interface AgentAction {
  type: ActionType | string;
  selector?: string;
  text?: string;
  url?: string;
  assertion?: string;
  timeout?: number;
}

export interface AgentEvent {
  timestamp: number;
  action: AgentAction;
  result: AgentResult | 'success' | 'failed';
  duration: number;
  errorMessage?: string;
  errorCode?: string;
  screenshot?: string;
  attempts?: number;
  /** Agent identifier — used by the bug detector to build per-agent vector clocks. */
  agentId?: string;
  /** Lamport timestamp (logical clock value) at event time. */
  lamport?: number;
  /** Vector clock snapshot — keys are agentIds, values are their counters. */
  vectorClock?: Record<string, number>;
}

export interface AgentState {
  id: string;
  role: AgentRole;
  currentUrl?: string;
  variables: Record<string, unknown>;
}

export interface AgentExecutorOptions {
  /** Maximum actions accepted per execute() call. Prevents runaway scenarios. */
  maxActionsPerCall?: number;
  /** Maximum events retained in memory before old ones are dropped. */
  maxEventLogSize?: number;
  /** Number of retry attempts per action on transient errors. */
  maxRetriesPerAction?: number;
  /** Base delay (ms) for exponential back-off between retries. */
  retryBaseDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<AgentExecutorOptions> = {
  maxActionsPerCall: 200,
  maxEventLogSize: 1_000,
  maxRetriesPerAction: 1, // 0 = no retry, 1 = one retry, etc.
  retryBaseDelayMs: 250,
};

// ─── Error Hierarchy ─────────────────────────────────────────────────────────

export type AgentErrorCode =
  | 'TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'SELECTOR_NOT_FOUND'
  | 'PAGE_CLOSED'
  | 'UNKNOWN_ACTION'
  | 'INVALID_ACTION'
  | 'RESOURCE_LIMIT'
  | 'UNKNOWN';

export class AgentError extends Error {
  constructor(
    message: string,
    public readonly code: AgentErrorCode,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

/** Classify a thrown error into an AgentError with a stable code. */
function classifyError(err: unknown): AgentError {
  if (err instanceof AgentError) return err;
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof playwrightErrors.TimeoutError || /timeout|timed out/i.test(message)) {
    return new AgentError(message, 'TIMEOUT', true);
  }
  if (/page.*closed|target closed|page.*disposed/i.test(message)) {
    return new AgentError(message, 'PAGE_CLOSED', false);
  }
  if (/net::|navigation failed|err_/i.test(message)) {
    return new AgentError(message, 'NAVIGATION_FAILED', true);
  }
  if (/selector resolved to|element is not|not found/i.test(message)) {
    return new AgentError(message, 'SELECTOR_NOT_FOUND', false);
  }
  return new AgentError(message, 'UNKNOWN', true);
}

// ─── Action Registry ─────────────────────────────────────────────────────────

export interface ActionContext {
  page: Page;
  agent: Agent;
  event: AgentEvent;
}

export type ActionHandler = (action: AgentAction, ctx: ActionContext) => Promise<void>;

/**
 * Pluggable registry — register custom action types without touching the
 * Agent class. Built-in handlers cover the original 6 action types.
 */
export class ActionRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  register(type: string, handler: ActionHandler): this {
    this.handlers.set(type, handler);
    return this;
  }

  get(type: string): ActionHandler | undefined {
    return this.handlers.get(type);
  }

  static defaults(): ActionRegistry {
    return new ActionRegistry()
      .register('navigate', async (action, { page, agent }) => {
        if (!action.url) throw new AgentError('navigate requires url', 'INVALID_ACTION', false);
        await page.goto(action.url, {
          waitUntil: 'networkidle',
          timeout: action.timeout ?? 30_000,
        });
        agent.state.currentUrl = action.url;
      })
      .register('click', async (action, { page }) => {
        if (!action.selector)
          throw new AgentError('click requires selector', 'INVALID_ACTION', false);
        await page.click(action.selector, { timeout: action.timeout ?? 5_000 });
      })
      .register('fill', async (action, { page }) => {
        if (!action.selector)
          throw new AgentError('fill requires selector', 'INVALID_ACTION', false);
        await page.fill(action.selector, action.text ?? '', { timeout: action.timeout ?? 5_000 });
      })
      .register('wait', async (action, { page }) => {
        await page.waitForTimeout(action.timeout ?? 1_000);
      })
      .register('verify', async (action, { page }) => {
        if (!action.assertion)
          throw new AgentError('verify requires assertion', 'INVALID_ACTION', false);
        await page.waitForSelector(action.assertion, { timeout: action.timeout ?? 5_000 });
      })
      .register('screenshot', async (_action, { page, event }) => {
        const buffer = await page.screenshot();
        event.screenshot = buffer.toString('base64');
      });
  }
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export class Agent {
  readonly id: string;
  readonly role: AgentRole;
  readonly events: AgentEvent[] = [];
  readonly state: AgentState;
  page?: Page;

  private readonly options: Required<AgentExecutorOptions>;
  private readonly registry: ActionRegistry;

  constructor(
    id: string,
    role: AgentRole,
    opts: { options?: AgentExecutorOptions; registry?: ActionRegistry } = {},
  ) {
    this.id = id;
    this.role = role;
    this.options = { ...DEFAULT_OPTIONS, ...opts.options };
    this.registry = opts.registry ?? ActionRegistry.defaults();
    this.state = { id, role, variables: {} };
  }

  /**
   * Run a sequence of actions on the given page.
   * Continues past failures so all actions get attempted; the caller can
   * check hasFailures() to decide whether to retry the whole scenario.
   */
  async execute(page: Page, actions: AgentAction[]): Promise<AgentEvent[]> {
    if (actions.length > this.options.maxActionsPerCall) {
      throw new AgentError(
        `Too many actions: ${actions.length} > ${this.options.maxActionsPerCall}`,
        'RESOURCE_LIMIT',
        false,
      );
    }

    this.page = page;
    const newEvents: AgentEvent[] = [];

    // Watch for page-level errors during the run. Defensive: real Playwright
    // Page is an EventEmitter, but mocks/proxies may omit `.on`/`.off`.
    const pageErrorHandler = (err: Error) => {
      console.warn(`[agent ${this.id}] page error:`, err.message);
    };
    const ev = page as unknown as { on?: Function; off?: Function };
    if (typeof ev.on === 'function') ev.on('pageerror', pageErrorHandler);

    try {
      for (const action of actions) {
        const event = await this.runOneAction(page, action);
        newEvents.push(event);
        this.appendEvent(event);
      }
    } finally {
      if (typeof ev.off === 'function') ev.off('pageerror', pageErrorHandler);
    }

    return this.events;
  }

  private async runOneAction(page: Page, action: AgentAction): Promise<AgentEvent> {
    const startTime = performance.now();
    const event: AgentEvent = {
      timestamp: Date.now(),
      action,
      result: 'success',
      duration: 0,
      agentId: this.id,
    };

    const handler = this.registry.get(action.type);
    if (!handler) {
      event.result = 'failed';
      event.errorMessage = `Unknown action type: ${action.type}`;
      event.errorCode = 'UNKNOWN_ACTION';
      event.duration = performance.now() - startTime;
      await this.captureFallbackScreenshot(page, event);
      return event;
    }

    let attempts = 0;
    let lastError: AgentError | undefined;

    while (attempts <= this.options.maxRetriesPerAction) {
      attempts++;
      try {
        await handler(action, { page, agent: this, event });
        event.result = 'success';
        event.attempts = attempts;
        event.duration = performance.now() - startTime;
        return event;
      } catch (err) {
        lastError = classifyError(err);
        if (!lastError.retryable || attempts > this.options.maxRetriesPerAction) break;
        await sleep(this.options.retryBaseDelayMs * Math.pow(2, attempts - 1));
      }
    }

    // All attempts failed
    event.result = lastError?.code === 'TIMEOUT' ? 'timeout' : 'failed';
    event.errorMessage = lastError?.message ?? 'Unknown failure';
    event.errorCode = lastError?.code ?? 'UNKNOWN';
    event.attempts = attempts;
    event.duration = performance.now() - startTime;
    await this.captureFallbackScreenshot(page, event);
    return event;
  }

  private async captureFallbackScreenshot(page: Page, event: AgentEvent): Promise<void> {
    try {
      const buffer = await page.screenshot();
      event.screenshot = buffer.toString('base64');
    } catch {
      // Ignore — page may already be closed
    }
  }

  private appendEvent(event: AgentEvent): void {
    this.events.push(event);
    // Drop oldest events when over the cap
    if (this.events.length > this.options.maxEventLogSize) {
      this.events.splice(0, this.events.length - this.options.maxEventLogSize);
    }
  }

  // ─── Public helpers (preserved API) ────────────────────────────────────────

  getAllEvents(): AgentEvent[] {
    return this.events;
  }

  getLastEvent(): AgentEvent | undefined {
    return this.events[this.events.length - 1];
  }

  hasFailures(): boolean {
    return this.events.some((e) => e.result === 'failed' || e.result === 'timeout');
  }

  clearEvents(): void {
    this.events.length = 0;
  }
}

// ─── Event Logger ────────────────────────────────────────────────────────────

export class EventLogger {
  private readonly events: AgentEvent[] = [];

  logEvent(event: AgentEvent): void {
    this.events.push(event);
  }

  logEvents(events: AgentEvent[]): void {
    this.events.push(...events);
  }

  getAllEvents(): AgentEvent[] {
    return this.events;
  }

  getEventsByAgent(agentId: string): AgentEvent[] {
    return this.events.filter((e) => e.agentId === agentId);
  }

  clear(): void {
    this.events.length = 0;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
