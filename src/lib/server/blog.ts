/**
 * Server-side access to a blog's Durable Object.
 *
 * Astro pages call these directly, which means a page render talks to the Durable
 * Object over RPC in-process — no HTTP round trip back into our own Worker just to
 * read data we are already authorized to read.
 *
 * This is what lets the reader page put the feed in its first HTML byte. The
 * previous iteration rendered an empty shell and had the browser fetch the feed
 * after hydration, so nothing was visible until three sequential steps had
 * completed: download JS, hydrate, fetch.
 */

import { env } from 'cloudflare:workers';

import { validateBlogId } from '../blog-id';
import type { LiveBlog } from '../../durable-objects/LiveBlog';
import type { Result, Snapshot } from '../protocol';

/**
 * `wrangler types` emits `DurableObjectNamespace /* LiveBlog *\/` — it knows the
 * class name but cannot import the class to parameterize the generic, so the
 * generated binding has no RPC method types.
 *
 * This is the one place we bridge that gap. Casting here, once, gives every caller
 * a fully typed stub, so a typo in an RPC method name or argument is a build
 * error rather than a runtime failure.
 */
export function blogNamespace(bindings: Env): DurableObjectNamespace<LiveBlog> {
	return bindings.LIVE_BLOG as unknown as DurableObjectNamespace<LiveBlog>;
}

/** Typed stub, for callers that receive `env` as an argument (the Worker). */
export function blogStub(bindings: Env, blogId: string): DurableObjectStub<LiveBlog> {
	const namespace = blogNamespace(bindings);
	return namespace.get(namespace.idFromName(blogId));
}

/** Typed stub, for callers with no `env` in scope (Astro pages and endpoints). */
export function getBlogStub(blogId: string): DurableObjectStub<LiveBlog> {
	return blogStub(env, blogId);
}

export type LoadSnapshotResult =
	| { blogId: string; snapshot: Snapshot; error?: undefined }
	| { blogId: string | null; snapshot: null; error: string };

/**
 * Validate an untrusted route parameter and load a snapshot.
 *
 * Validation happens before a stub is obtained, because `idFromName` accepts any
 * string — an unvalidated id would turn the route into an unbounded, publicly
 * addressable key space.
 */
export async function loadSnapshot(
	blogIdParam: string | undefined,
	options: { limit?: number; before?: number } = {},
): Promise<LoadSnapshotResult> {
	const validation = validateBlogId(blogIdParam);
	if (!validation.valid) {
		return { blogId: null, snapshot: null, error: validation.error };
	}

	const result: Result<Snapshot> = await getBlogStub(validation.blogId).getSnapshot(options);
	if (!result.ok) {
		return { blogId: validation.blogId, snapshot: null, error: result.error };
	}

	return { blogId: validation.blogId, snapshot: result.value };
}
