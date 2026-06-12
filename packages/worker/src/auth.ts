import type { Env } from "./types";

export async function isAuthorized(request: Request, env: Env) {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const supplied = header.slice("Bearer ".length);
  const encoder = new TextEncoder();
  const [expectedDigest, suppliedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(env.API_TOKEN)),
    crypto.subtle.digest("SHA-256", encoder.encode(supplied))
  ]);

  return equalBytes(new Uint8Array(expectedDigest), new Uint8Array(suppliedDigest));
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}
