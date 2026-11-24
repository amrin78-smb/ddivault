//
// tests/helpers/next-server-stub.mjs — the smallest honest stand-in for
// `next/server`, so a frontend route handler can be loaded and called by
// `node --test` with no Next.js runtime.
//
// ⛔ WHY A STUB IS NEEDED AT ALL: `next` lives in `frontend/node_modules` and
// ships no `exports` map, so bare ESM `import 'next/server'` cannot resolve
// (`ERR_MODULE_NOT_FOUND` on an extensionless path) outside the bundler. The
// alternative was to make `frontend/src/lib/publicUrl.ts` import NextRequest as
// `import type`, which is deliberately off-limits (that file is shared,
// verified-live code we do not touch).
//
// `NextResponse.redirect` here delegates to the WHATWG `Response.redirect`,
// which is what Next's own implementation ultimately produces — so the asserted
// `status` / `location` are the real ones, not an invention of this file.
//

export class NextRequest {}

export const NextResponse = {
  redirect(url, status = 307) {
    return Response.redirect(String(url), status);
  },
  json(body, init) {
    return Response.json(body, init);
  },
  next() {
    return new Response(null, { status: 200 });
  },
  rewrite(url) {
    return new Response(null, { status: 200, headers: { 'x-middleware-rewrite': String(url) } });
  },
};
