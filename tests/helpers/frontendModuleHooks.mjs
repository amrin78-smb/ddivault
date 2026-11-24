//
// tests/helpers/frontendModuleHooks.mjs — module resolve hooks that let a test
// import a FRONTEND TypeScript module (route handler, lib) directly under
// `node --test`:
//
//   * `next/server`     -> ./next-server-stub.mjs  (see that file for why)
//   * `@/lib/<name>`    -> frontend/src/lib/<name>.ts   (the tsconfig path alias
//                          that Next/tsc resolve and bare Node does not)
//
// Node strips the TypeScript types itself (node >= 22.18 / 24), so the module
// under test is the REAL file, not a copy.
//
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = path.resolve(here, '..', '..', 'frontend', 'src');
const NEXT_SERVER_STUB = new URL('./next-server-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') {
    return { url: NEXT_SERVER_STUB, shortCircuit: true, format: 'module' };
  }
  if (specifier.startsWith('@/')) {
    const target = path.join(FRONTEND_SRC, specifier.slice(2) + '.ts');
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
