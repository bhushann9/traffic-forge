import { Router, type Request, type Response, type RequestHandler } from 'express';
import { SwarmAgent } from './engine/swarmAgent.js';
import type { SwarmRunSummary } from './engine/evidenceCapture.js';
import { ScenarioOrchestrator } from './engine/multiAgent/orchestrator.js';
import type { ScenarioRunSummary, AgentLLMProvider } from './engine/multiAgent/types.js';
import { seedAuth, SeedAuthError } from './engine/multiAgent/seedAuth.js';
import path from 'path';
import { IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import rateLimit from 'express-rate-limit';
import { z } from 'zod/v4';
import { db } from '@workspace/db';
import { testConfigsTable, testRunsTable, analysisResultsTable } from '@workspace/db';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { logger as rootLogger, runLogger } from '../../shared/lib/logger';
import { scanUrl } from './engine/scanner.js';
import { runRealLoadTest, type LiveMetrics } from './engine/loadEngine.js';
import { runBrowserLoadTest, type BrowserLiveMetrics } from './engine/browserEngine.js';
import { BugDetector } from './engine/bugDetector.js';
import { Reporter } from './engine/reporter.js';
import { RCAEngine } from './engine/rcaEngine.js';
import { BottleneckDetector } from './engine/bottleneckDetector.js';
import { PredictiveModel } from './engine/predictiveModel.js';
import { streamReportPdf } from './engine/reportPdf.js';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from '../../shared/openapi.js';
import {
  buildOrchestrator,
  type NodeHandler,
  type ProgressEvent,
  type OrchestratorState,
} from './engine/orchestrator.js';
import type { AgentEvent } from './engine/agentExecutor.js';
import type { TestReport, BugReport } from './types/report.js';
import type { DetectedBug } from './types/bug.js';
import type { RCAReport } from './types/rca.js';
import type { BottleneckReport, EndpointStats } from './types/bottleneck.js';
import type { Prediction, LoadSample } from './types/prediction.js';

const router = Router();

// ─── Rate limiters ────────────────────────────────────────────────────────────
// Tighter limits on expensive endpoints (Claude API calls, browser launches,
// outbound HTTP scans) to prevent abuse and runaway costs.

const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 scans per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many scan requests; try again in a minute' },
});

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5, // 5 analyses per minute per IP — Claude calls are expensive
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analysis requests; try again in a minute' },
});

const startRunLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6, // 6 test runs per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many test runs started; try again in a minute' },
});

// ─── Zod request schemas ──────────────────────────────────────────────────────

const scanSchema = z.object({
  url: z.string().url('url must be a valid http(s) URL'),
  maxPages: z.coerce.number().int().min(1).max(30).optional(),
});

const testConfigSchema = z.object({
  url: z.string().url(),
  user_count: z.number().int().min(1).max(1000).optional(),
  duration_sec: z.number().int().min(5).max(3600).optional(),
  ramp_up_sec: z.number().int().min(0).max(600).optional(),
  app_type: z.string().max(50).nullable().optional(),
  persona: z.string().max(50).nullable().optional(),
  shadow_mode: z.boolean().optional(),
  respect_rate_limits: z.boolean().optional(),
  auto_stop_error_threshold: z.number().int().min(0).max(100).optional(),
  discovered_paths: z.array(z.string().max(2048)).max(500).optional(),
  test_mode: z.enum(['http', 'browser', 'both']).optional(),
  browser_user_count: z.number().int().min(1).max(50).optional(),
  browser_duration_sec: z.number().int().min(5).max(3600).optional(),
  browser_ramp_up_sec: z.number().int().min(0).max(600).optional(),
  login_username: z.string().max(200).nullable().optional(),
  login_password: z.string().max(500).nullable().optional(),
});

const createRunSchema = z.object({
  config_id: z.number().int().positive().optional(),
  status: z.enum(['pending', 'running', 'completed', 'cancelled', 'interrupted']).optional(),
});

const startRunSchema = z.object({
  config: z.record(z.string(), z.unknown()).optional(),
});

const runIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID').or(z.string().min(1).max(100)),
});

/**
 * Validate body/params with a Zod schema. Sends a structured 400 on failure
 * and returns null so the caller can early-exit. Wraps the standard Zod
 * error into { error: 'Invalid request', issues: [...] } for clients.
 */
function validate<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  res: Response,
): z.infer<S> | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    res.status(400).json({
      error: 'Invalid request',
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
    return null;
  }
  return result.data;
}

// ─── In-memory state ─────────────────────────────────────────────────────────

const activeRuns = new Map<
  string,
  { abortController: AbortController; startedAt: number; config: Record<string, unknown> }
>();
const runClients = new Map<string, Set<WebSocket>>();

// AI analysis result shape returned to the frontend.
// Persisted to the analysis_results DB table; in-memory map is a hot cache
// for in-flight progress so the WebSocket can poll cheaply without DB hits.
interface AnalysisResult {
  runId: string;
  status: 'pending' | 'running' | 'complete' | 'error';
  error?: string;
  report?: TestReport;
  bugs?: BugReport[];
  rcaReports?: RCAReport[];
  bottlenecks?: BottleneckReport[];
  prediction?: Prediction;
  cost?: { estimatedUsd: number };
  analyzedAt?: number;
}

const analysisCache = new Map<string, AnalysisResult>();

async function persistAnalysis(result: AnalysisResult): Promise<void> {
  // Always update the in-memory cache first so listeners get fresh state
  // even if the DB write is slow or fails.
  analysisCache.set(result.runId, result);
  try {
    await db
      .insert(analysisResultsTable)
      .values({
        run_id: result.runId,
        status: result.status,
        error: result.error ?? null,
        report: result.report ?? null,
        bugs: result.bugs ?? null,
        rca_reports: result.rcaReports ?? null,
        bottlenecks: result.bottlenecks ?? null,
        prediction: result.prediction ?? null,
        cost_usd: result.cost?.estimatedUsd ?? null,
        analyzed_at: result.analyzedAt ? new Date(result.analyzedAt) : null,
      })
      .onConflictDoUpdate({
        target: analysisResultsTable.run_id,
        set: {
          status: result.status,
          error: result.error ?? null,
          report: result.report ?? null,
          bugs: result.bugs ?? null,
          rca_reports: result.rcaReports ?? null,
          bottlenecks: result.bottlenecks ?? null,
          prediction: result.prediction ?? null,
          cost_usd: result.cost?.estimatedUsd ?? null,
          analyzed_at: result.analyzedAt ? new Date(result.analyzedAt) : null,
        },
      });
  } catch (err) {
    rootLogger.warn({ err, runId: result.runId }, 'Failed to persist analysis to DB');
  }
}

async function loadAnalysis(runId: string): Promise<AnalysisResult | null> {
  const cached = analysisCache.get(runId);
  if (cached) return cached;
  try {
    const [row] = await db
      .select()
      .from(analysisResultsTable)
      .where(eq(analysisResultsTable.run_id, runId))
      .limit(1);
    if (!row) return null;
    const restored: AnalysisResult = {
      runId: row.run_id,
      status: row.status as AnalysisResult['status'],
      error: row.error ?? undefined,
      report: (row.report as TestReport) ?? undefined,
      bugs: (row.bugs as BugReport[]) ?? undefined,
      rcaReports: (row.rca_reports as RCAReport[]) ?? undefined,
      bottlenecks: (row.bottlenecks as BottleneckReport[]) ?? undefined,
      prediction: (row.prediction as Prediction) ?? undefined,
      cost: row.cost_usd != null ? { estimatedUsd: row.cost_usd } : undefined,
      analyzedAt: row.analyzed_at?.getTime(),
    };
    analysisCache.set(runId, restored);
    return restored;
  } catch (err) {
    rootLogger.warn({ err, runId }, 'Failed to load analysis from DB');
    return null;
  }
}

// Collect synthetic events from completed runs (populated by the load test engines)
// Maps runId → synthetic AgentEvents derived from HTTP metrics
const runEventStore = new Map<string, AgentEvent[]>();

function broadcastToRun(runId: string, payload: unknown) {
  const clients = runClients.get(runId);
  if (!clients || clients.size === 0) return;
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function setupWebSocketServer(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const runId = url.searchParams.get('runId') ?? '__global__';

    if (!runClients.has(runId)) runClients.set(runId, new Set());
    runClients.get(runId)!.add(ws);

    rootLogger.info({ runId }, 'WebSocket client connected');

    ws.on('close', () => {
      runClients.get(runId)?.delete(ws);
      if (runClients.get(runId)?.size === 0) runClients.delete(runId);
    });
  });
}

// ─── Health ───────────────────────────────────────────────────────────────────

router.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'trafficforge-backend' });
});

// ─── OpenAPI / Swagger UI ────────────────────────────────────────────────────

router.get('/openapi.json', (_req: Request, res: Response) => {
  res.json(openApiSpec);
});

router.use(
  '/docs',
  swaggerUi.serveFiles(openApiSpec as unknown as Record<string, unknown>),
  swaggerUi.setup(openApiSpec as unknown as Record<string, unknown>, {
    customSiteTitle: 'TrafficForge API Docs',
  }),
);

// ─── Active Runs ──────────────────────────────────────────────────────────────

router.get('/active-runs', (_req: Request, res: Response) => {
  const runs = Array.from(activeRuns.entries()).map(([id, data]) => ({
    id,
    startedAt: data.startedAt,
    config: { url: (data.config as Record<string, unknown>).url },
  }));
  return res.json(runs);
});

// ─── Real URL Scanner ─────────────────────────────────────────────────────────

const scan: RequestHandler = async (req, res) => {
  const body = validate(scanSchema, req.body, res);
  if (!body) return;
  const { url, maxPages = 20 } = body;

  try {
    const result = await scanUrl(url, maxPages);
    if (result.error) {
      return res.status(502).json({ error: result.error });
    }
    return res.json(result);
  } catch (err) {
    req.log.error({ err }, 'Scanner error');
    return res.status(500).json({ error: 'Failed to scan URL' });
  }
};
router.post('/scan', scanLimiter, scan);

// ─── Test Configs ─────────────────────────────────────────────────────────────

const createTestConfig: RequestHandler = async (req, res) => {
  const body = validate(testConfigSchema, req.body, res);
  if (!body) return;

  try {
    const [row] = await db
      .insert(testConfigsTable)
      .values({
        url: body.url,
        user_count: body.user_count ?? 10,
        duration_sec: body.duration_sec ?? 60,
        ramp_up_sec: body.ramp_up_sec ?? 10,
        app_type: body.app_type ?? null,
        persona: body.persona ?? null,
        shadow_mode: body.shadow_mode ?? false,
        respect_rate_limits: body.respect_rate_limits ?? true,
        auto_stop_error_threshold: body.auto_stop_error_threshold ?? 10,
        discovered_paths: body.discovered_paths ?? [],
        test_mode: body.test_mode ?? 'http',
        browser_user_count: body.browser_user_count ?? 3,
        browser_duration_sec: body.browser_duration_sec ?? 60,
        browser_ramp_up_sec: body.browser_ramp_up_sec ?? 5,
        login_username: body.login_username ?? null,
        login_password: body.login_password ?? null,
      })
      .returning();

    return res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, 'Failed to create test config');
    return res.status(500).json({ error: 'Failed to create test config' });
  }
};
router.post('/test-configs', createTestConfig);

// ─── Test Runs ────────────────────────────────────────────────────────────────

const createTestRun: RequestHandler = async (req, res) => {
  const body = validate(createRunSchema, req.body ?? {}, res);
  if (!body) return;
  const id = randomUUID();

  try {
    const [row] = await db
      .insert(testRunsTable)
      .values({ id, config_id: body.config_id ?? null, status: body.status ?? 'pending' })
      .returning();
    return res.status(201).json(row);
  } catch (err) {
    req.log.error({ err }, 'Failed to create test run');
    return res.status(500).json({ error: 'Failed to create test run' });
  }
};
router.post('/test-runs', createTestRun);

const listTestRuns: RequestHandler = async (req, res) => {
  try {
    const runs = await db
      .select()
      .from(testRunsTable)
      .orderBy(desc(testRunsTable.created_at))
      .limit(50);
    return res.json(runs);
  } catch (err) {
    req.log.error({ err }, 'Failed to list test runs');
    return res.status(500).json({ error: 'Failed to list test runs' });
  }
};
router.get('/test-runs', listTestRuns);

const getTestRun: RequestHandler<{ id: string }> = async (req, res) => {
  const id = req.params.id;
  try {
    const [run] = await db.select().from(testRunsTable).where(eq(testRunsTable.id, id)).limit(1);
    if (!run) return res.status(404).json({ error: 'Test run not found' });
    return res.json(run);
  } catch (err) {
    req.log.error({ err }, 'Failed to fetch test run');
    return res.status(500).json({ error: 'Failed to fetch test run' });
  }
};
router.get('/test-runs/:id', getTestRun);

const startTestRun: RequestHandler<{ id: string }> = async (req, res) => {
  const params = validate(runIdParamSchema, req.params, res);
  if (!params) return;
  const body = validate(startRunSchema, req.body ?? {}, res);
  if (!body) return;
  const id = params.id;

  if (activeRuns.has(id)) return res.status(400).json({ error: 'Test run already active', id });

  let config = body.config as Record<string, unknown> | undefined;
  if (!config?.url) {
    const [run] = await db.select().from(testRunsTable).where(eq(testRunsTable.id, id)).limit(1);
    if (run?.config_id) {
      const [cfg] = await db
        .select()
        .from(testConfigsTable)
        .where(eq(testConfigsTable.id, run.config_id))
        .limit(1);
      config = cfg as Record<string, unknown>;
    }
  }

  if (!config?.url) return res.status(400).json({ error: 'No url found in config', id });

  await db
    .update(testRunsTable)
    .set({ status: 'running', started_at: new Date() })
    .where(eq(testRunsTable.id, id));

  const abortController = new AbortController();
  activeRuns.set(id, { abortController, startedAt: Date.now(), config });

  runRealLoadTestSession(id, config, abortController).finally(() => {
    activeRuns.delete(id);
  });

  return res.json({ id, status: 'running', message: 'Real load test started' });
};
router.post('/test-runs/:id/start', startRunLimiter, startTestRun);

const stopTestRun: RequestHandler<{ id: string }> = (req, res) => {
  const id = req.params.id;
  const run = activeRuns.get(id);
  if (!run) return res.status(404).json({ error: 'No active run found', id });

  run.abortController.abort();
  activeRuns.delete(id);
  return res.json({ id, status: 'stopped', message: 'Test run aborted' });
};
router.post('/test-runs/:id/stop', stopTestRun);

const cleanupTestRun: RequestHandler<{ id: string }> = async (req, res) => {
  const id = req.params.id;
  const run = activeRuns.get(id);
  if (run) {
    run.abortController.abort();
    activeRuns.delete(id);
  }

  try {
    const [runRow] = await db.select().from(testRunsTable).where(eq(testRunsTable.id, id)).limit(1);
    await db.delete(testRunsTable).where(eq(testRunsTable.id, id));
    if (runRow?.config_id) {
      await db
        .delete(testConfigsTable)
        .where(eq(testConfigsTable.id, runRow.config_id))
        .catch(() => {});
    }
    return res.json({ id, message: 'Cleaned up', cleaned: true });
  } catch (err) {
    req.log.error({ err }, 'Failed to cleanup test run');
    return res.status(500).json({ error: 'Failed to cleanup' });
  }
};
router.post('/test-runs/:id/cleanup', cleanupTestRun);

// ─── AI Analysis Pipeline ────────────────────────────────────────────────────

const runAnalysis: RequestHandler<{ id: string }> = async (req, res) => {
  const runId = req.params.id;

  // Allow re-triggering — clear cache + mark pending in DB
  await persistAnalysis({ runId, status: 'pending' });

  // Fetch the run from DB to get metrics
  let run: Record<string, unknown> | undefined;
  try {
    const [row] = await db.select().from(testRunsTable).where(eq(testRunsTable.id, runId)).limit(1);
    if (!row) return res.status(404).json({ error: 'Test run not found' });
    run = row as unknown as Record<string, unknown>;
  } catch (err) {
    req.log.error({ err }, 'Failed to fetch run for analysis');
    return res.status(500).json({ error: 'Failed to fetch test run' });
  }

  // Fetch config
  let config: Record<string, unknown> = {};
  if (run.config_id) {
    try {
      const [cfg] = await db
        .select()
        .from(testConfigsTable)
        .where(eq(testConfigsTable.id, run.config_id as number))
        .limit(1);
      if (cfg) config = cfg as unknown as Record<string, unknown>;
    } catch {
      /* use empty config */
    }
  }

  const url = (config.url ?? run.url ?? 'unknown') as string;
  const appType = (config.app_type ?? 'web') as string;

  // Respond immediately; run analysis in the background
  res.json({ runId, status: 'running', message: 'AI analysis started' });

  // Background analysis
  runAIAnalysis(runId, url, appType, run!, config).catch((err) => {
    rootLogger.error({ err, runId }, 'AI analysis failed');
    void persistAnalysis({ runId, status: 'error', error: String(err) });
  });

  return;
};
router.post('/test-runs/:id/analyze', analyzeLimiter, runAnalysis);

const getAnalysisResult: RequestHandler<{ id: string }> = async (req, res) => {
  const runId = req.params.id;
  const result = await loadAnalysis(runId);
  if (!result) return res.status(404).json({ error: 'No analysis found for this run' });
  return res.json(result);
};
router.get('/test-runs/:id/analysis', getAnalysisResult);

const getAnalysisPdf: RequestHandler<{ id: string }> = async (req, res) => {
  const runId = req.params.id;
  const result = await loadAnalysis(runId);
  if (!result) return res.status(404).json({ error: 'No analysis found for this run' });
  if (result.status !== 'complete' || !result.report) {
    return res.status(409).json({ error: 'Analysis is not yet complete' });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="trafficforge-report-${runId.slice(0, 8)}.pdf"`,
  );

  streamReportPdf(
    {
      report: result.report,
      rcaReports: result.rcaReports,
      bottlenecks: result.bottlenecks,
      costUsd: result.cost?.estimatedUsd,
    },
    res,
  );
  return;
};
router.get('/test-runs/:id/analysis.pdf', getAnalysisPdf);

async function runAIAnalysis(
  runId: string,
  url: string,
  appType: string,
  run: Record<string, unknown>,
  _config: Record<string, unknown>,
): Promise<void> {
  // All background logs in this analysis carry { runId } — filter by it to
  // see the full lifecycle of one analysis from start to finish.
  const log = runLogger(runId, { component: 'analysis' });
  log.info({ url, appType }, 'AI analysis started');
  await persistAnalysis({ runId, status: 'running' });

  // Engines pick up the configured LLM provider chain (LLM_PROVIDER env var,
  // default ollama) automatically via getLLMClient() — no API key plumbing here.
  const bugDetector = new BugDetector();
  const reporter = new Reporter();
  const rcaEngine = new RCAEngine();
  const bottleneckDetector = new BottleneckDetector();
  const predictiveModel = new PredictiveModel();

  // Pull run-level facts that every node needs
  const storedEvents = runEventStore.get(runId) ?? [];
  const pageMetrics = (run.page_metrics ?? {}) as Record<
    string,
    { count: number; avgMs: number; errors: number }
  >;
  const errorBreakdown = (run.error_breakdown ?? {}) as Record<string, number>;
  const errorRate = (run.error_rate ?? 0) as number;
  const avgResponseMs = (run.avg_response_ms ?? 0) as number;
  const p95Ms = (run.p95_ms ?? 0) as number;
  const userCount = (run.user_count as number) ?? 5;

  // ── Build LangGraph node handlers ─────────────────────────────────────────

  /** Planner node — synthesizes AgentEvents from run metrics. */
  const plannerNode: NodeHandler = async () => {
    const syntheticEvents: AgentEvent[] = [...storedEvents];
    for (const [path, metrics] of Object.entries(pageMetrics)) {
      for (let i = 0; i < Math.min(metrics.count, 20); i++) {
        syntheticEvents.push({
          timestamp: Date.now() - (metrics.count - i) * 1000,
          action: { type: 'navigate', url: `${url}${path}` },
          result: i < metrics.errors ? 'failed' : 'success',
          duration: metrics.avgMs,
          errorMessage: i < metrics.errors ? `HTTP error on ${path}` : undefined,
          agentId: `synthetic-${i % userCount}`,
        });
      }
    }
    return { events: syntheticEvents };
  };

  /** Detector node — runs the BugDetector and adds aggregate-metric bugs. */
  const detectorNode: NodeHandler = async (state) => {
    const detected: DetectedBug[] = bugDetector.detectAll({
      events: state.events,
      appType,
      agentCount: userCount,
    });

    if (errorRate > 5) {
      detected.push({
        id: `error-rate-${runId}`,
        type: 'persistence_failure',
        severity: errorRate > 20 ? 'high' : 'medium',
        title: 'High error rate under load',
        description: `${errorRate.toFixed(1)}% of requests failed during the load test. Error types: ${Object.keys(errorBreakdown).join(', ') || 'timeout/connection'}`,
        evidence: Object.entries(errorBreakdown)
          .slice(0, 3)
          .map(([type, count]) => ({
            type: 'event' as const,
            description: `${count} ${type} errors`,
            timestamp: Date.now(),
          })),
        confidence: 0.9,
        appType,
        detectedAt: Date.now(),
      });
    }

    if (p95Ms > 3000) {
      detected.push({
        id: `latency-${runId}`,
        type: 'realtime_sync_failure',
        severity: p95Ms > 8000 ? 'high' : 'medium',
        title: 'High tail latency (p95)',
        description: `P95 response time is ${p95Ms}ms — well above the 1s acceptable threshold. Indicates resource contention or blocking operations.`,
        evidence: [
          {
            type: 'timing' as const,
            description: `p95 = ${p95Ms}ms, avg = ${avgResponseMs.toFixed(0)}ms`,
            timestamp: Date.now(),
          },
        ],
        confidence: 0.85,
        appType,
        detectedAt: Date.now(),
      });
    }

    return { bugs: detected };
  };

  /** Reporter node — Claude-powered structured analysis. */
  const reporterNode: NodeHandler = async (state) => {
    const { cost, ...reportData } = await reporter.generateReport({
      url,
      appType,
      bugs: state.bugs,
      events: state.events,
    });
    return { report: reportData, totalCostUsd: cost.estimatedUsd };
  };

  /** RCA node — per-bug root cause analysis (capped at 5 to limit API cost). */
  const rcaNode: NodeHandler = async (state) => {
    const rcaReports: RCAReport[] = [];
    let costAccum = 0;
    const bugsForRCA = state.report?.bugs ?? state.bugs.map((b) => ({ bug: b }) as BugReport);
    for (const item of bugsForRCA.slice(0, 5)) {
      try {
        const { cost, ...rca } = await rcaEngine.analyze({
          bug: item.bug,
          appType,
          events: state.events,
          metrics: {
            error_rate: errorRate,
            avg_duration: avgResponseMs,
            p95_latency: p95Ms,
          },
        });
        rcaReports.push(rca);
        costAccum += cost.estimatedUsd;
      } catch (err) {
        log.warn({ err, bugId: item.bug.id }, 'RCA failed for bug');
      }
    }
    return { rcaReports, totalCostUsd: costAccum };
  };

  // ── Run the LangGraph pipeline with streaming progress ────────────────────

  const orchestrator = buildOrchestrator({
    planner: plannerNode,
    detector: detectorNode,
    reporter: reporterNode,
    rca: rcaNode,
  });

  const onProgress = (event: ProgressEvent) => {
    broadcastToRun(runId, { kind: 'analysis_progress', runId, event });
    log.debug({ event }, 'Orchestrator progress');
  };

  let finalState: OrchestratorState;
  try {
    finalState = await orchestrator.stream({ url, appType }, onProgress);
  } catch (err) {
    await persistAnalysis({
      runId,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // ── Post-pipeline algorithmic computations (no API calls) ─────────────────

  const endpointStats: EndpointStats[] = Object.entries(pageMetrics).map(([path, m]) => ({
    path,
    count: m.count,
    percentiles: bottleneckDetector.computePercentiles(Array(m.count).fill(m.avgMs)),
    errorRate: m.count > 0 ? (m.errors / m.count) * 100 : 0,
  }));

  const bottlenecks = bottleneckDetector.detectAll({
    events: finalState.events,
    endpointStats,
    resourceStats: undefined,
  });

  let prediction: Prediction | undefined;
  if (avgResponseMs > 0) {
    const samples: LoadSample[] = [
      {
        agentCount: Math.max(1, Math.floor(userCount * 0.25)),
        avgResponseMs: avgResponseMs * 0.6,
        cpuPercent: 20,
        memoryMB: 256,
        errorRate: errorRate * 0.2,
      },
      {
        agentCount: Math.max(1, Math.floor(userCount * 0.5)),
        avgResponseMs: avgResponseMs * 0.8,
        cpuPercent: 40,
        memoryMB: 384,
        errorRate: errorRate * 0.5,
      },
      { agentCount: userCount, avgResponseMs, cpuPercent: 65, memoryMB: 512, errorRate },
    ];
    try {
      prediction = predictiveModel.predict(samples, userCount * 2);
    } catch {
      // Not enough variance for prediction
    }
  }

  await persistAnalysis({
    runId,
    status: 'complete',
    report: finalState.report,
    bugs: finalState.report?.bugs,
    rcaReports: finalState.rcaReports,
    bottlenecks,
    prediction,
    cost: { estimatedUsd: finalState.totalCostUsd },
    analyzedAt: Date.now(),
  });

  log.info(
    {
      bugs: finalState.bugs.length,
      rcaCount: finalState.rcaReports.length,
      costUsd: finalState.totalCostUsd.toFixed(4),
    },
    'AI analysis complete (LangGraph)',
  );
}

// ─── Real Load Test Session ───────────────────────────────────────────────────

async function runRealLoadTestSession(
  runId: string,
  config: Record<string, unknown>,
  abortController: AbortController,
) {
  const testMode = (config.test_mode as string) ?? 'http';
  const autoStopThreshold = Number(config.auto_stop_error_threshold ?? 10);

  // Shared HTTP config
  const userCount = Number(config.user_count ?? 10);
  const durationSec = Number(config.duration_sec ?? 60);
  const rampUpSec = Number(config.ramp_up_sec ?? 10);
  const respectRateLimits = Boolean(config.respect_rate_limits ?? true);
  const storedPaths = (config.discovered_paths as string[] | undefined) ?? [];
  const paths = storedPaths.length > 0 ? storedPaths : ['/'];

  // Browser config
  const browserUserCount = Number(config.browser_user_count ?? 3);
  const browserDurationSec = Number(config.browser_duration_sec ?? 60);
  const browserRampUpSec = Number(config.browser_ramp_up_sec ?? 5);

  const mergedPageMetrics: Record<string, { count: number; avgMs: number; errors: number }> = {};
  const mergedErrorBreakdown: Record<string, number> = {};
  let totalCompleted = 0,
    totalFailed = 0,
    totalRequests = 0;
  let avgResponseMs = 0,
    p50Ms = 0,
    p95Ms = 0,
    p99Ms = 0,
    errorRate = 0;

  const runHttp = async () => {
    const loadConfig = {
      url: config.url as string,
      paths,
      userCount,
      durationMs: durationSec * 1000,
      rampUpMs: rampUpSec * 1000,
      respectRateLimits,
      autoStopErrorThreshold: autoStopThreshold,
      timeoutMs: 15000,
    };

    const onMetrics = (metrics: LiveMetrics) => {
      broadcastToRun(runId, {
        type: 'metrics',
        runId,
        stats: {
          activeAgents: metrics.activeUsers,
          requestsPerSec: metrics.requestsPerSec,
          errorRate: metrics.errorRate,
          avgResponseTime: metrics.avgResponseMs,
        },
        resourceStats: metrics.resourceStats,
        chartPoint: metrics.chartPoint,
        activity: metrics.activityBatch,
        enriched: {
          completed: metrics.completed,
          failed: metrics.failed,
          elapsedMs: metrics.elapsedMs,
          status: metrics.status,
          p50Ms: metrics.p50Ms,
          p95Ms: metrics.p95Ms,
          p99Ms: metrics.p99Ms,
          deviceCounts: null,
          pageVisits: metrics.pageVisits,
          journeyNames: null,
          errorsByType: metrics.errorsByType,
          pageMetrics: metrics.pageMetrics,
          engineType: 'http',
        },
      });
    };

    try {
      const stats = await runRealLoadTest(runId, loadConfig, abortController, onMetrics);
      totalCompleted += stats.completed;
      totalFailed += stats.failed;
      totalRequests += stats.totalRequests;
      avgResponseMs = stats.avgResponseMs;
      p50Ms = stats.p50Ms;
      p95Ms = stats.p95Ms;
      p99Ms = stats.p99Ms;
      errorRate = stats.errorRate;
      for (const [k, v] of Object.entries(stats.pageMetrics)) {
        mergedPageMetrics[k] = v;
      }
      for (const [k, v] of Object.entries(stats.errorBreakdown)) {
        mergedErrorBreakdown[k] = (mergedErrorBreakdown[k] ?? 0) + v;
      }
    } catch (err) {
      rootLogger.error({ err, runId }, 'HTTP load test engine error');
    }
  };

  const runBrowser = async () => {
    const browserConfig = {
      url: config.url as string,
      appType: (config.app_type as string) ?? 'generic',
      userCount: browserUserCount,
      durationMs: browserDurationSec * 1000,
      rampUpMs: browserRampUpSec * 1000,
      loginUsername: (config.login_username as string) ?? undefined,
      loginPassword: (config.login_password as string) ?? undefined,
      discoveredPaths: paths,
    };

    const onBrowserMetrics = (metrics: BrowserLiveMetrics) => {
      broadcastToRun(runId, {
        type: 'metrics',
        runId,
        stats: {
          activeAgents: metrics.activeUsers,
          requestsPerSec: 0,
          errorRate:
            metrics.completed + metrics.failed > 0
              ? Math.round((metrics.failed / (metrics.completed + metrics.failed)) * 100)
              : 0,
          avgResponseTime: metrics.avgDurationMs,
        },
        activity: metrics.activityBatch,
        enriched: {
          completed: metrics.completed,
          failed: metrics.failed,
          elapsedMs: 0,
          status: 'running',
          p50Ms: 0,
          p95Ms: 0,
          p99Ms: 0,
          pageVisits: Object.fromEntries(
            Object.entries(metrics.pageMetrics).map(([k, v]) => [k, v.count]),
          ),
          errorsByType: metrics.errorsByType,
          pageMetrics: metrics.pageMetrics,
          engineType: 'browser',
        },
      });
    };

    try {
      const stats = await runBrowserLoadTest(
        runId,
        browserConfig,
        abortController,
        onBrowserMetrics,
      );
      totalCompleted += stats.completed;
      totalFailed += stats.failed;
      totalRequests += stats.completed + stats.failed;
      const avgMs = stats.avgDurationMs;
      if (avgResponseMs === 0) {
        avgResponseMs = avgMs;
      } else {
        avgResponseMs = Math.round((avgResponseMs + avgMs) / 2);
      }
      // Merge browser percentiles — only set if HTTP didn't already set them
      if (p95Ms === 0 && stats.p95Ms) p95Ms = stats.p95Ms;
      if (p99Ms === 0 && stats.p99Ms) p99Ms = stats.p99Ms;
      if (p50Ms === 0 && stats.p50Ms) p50Ms = stats.p50Ms;
      for (const [k, v] of Object.entries(stats.pageMetrics)) {
        if (mergedPageMetrics[k]) {
          mergedPageMetrics[k].count += v.count;
          mergedPageMetrics[k].errors += v.errors;
        } else {
          mergedPageMetrics[k] = v;
        }
      }
      for (const [k, v] of Object.entries(stats.errorsByType)) {
        mergedErrorBreakdown[k] = (mergedErrorBreakdown[k] ?? 0) + v;
      }
    } catch (err) {
      rootLogger.error({ err, runId }, 'Browser load test engine error');
    }
  };

  if (testMode === 'http') {
    await runHttp();
  } else if (testMode === 'browser') {
    await runBrowser();
  } else {
    // "both" — run concurrently
    await Promise.allSettled([runHttp(), runBrowser()]);
  }

  if (totalRequests > 0) {
    errorRate = Math.round((totalFailed / totalRequests) * 100 * 10) / 10;
  }

  const finalStatus = abortController.signal.aborted ? 'cancelled' : 'completed';
  const passed = errorRate < autoStopThreshold;

  await db
    .update(testRunsTable)
    .set({
      status: finalStatus,
      ended_at: new Date(),
      total_requests: totalRequests,
      error_rate: errorRate,
      avg_response_ms: avgResponseMs,
      p50_ms: p50Ms,
      p95_ms: p95Ms,
      p99_ms: p99Ms,
      passed,
      user_count:
        testMode === 'browser'
          ? browserUserCount
          : testMode === 'both'
            ? userCount + browserUserCount
            : userCount,
      page_metrics: mergedPageMetrics,
      error_breakdown: mergedErrorBreakdown,
    })
    .where(eq(testRunsTable.id, runId));

  broadcastToRun(runId, {
    type: 'metrics',
    runId,
    stats: {
      activeAgents: 0,
      requestsPerSec: 0,
      errorRate,
      avgResponseTime: avgResponseMs,
    },
    enriched: {
      completed: totalCompleted,
      failed: totalFailed,
      elapsedMs: 0,
      status: finalStatus,
      p50Ms,
      p95Ms,
      p99Ms,
      pageVisits: Object.fromEntries(
        Object.entries(mergedPageMetrics).map(([k, v]) => [k, v.count]),
      ),
      errorsByType: mergedErrorBreakdown,
      pageMetrics: mergedPageMetrics,
    },
  });
}

// ─── Swarm Agent Runs ─────────────────────────────────────────────────────────

const llmProviderEnum = z.enum([
  'claude',       // alias for anthropic — kept for UI compatibility
  'anthropic',
  'groq',
  'cerebras',
  'ollama',
  'openrouter',
  'deepseek',
  'gemini',
  'none',
]);

const swarmRunSchema = z.object({
  targetUrl: z.string().url('targetUrl must be a valid http(s) URL'),
  maxSteps: z.coerce.number().int().min(1).max(200).optional(),
  stepTimeoutMs: z.coerce.number().int().min(1000).max(30_000).optional(),
  llmProvider: llmProviderEnum.optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().max(100).optional(),
  headless: z.boolean().optional(),
});

// In-memory store: runId → { agent, summary | null }
const swarmRuns = new Map<
  string,
  { agent: SwarmAgent; summary: SwarmRunSummary | null; startedAt: number }
>();

const startSwarmRun: RequestHandler = async (req, res) => {
  const body = validate(swarmRunSchema, req.body, res);
  if (!body) return;

  const runId = randomUUID();
  const agent = new SwarmAgent();

  swarmRuns.set(runId, { agent, summary: null, startedAt: Date.now() });

  // Stream events to any WebSocket clients watching this runId
  agent.on('event', (event) => {
    broadcastToRun(runId, { kind: 'swarm_event', runId, event });
  });

  // Fire and forget — client polls GET /swarm-runs/:id for status
  agent
    .run({
      targetUrl: body.targetUrl,
      maxSteps: body.maxSteps ?? 20,
      stepTimeoutMs: body.stepTimeoutMs ?? 6000,
      llmProvider: body.llmProvider ?? 'none',
      llmApiKey: body.llmApiKey,
      headless: body.headless ?? true,
    })
    .then((summary) => {
      const entry = swarmRuns.get(runId);
      if (entry) entry.summary = summary;
    })
    .catch((err) => {
      rootLogger.error({ err, runId }, 'Swarm run failed');
    });

  return res.status(202).json({ runId, status: 'running', message: 'Swarm agent started' });
};
router.post('/swarm-runs', startSwarmRun);

const getSwarmRun: RequestHandler<{ id: string }> = (req, res) => {
  const entry = swarmRuns.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Swarm run not found' });
  if (!entry.summary) {
    return res.json({ runId: req.params.id, status: 'running', startedAt: entry.startedAt });
  }
  return res.json({ runId: req.params.id, status: 'done', summary: entry.summary });
};
router.get('/swarm-runs/:id', getSwarmRun);

const stopSwarmRun: RequestHandler<{ id: string }> = (req, res) => {
  const entry = swarmRuns.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Swarm run not found' });
  entry.agent.abort();
  return res.json({ runId: req.params.id, status: 'aborted' });
};
router.post('/swarm-runs/:id/stop', stopSwarmRun);

// ─── Scenario Runs (Multi-Agent: Planner → Executor → Healer) ────────────────

const scenarioRunSchema = z.object({
  goal: z.string().min(5).max(500),
  targetUrl: z.string().url('targetUrl must be a valid http(s) URL'),
  maxSteps: z.coerce.number().int().min(1).max(50).optional(),
  stepTimeoutMs: z.coerce.number().int().min(1000).max(30_000).optional(),
  allowHealing: z.boolean().optional(),
  headless: z.boolean().optional(),
  storageStatePath: z.string().max(500).optional(),
  llmProvider: llmProviderEnum.optional(),
  llmApiKey: z.string().optional(),
  llmModel: z.string().max(100).optional(),
  llmBaseUrl: z.string().url().optional(),
});

const seedAuthSchema = z.object({
  loginUrl: z.string().url('loginUrl must be a valid http(s) URL'),
  usernameField: z.string().min(1).max(100),
  passwordField: z.string().min(1).max(100),
  submitButton: z.string().min(1).max(100),
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(500),
  outputName: z.string().min(1).max(80).optional(),
  expectUrl: z.string().max(500).optional(),
});

const scenarioRuns = new Map<
  string,
  {
    orchestrator: ScenarioOrchestrator;
    summary: ScenarioRunSummary | null;
    startedAt: number;
  }
>();

const startScenarioRun: RequestHandler = async (req, res) => {
  const body = validate(scenarioRunSchema, req.body, res);
  if (!body) return;

  const runId = randomUUID();
  const orchestrator = new ScenarioOrchestrator();

  scenarioRuns.set(runId, { orchestrator, summary: null, startedAt: Date.now() });

  orchestrator.on('event', (event) => {
    broadcastToRun(runId, { kind: 'scenario_event', runId, event });
  });

  const resolvedProvider = (body.llmProvider ??
    (process.env.LLM_PROVIDER as AgentLLMProvider | undefined) ??
    'groq') as AgentLLMProvider;

  orchestrator
    .run(runId, {
      goal: body.goal,
      targetUrl: body.targetUrl,
      maxSteps: body.maxSteps,
      stepTimeoutMs: body.stepTimeoutMs,
      allowHealing: body.allowHealing ?? true,
      headless: body.headless ?? true,
      storageStatePath: body.storageStatePath,
      llm: {
        provider: resolvedProvider,
        apiKey: body.llmApiKey,
        model: body.llmModel,
        baseUrl: body.llmBaseUrl,
      },
    })
    .then((summary) => {
      const entry = scenarioRuns.get(runId);
      if (entry) entry.summary = summary;
    })
    .catch((err) => {
      rootLogger.error({ err, runId }, 'Scenario orchestrator threw');
    });

  return res.status(202).json({ runId, status: 'planning', message: 'Scenario run started' });
};
router.post('/scenario-runs', startScenarioRun);

const getScenarioRun: RequestHandler<{ id: string }> = (req, res) => {
  const entry = scenarioRuns.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Scenario run not found' });
  if (!entry.summary) {
    return res.json({ runId: req.params.id, status: 'running', startedAt: entry.startedAt });
  }
  return res.json({ runId: req.params.id, status: 'done', summary: entry.summary });
};
router.get('/scenario-runs/:id', getScenarioRun);

const stopScenarioRun: RequestHandler<{ id: string }> = (req, res) => {
  const entry = scenarioRuns.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Scenario run not found' });
  entry.orchestrator.abort();
  return res.json({ runId: req.params.id, status: 'aborted' });
};
router.post('/scenario-runs/:id/stop', stopScenarioRun);

// ─── Seed Auth (login bootstrap for Scenario runs) ───────────────────────────

const runSeedAuth: RequestHandler = async (req, res) => {
  const body = validate(seedAuthSchema, req.body, res);
  if (!body) return;

  const safeName = (body.outputName ?? `seed-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_');
  const outputPath = path.resolve(process.cwd(), '.storage-state', `${safeName}.json`);

  try {
    const savedTo = await seedAuth({
      loginUrl: body.loginUrl,
      usernameField: body.usernameField,
      passwordField: body.passwordField,
      submitButton: body.submitButton,
      username: body.username,
      password: body.password,
      outputPath,
      expectUrl: body.expectUrl,
    });
    return res.json({ storageStatePath: savedTo, message: 'Seed auth saved' });
  } catch (err) {
    if (err instanceof SeedAuthError) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    rootLogger.error({ err }, 'Seed auth failed');
    return res.status(500).json({ error: 'Seed auth failed' });
  }
};
router.post('/scenario-runs/seed-auth', runSeedAuth);

export default router;
