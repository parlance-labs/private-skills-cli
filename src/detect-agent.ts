import { determineAgent, type AgentResult } from '@vercel/detect-agent';
import { setDetectedAgent } from './telemetry.ts';
import type { AgentType } from './types.ts';

let cachedResult: AgentResult | null = null;

/**
 * Map from @vercel/detect-agent names to skills-cli AgentType identifiers.
 * Only includes agents that exist in both systems.
 */
const agentNameToType: Record<string, AgentType> = {
  cursor: 'cursor',
  'cursor-cli': 'cursor',
  claude: 'claude-code',
  cowork: 'claude-code',
  devin: 'universal', // Devin not in skills-cli agent list, use universal
  replit: 'replit',
  gemini: 'gemini-cli',
  codex: 'codex',
  antigravity: 'antigravity',
  'augment-cli': 'augment',
  opencode: 'opencode',
  'github-copilot': 'github-copilot',
};

/** Non-agent sentinel returned when detection is forced off. */
const NOT_AGENT: AgentResult = { isAgent: false } as AgentResult;

/**
 * Detect if the CLI is being run inside an AI agent environment.
 * Results are cached after the first call. Also updates telemetry with the agent name.
 *
 * Set SKILLS_FORCE_AGENT_DETECTION=0 to force non-agent mode (useful in tests).
 * Set SKILLS_FORCE_AGENT_DETECTION=1 to force agent mode.
 */
export async function detectAgent(): Promise<AgentResult> {
  if (cachedResult) return cachedResult;

  const override = process.env.SKILLS_FORCE_AGENT_DETECTION;
  if (override === '0') {
    cachedResult = NOT_AGENT;
    return cachedResult;
  }

  cachedResult = await determineAgent();

  if (override === '1' && !cachedResult.isAgent) {
    cachedResult = {
      isAgent: true,
      agent: { name: 'devin' },
    } as AgentResult;
  }

  if (cachedResult.isAgent) {
    setDetectedAgent(cachedResult.agent.name);
  }
  return cachedResult;
}

/** Clear cached detection result (for tests). */
export function resetAgentDetectionCache(): void {
  cachedResult = null;
}

/**
 * Returns true if the CLI is running inside a detected AI agent.
 * When true, the CLI should skip interactive prompts and use sensible defaults.
 */
export async function isRunningInAgent(): Promise<boolean> {
  const result = await detectAgent();
  return result.isAgent;
}

/**
 * Returns the name of the detected agent, or null if not running in an agent.
 */
export async function getAgentName(): Promise<string | null> {
  const result = await detectAgent();
  return result.isAgent ? result.agent.name : null;
}

/**
 * Maps a detected agent name to the corresponding skills-cli AgentType.
 * Returns null if the agent can't be mapped to a specific skills-cli agent.
 */
export function getAgentType(agentName: string): AgentType | null {
  return agentNameToType[agentName] ?? null;
}
