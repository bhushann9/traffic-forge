import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { EventEmitter } from 'events';
import { logger } from '../../../shared/lib/logger.js';
import {
  EvidenceCapture,
  fingerprintFailure,
  compareSeverity,
  type StepEvidence,
  type DetectedFailure,
  type FailureSeverity,
  type SwarmStep,
  type SwarmRunSummary,
} from './evidenceCapture.js';
import { enrichFailuresWithNarratives, type NarrativeProvider } from './narrative.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface SwarmConfig {
  targetUrl: string;
  maxSteps: number;
  stepTimeoutMs?: number;     // max ms per step (default 8000)
  thinkTimeMs?: number;       // wait between steps (default 300)
  llmProvider?: NarrativeProvider;  // LLM for fix narratives (default 'none')
  llmApiKey?: string;
  llmModel?: string;
  headless?: boolean;               // default true; set false to watch the browser
  viewport?: { width: number; height: number };
}

// ─── Events ───────────────────────────────────────────────────────────────────

export type SwarmEvent =
  | { type: 'step'; step: SwarmStep }
  | { type: 'failure'; failure: DetectedFailure }
  | { type: 'done'; summary: SwarmRunSummary }
  | { type: 'error'; message: string };

export declare interface SwarmAgent {
  on(event: 'event', listener: (e: SwarmEvent) => void): this;
  emit(event: 'event', e: SwarmEvent): boolean;
}

// ─── Clickable selector list ──────────────────────────────────────────────────

const CLICKABLE_SELECTORS = [
  'button:not([disabled])',
  'a[href]',
  'input[type="submit"]:not([disabled])',
  'input[type="button"]:not([disabled])',
  '[role="button"]:not([disabled])',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  'label[for]',
  '[data-testid]',
  '[data-action]',
];

// ─── SwarmAgent ───────────────────────────────────────────────────────────────

export class SwarmAgent extends EventEmitter {
  private aborted = false;
  private browser: Browser | null = null;

  abort(): void {
    this.aborted = true;
  }

  async run(config: SwarmConfig): Promise<SwarmRunSummary> {
    const runId = Math.random().toString(36).slice(2, 10);
    const startedAt = Date.now();
    const steps: SwarmStep[] = [];
    const allFailures: DetectedFailure[] = [];
    const failureByFingerprint = new Map<string, DetectedFailure>();

    const stepTimeout = config.stepTimeoutMs ?? 8_000;
    const thinkTime = config.thinkTimeMs ?? 300;

    logger.info({ runId, url: config.targetUrl }, 'Swarm agent starting');

    try {
      this.browser = await chromium.launch({
        headless: config.headless ?? true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    } catch (err) {
      const msg = 'Failed to launch Chromium. Is Playwright installed?';
      logger.error({ err }, msg);
      this.emit('event', { type: 'error', message: msg });
      throw new Error(msg);
    }

    let context: BrowserContext | null = null;
    let page: Page | null = null;
    const capture = new EvidenceCapture();

    // Per-page error buffers (filled by event listeners, read per-step)
    const pageErrors: Array<{ message: string; stack?: string }> = [];

    try {
      context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        viewport: config.viewport ?? { width: 1280, height: 720 },
        ignoreHTTPSErrors: true,
      });

      page = await context.newPage();
      capture.attach(page);

      // JS crash listener
      page.on('pageerror', (err) => {
        pageErrors.push({ message: err.message, stack: err.stack });
      });

      // Navigate to target
      try {
        await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      } catch (err) {
        const msg = `Failed to load ${config.targetUrl}: ${err instanceof Error ? err.message : String(err)}`;
        this.emit('event', { type: 'error', message: msg });
        return this._buildSummary(runId, config.targetUrl, steps, failureByFingerprint, startedAt);
      }

      // Drain any events from initial page load
      capture.drain();

      // ── Main swarm loop ─────────────────────────────────────────────────────
      let stuckCount = 0;
      let lastUrl = page.url();

      for (let i = 0; i < config.maxSteps && !this.aborted; i++) {
        const stepStart = Date.now();

        // 1. Screenshot before action
        const screenshotBefore = await EvidenceCapture.screenshot(page);
        const urlBefore = page.url();
        // @ts-ignore - document is available inside page.evaluate browser context
        const domBefore = await page.evaluate(() => document.body?.innerHTML ?? '').catch(() => '');
        const domSnapshotBefore = await EvidenceCapture.domSnapshot(page);

        // If stuck on same URL for 3+ consecutive steps, go back to start
        const currentUrl = page.url();
        if (currentUrl === lastUrl) {
          stuckCount++;
        } else {
          stuckCount = 0;
          lastUrl = currentUrl;
        }
        if (stuckCount >= 3) {
          await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
          stuckCount = 0;
          lastUrl = page.url();
          capture.drain();
          continue;
        }

        // 2. Pick a random clickable element
        const { selector, elementIdx, text, found } = await this._pickRandomElement(page);
        if (!found) {
          // No clickable elements — go back to start
          await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
          stuckCount = 0;
          lastUrl = page.url();
          capture.drain();
          continue;
        }

        // 3. Drain buffers right before action (clean slate for this step)
        capture.drain();
        pageErrors.splice(0);

        // 4. Perform the click — use a short click timeout so unresponsive elements
        //    fail fast rather than blocking the whole step for 6 seconds.
        const clickTimeout = Math.min(stepTimeout, 3_000);
        let clickedOk = false;
        try {
          await page.locator(selector).nth(elementIdx).click({ timeout: clickTimeout, force: true });
          clickedOk = true;
          // Wait for any triggered navigation / animations to settle
          await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
          await page!.waitForTimeout(thinkTime);
        } catch {
          // Click failed — element may have detached or navigated away
        }

        // 5. Collect evidence after action
        const { consoleLogs, networkRequests } = capture.drain();
        const screenshotAfter = await EvidenceCapture.screenshot(page);
        const urlAfter = page.url();
        // @ts-ignore - document is available inside page.evaluate browser context
        const domAfter = await page.evaluate(() => document.body?.innerHTML ?? '').catch(() => '');
        const domSnapshotAfter = await EvidenceCapture.domSnapshot(page);
        const isBlank = await EvidenceCapture.isBlankPage(page);

        // 6. Determine verification result
        const domMutated = domAfter !== domBefore;
        const networkFired = networkRequests.some((r) => !r.url.startsWith('data:'));
        const urlChanged = urlAfter !== urlBefore;

        let verificationResult: SwarmStep['verificationResult'];
        if (!clickedOk) {
          verificationResult = 'skipped';
        } else if (urlChanged) {
          verificationResult = 'url_changed';
        } else if (domMutated) {
          verificationResult = 'dom_changed';
        } else if (networkFired) {
          verificationResult = 'network_fired';
        } else {
          verificationResult = 'no_change';
        }

        const evidence: StepEvidence = {
          screenshotBefore,
          screenshotAfter,
          urlBefore,
          urlAfter,
          domSnapshotBefore,
          domSnapshotAfter,
          consoleLogs,
          networkRequests,
          domMutated,
          networkFired,
        };

        // 7. Detect failures from this step
        const stepFailures = this._detectFailures(
          i,
          selector,
          text,
          evidence,
          pageErrors.splice(0),
          isBlank,
          urlBefore,
          urlAfter,
          clickedOk,
        );

        // 8. Deduplicate failures by fingerprint
        for (const f of stepFailures) {
          if (!failureByFingerprint.has(f.fingerprint)) {
            failureByFingerprint.set(f.fingerprint, f);
          }
          allFailures.push(f);
        }

        const step: SwarmStep = {
          index: i,
          elementSelector: selector,
          elementText: text,
          actionType: 'click',
          timestamp: stepStart,
          durationMs: Date.now() - stepStart,
          evidence,
          failures: stepFailures,
          verificationResult,
        };

        steps.push(step);
        this.emit('event', { type: 'step', step });
        for (const f of stepFailures) {
          this.emit('event', { type: 'failure', failure: f });
        }

        logger.debug(
          { step: i, selector, failures: stepFailures.length, verification: verificationResult },
          'Swarm step complete',
        );
      }

      // 9. Generate LLM narratives for unique failures (after the test).
      //    Failures fingerprint to bucket duplicates, so this is at most
      //    one API call per unique bug. Errors are swallowed and logged.
      if (config.llmProvider && config.llmProvider !== 'none' && config.llmApiKey) {
        await enrichFailuresWithNarratives(failureByFingerprint, {
          provider: config.llmProvider,
          apiKey: config.llmApiKey,
          model: config.llmModel,
        });
      }
    } catch (err) {
      logger.error({ err, runId }, 'Swarm agent unhandled error');
    } finally {
      await page?.close().catch(() => {});
      await context?.close().catch(() => {});
      await this.browser?.close().catch(() => {});
      this.browser = null;
    }

    const summary = this._buildSummary(runId, config.targetUrl, steps, failureByFingerprint, startedAt);
    this.emit('event', { type: 'done', summary });
    logger.info({ runId, steps: steps.length, uniqueBugs: summary.uniqueBugs }, 'Swarm agent done');
    return summary;
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async _pickRandomElement(
    page: Page,
  ): Promise<{ selector: string; elementIdx: number; text: string; found: boolean }> {
    for (const sel of CLICKABLE_SELECTORS) {
      try {
        const allEls = page.locator(sel);
        const count = await allEls.count();
        if (count === 0) continue;

        // Build candidate list, skipping useless hrefs and hidden elements
        const candidates: number[] = [];
        for (let i = 0; i < Math.min(count, 30); i++) {
          const el = allEls.nth(i);
          const href = await el.getAttribute('href').catch(() => null);
          // Skip anchor-only, javascript: and empty hrefs
          if (href !== null && (href === '#' || href.startsWith('javascript:') || href === '')) continue;
          // Skip links that open new tabs — they never change current page state
          const target = await el.getAttribute('target').catch(() => null);
          if (target === '_blank') continue;
          const visible = await el.isVisible().catch(() => false);
          if (!visible) continue;
          candidates.push(i);
        }

        if (candidates.length === 0) continue;
        const idx = candidates[Math.floor(Math.random() * candidates.length)];
        const el = allEls.nth(idx);
        const text = ((await el.textContent().catch(() => '')) ?? '').trim().slice(0, 60) || sel;
        return { selector: sel, elementIdx: idx, text, found: true };
      } catch {
        continue;
      }
    }
    return { selector: '', elementIdx: 0, text: '', found: false };
  }

  private _detectFailures(
    stepIndex: number,
    selector: string,
    elementText: string,
    evidence: StepEvidence,
    pageErrors: Array<{ message: string; stack?: string }>,
    isBlank: boolean,
    urlBefore: string,
    urlAfter: string,
    clickedOk: boolean,
  ): DetectedFailure[] {
    const failures: DetectedFailure[] = [];

    const push = (type: FailureSeverity, message: string, extra?: Partial<DetectedFailure>) => {
      failures.push({
        type,
        message,
        fingerprint: fingerprintFailure(type, message, selector),
        stepIndex,
        elementSelector: selector,
        elementText,
        evidence,
        ...extra,
      });
    };

    // Extract hostname of the page under test so we can filter third-party noise
    let targetHost = '';
    try { targetHost = new URL(urlBefore).hostname; } catch { /* ignore */ }

    const isSameOrigin = (url: string) => {
      try { return new URL(url).hostname === targetHost; } catch { return false; }
    };

    // JS crash
    for (const err of pageErrors) {
      push('crash', err.message, { stack: err.stack });
    }

    // 4xx / 5xx HTTP responses — same-origin only to avoid third-party noise
    for (const req of evidence.networkRequests) {
      if (req.status != null && req.status >= 400 && isSameOrigin(req.url)) {
        push('http_error', `HTTP ${req.status} on ${req.url}`, { url: req.url, status: req.status });
      }
    }

    // Network failures — same-origin only
    for (const req of evidence.networkRequests) {
      if (req.failed && isSameOrigin(req.url)) {
        push('network', `Network failure: ${req.failureReason ?? 'unknown'} — ${req.url}`, {
          url: req.url,
        });
      }
    }

    // Console errors — skip generic "Failed to load resource" noise from third-party scripts
    for (const log of evidence.consoleLogs) {
      if (log.level === 'error' && !log.text.includes('ERR_NAME_NOT_RESOLVED')) {
        push('console_error', `Console error: ${log.text.slice(0, 300)}`);
      }
    }

    // Page went blank after click — only flag if no HTTP error already explains it
    const hasHttpError = evidence.networkRequests.some(
      (r) => r.status != null && r.status >= 400 && isSameOrigin(r.url),
    );
    if (clickedOk && isBlank && !hasHttpError) {
      push('navigation_failure', 'Page became blank after click — possible unhandled navigation or React crash');
    }

    // URL stuck on same page AND no DOM change AND no network activity
    if (
      clickedOk &&
      urlAfter === urlBefore &&
      !evidence.domMutated &&
      !evidence.networkFired &&
      evidence.consoleLogs.length === 0
    ) {
      // Only flag as navigation failure if the element looked like it should navigate (a link or submit)
      if (selector.startsWith('a[') || selector.includes('submit')) {
        push('navigation_failure', `Clicked "${elementText}" but nothing happened — no DOM change, no network request, no URL change`);
      }
    }

    // Sort by severity
    failures.sort((a, b) => compareSeverity(a.type, b.type));
    return failures;
  }

  private _buildSummary(
    runId: string,
    targetUrl: string,
    steps: SwarmStep[],
    failureByFingerprint: Map<string, DetectedFailure>,
    startedAt: number,
  ): SwarmRunSummary {
    const failures = Array.from(failureByFingerprint.values()).sort((a, b) =>
      compareSeverity(a.type, b.type),
    );

    const severityCounts: Record<FailureSeverity, number> = {
      crash: 0,
      http_error: 0,
      network: 0,
      console_error: 0,
      navigation_failure: 0,
      slow: 0,
    };
    for (const f of failures) severityCounts[f.type]++;

    const finishedAt = Date.now();
    return {
      runId,
      targetUrl,
      totalSteps: steps.length,
      totalFailures: steps.reduce((acc, s) => acc + s.failures.length, 0),
      uniqueBugs: failures.length,
      severityCounts,
      steps,
      failures,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
    };
  }
}

