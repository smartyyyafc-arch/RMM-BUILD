import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Generates a new opaque token (URL-safe hex). */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Hashes a token for at-rest storage. Tokens are high-entropy, so a fast
 * hash is sufficient — we never store the plaintext. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two secrets to avoid timing side channels. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Extracts a bearer token from an Authorization header, or null. */
export function bearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
