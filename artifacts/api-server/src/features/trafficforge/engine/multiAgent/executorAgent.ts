/**
 * Executor Agent — runs a TestPlan against a real browser via Playwright.
 *
 * No LLM calls. No reasoning. Pure execution: take a typed action, run it,
 * report success/failure. The Orchestrator wraps this with the Healer when
 * a step fails, but the Executor itself is stateless about recovery.
 *
 * Uses semantic locators (getByRole) — not CSS selectors — so tests stay
 * stable when developers change classes.
 */

import { chromium, type Browser, type BrowserContext, type Page, type Locator } from 'playwright';
import { logger } from '../../../../shared/lib/logger.js';
import type { StepAction, TestPlanStep, StepResult, StepStatus } from './types.js';

// ─── Public API ───────────────────────────────────────────────────────────────

export interface ExecutorOptions {
  stepTimeoutMs?: number;        // default 8000
  viewport?: { width: number; height: number };
  headless?: boolean;            // default true
  captureScreenshots?: boolean;  // default true
  /** Path to a saved Playwright storageState.json for pre-authenticated runs. */
  storageStatePath?: string;
}

/**
 * Holds the browser/page state across steps. One instance per scenario run.
 * Always call dispose() in a finally block.
 */
export class ExecutorAgent {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private opts: ExecutorOptions & {
    stepTimeoutMs: number;
    viewport: { width: number; height: number };
    headless: boolean;
    captureScreenshots: boolean;
  };

  // Per-step collectors — reset at the start of each runStep
  private _stepConsoleErrors: string[] = [];
  private _stepNetworkErrors: { url: string; status: number }[] = [];

  constructor(options: ExecutorOptions = {}) {
    this.opts = {
      stepTimeoutMs: options.stepTimeoutMs ?? 12_000,
      viewport: options.viewport ?? { width: 1280, height: 720 },
      headless: options.headless ?? true,
      captureScreenshots: options.captureScreenshots ?? true,
      storageStatePath: options.storageStatePath,
    };
  }

  /** Launch the browser and create a page. Must be called before runStep. */
  async start(): Promise<void> {
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    this.context = await this.browser.newContext({
      viewport: this.opts.viewport,
      ignoreHTTPSErrors: true,
      ...(this.opts.storageStatePath ? { storageState: this.opts.storageStatePath } : {}),
    });
    this.page = await this.context.newPage();

    // Wire up persistent listeners for metrics collection
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        this._stepConsoleErrors.push(msg.text().slice(0, 200));
      }
    });
    this.page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) {
        this._stepNetworkErrors.push({ url: response.url().slice(0, 200), status });
      }
    });
  }

  /** Returns the live Page so Healer can inspect DOM. Throws if not started. */
  getPage(): Page {
    if (!this.page) throw new Error('Executor not started');
    return this.page;
  }

  /**
   * Run a single step. Never throws — converts errors into a failed StepResult.
   * If `actionOverride` is provided (Healer's proposed action), runs that
   * instead of step.action; the original step description is preserved.
   */
  async runStep(step: TestPlanStep, actionOverride?: StepAction): Promise<StepResult> {
    if (!this.page) {
      return this._failed(step, Date.now(), 'Executor not started');
    }
    const action = actionOverride ?? step.action;
    const startedAt = Date.now();

    // Reset per-step collectors
    this._stepConsoleErrors = [];
    this._stepNetworkErrors = [];

    try {
      const pageLoadMs = await this._performAction(action);
      const finishedAt = Date.now();
      const screenshot = await this._maybeScreenshot();
      return {
        step,
        status: 'passed' as StepStatus,
        startedAt,
        finishedAt,
        screenshot,
        url: this.page.url(),
        ...(pageLoadMs !== undefined ? { pageLoadMs } : {}),
        ...(this._stepConsoleErrors.length > 0 ? { consoleErrors: [...this._stepConsoleErrors] } : {}),
        ...(this._stepNetworkErrors.length > 0 ? { networkErrors: [...this._stepNetworkErrors] } : {}),
      };
    } catch (err) {
      const finishedAt = Date.now();
      const screenshot = await this._maybeScreenshot();
      const message = err instanceof Error ? err.message : String(err);
      return {
        step,
        status: 'failed' as StepStatus,
        startedAt,
        finishedAt,
        error: message,
        screenshot,
        url: this.page.url(),
        ...(this._stepConsoleErrors.length > 0 ? { consoleErrors: [...this._stepConsoleErrors] } : {}),
        ...(this._stepNetworkErrors.length > 0 ? { networkErrors: [...this._stepNetworkErrors] } : {}),
      };
    }
  }

  async dispose(): Promise<void> {
    await this.page?.close().catch(() => {});
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  // ─── Private: action dispatch ───────────────────────────────────────────────

  /** Returns pageLoadMs for navigate steps, undefined for all others. */
  private async _performAction(action: StepAction): Promise<number | undefined> {
    const page = this.page!;
    const timeout = this.opts.stepTimeoutMs;

    switch (action.type) {
      case 'navigate': {
        const t0 = Date.now();
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout });
        return Date.now() - t0;
      }

      case 'click': {
        const loc = await this._resolveLocator(action.role, action.name, action.selector);
        await loc.click({ timeout });
        return undefined;
      }

      case 'fill': {
        const loc = await this._resolveLocator(action.role, action.name, action.selector);
        await loc.fill(action.value, { timeout });
        return undefined;
      }

      case 'expect_text': {
        await page.waitForFunction(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (text: string) => (document as any).body.innerText.includes(text),
          action.text,
          { timeout },
        );
        return undefined;
      }

      case 'expect_url': {
        const re = this._toRegex(action.pattern);
        await page.waitForURL(re, { timeout });
        return undefined;
      }

      case 'wait_for': {
        const loc = await this._resolveLocator(action.role, action.name, action.selector);
        await loc.waitFor({ state: 'visible', timeout });
        return undefined;
      }

      case 'wait_ms':
        await page.waitForTimeout(action.ms);
        return undefined;
    }
  }

  /**
   * Try role+name first (accessibility-first). If no match found immediately,
   * fall back to CSS selector from the DOM snapshot. This prevents 8-second
   * timeouts when the AI-generated accessible name doesn't match the real DOM.
   */
  private async _resolveLocator(role: string, name: string, selector?: string): Promise<Locator> {
    const page = this.page!;
    const byRole = page.getByRole(role as Parameters<Page['getByRole']>[0], { name });

    // Quick non-waiting check — count() never waits for elements to appear
    const count = await byRole.count().catch(() => 0);
    if (count === 1) return byRole;
    if (count > 1) {
      // Multiple matches (e.g. image + text link both named "Sauce Labs Backpack")
      // CSS selector from DOM snapshot is more precise — prefer it when available
      if (selector) {
        const bySel = page.locator(selector);
        const selCount = await bySel.count().catch(() => 0);
        if (selCount === 1) {
          logger.debug({ role, name, selector }, 'Using CSS selector (unique) over ambiguous role match');
          return bySel;
        }
        if (selCount > 1) {
          logger.debug({ role, name, selector }, 'CSS selector also ambiguous — using first()');
          return bySel.first();
        }
      }
      // No selector or selector found nothing — use first role match
      return byRole.first();
    }

    // Role+name yielded nothing — try CSS selector fallback
    if (selector) {
      const bySel = page.locator(selector);
      const selCount = await bySel.count().catch(() => 0);
      if (selCount > 0) {
        logger.debug({ role, name, selector }, 'Using CSS selector fallback');
        return selCount === 1 ? bySel : bySel.first();
      }
    }

    // Neither found — return role locator so the timeout error is descriptive
    return byRole;
  }

  private _toRegex(pattern: string): RegExp {
    // If user wrote a regex (slash-delimited), unwrap it; otherwise treat as substring
    const m = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (m) return new RegExp(m[1], m[2]);
    // Escape regex metacharacters so substrings match literally
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(escaped);
  }

  private async _maybeScreenshot(): Promise<string | null> {
    if (!this.opts.captureScreenshots || !this.page) return null;
    try {
      const buf = await this.page.screenshot({ type: 'png', fullPage: false });
      return buf.toString('base64');
    } catch (err) {
      logger.debug({ err }, 'Screenshot failed');
      return null;
    }
  }

  private _failed(step: TestPlanStep, startedAt: number, message: string): StepResult {
    return {
      step,
      status: 'failed',
      startedAt,
      finishedAt: Date.now(),
      error: message,
    };
  }
}
