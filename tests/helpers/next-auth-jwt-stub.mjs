//
// tests/helpers/next-auth-jwt-stub.mjs — stand-in for `next-auth/jwt` so
// middleware.ts can be driven under `node --test`.
//
// ⛔ The POINT of the stub is that `getToken()` returns null for reasons the
// caller cannot distinguish. The real v4 implementation returns null both when
// no session cookie was sent AND when one was sent that it cannot read (wrong
// cookie name because `secureCookie` is derived from `NEXTAUTH_URL`'s scheme, or
// a rotated `NEXTAUTH_SECRET`). `setToken(null)` with a cookie on the request is
// exactly that second state, which is otherwise unreachable in a unit test.
//
const state = { token: null };

export function setToken(v) {
  state.token = v;
}

export async function getToken() {
  return state.token;
}
