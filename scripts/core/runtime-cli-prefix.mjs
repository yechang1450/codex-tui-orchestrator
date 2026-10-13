import path from 'node:path';
import {fileURLToPath} from 'node:url';

const pluginRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

// Node exposes the real Windows process environment case-insensitively, while
// injectable test and bootstrap environments are plain objects. Keep the
// bootstrap-owned data root stable across both forms without trusting npm's
// inherited configuration.
function environmentValue(env, name) {
  if (!env || typeof env !== 'object') return '';
  const direct = env[name];
  if (typeof direct === 'string') return direct.trim();
  const wanted = String(name).toLowerCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') return value.trim();
  }
  return '';
}

/** The private CLI prefix owned by this plugin bootstrap, never npm's ambient prefix. */
export function runtimeCliPrefix(env = process.env) {
  const dataRoot = environmentValue(env, 'PLUGIN_DATA');
  const runtimeHome = dataRoot
    ? path.resolve(dataRoot, 'runtime')
    : path.resolve(pluginRoot, 'temp', 'runtime');
  return path.join(runtimeHome, 'cli');
}

export function runtimeCliNodeModulesRoot(env = process.env) {
  return path.join(runtimeCliPrefix(env), 'node_modules');
}
