// Cloudflare Access JWT verification (RS256) using WebCrypto + JWKS.
// The Cloudflare edge injects the signed JWT in the `Cf-Access-Jwt-Assertion`
// header after a successful Access login. We verify it here as defense in depth.

// Module-scoped JWKS cache (persists across requests on the same isolate).
let jwksCache = { keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

function b64urlToBuf(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBuf(parts[1])));
  return {
    payload,
    signingInput: parts[0] + "." + parts[1],
    signature: parts[2],
  };
}

async function fetchJwks(authDomain) {
  const now = Date.now();
  if (jwksCache.keys && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`${authDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Failed to fetch JWKS (${res.status})`);
  const data = await res.json();
  jwksCache = { keys: data.keys || [], fetchedAt: now };
  return jwksCache.keys;
}

// Returns the JWT payload on success, throws on any failure.
export async function verify(token, authDomain, aud) {
  if (!token) throw new Error("Missing token");
  const { payload, signingInput, signature } = decodeJwt(token);

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && payload.exp < now) {
    throw new Error("Token expired");
  }

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) {
    throw new Error("Audience mismatch");
  }

  const keys = await fetchJwks(authDomain);
  const jwk = keys.find((k) => k.kid === payload.kid);
  if (!jwk) throw new Error("No matching signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    new Uint8Array(b64urlToBuf(signature)),
    new TextEncoder().encode(signingInput)
  );
  if (!valid) throw new Error("Invalid signature");

  return payload;
}
