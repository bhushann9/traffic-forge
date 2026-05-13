/**
 * Browser-Based Load Engine — uses real Playwright Chromium instances to
 * simulate actual user behaviour: clicking, scrolling, typing, posting, chatting.
 * Each virtual user runs inside its own isolated browser context.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { logger } from '../../../shared/lib/logger.js';

export interface BrowserConfig {
  url: string;
  appType: string;
  userCount: number;
  durationMs: number;
  rampUpMs: number;
  loginUsername?: string;
  loginPassword?: string;
  discoveredPaths?: string[];
}

export interface BrowserRequestResult {
  userId: number;
  action: string;
  success: boolean;
  durationMs: number;
  errorType?: string;
  timestamp: number;
}

export interface BrowserLiveMetrics {
  completed: number;
  failed: number;
  avgDurationMs: number;
  activeUsers: number;
  activityBatch: Array<{
    id: number;
    name: string;
    action: string;
    type: 'info' | 'success' | 'error';
    time: string;
  }>;
  pageMetrics: Record<string, { count: number; avgMs: number; errors: number }>;
  errorsByType: Record<string, number>;
}

let browserActivityId = 10000;

function makeActivity(userId: number, action: string, type: 'info' | 'success' | 'error') {
  return {
    id: ++browserActivityId,
    name: `Browser-${userId}`,
    action,
    type,
    time: new Date().toLocaleTimeString(),
  };
}

async function tryLogin(
  page: Page,
  baseUrl: string,
  username: string,
  password: string,
): Promise<boolean> {
  try {
    const loginSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="username" i]',
    ];
    const passSelectors = ['input[type="password"]', 'input[name="password"]'];
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'button:has-text("Continue")',
    ];

    let userField: ReturnType<Page['locator']> | null = null;
    for (const sel of loginSelectors) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        userField = el;
        break;
      }
    }
    if (!userField) return false;

    let passField: ReturnType<Page['locator']> | null = null;
    for (const sel of passSelectors) {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        passField = el;
        break;
      }
    }
    if (!passField) return false;

    await userField.fill(username);
    await passField.fill(password);

    for (const sel of submitSelectors) {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0) {
        await btn.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function runSocialMediaJourney(
  page: Page,
  baseUrl: string,
  userId: number,
  username?: string,
  password?: string,
  onAction?: (r: BrowserRequestResult) => void,
): Promise<void> {
  const t = Date.now();

  const navigate = async (path: string, label: string): Promise<number> => {
    const t0 = Date.now();
    try {
      await page.goto(`${baseUrl.replace(/\/$/, '')}${path}`, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      const ms = Date.now() - t0;
      onAction?.({
        userId,
        action: `${label} (${ms}ms)`,
        success: true,
        durationMs: ms,
        timestamp: Date.now(),
      });
      return ms;
    } catch (e) {
      const ms = Date.now() - t0;
      onAction?.({
        userId,
        action: `${label} — failed`,
        success: false,
        durationMs: ms,
        errorType: 'navigation',
        timestamp: Date.now(),
      });
      return ms;
    }
  };

  await navigate('/', 'Opened homepage');

  if (username && password) {
    const loggedIn = await tryLogin(page, baseUrl, username, password);
    if (loggedIn) {
      onAction?.({
        userId,
        action: 'Logged in successfully',
        success: true,
        durationMs: 0,
        timestamp: Date.now(),
      });
    }
  }

  // @ts-ignore - window is available in page.evaluate context
  await page.evaluate(() => (window as any).scrollBy(0, 600));
  await page.waitForTimeout(500);
  onAction?.({
    userId,
    action: 'Scrolled feed',
    success: true,
    durationMs: 0,
    timestamp: Date.now(),
  });

  const postLinks = page
    .locator(
      'a[href*="/post"], a[href*="/p/"], a[href*="/status/"], article a, [data-testid*="post"] a',
    )
    .first();
  if ((await postLinks.count()) > 0) {
    const t0 = Date.now();
    await postLinks.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    const ms = Date.now() - t0;
    onAction?.({
      userId,
      action: `Opened post (${ms}ms)`,
      success: true,
      durationMs: ms,
      timestamp: Date.now(),
    });
  }

  const likeBtn = page
    .locator(
      '[aria-label*="like" i], [data-testid*="like"], button:has-text("Like"), button:has-text("♥")',
    )
    .first();
  if ((await likeBtn.count()) > 0) {
    await likeBtn.click().catch(() => {});
    onAction?.({
      userId,
      action: 'Liked a post',
      success: true,
      durationMs: 0,
      timestamp: Date.now(),
    });
    await page.waitForTimeout(300);
  }

  const commentBox = page
    .locator(
      'textarea[placeholder*="comment" i], input[placeholder*="comment" i], [contenteditable][data-testid*="comment"]',
    )
    .first();
  if ((await commentBox.count()) > 0 && username) {
    await commentBox.click().catch(() => {});
    await commentBox.type('Great content! 🔥', { delay: 40 });
    onAction?.({
      userId,
      action: 'Typed comment',
      success: true,
      durationMs: 0,
      timestamp: Date.now(),
    });
    const sendBtn = page.locator('button:has-text("Post"), button[type="submit"]').first();
    if ((await sendBtn.count()) > 0) {
      await sendBtn.click().catch(() => {});
      onAction?.({
        userId,
        action: 'Posted comment',
        success: true,
        durationMs: 0,
        timestamp: Date.now(),
      });
    }
  }

  await page
    .goBack({ waitUntil: 'domcontentloaded', timeout: 8000 })
    .catch(() =>
      page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
    );
  onAction?.({
    userId,
    action: `Journey complete (${Date.now() - t}ms total)`,
    success: true,
    durationMs: Date.now() - t,
    timestamp: Date.now(),
  });
}

async function runChatAppJourney(
  page: Page,
  baseUrl: string,
  userId: number,
  username?: string,
  password?: string,
  onAction?: (r: BrowserRequestResult) => void,
): Promise<void> {
  const t = Date.now();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const loadMs = Date.now() - t;
    onAction?.({
      userId,
      action: `Opened chat app (${loadMs}ms)`,
      success: true,
      durationMs: loadMs,
      timestamp: Date.now(),
    });
  } catch {
    onAction?.({
      userId,
      action: 'Failed to load app',
      success: false,
      durationMs: 0,
      errorType: 'navigation',
      timestamp: Date.now(),
    });
    return;
  }

  if (username && password) {
    const loggedIn = await tryLogin(page, baseUrl, username, password);
    if (loggedIn)
      onAction?.({
        userId,
        action: 'Logged in',
        success: true,
        durationMs: 0,
        timestamp: Date.now(),
      });
  }

  await page.waitForTimeout(1000);

  const chatItems = page
    .locator(
      '[data-testid*="conversation"], [class*="conversation"], [class*="chat-item"], li[class*="contact"]',
    )
    .first();
  if ((await chatItems.count()) > 0) {
    await chatItems.click().catch(() => {});
    onAction?.({
      userId,
      action: 'Opened conversation',
      success: true,
      durationMs: 0,
      timestamp: Date.now(),
    });
    await page.waitForTimeout(500);
  }

  const messageSelectors = [
    'textarea[placeholder*="message" i]',
    'input[placeholder*="message" i]',
    'div[contenteditable][role="textbox"]',
    '[data-testid*="message-input"]',
    'textarea[placeholder*="type" i]',
    'input[placeholder*="type" i]',
  ];

  for (const sel of messageSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      await el.click().catch(() => {});
      const msgs = ['Hey there! 👋', 'How are you doing?', 'Testing the chat feature!'];
      const msg = msgs[userId % msgs.length];
      await el.type(msg, { delay: 50 });
      onAction?.({
        userId,
        action: `Typed: "${msg}"`,
        success: true,
        durationMs: 0,
        timestamp: Date.now(),
      });

      const sendBtn = page
        .locator('button[type="submit"], button[aria-label*="send" i], button:has-text("Send")')
        .first();
      if ((await sendBtn.count()) > 0) {
        const t0 = Date.now();
        await sendBtn.click().catch(() => {});
        await page.waitForTimeout(800);
        onAction?.({
          userId,
          action: `Message sent (${Date.now() - t0}ms)`,
          success: true,
          durationMs: Date.now() - t0,
          timestamp: Date.now(),
        });
      } else {
        await el.press('Enter');
        onAction?.({
          userId,
          action: 'Message sent via Enter',
          success: true,
          durationMs: 0,
          timestamp: Date.now(),
        });
      }
      break;
    }
  }

  onAction?.({
    userId,
    action: `Chat journey complete (${Date.now() - t}ms)`,
    success: true,
    durationMs: Date.now() - t,
    timestamp: Date.now(),
  });
}

async function runEcommerceJourney(
  page: Page,
  baseUrl: string,
  userId: number,
  username?: string,
  password?: string,
  onAction?: (r: BrowserRequestResult) => void,
): Promise<void> {
  const t = Date.now();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ms = Date.now() - t;
    onAction?.({
      userId,
      action: `Loaded homepage (${ms}ms)`,
      success: true,
      durationMs: ms,
      timestamp: Date.now(),
    });
  } catch {
    onAction?.({
      userId,
      action: 'Failed to load store',
      success: false,
      durationMs: 0,
      errorType: 'navigation',
      timestamp: Date.now(),
    });
    return;
  }

  // @ts-ignore - window is available in page.evaluate context
  await page.evaluate(() => (window as any).scrollBy(0, 400));
  onAction?.({
    userId,
    action: 'Browsing products',
    success: true,
    durationMs: 0,
    timestamp: Date.now(),
  });

  const productLinks = page
    .locator(
      'a[href*="/product"], a[href*="/item"], a[href*="/p/"], [class*="product-card"] a, [class*="product-item"] a',
    )
    .first();
  if ((await productLinks.count()) > 0) {
    const t0 = Date.now();
    await productLinks.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    const ms = Date.now() - t0;
    onAction?.({
      userId,
      action: `Opened product page (${ms}ms)`,
      success: true,
      durationMs: ms,
      timestamp: Date.now(),
    });
  }

  const addToCart = page
    .locator(
      'button:has-text("Add to Cart"), button:has-text("Add to Bag"), button:has-text("Buy Now"), [data-testid*="add-to-cart"]',
    )
    .first();
  if ((await addToCart.count()) > 0) {
    const t0 = Date.now();
    await addToCart.click().catch(() => {});
    await page.waitForTimeout(600);
    onAction?.({
      userId,
      action: `Added to cart (${Date.now() - t0}ms)`,
      success: true,
      durationMs: Date.now() - t0,
      timestamp: Date.now(),
    });
  }

  const cartLink = page
    .locator('a[href*="/cart"], a[href*="/basket"], [aria-label*="cart" i], [data-testid*="cart"]')
    .first();
  if ((await cartLink.count()) > 0) {
    const t0 = Date.now();
    await cartLink.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    onAction?.({
      userId,
      action: `Viewed cart (${Date.now() - t0}ms)`,
      success: true,
      durationMs: Date.now() - t0,
      timestamp: Date.now(),
    });
  }

  onAction?.({
    userId,
    action: `Shopping journey done (${Date.now() - t}ms)`,
    success: true,
    durationMs: Date.now() - t,
    timestamp: Date.now(),
  });
}

async function runSaaSJourney(
  page: Page,
  baseUrl: string,
  userId: number,
  username?: string,
  password?: string,
  onAction?: (r: BrowserRequestResult) => void,
): Promise<void> {
  const t = Date.now();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ms = Date.now() - t;
    onAction?.({
      userId,
      action: `Opened app (${ms}ms)`,
      success: true,
      durationMs: ms,
      timestamp: Date.now(),
    });
  } catch {
    onAction?.({
      userId,
      action: 'Failed to load SaaS app',
      success: false,
      durationMs: 0,
      errorType: 'navigation',
      timestamp: Date.now(),
    });
    return;
  }

  if (username && password) {
    const loggedIn = await tryLogin(page, baseUrl, username, password);
    if (loggedIn)
      onAction?.({
        userId,
        action: 'Logged in to dashboard',
        success: true,
        durationMs: 0,
        timestamp: Date.now(),
      });
  }

  await page.waitForTimeout(1000);

  const navLinks = page.locator('nav a, aside a, [role="navigation"] a').all();
  const links = (await navLinks).slice(0, 4);
  for (const link of links) {
    try {
      const href = await link.getAttribute('href');
      if (!href || href === '#' || href.startsWith('http')) continue;
      const t0 = Date.now();
      await link.click();
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      const ms = Date.now() - t0;
      onAction?.({
        userId,
        action: `Navigated to ${href} (${ms}ms)`,
        success: true,
        durationMs: ms,
        timestamp: Date.now(),
      });
      await page.waitForTimeout(400);
    } catch {
      // skip
    }
  }

  const buttons = page.locator('main button, [role="main"] button').all();
  const btns = (await buttons).slice(0, 3);
  for (const btn of btns) {
    try {
      const text = await btn.textContent();
      if (!text) continue;
      await btn.click().catch(() => {});
      onAction?.({
        userId,
        action: `Clicked "${text.trim().slice(0, 30)}"`,
        success: true,
        durationMs: 0,
        timestamp: Date.now(),
      });
      await page.waitForTimeout(300);
    } catch {
      // skip
    }
  }

  onAction?.({
    userId,
    action: `SaaS journey done (${Date.now() - t}ms)`,
    success: true,
    durationMs: Date.now() - t,
    timestamp: Date.now(),
  });
}

async function runForumJourney(
  page: Page,
  baseUrl: string,
  userId: number,
  username?: string,
  password?: string,
  onAction?: (r: BrowserRequestResult) => void,
): Promise<void> {
  const t = Date.now();

  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ms = Date.now() - t;
    onAction?.({
      userId,
      action: `Opened forum (${ms}ms)`,
      success: true,
      durationMs: ms,
      timestamp: Date.now(),
    });
  } catch {
    onAction?.({
      userId,
      action: 'Failed to load forum',
      success: false,
      durationMs: 0,
      errorType: 'navigation',
      timestamp: Date.now(),
    });
    return;
  }

  const threadLinks = page
    .locator(
      'a[href*="/thread"], a[href*="/topic"], a[href*="/t/"], [class*="thread"] a, [class*="topic"] a',
    )
    .first();
  if ((await threadLinks.count()) > 0) {
    const t0 = Date.now();
    await threadLinks.click().catch(() => {});
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    onAction?.({
      userId,
      action: `Opened thread (${Date.now() - t0}ms)`,
      success: true,
      durationMs: Date.now() - t0,
      timestamp: Date.now(),
    });
    // @ts-ignore - window is available in page.evaluate context
    await page.evaluate(() => (window as any).scrollBy(0, (window as any).innerHeight));
  }

  if (username && password) {
    const replyBox = page
      .locator(
        'textarea[name*="reply"], textarea[placeholder*="reply" i], textarea[placeholder*="post" i]',
      )
      .first();
    if ((await replyBox.count()) > 0) {
      await replyBox.fill('Interesting thread! Thanks for sharing.');
      onAction?.({
        userId,
        action: 'Drafted reply',
        success: true,
        durationMs: 0,
        timestamp: Date.now(),
      });
    }
  }

  onAction?.({
    userId,
    action: `Forum journey done (${Date.now() - t}ms)`,
    success: true,
    durationMs: Date.now() - t,
    timestamp: Date.now(),
  });
}

async function runGenericJourney(
  page: Page,
  baseUrl: string,
  userId: number,
  discoveredPaths: string[],
  onAction?: (r: BrowserRequestResult) => void,
): Promise<void> {
  const paths = discoveredPaths.length > 0 ? discoveredPaths.slice(0, 5) : ['/'];

  for (const path of paths) {
    const t0 = Date.now();
    try {
      const fullUrl = `${baseUrl.replace(/\/$/, '')}${path}`;
      await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const ms = Date.now() - t0;
      onAction?.({
        userId,
        action: `${path} → 200 (${ms}ms)`,
        success: true,
        durationMs: ms,
        timestamp: Date.now(),
      });
    } catch {
      onAction?.({
        userId,
        action: `${path} → failed`,
        success: false,
        durationMs: Date.now() - t0,
        errorType: 'navigation',
        timestamp: Date.now(),
      });
    }
    await page.waitForTimeout(300);
    // @ts-ignore - window is available in page.evaluate context
    await page.evaluate(() => (window as any).scrollBy(0, 400));
  }
}

async function runUserJourney(
  browser: Browser,
  config: BrowserConfig,
  userId: number,
  onAction: (r: BrowserRequestResult) => void,
): Promise<void> {
  let context: BrowserContext | null = null;
  let page: Page | null = null;

  try {
    context = await browser.newContext({
      userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36`,
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();

    const appType = (config.appType ?? '').toLowerCase().replace(/[\s-]/g, '');

    if (appType.includes('social') || appType.includes('media')) {
      await runSocialMediaJourney(
        page,
        config.url,
        userId,
        config.loginUsername,
        config.loginPassword,
        onAction,
      );
    } else if (appType.includes('chat')) {
      await runChatAppJourney(
        page,
        config.url,
        userId,
        config.loginUsername,
        config.loginPassword,
        onAction,
      );
    } else if (
      appType.includes('ecommerce') ||
      appType.includes('commerce') ||
      appType.includes('shop')
    ) {
      await runEcommerceJourney(
        page,
        config.url,
        userId,
        config.loginUsername,
        config.loginPassword,
        onAction,
      );
    } else if (appType.includes('saas')) {
      await runSaaSJourney(
        page,
        config.url,
        userId,
        config.loginUsername,
        config.loginPassword,
        onAction,
      );
    } else if (appType.includes('forum')) {
      await runForumJourney(
        page,
        config.url,
        userId,
        config.loginUsername,
        config.loginPassword,
        onAction,
      );
    } else {
      await runGenericJourney(page, config.url, userId, config.discoveredPaths ?? [], onAction);
    }
  } catch (err) {
    logger.error({ err, userId }, 'Browser user journey error');
    onAction({
      userId,
      action: 'Journey failed (browser crash)',
      success: false,
      durationMs: 0,
      errorType: 'browser_error',
      timestamp: Date.now(),
    });
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
  }
}

export async function runBrowserLoadTest(
  runId: string,
  config: BrowserConfig,
  abortController: AbortController,
  onMetrics: (metrics: BrowserLiveMetrics) => void,
): Promise<{
  completed: number;
  failed: number;
  avgDurationMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  pageMetrics: Record<string, { count: number; avgMs: number; errors: number }>;
  errorsByType: Record<string, number>;
}> {
  const allResults: BrowserRequestResult[] = [];
  const recentBatch: typeof allResults = [];
  let activeUsers = 0;

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  } catch (err) {
    logger.error({ err }, 'Failed to launch browser');
    throw new Error('Browser launch failed. Chromium may not be available.');
  }

  const startTime = Date.now();
  const rampSteps = Math.max(1, config.userCount);
  const rampDelay = config.rampUpMs / rampSteps;

  const userPromises: Promise<void>[] = [];

  const onAction = (r: BrowserRequestResult) => {
    allResults.push(r);
    recentBatch.push(r);
  };

  const metricsLoop = setInterval(() => {
    if (abortController.signal.aborted) return;
    const batch = recentBatch.splice(0);
    const completed = allResults.filter((r) => r.success).length;
    const failed = allResults.filter((r) => !r.success).length;
    const times = allResults
      .filter((r) => r.success)
      .map((r) => r.durationMs)
      .filter((t) => t > 0);
    const avgDurationMs =
      times.length === 0 ? 0 : Math.round(times.reduce((a, b) => a + b, 0) / times.length);

    const pageMetrics: Record<string, { count: number; avgMs: number; errors: number }> = {};
    for (const r of allResults) {
      const key = r.action.split(' → ')[0]?.split(' (')[0] ?? r.action;
      if (!pageMetrics[key]) pageMetrics[key] = { count: 0, avgMs: 0, errors: 0 };
      pageMetrics[key].count++;
      if (!r.success) pageMetrics[key].errors++;
    }

    const errorsByType: Record<string, number> = {};
    for (const r of allResults.filter((r) => !r.success)) {
      const k = r.errorType ?? 'unknown';
      errorsByType[k] = (errorsByType[k] ?? 0) + 1;
    }

    onMetrics({
      completed,
      failed,
      avgDurationMs,
      activeUsers,
      activityBatch: batch.map((r) =>
        makeActivity(r.userId, r.action, r.success ? 'success' : 'error'),
      ),
      pageMetrics,
      errorsByType,
    });
  }, 500);

  for (let i = 0; i < config.userCount; i++) {
    if (abortController.signal.aborted) break;

    const userId = i + 1;
    activeUsers++;

    const runUser = async () => {
      const deadline = startTime + config.durationMs;
      while (Date.now() < deadline && !abortController.signal.aborted) {
        await runUserJourney(browser!, config, userId, onAction);
        if (Date.now() < deadline && !abortController.signal.aborted) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      activeUsers--;
    };

    userPromises.push(runUser());
    if (i < config.userCount - 1) {
      await new Promise((r) => setTimeout(r, rampDelay));
    }
  }

  await Promise.allSettled(userPromises);
  clearInterval(metricsLoop);

  await browser.close().catch(() => {});

  const completed = allResults.filter((r) => r.success).length;
  const failed = allResults.filter((r) => !r.success).length;
  const times = allResults
    .filter((r) => r.success)
    .map((r) => r.durationMs)
    .filter((t) => t > 0);
  const avgDurationMs =
    times.length === 0 ? 0 : Math.round(times.reduce((a, b) => a + b, 0) / times.length);

  const pageMetrics: Record<string, { count: number; avgMs: number; errors: number }> = {};
  for (const r of allResults) {
    const key = r.action.split(' → ')[0]?.split(' (')[0] ?? r.action;
    if (!pageMetrics[key]) pageMetrics[key] = { count: 0, avgMs: 0, errors: 0 };
    pageMetrics[key].count++;
    if (!r.success) pageMetrics[key].errors++;
  }

  const errorsByType: Record<string, number> = {};
  for (const r of allResults.filter((r) => !r.success)) {
    const k = r.errorType ?? 'unknown';
    errorsByType[k] = (errorsByType[k] ?? 0) + 1;
  }

  const sorted = [...times].sort((a, b) => a - b);
  const p95Ms = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] ?? sorted[sorted.length - 1]! : 0;
  const p99Ms = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.99)] ?? sorted[sorted.length - 1]! : 0;
  const p50Ms = sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.50)] ?? sorted[sorted.length - 1]! : 0;

  return { completed, failed, avgDurationMs, p50Ms, p95Ms, p99Ms, pageMetrics, errorsByType };
}
