/**
 * A deliberately small markdown subset renderer.
 *
 * ## Why not DOMPurify?
 *
 * The previous iteration of this project imported `isomorphic-dompurify` into
 * the Durable Object to sanitize post content. That pulls jsdom into a Worker
 * under `nodejs_compat` — a large dependency and a real cold-start cost — and it
 * was configured with `ALLOWED_TAGS: []`, i.e. "strip every tag". Loading a full
 * HTML parser and DOM implementation to perform text escaping is the wrong tool.
 *
 * ## Why this is safe
 *
 * The order of operations is the entire security argument:
 *
 *   1. Escape `& < > " '` across the whole input **first**. After this step the
 *      string provably contains no HTML — any markup the author typed is now
 *      inert entities.
 *   2. Only then apply formatting, and only by emitting tags this module writes
 *      itself, from a closed set: p, br, strong, em, code, pre, a, ul, ol, li,
 *      blockquote, h3.
 *
 * Because step 1 removes all author-controlled markup and step 2 only ever adds
 * literals from this file, there is no path for injected HTML to survive. There
 * is no sanitizer to misconfigure and no parser to disagree with the browser.
 *
 * The one place author input reaches an attribute is link `href`, which is
 * checked against a protocol allowlist (see `safeUrl`).
 *
 * Rendering happens once on write, in the Durable Object, and the resulting HTML
 * is what goes over the WebSocket. That keeps a markdown parser out of the
 * reader's bundle entirely.
 */

/** Protocols permitted in link hrefs. Everything else is dropped. */
import { escapeHtml } from './escape';

// Re-exported so existing importers keep working; the implementation lives in
// ./escape so the reader island can import it without the renderer.
export { escapeHtml };

const SAFE_URL = /^(?:https?:\/\/|mailto:|\/|#)/i;

/** Placeholder for extracted code spans, using a character escaping cannot produce. */
const CODE_PLACEHOLDER = '\u0000CODE';

export function renderMarkdown(source: string): string {
	if (!source) return '';

	// Normalize line endings so block splitting is predictable.
	const normalized = source.replace(/\r\n?/g, '\n').trim();
	if (!normalized) return '';

	// Step 1: escape everything. Past this line, no author HTML exists.
	const escaped = escapeHtml(normalized);

	// Pull code spans out before any other inline rule can touch their contents,
	// so `**not bold**` inside backticks stays literal.
	const codeSpans: string[] = [];
	const withPlaceholders = escaped
		.replace(/```\n?([\s\S]*?)```/g, (_m, code: string) => {
			codeSpans.push(`<pre><code>${trimTrailingNewline(code)}</code></pre>`);
			return `${CODE_PLACEHOLDER}${codeSpans.length - 1}\u0000`;
		})
		.replace(/`([^`\n]+)`/g, (_m, code: string) => {
			codeSpans.push(`<code>${code}</code>`);
			return `${CODE_PLACEHOLDER}${codeSpans.length - 1}\u0000`;
		});

	// Step 2: block-level structure, then inline formatting within each block.
	const html = withPlaceholders
		.split(/\n{2,}/)
		.map((block) => renderBlock(block.trim()))
		.filter(Boolean)
		.join('');

	// Restore code spans last so their contents are never reprocessed.
	return html.replace(
		new RegExp(`${CODE_PLACEHOLDER}(\\d+)\u0000`, 'g'),
		(_m, index: string) => codeSpans[Number(index)] ?? '',
	);
}

function renderBlock(block: string): string {
	if (!block) return '';

	// A block that is exactly one restored code fence needs no <p> wrapper.
	if (new RegExp(`^${CODE_PLACEHOLDER}\\d+\u0000$`).test(block)) return block;

	// Sub-heading: "### text"
    const heading = /^#{1,3}\s+(.*)$/.exec(block);
	if (heading) return `<h3>${renderInline(heading[1] ?? '')}</h3>`;

	// Blockquote: every line starts with ">"
	const lines = block.split('\n');
	if (lines.every((line) => line.startsWith('&gt;'))) {
		const inner = lines.map((line) => line.replace(/^&gt;\s?/, '')).join('\n');
		return `<blockquote>${renderInline(inner)}</blockquote>`;
	}

	// Unordered list: every line starts with "- " or "* "
	if (lines.every((line) => /^[-*]\s+/.test(line))) {
		const items = lines
			.map((line) => `<li>${renderInline(line.replace(/^[-*]\s+/, ''))}</li>`)
			.join('');
		return `<ul>${items}</ul>`;
	}

	// Ordered list: every line starts with "1. "
	if (lines.every((line) => /^\d+\.\s+/.test(line))) {
		const items = lines
			.map((line) => `<li>${renderInline(line.replace(/^\d+\.\s+/, ''))}</li>`)
			.join('');
		return `<ol>${items}</ol>`;
	}

	return `<p>${renderInline(block)}</p>`;
}

function renderInline(text: string): string {
	return (
		text
			// Links: [label](url). Bold/italic are applied to the label afterwards
			// because this runs before the emphasis rules.
			.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
				const href = safeUrl(url);
				if (!href) return label;
				const external = /^https?:\/\//i.test(href);
				const attrs = external ? ' target="_blank" rel="noopener noreferrer nofollow"' : '';
				return `<a href="${href}"${attrs}>${label}</a>`;
			})
			// Bold before italic, so "**x**" is not consumed as two italics.
			.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
			.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>')
			.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>')
			// Remaining single newlines are intentional line breaks.
			.replace(/\n/g, '<br />')
	);
}

/**
 * Validate a link target against the protocol allowlist.
 *
 * Returns the URL when acceptable, or `null` to render the label as plain text.
 * The input is already HTML-escaped, so `"` cannot appear and cannot break out
 * of the surrounding attribute; this check is about rejecting `javascript:`,
 * `data:` and similar schemes.
 */
function safeUrl(url: string): string | null {
	const trimmed = url.trim();
	if (!SAFE_URL.test(trimmed)) return null;
	// Control characters can be used to smuggle a scheme past a naive regex.
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
	return trimmed;
}

/**
 * Plain-text rendering of markdown source, for RSS descriptions, meta
 * descriptions, and anywhere a preview string is needed.
 */
export function toPlainText(source: string, maxLength = 200): string {
	const text = source
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
		.replace(/[*_#>]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function trimTrailingNewline(value: string): string {
	return value.replace(/\n+$/, '');
}
