/**
 * Post markup, defined once.
 *
 * The reader page renders its initial feed on the server, and the live island
 * inserts later posts in the browser. If those two produced different markup they
 * would drift the moment either changed, and a post that arrived over the socket
 * would look subtly different from one that arrived in the HTML.
 *
 * So both call this function. The Astro component pipes it through `set:html`,
 * and the island assigns it to `innerHTML`.
 *
 * ## Why assigning this to innerHTML is safe
 *
 * Every interpolated value is either:
 *   - `post.html`, already rendered and escaped by src/lib/markdown.ts, which
 *     escapes all input before emitting any tags; or
 *   - passed through `escapeHtml()` here; or
 *   - a number, or a string from a closed set defined in this file.
 */

import { escapeHtml } from './escape';
import type { Post } from './protocol';

export interface RenderPostOptions {
	blogId: string;
	/** Render as a permalink page rather than a feed item. */
	standalone?: boolean;
}

const KIND_LABELS: Record<string, string> = {
	headline: 'Headline',
	quote: 'Quote',
	image: 'Image',
	embed: 'Embed',
};

export function renderPost(post: Post, options: RenderPostOptions): string {
	const { blogId, standalone = false } = options;

	const classes = ['post', `post--${post.kind}`];
	if (post.deleted) classes.push('post--deleted');
	if (post.pinned) classes.push('post--pinned');
	if (standalone) classes.push('post--standalone');

	const permalink = `/blog/${encodeURIComponent(blogId)}/post/${encodeURIComponent(post.id)}`;
	const iso = new Date(post.createdAt).toISOString();

	const badges: string[] = [];
	if (post.pinned) {
		badges.push('<span class="post__badge post__badge--key">Key event</span>');
	}
	if (KIND_LABELS[post.kind]) {
		badges.push(`<span class="post__badge">${escapeHtml(KIND_LABELS[post.kind]!)}</span>`);
	}
	if (post.revision > 1 && !post.deleted) {
		// Corrections are surfaced, not hidden. A live blog that silently rewrites
		// history is not trustworthy.
		const label = post.revision === 2 ? 'Updated' : `Updated ×${post.revision - 1}`;
		badges.push(`<span class="post__badge post__badge--corrected" title="${escapeHtml(iso)}">${label}</span>`);
	}

	const body = post.deleted
		? '<p class="post__tombstone">This post was removed by the author.</p>'
		: `<div class="post__body">${post.html}</div>`;

	const author = post.author
		? `<span class="post__author">${escapeHtml(post.author)}</span>`
		: '';

	// `data-created` lets the island upgrade the timestamp to a relative, ticking
	// label. Without JavaScript the absolute time rendered here is already correct.
	return [
		`<article class="${classes.join(' ')}" id="post-${escapeHtml(post.id)}"`,
		` data-post-id="${escapeHtml(post.id)}" data-seq="${post.seq}" data-created="${post.createdAt}">`,
		'<header class="post__meta">',
		standalone
			? `<time class="post__time" datetime="${escapeHtml(iso)}">${escapeHtml(formatClock(post.createdAt))}</time>`
			: `<a class="post__permalink" href="${permalink}"><time class="post__time" datetime="${escapeHtml(iso)}">${escapeHtml(formatClock(post.createdAt))}</time></a>`,
		author,
		badges.join(''),
		'</header>',
		body,
		'</article>',
	].join('');
}

/** `14:32` in UTC. The island replaces this with a localized, relative label. */
export function formatClock(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

/** Markup for the pinned "key events" rail. */
export function renderKeyEvent(post: Post, blogId: string): string {
	const permalink = `/blog/${encodeURIComponent(blogId)}/post/${encodeURIComponent(post.id)}`;
	const iso = new Date(post.createdAt).toISOString();
	return [
		`<li class="key-events__item" data-post-id="${escapeHtml(post.id)}">`,
		`<a class="key-events__link" href="${permalink}">`,
		`<time datetime="${escapeHtml(iso)}">${escapeHtml(formatClock(post.createdAt))}</time>`,
		`<span class="key-events__text">${escapeHtml(firstLine(post.body))}</span>`,
		'</a></li>',
	].join('');
}

function firstLine(body: string, maxLength = 90): string {
	const line = body.split('\n').find((candidate) => candidate.trim().length > 0)?.trim() ?? '';
	const clean = line.replace(/[*_`#>]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
	return clean.length > maxLength ? `${clean.slice(0, maxLength - 1).trimEnd()}…` : clean;
}
