/**
 * Tests for capability tokens — the only thing standing between a public URL and
 * write access to someone's live blog.
 */

import { describe, expect, it } from 'vitest';

import {
	buildAuthorUrl,
	hashToken,
	mintToken,
	readTokenFromFragment,
	timingSafeEqual,
	verifyToken,
} from '../src/lib/capability';

describe('mintToken', () => {
	it('produces URL-fragment-safe tokens', () => {
		const token = mintToken();
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(encodeURIComponent(token)).toBe(token);
	});

	it('produces at least 256 bits of entropy', () => {
		// 32 bytes base64url-encoded, unpadded, is 43 characters.
		expect(mintToken().length).toBeGreaterThanOrEqual(43);
	});

	it('does not repeat', () => {
		const tokens = new Set(Array.from({ length: 200 }, () => mintToken()));
		expect(tokens.size).toBe(200);
	});
});

describe('hashToken', () => {
	it('is a 64-character hex SHA-256 digest', async () => {
		expect(await hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
	});

	it('matches the known SHA-256 of "abc"', async () => {
		expect(await hashToken('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		);
	});

	it('is deterministic and collision-free for distinct inputs', async () => {
		expect(await hashToken('a')).toBe(await hashToken('a'));
		expect(await hashToken('a')).not.toBe(await hashToken('b'));
	});
});

describe('verifyToken', () => {
	it('accepts the token matching a stored hash', async () => {
		const token = mintToken();
		expect(await verifyToken(token, await hashToken(token))).toBe(true);
	});

	it('rejects a different token', async () => {
		expect(await verifyToken(mintToken(), await hashToken(mintToken()))).toBe(false);
	});

	it('rejects null, undefined, and empty input rather than short-circuiting to true', async () => {
		const hash = await hashToken('real');
		expect(await verifyToken(null, hash)).toBe(false);
		expect(await verifyToken(undefined, hash)).toBe(false);
		expect(await verifyToken('', hash)).toBe(false);
	});

	it('rejects when nothing is stored', async () => {
		expect(await verifyToken('anything', null)).toBe(false);
		expect(await verifyToken('anything', '')).toBe(false);
	});
});

describe('timingSafeEqual', () => {
	it('compares equal strings as equal', () => {
		expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
	});

	it('detects a difference in the final character', () => {
		// A naive early-return comparison is most likely to get this wrong.
		expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false);
	});

	it('detects a difference in the first character', () => {
		expect(timingSafeEqual('abcdef', 'zbcdef')).toBe(false);
	});

	it('treats different lengths as unequal', () => {
		expect(timingSafeEqual('abc', 'abcd')).toBe(false);
	});
});

describe('readTokenFromFragment', () => {
	it('reads the token from a fragment', () => {
		expect(readTokenFromFragment('#edit=abc123')).toBe('abc123');
	});

	it('works without a leading hash', () => {
		expect(readTokenFromFragment('edit=abc123')).toBe('abc123');
	});

	it('finds the token among other fragment parameters', () => {
		expect(readTokenFromFragment('#foo=1&edit=abc&bar=2')).toBe('abc');
	});

	it('returns null when absent or empty', () => {
		expect(readTokenFromFragment('')).toBeNull();
		expect(readTokenFromFragment('#')).toBeNull();
		expect(readTokenFromFragment('#other=1')).toBeNull();
		expect(readTokenFromFragment('#edit=')).toBeNull();
	});
});

describe('buildAuthorUrl', () => {
	it('puts the token after the hash, never in the path or query', () => {
		const url = buildAuthorUrl('https://example.com', 'my-blog', 'SECRET');
		expect(url).toBe('https://example.com/blog/my-blog/author#edit=SECRET');

		// The critical property: nothing before the '#' contains the token, because
		// that is the part browsers actually transmit.
		const [beforeFragment] = url.split('#');
		expect(beforeFragment).not.toContain('SECRET');
	});
});
