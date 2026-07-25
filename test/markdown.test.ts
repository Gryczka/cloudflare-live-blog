/**
 * Tests for the markdown renderer.
 *
 * These matter more than most: this module is the reason the project does not ship
 * DOMPurify (and therefore jsdom) inside a Durable Object. Its safety argument is
 * "escape everything first, then only emit tags we write ourselves", so the tests
 * exercise that boundary directly.
 */

import { describe, expect, it } from 'vitest';

import { escapeHtml, renderMarkdown, toPlainText } from '../src/lib/markdown';

describe('renderMarkdown — injection resistance', () => {
	it('escapes raw HTML instead of rendering it', () => {
		const html = renderMarkdown('<b>bold</b>');
		expect(html).toBe('<p>&lt;b&gt;bold&lt;/b&gt;</p>');
		expect(html).not.toContain('<b>');
	});

	it('neutralizes script tags', () => {
		const html = renderMarkdown('<script>alert(1)</script>');
		expect(html).not.toContain('<script');
		expect(html).toContain('&lt;script&gt;');
	});

	it('neutralizes event-handler injection via img', () => {
		const html = renderMarkdown('<img src=x onerror=alert(1)>');
		// The handler text survives as inert content — what matters is that no tag
		// was produced to carry it, so the browser never parses it as an attribute.
		expect(html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
		expect(html).not.toContain('<img');
	});

	it('emits only tags this renderer produces itself', () => {
		const hostile = '<img src=x onerror=alert(1)><iframe></iframe><svg onload=alert(2)>';
		const html = renderMarkdown(hostile);
		// Collect every tag name in the output and assert it is from our closed set.
		const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((match) => match[1]!.toLowerCase());
		expect(tags).toEqual(['p', 'p']);
	});

	it('drops javascript: links but keeps the label as text', () => {
		const html = renderMarkdown('[click me](javascript:alert(1))');
		expect(html).not.toContain('javascript:');
		expect(html).not.toContain('<a ');
		expect(html).toContain('click me');
	});

	it('drops data: links', () => {
		const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
		expect(html).not.toContain('data:');
		expect(html).not.toContain('<a ');
	});

	it('rejects control characters smuggled into a URL', () => {
		const html = renderMarkdown('[x](java\u0000script:alert(1))');
		expect(html).not.toContain('<a ');
	});

	it('cannot be escaped via a quote in link text', () => {
		const html = renderMarkdown('["onmouseover="alert(1)](https://example.com)');
		// The quote is already an entity by the time the anchor is built.
		expect(html).not.toMatch(/"\s*onmouseover/);
		expect(html).toContain('href="https://example.com"');
	});
});

describe('renderMarkdown — formatting', () => {
	it('renders bold and italic', () => {
		expect(renderMarkdown('**bold** and *italic*')).toBe(
			'<p><strong>bold</strong> and <em>italic</em></p>',
		);
	});

	it('does not treat bold as two italics', () => {
		expect(renderMarkdown('**bold**')).toBe('<p><strong>bold</strong></p>');
	});

	it('adds rel and target to external links only', () => {
		const external = renderMarkdown('[x](https://example.com)');
		expect(external).toContain('rel="noopener noreferrer nofollow"');
		expect(external).toContain('target="_blank"');

		const internal = renderMarkdown('[x](/blog/abc)');
		expect(internal).toContain('href="/blog/abc"');
		expect(internal).not.toContain('target="_blank"');
	});

	it('renders unordered and ordered lists', () => {
		expect(renderMarkdown('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
		expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
	});

	it('renders blockquotes', () => {
		expect(renderMarkdown('> quoted')).toBe('<blockquote>quoted</blockquote>');
	});

	it('renders inline code without applying inner formatting', () => {
		const html = renderMarkdown('use `**not bold**` here');
		expect(html).toContain('<code>**not bold**</code>');
		expect(html).not.toContain('<strong>');
	});

	it('renders fenced code blocks', () => {
		const html = renderMarkdown('```\nconst a = 1;\n```');
		expect(html).toContain('<pre><code>const a = 1;</code></pre>');
	});

	it('escapes HTML inside code blocks', () => {
		const html = renderMarkdown('```\n<script>x</script>\n```');
		expect(html).not.toContain('<script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('turns single newlines into line breaks and blank lines into paragraphs', () => {
		expect(renderMarkdown('a\nb')).toBe('<p>a<br />b</p>');
		expect(renderMarkdown('a\n\nb')).toBe('<p>a</p><p>b</p>');
	});

	it('renders headings as h3 so they never outrank the page title', () => {
		expect(renderMarkdown('### Sub')).toBe('<h3>Sub</h3>');
	});

	it('returns an empty string for empty input', () => {
		expect(renderMarkdown('')).toBe('');
		expect(renderMarkdown('   \n  ')).toBe('');
	});
});

describe('escapeHtml', () => {
	it('escapes all five significant characters', () => {
		expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
	});

	it('escapes ampersands before other entities so they are not double-escaped', () => {
		expect(escapeHtml('&lt;')).toBe('&amp;lt;');
	});
});

describe('toPlainText', () => {
	it('strips markdown syntax', () => {
		expect(toPlainText('**bold** and [a link](https://example.com)')).toBe('bold and a link');
	});

	it('truncates with an ellipsis', () => {
		expect(toPlainText('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`);
	});

	it('leaves short text untouched', () => {
		expect(toPlainText('short', 100)).toBe('short');
	});
});
