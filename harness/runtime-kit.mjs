import path from 'node:path';
import { createRequire } from 'node:module';

// A checkout is useful until the Runtime release containing kits/general is published.
export function runtimeDirectory(env = process.env) {
  return path.resolve(env.RULITH_RUNTIME_DIR || path.dirname(createRequire(import.meta.url).resolve('rulith/package.json')));
}
export const generalKit = (env = process.env) => path.join(runtimeDirectory(env), 'kits', 'general');
