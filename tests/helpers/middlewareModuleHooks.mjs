//
// tests/helpers/middlewareModuleHooks.mjs — module resolve hooks that let a test
// import `frontend/src/middleware.ts` directly under `node --test`:
//
//   * `next/server`     -> ./next-server-stub.mjs       (reused as-is)
//   * `next-auth/jwt`   -> ./next-auth-jwt-stub.mjs     (getToken, controllable)
//   * `@/lib/<name>`    -> frontend/src/lib/<name>.ts   (the tsconfig alias that
//                          Next/tsc resolve and bare Node does not)
//
// Separate from `frontendModuleHooks.mjs` only because middleware also pulls in
// `next-auth/jwt`, which lives in `frontend/node_modules` and so is unresolvable
// from a test at the repo root. Node strips the TypeScript types itself
// (node >= 22.18 / 24), so the module under test is the REAL file.
//
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_SRC = path.resolve(here, '..', '..', 'frontend', 'src');
const NEXT_SERVER_STUB  = new URL('./next-server-stub.mjs', import.meta.url).href;
const NEXT_AUTH_JWT_STUB = new URL('./next-auth-jwt-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'next/server') {
    return { url: NEXT_SERVER_STUB, shortCircuit: true, format: 'module' };
  }
  if (specifier === 'next-auth/jwt') {
    return { url: NEXT_AUTH_JWT_STUB, shortCircuit: true, format: 'module' };
  }
  if (specifier.startsWith('@/')) {
    const target = path.join(FRONTEND_SRC, specifier.slice(2) + '.ts');
    return { url: pathToFileURL(target).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
