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

import { isValidBlogId, validateBlogId } from '../blog-id';
import { legacyBlogManifest, type LegacyBlogManifest } from '../legacy-blog-manifest';
import type { LiveBlog } from '../../durable-objects/LiveBlog';
import type { BlogDirectory } from '../../durable-objects/BlogDirectory';
import type { Result, Snapshot } from '../protocol';

/** Wrangler generates the typed namespace from the existing class binding. */
export function blogNamespace(bindings: Env): DurableObjectNamespace<LiveBlog> {
	return bindings.LIVE_BLOG;
}

/** Typed stub, for callers that receive `env` as an argument (the Worker). */
export function blogStub(bindings: Env, blogId: string): DurableObjectStub<LiveBlog> {
	const namespace = blogNamespace(bindings);
	return namespace.get(namespace.idFromName(blogId));
}

/** Typed stub, for callers with no `env` in scope (Astro pages and endpoints). */
export function directory(bindings: Env): DurableObjectStub<BlogDirectory> {
	return bindings.BLOG_DIRECTORY.getByName('global');
}

type BlogLookupBindings = Pick<Env, 'LIVE_BLOG' | 'BLOG_DIRECTORY'> & LegacyBlogManifest;

/** Hashing a name is local; get()/RPC happen only after admission or verification. */
export async function resolveBlogStub(bindings: BlogLookupBindings, blogId: string): Promise<DurableObjectStub<LiveBlog> | null> {
	if (!isValidBlogId(blogId)) return null;
	const manifest = legacyBlogManifest(bindings);
	const registry = bindings.BLOG_DIRECTORY.getByName('global');
	const entry = await registry.lookup(blogId);
	const objectId = bindings.LIVE_BLOG.idFromName(blogId);
	if (entry && !entry.legacy && entry.expires > Date.now()) return bindings.LIVE_BLOG.get(objectId);
	if (!entry?.legacy && !manifest.objects.has(objectId.toString()) && !manifest.names.has(blogId)) return null;

	// No author capability, post contents, schema initialization or alarm writes.
	const stub = bindings.LIVE_BLOG.get(objectId);
	const metadata = await stub.getPublicMetadata();
	if (!metadata.ok || metadata.value.blogId !== blogId) return null;
	return await registry.registerLegacy(blogId, metadata.value) ? stub : null;
}

export async function getBlogStub(blogId: string): Promise<DurableObjectStub<LiveBlog> | null> {
	return resolveBlogStub(env, blogId);
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

	const stub = await getBlogStub(validation.blogId);
	if (!stub) return { blogId: validation.blogId, snapshot: null, error: 'Live blog not found.' };
	const result: Result<Snapshot> = await stub.getSnapshot(options);
	if (!result.ok) {
		return { blogId: validation.blogId, snapshot: null, error: result.error };
	}

	return { blogId: validation.blogId, snapshot: result.value };
}
