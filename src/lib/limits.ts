/**
 * Shared limits for the public demo.
 *
 * These numbers are internally consistent, which is the point. A previous
 * iteration of this project advertised 1,000 posts per blog while storing every
 * post inside a single key-value entry with a 128KB ceiling — the app broke
 * around a dozen full-length posts, well before reaching the documented limit.
 *
 * With the SQLite storage backend each Durable Object gets its own 10GB
 * database, so the worst case here is:
 *
 *   MAX_POSTS_PER_BLOG * MAX_BODY_LENGTH = 5,000 * 4,000 chars ≈ 20MB
 *
 * That is roughly 0.2% of the available space, so these caps exist to bound
 * abuse on a public demo, not to work around a storage cliff.
 *
 * Both the client and the server import this file, so validation messages and
 * character counters cannot drift apart.
 */

/** Longest markdown source accepted for a single post. */
export const MAX_BODY_LENGTH = 4_000;

/** Longest byline. */
export const MAX_AUTHOR_LENGTH = 80;

/** Longest blog title. */
export const MAX_TITLE_LENGTH = 140;

/** Longest standfirst / summary. */
export const MAX_SUMMARY_LENGTH = 280;

/** Longest blog id accepted in a URL. */
export const MAX_BLOG_ID_LENGTH = 64;

/** Hard cap on posts per blog, enforced in SQL against a real COUNT. */
export const MAX_POSTS_PER_BLOG = 5_000;

/** Hard cap on simultaneously pinned "key events". */
export const MAX_PINNED_POSTS = 12;

/** Hard cap on concurrent reader sockets for one blog. */
export const MAX_CONNECTIONS_PER_BLOG = 1_000;

/** Posts rendered into the server HTML on first paint, and per history page. */
export const SNAPSHOT_PAGE_SIZE = 50;

/**
 * Largest gap a reconnecting client may replay over the socket. Beyond this we
 * tell the client to re-fetch a snapshot instead, so one long-disconnected tab
 * cannot make the Durable Object serialize an unbounded result set.
 */
export const MAX_REPLAY_POSTS = 200;

/** Blogs with no writes for this long are cleaned up by the DO alarm. */
export const BLOG_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** How often the cleanup alarm re-arms itself. */
export const ALARM_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Post kinds. `update` is the default; the rest change presentation only. */
export const POST_KINDS = ['update', 'headline', 'quote', 'image', 'embed'] as const;

export type PostKind = (typeof POST_KINDS)[number];

export function isPostKind(value: unknown): value is PostKind {
	return typeof value === 'string' && (POST_KINDS as readonly string[]).includes(value);
}
