/**
 * HTML escaping, deliberately in its own module.
 *
 * This lives apart from src/lib/markdown.ts for a bundling reason. The reader
 * island needs `escapeHtml` (via src/lib/render-post.ts) but never needs the
 * markdown renderer — posts arrive as already-rendered HTML over the socket. When
 * both lived in one module, the reader downloaded the entire renderer to call one
 * five-line function, because the shared chunk was pulled in whole.
 *
 * Splitting it keeps roughly 2KB gzip out of the reader's payload, which is a
 * meaningful fraction of a budget measured in single-digit kilobytes.
 */

/**
 * Escape the five characters that carry meaning in HTML text and attribute
 * contexts.
 *
 * Order matters: `&` must be replaced first, or the entities introduced by the
 * later replacements would themselves be re-escaped into `&amp;lt;`.
 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
