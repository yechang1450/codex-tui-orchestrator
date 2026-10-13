import {runtimeCliNodeModulesRoot} from './runtime-cli-prefix.mjs';

/**
 * Runtime preparation may reuse only the private prefix owned by its current
 * bootstrap.  The SDK dependency tree is an API dependency, not a host CLI
 * source: treating its optional native package as a host candidate can pin a
 * fresh installation to the SDK's historical transitive CLI release.
 */
export function runtimeCliCandidateRoots(env = process.env) {
  return [runtimeCliNodeModulesRoot(env)];
}
