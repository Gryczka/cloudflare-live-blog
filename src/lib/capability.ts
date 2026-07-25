/**
 * Capability tokens for author access.
 *
 * The problem being solved: a live blog needs a writer role, but a public demo
 * cannot ask visitors to create accounts. The previous iteration resolved this
 * by having no access control whatsoever — anyone who guessed a blog id could
 * publish to it.
 *
 * The model here:
 *
 *   - Creating a blog mints a 256-bit random `editToken`, returned exactly once.
 *   - Only `sha256(editToken)` is persisted. The token itself is never stored,
 *     so a database read does not yield the ability to publish.
 *   - The token travels in the URL *fragment* (`#edit=...`). Fragments are not
 *     sent to servers, so the token stays out of access logs, the `Referer`
 *     header, and any analytics beacon. The author console reads it from
 *     `location.hash` and attaches it to write requests as a header.
 *   - Verification is a constant-time comparison of hex digests.
 *
 * Readers need no token at all — a live blog is public by definition. This is
 * only about who may write.
 */

const TOKEN_BYTES = 32;

/** Header used to carry the capability token on write requests. */
export const EDIT_TOKEN_HEADER = 'X-Edit-Token';

/** Fragment key the author console reads the token from. */
export const EDIT_TOKEN_FRAGMENT_KEY = 'edit';

/**
 * Mint a new capability token. Uses `crypto.getRandomValues`, encoded
 * base64url so it survives being placed in a URL fragment untouched.
 */
export function mintToken(): string {
	const bytes = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

/** SHA-256 of a token, as lowercase hex. This is what gets persisted. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compare a presented token against a stored hash.
 *
 * The hash comparison accumulates differences instead of returning early, so
 * the time taken does not depend on how many leading characters matched.
 */
export async function verifyToken(
	presented: string | null | undefined,
	storedHash: string | null | undefined,
): Promise<boolean> {
	if (!presented || !storedHash) return false;
	const presentedHash = await hashToken(presented);
	return timingSafeEqual(presentedHash, storedHash);
}

/**
 * Constant-time string comparison for equal-length hex digests.
 *
 * Length is compared first and returns early — that is safe here because both
 * inputs are SHA-256 hex digests of known fixed length, so length carries no
 * secret information.
 */
export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Build the author URL for a freshly created blog. The token goes after `#` so
 * it is never transmitted to the server as part of navigation.
 */
export function buildAuthorUrl(origin: string, blogId: string, editToken: string): string {
	return `${origin}/blog/${encodeURIComponent(blogId)}/author#${EDIT_TOKEN_FRAGMENT_KEY}=${editToken}`;
}

/** Read a capability token out of a URL fragment such as `#edit=abc`. */
export function readTokenFromFragment(hash: string): string | null {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash;
	if (!raw) return null;
	const token = new URLSearchParams(raw).get(EDIT_TOKEN_FRAGMENT_KEY);
	return token && token.length > 0 ? token : null;
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
