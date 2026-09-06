import { resolveHost } from './host-cli.mjs';
export { adapters as AGENTS, launchArgs } from './host-cli.mjs';
export function resolveAgent() {
  if (process.env.ORCH_AGENT && process.env.ORCH_AGENT !== 'codex') throw new Error('Codex plugin only supports codex; use open-tui-orchestrator for host adapters.');
  return resolveHost({ agent: 'codex' });
}
