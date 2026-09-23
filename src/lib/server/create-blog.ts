import { generateBlogId, slugify, validateBlogId } from '../blog-id';
import { json, readJson } from './api-response';
import { reserveBlogCreation } from './blog-creation-rate-limit';
import { blogStub } from './blog';

/** Astro-independent implementation of POST /api/blogs. */
export async function handleCreateBlog(request: Request, env: Env, url: URL): Promise<Response> {
	// Creation has no stable capability yet, so this is the only write keyed by IP.
	const reservation = await reserveBlogCreation(env, request.headers.get('CF-Connecting-IP'));
	if (reservation === 'unavailable') {
		console.error(JSON.stringify({ event: 'blog_creation_rate_limiter_unavailable' }));
		return json({ error: 'Live blog creation is temporarily unavailable. Try again shortly.' }, 503);
	}
	if (reservation === 'exhausted') {
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

	console.log(JSON.stringify({ event: 'blog_created', colo: request.cf?.colo ?? null }));

	return json(
		{
			blogId: created.value.blogId,
			editToken: created.value.editToken,
			readerUrl: `${url.origin}/blog/${created.value.blogId}`,
			// The token is in the fragment on purpose: fragments are never sent to
			// the server, so it stays out of logs, Referer headers, and analytics.
			authorUrl: `${url.origin}/blog/${created.value.blogId}/author#edit=${created.value.editToken}`,
		},
		201,
	);
}
