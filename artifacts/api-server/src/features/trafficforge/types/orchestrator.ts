import type { ScanResult } from '../engine/scanner.js';
import type { AgentEvent } from '../engine/agentExecutor.js';

export interface OrchestratorState {
  url: string;
  scanResult?: ScanResult;
  scenarios?: Scenario[];
  events?: AgentEvent[];
  bugs?: DetectedBug[];
  report?: TestReport;
  status:
    | 'pending'
    | 'scanning'
    | 'planning'
    | 'executing'
    | 'detecting'
    | 'reporting'
    | 'complete'
    | 'error';
  error?: string;
}

export interface Scenario {
  name: string;
  description: string;
  agents: ScenarioAgent[];
}

export interface ScenarioAgent {
  role: 'chatter' | 'commenter' | 'monitor';
  actions: any[];
}

export interface DetectedBug {
  id: string;
  title: string;
  type: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
  evidence: string[];
  confidence: number;
}

export interface TestReport {
  summary: string;
  bugs: DetectedBug[];
  metrics: Record<string, number>;
  recommendations: string[];
}

export type NodeName = 'planner' | 'executor' | 'detector' | 'reporter';

export interface NodeHandler {
  (state: OrchestratorState): Promise<Partial<OrchestratorState>>;
}
