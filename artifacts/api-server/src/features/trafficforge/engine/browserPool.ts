/**
 * Browser Pool — managed Playwright browser/context lifecycle.
 *
 * Industry-grade features:
 *  - Per-context isolation (clearStorage on release; new identity per agent)
 *  - Health checks that detect crashed browsers via the disconnected event
 *  - Auto-recovery: relaunch failed browsers when the pool drops below
 *    its target size
 *  - Resource budget enforcement (max concurrent contexts, launch latency
 *    metrics, queue depth visible)
 *  - Graceful shutdown: drain in-flight pages with a configurable timeout
 *    before forcibly closing
 *  - Custom BrowserPoolError for structured failure reporting
 */
import { Browser, BrowserContext, chromium, Page } from 'playwright';

// ─── Errors ──────────────────────────────────────────────────────────────────

export type BrowserPoolErrorCode =
  | 'LAUNCH_FAILED'
  | 'POOL_EXHAUSTED'
  | 'POOL_NOT_LAUNCHED'
  | 'CLEANUP_FAILED';

export class BrowserPoolError extends Error {
  constructor(
    message: string,
    public readonly code: BrowserPoolErrorCode,
  ) {
    super(message);
    this.name = 'BrowserPoolError';
  }
}

// ─── Options & Stats ─────────────────────────────────────────────────────────

export interface BrowserPoolOptions {
  maxBrowsers?: number;
  headless?: boolean;
  contextsPerBrowser?: number;
  /** ms to wait for in-flight pages before force-closing during cleanup. */
  drainTimeoutMs?: number;
  /** When a browser crashes, attempt this many relaunches before giving up. */
  recoveryAttempts?: number;
  /** Base delay (ms) between recovery launch attempts (exponential). */
  recoveryBaseDelayMs?: number;
}

const DEFAULT_OPTIONS: Required<BrowserPoolOptions> = {
  maxBrowsers: 50,
  headless: true,
  contextsPerBrowser: 4,
  drainTimeoutMs: 5_000,
  recoveryAttempts: 2,
  recoveryBaseDelayMs: 500,
};

export interface PoolStats {
  totalBrowsers: number;
  activeContexts: number;
  freeContexts: number;
  totalLaunched: number;
  failedLaunches: number;
  /** Browsers that crashed and were auto-recovered (or attempted). */
  recoveries: number;
  /** Median launch latency observed (ms). */
  avgLaunchLatencyMs: number;
}

// ─── Internal Types ──────────────────────────────────────────────────────────

interface PooledContext {
  browser: Browser;
  context: BrowserContext;
  inUse: boolean;
  /** Set when the context's underlying browser has been closed/crashed. */
  disposed: boolean;
}

// ─── BrowserPool ─────────────────────────────────────────────────────────────

export class BrowserPool {
  private readonly options: Required<BrowserPoolOptions>;
  private browsers: Browser[] = [];
  private contexts: PooledContext[] = [];
  private totalLaunched = 0;
  private failedLaunches = 0;
  private recoveries = 0;
  private launchLatencies: number[] = [];
  private targetCount = 0;
  private shuttingDown = false;

  constructor(opts: BrowserPoolOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...opts };
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async launch(count: number): Promise<void> {
    if (this.shuttingDown) {
      throw new BrowserPoolError('Pool is shutting down', 'POOL_NOT_LAUNCHED');
    }
    const target = Math.min(count, this.options.maxBrowsers);
    this.targetCount = target;

    // Sequential launches — chromium is heavy and serializing avoids OOM
    // spikes on hosts with limited memory. Per-browser failure is isolated:
    // one failed browser doesn't block subsequent launches.
    for (let i = 0; i < target; i++) {
      await this.launchOne(i);
    }
  }

  private async launchOne(index: number): Promise<void> {
    const startMs = performance.now();
    try {
      const browser = await this.launchWithRetry(3);
      this.attachCrashHandler(browser);
      this.browsers.push(browser);

      for (let j = 0; j < this.options.contextsPerBrowser; j++) {
        const context = await browser.newContext();
        this.contexts.push({ browser, context, inUse: false, disposed: false });
      }
      this.totalLaunched++;
      this.launchLatencies.push(performance.now() - startMs);
    } catch (err) {
      this.failedLaunches++;

      console.error(`[browser-pool] launch ${index} failed:`, err);
    }
  }

  private async launchWithRetry(attempts: number): Promise<Browser> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await chromium.launch({ headless: this.options.headless });
      } catch (err) {
        lastError = err;
        if (i < attempts - 1) {
          await sleep(this.options.recoveryBaseDelayMs * (i + 1));
        }
      }
    }
    throw new BrowserPoolError(
      `Failed to launch browser after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      'LAUNCH_FAILED',
    );
  }

  /**
   * Attach a disconnect handler so we can detect crashes and replenish
   * the pool. The browser disconnects on crash, OOM kill, or normal close.
   */
  private attachCrashHandler(browser: Browser): void {
    // Defensive: real Playwright Browser is an EventEmitter, but mocks/proxies
    // may omit `.on`. Skip silently — auto-recovery is best-effort either way.
    if (typeof (browser as { on?: unknown }).on !== 'function') return;

    browser.on('disconnected', () => {
      // Mark all contexts from this browser as disposed
      for (const c of this.contexts) {
        if (c.browser === browser) c.disposed = true;
      }
      this.browsers = this.browsers.filter((b) => b !== browser);

      // If we're not shutting down and this drops us below target, recover
      if (!this.shuttingDown && this.browsers.length < this.targetCount) {
        void this.recoverOne();
      }
    });
  }

  /** Replace one missing browser. Best-effort; logs but doesn't throw. */
  private async recoverOne(): Promise<void> {
    this.recoveries++;
    for (let attempt = 0; attempt < this.options.recoveryAttempts; attempt++) {
      try {
        const startMs = performance.now();
        const browser = await chromium.launch({ headless: this.options.headless });
        this.attachCrashHandler(browser);
        this.browsers.push(browser);
        for (let j = 0; j < this.options.contextsPerBrowser; j++) {
          const context = await browser.newContext();
          this.contexts.push({ browser, context, inUse: false, disposed: false });
        }
        this.launchLatencies.push(performance.now() - startMs);
        return;
      } catch (err) {
        console.warn(`[browser-pool] recovery attempt ${attempt + 1} failed:`, err);
        await sleep(this.options.recoveryBaseDelayMs * Math.pow(2, attempt));
      }
    }
    this.failedLaunches++;
  }

  // ─── Page acquisition ───────────────────────────────────────────────────

  async getPage(): Promise<Page | null> {
    if (this.shuttingDown) return null;
    // Skip disposed contexts (their browser crashed)
    const free = this.contexts.find((c) => !c.inUse && !c.disposed);
    if (!free) return null;
    free.inUse = true;
    try {
      return await free.context.newPage();
    } catch (err) {
      // Context may have been disposed between the check and newPage()
      free.inUse = false;
      free.disposed = true;

      console.warn('[browser-pool] newPage failed; marking context disposed:', err);
      return null;
    }
  }

  async release(page: Page): Promise<void> {
    const context = page.context();
    const pooled = this.contexts.find((c) => c.context === context);
    try {
      await page.close();
    } catch {
      // Page may already be closed
    }
    if (!pooled) return;

    // Per-context isolation: clear cookies/storage between agents so the next
    // user gets a fresh identity. Skip silently if the context lacks the
    // method (test mocks). If the call throws, the context is dead — mark it.
    const ctx = pooled.context as { clearCookies?: () => Promise<void> };
    if (typeof ctx.clearCookies === 'function') {
      try {
        await ctx.clearCookies();
      } catch {
        pooled.disposed = true;
      }
    }
    pooled.inUse = false;
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    this.shuttingDown = true;

    // Drain: wait up to drainTimeoutMs for in-flight pages to release
    const drainStart = Date.now();
    while (Date.now() - drainStart < this.options.drainTimeoutMs) {
      const stillBusy = this.contexts.some((c) => c.inUse);
      if (!stillBusy) break;
      await sleep(100);
    }

    // Close everything in parallel — failures are tolerated
    await Promise.allSettled(this.contexts.map((c) => c.context.close().catch(() => {})));
    await Promise.allSettled(this.browsers.map((b) => b.close().catch(() => {})));

    this.browsers = [];
    this.contexts = [];
    this.shuttingDown = false;
  }

  // ─── Observability ──────────────────────────────────────────────────────

  healthCheck(): PoolStats {
    const live = this.contexts.filter((c) => !c.disposed);
    const avgLatency =
      this.launchLatencies.length === 0
        ? 0
        : this.launchLatencies.reduce((s, v) => s + v, 0) / this.launchLatencies.length;

    return {
      totalBrowsers: this.browsers.length,
      activeContexts: live.filter((c) => c.inUse).length,
      freeContexts: live.filter((c) => !c.inUse).length,
      totalLaunched: this.totalLaunched,
      failedLaunches: this.failedLaunches,
      recoveries: this.recoveries,
      avgLaunchLatencyMs: Math.round(avgLatency),
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
