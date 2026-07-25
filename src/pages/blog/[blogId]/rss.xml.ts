/**
 * RSS feed for a live blog.
 *
 * A live blog is a blog, and readers who want to follow long-running coverage
 * without keeping a tab open should be able to. This is close to free — the
 * Durable Object already returns exactly the data a feed needs — and the previous
 * iteration simply did not have it.
 */

import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';

import { validateBlogId } from '../../../lib/blog-id';
import { toPlainText } from '../../../lib/markdown';
import { getBlogStub } from '../../../lib/server/blog';
import { SNAPSHOT_PAGE_SIZE } from '../../../lib/limits';

export const GET: APIRoute = async (context) => {
	const validation = validateBlogId(context.params.blogId);
	if (!validation.valid) {
		return new Response('Not found', { status: 404 });
	}

	const result = await getBlogStub(validation.blogId).getSnapshot({ limit: SNAPSHOT_PAGE_SIZE });
	if (!result.ok) {
		return new Response('Not found', { status: 404 });
	}

	const { meta, posts } = result.value;
	const site = context.site ?? new URL(context.url.origin);
	const blogPath = `/blog/${validation.blogId}`;

	const response = await rss({
		title: meta.title,
		description: meta.summary || `Live coverage: ${meta.title}`,
		site,
		trailingSlash: false,
		items: posts
			// Tombstones would be noise in a reader that already has the original.
			.filter((post) => !post.deleted)
			.map((post) => ({
				// Feed readers key on link, so a stable permalink matters here.
				link: `${blogPath}/post/${post.id}`,
				guid: post.id,
				title: toPlainText(post.body, 80) || 'Update',
				pubDate: new Date(post.createdAt),
				description: toPlainText(post.body, 400),
				// `html` is produced by our own renderer, which escapes all input
				// before emitting any tags, so it is safe to embed directly.
				content: post.html,
				author: post.author ?? undefined,
			})),
		customData: `<language>en</language>`,
	});

	response.headers.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
	return response;
};
