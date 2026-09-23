/**
 * Worker entrypoint.
 *
 * We take over the entrypoint from the Astro adapter (`main` in wrangler.jsonc)
 * for two reasons the framework cannot cover:
 *
 *   1. Wrangler needs named exports of the Durable Object classes.
 *   2. A WebSocket upgrade must return a 101 response carrying a `webSocket`
 *      property. That value does not survive a framework render pipeline, so the
 *      whole `/api/blogs/*` surface is answered here, before Astro is consulted.
 *
 * Anything that is not an API route is delegated to Astro via `handle()`.
 *
 * This is the documented custom-entrypoint pattern for @astrojs/cloudflare v13+.
 * The previous iteration of this project achieved the same thing by dynamically
 * importing OpenNext's generated `worker.js` from inside its own handler and
 * catching the failure — which worked, but was not a supported interface.
 */

import { handle } from '@astrojs/cloudflare/handler';

import { BlogCreationRateLimiter } from './durable-objects/BlogCreationRateLimiter';
import { LiveBlog } from './durable-objects/LiveBlog';
import { EDIT_TOKEN_HEADER } from './lib/capability';
import { isValidBlogId, validateBlogId } from './lib/blog-id';
import { SNAPSHOT_PAGE_SIZE } from './lib/limits';
import type { Result } from './lib/protocol';
import { json, readJson } from './lib/server/api-response';
import { blogStub } from './lib/server/blog';
import { handleCreateBlog } from './lib/server/create-blog';

export { BlogCreationRateLimiter, LiveBlog };

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/api/blogs' || url.pathname.startsWith('/api/blogs/')) {
			try {
				const response = await routeApi(request, env, url);

				/**
				 * A WebSocket upgrade must be returned exactly as the Durable Object
				 * produced it.
				 *
				 * `new Response(body, { status: 101 })` throws outright — the Response
				 * constructor only accepts 200-599 — and even if it did not, copying the
				 * response would drop the `webSocket` property that makes the upgrade
				 * work. This is the same reason the upgrade cannot be an Astro route.
				 */
				if (response.status === 101) return response;

				return withApiHeaders(response);
			} catch (error) {
				console.error(JSON.stringify({ event: 'api_error', path: url.pathname, error: String(error) }));
				return withApiHeaders(json({ error: 'Something went wrong handling that request.' }, 500));
			}
		}

		const response = await handle(request, env, ctx);
		return withDocumentHeaders(response);
	},
} satisfies ExportedHandler<Env>;

/* -------------------------------------------------------------------------- */
/*                                  Routing                                   */
/* -------------------------------------------------------------------------- */

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
	// ['api', 'blogs', ':blogId', ...rest]
	const segments = url.pathname.split('/').filter(Boolean);
	const method = request.method.toUpperCase();

	// POST /api/blogs — create a live blog
	if (segments.length === 2) {
		if (method !== 'POST') return methodNotAllowed('POST');
		return handleCreateBlog(request, env, url);
	}

	const blogIdRaw = segments[2] ?? '';
	const blogId = safeDecode(blogIdRaw);
	const validation = validateBlogId(blogId);
	if (!validation.valid) return json({ error: validation.error }, 400);

	const stub = blogStub(env, validation.blogId);
	const rest = segments.slice(3);
	const token = request.headers.get(EDIT_TOKEN_HEADER);

	// GET /api/blogs/:id/socket — WebSocket upgrade (must be a fetch, not RPC)
	if (rest.length === 1 && rest[0] === 'socket') {
		if (method !== 'GET') return methodNotAllowed('GET');
		return stub.fetch(request);
	}

	// GET /api/blogs/:id/snapshot — paginated history
	if (rest.length === 1 && rest[0] === 'snapshot') {
		if (method !== 'GET') return methodNotAllowed('GET');
		const before = parsePositiveInt(url.searchParams.get('before'));
		const limit = parsePositiveInt(url.searchParams.get('limit')) ?? SNAPSHOT_PAGE_SIZE;
		return unwrap(await stub.getSnapshot({ before, limit }));
	}

	// GET /api/blogs/:id/session — does the caller hold a valid author capability?
	if (rest.length === 1 && rest[0] === 'session') {
		if (method !== 'GET') return methodNotAllowed('GET');
		const authorized = await stub.checkToken(token);
		return json({ authorized }, authorized ? 200 : 403);
	}

	// PATCH /api/blogs/:id/meta
	if (rest.length === 1 && rest[0] === 'meta') {
		if (method !== 'PATCH') return methodNotAllowed('PATCH');
		const body = await readJson<{ title?: string; summary?: string }>(request);
		if (!body.ok) return json({ error: body.error }, 400);
		return unwrap(await stub.updateMeta(token, body.value));
	}

	// PUT /api/blogs/:id/status
	if (rest.length === 1 && rest[0] === 'status') {
		if (method !== 'PUT') return methodNotAllowed('PUT');
		const body = await readJson<{ status?: string }>(request);
		if (!body.ok) return json({ error: body.error }, 400);
		const status = body.value.status;
		if (status !== 'live' && status !== 'ended') {
			return json({ error: 'Status must be "live" or "ended".' }, 400);
		}
		return unwrap(await stub.setStatus(token, status));
	}

	// POST /api/blogs/:id/posts
	if (rest.length === 1 && rest[0] === 'posts') {
		if (method !== 'POST') return methodNotAllowed('POST');
		const body = await readJson<Record<string, unknown>>(request);
		if (!body.ok) return json({ error: body.error }, 400);
		return unwrap(
			await stub.createPost(token, {
				body: String(body.value.body ?? ''),
				author: optionalString(body.value.author),
				kind: body.value.kind as never,
				pinned: body.value.pinned === true,
			}),
		);
	}

	// PATCH | DELETE /api/blogs/:id/posts/:postId
	if (rest.length === 2 && rest[0] === 'posts') {
		const postId = safeDecode(rest[1] ?? '');
		if (!postId) return json({ error: 'A post id is required.' }, 400);

		if (method === 'GET') return unwrap(await stub.getPost(postId));

		if (method === 'DELETE') {
			return unwrap(await stub.deletePost(token, postId));
		}

		if (method === 'PATCH') {
			const body = await readJson<Record<string, unknown>>(request);
			if (!body.ok) return json({ error: body.error }, 400);
			return unwrap(
				await stub.updatePost(token, postId, {
					body: body.value.body === undefined ? undefined : String(body.value.body),
					author: body.value.author === undefined ? undefined : optionalString(body.value.author),
					kind: body.value.kind as never,
					pinned: body.value.pinned === undefined ? undefined : body.value.pinned === true,
				}),
			);
		}

		return methodNotAllowed('GET, PATCH, DELETE');
	}

	return json({ error: 'Unknown endpoint.' }, 404);
}

/* -------------------------------------------------------------------------- */
/*                            Response helpers                                */
/* -------------------------------------------------------------------------- */

function unwrap<T>(result: Result<T>): Response {
	if (result.ok) return json(result.value, 200);
	return json({ error: result.error }, result.status);
}

function methodNotAllowed(allow: string): Response {
	return new Response(JSON.stringify({ error: `Method not allowed. Expected ${allow}.` }), {
		status: 405,
		headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: allow },
	});
}

/* -------------------------------------------------------------------------- */
/*                            Security headers                                */
/* -------------------------------------------------------------------------- */

/**
 * Headers applied to HTML responses.
 *
 * Note what is *not* here: `Content-Security-Policy`. Astro's `security.csp`
 * generates a policy with per-build hashes for every bundled script and style and
 * emits it as a `<meta http-equiv>` element (see astro.config.mjs). Setting a
 * second CSP here would be enforced as an intersection with that one and would
 * break island hydration the moment the hashes stopped matching.
 *
 * The previous iteration shipped a hand-written CSP containing `'unsafe-eval'`
 * and `'unsafe-inline'` for scripts — required by its dev server, but sent to
 * production, where it defeated most of the point of having a policy.
 */
function withDocumentHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
	headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	// Redundant with `frame-ancestors 'none'` in the CSP, kept for older browsers.
	headers.set('X-Frame-Options', 'DENY');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function withApiHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Referrer-Policy', 'no-referrer');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/* -------------------------------------------------------------------------- */
/*                                  Parsing                                   */
/* -------------------------------------------------------------------------- */

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return '';
	}
}

function parsePositiveInt(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalString(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

// Re-exported for the Astro pages, which validate ids before touching a stub.
export { isValidBlogId };
