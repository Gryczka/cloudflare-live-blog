/**
 * Worker entrypoint.
 *
 * We take over the entrypoint from the Astro adapter (`main` in wrangler.jsonc)
 * for two reasons the framework cannot cover:
 *
 *   1. Wrangler needs a named export of the Durable Object class.
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

import { LiveBlog } from './durable-objects/LiveBlog';
import { EDIT_TOKEN_HEADER, hashToken } from './lib/capability';
import { generateBlogId, isValidBlogId, slugify, validateBlogId } from './lib/blog-id';
import { blogStub } from './lib/server/blog';
import { SNAPSHOT_PAGE_SIZE } from './lib/limits';
import type { Result } from './lib/protocol';

export { LiveBlog };

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
		return createBlog(request, env, url);
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
		if (!(await allowWrite(env, token))) return rateLimited();
		const body = await readJson<{ title?: string; summary?: string }>(request);
		if (!body.ok) return json({ error: body.error }, 400);
		return unwrap(await stub.updateMeta(token, body.value));
	}

	// PUT /api/blogs/:id/status
	if (rest.length === 1 && rest[0] === 'status') {
		if (method !== 'PUT') return methodNotAllowed('PUT');
		if (!(await allowWrite(env, token))) return rateLimited();
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
		if (!(await allowWrite(env, token))) return rateLimited();
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
			if (!(await allowWrite(env, token))) return rateLimited();
			return unwrap(await stub.deletePost(token, postId));
		}

		if (method === 'PATCH') {
			if (!(await allowWrite(env, token))) return rateLimited();
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

async function createBlog(request: Request, env: Env, url: URL): Promise<Response> {
	// Blog creation is the one write with no stable caller identity yet, so this
	// is the only place we fall back to keying a rate limit on IP.
	const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
	const { success } = await env.CREATE_LIMITER.limit({ key: `create:${ip}` });
	if (!success) {
		return json({ error: 'Too many live blogs created from here. Try again in a minute.' }, 429);
	}

	const body = await readJson<{ title?: string; summary?: string; blogId?: string }>(request);
	if (!body.ok) return json({ error: body.error }, 400);

	// Prefer an explicit id, then a slug of the title, then a generated one.
	const requested = body.value.blogId?.trim();
	let blogId: string;
	if (requested) {
		const validation = validateBlogId(requested);
		if (!validation.valid) return json({ error: validation.error }, 400);
		blogId = validation.blogId;
	} else {
		blogId = (body.value.title ? slugify(body.value.title) : null) ?? generateBlogId();
	}

	// A generated slug can collide with an existing blog. Fall back to a random id
	// rather than handing the caller someone else's blog.
	let stub = blogStub(env, blogId);
	let created = await stub.createBlog({ blogId, title: body.value.title, summary: body.value.summary });

	if (!created.ok && created.status === 409 && !requested) {
		blogId = generateBlogId();
		stub = blogStub(env, blogId);
		created = await stub.createBlog({ blogId, title: body.value.title, summary: body.value.summary });
	}

	if (!created.ok) return json({ error: created.error }, created.status);

	console.log(JSON.stringify({ event: 'blog_created', blogId, colo: request.cf?.colo ?? null }));

	return json(
		{
			blogId: created.value.blogId,
			editToken: created.value.editToken,
			readerUrl: `${url.origin}/blog/${created.value.blogId}`,
			// The token is in the fragment on purpose — fragments are never sent to
			// the server, so it stays out of logs, Referer headers, and analytics.
			authorUrl: `${url.origin}/blog/${created.value.blogId}/author#edit=${created.value.editToken}`,
		},
		201,
	);
}

/* -------------------------------------------------------------------------- */
/*                              Rate limiting                                 */
/* -------------------------------------------------------------------------- */

/**
 * Edge guardrail for writes.
 *
 * Keyed on the SHA-256 of the presented capability token, which the docs
 * recommend over IP addresses: a token identifies one author, whereas an IP can
 * be shared by an entire office or mobile carrier.
 *
 * The raw token is never used as a key — only its digest — so tokens do not end
 * up inside rate limiter state.
 *
 * This is a cheap first filter, not the authoritative limit. Rate Limiting is
 * per-Cloudflare-location and eventually consistent, so totals like "posts per
 * blog" are enforced inside the Durable Object against a real SQL COUNT.
 */
async function allowWrite(env: Env, token: string | null): Promise<boolean> {
	const key = token ? `write:${(await hashToken(token)).slice(0, 32)}` : 'write:anonymous';
	const { success } = await env.WRITE_LIMITER.limit({ key });
	return success;
}

/* -------------------------------------------------------------------------- */
/*                            Response helpers                                */
/* -------------------------------------------------------------------------- */

function unwrap<T>(result: Result<T>): Response {
	if (result.ok) return json(result.value, 200);
	return json({ error: result.error }, result.status);
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			// API responses are per-caller and must never be cached by a shared cache.
			'Cache-Control': 'no-store',
		},
	});
}

function methodNotAllowed(allow: string): Response {
	return new Response(JSON.stringify({ error: `Method not allowed. Expected ${allow}.` }), {
		status: 405,
		headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: allow },
	});
}

function rateLimited(): Response {
	return json({ error: 'You are publishing too quickly. Give it a few seconds and try again.' }, 429);
}

async function readJson<T>(request: Request): Promise<Result<T>> {
	const contentType = request.headers.get('Content-Type') ?? '';
	if (!contentType.includes('application/json')) {
		return { ok: false, error: 'Expected a JSON request body.', status: 415 };
	}
	try {
		const parsed = (await request.json()) as T;
		if (parsed === null || typeof parsed !== 'object') {
			return { ok: false, error: 'Expected a JSON object.', status: 400 };
		}
		return { ok: true, value: parsed };
	} catch {
		return { ok: false, error: 'Request body was not valid JSON.', status: 400 };
	}
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
