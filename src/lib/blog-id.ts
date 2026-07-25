/**
 * Blog id validation and generation.
 *
 * A blog id is the Durable Object's name, so it is load-bearing: `idFromName`
 * accepts any string, which means an unvalidated id becomes an unbounded key
 * space addressable by anyone. Validation happens at the Worker edge before a
 * stub is ever obtained.
 */

import { MAX_BLOG_ID_LENGTH } from './limits';

const BLOG_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Words used to build readable random ids like `amber-signal-4821`. */
const ADJECTIVES = [
	'amber', 'brisk', 'clear', 'dusk', 'ember', 'first', 'grave', 'hollow',
	'inner', 'jetty', 'keen', 'level', 'north', 'open', 'prime', 'quiet',
	'rapid', 'still', 'true', 'urban', 'vivid', 'wired', 'young', 'zenith',
] as const;

const NOUNS = [
	'anchor', 'beacon', 'cable', 'dispatch', 'echo', 'front', 'gazette',
	'harbor', 'inkwell', 'journal', 'ledger', 'marker', 'notice', 'outpost',
	'press', 'query', 'record', 'signal', 'tribune', 'update', 'vector',
	'wire', 'yard', 'zone',
] as const;

export function isValidBlogId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_BLOG_ID_LENGTH &&
		BLOG_ID_PATTERN.test(value)
	);
}

export function validateBlogId(value: unknown): { valid: true; blogId: string } | { valid: false; error: string } {
	if (typeof value !== 'string' || value.length === 0) {
		return { valid: false, error: 'A blog id is required.' };
	}
	if (value.length > MAX_BLOG_ID_LENGTH) {
		return { valid: false, error: `Blog ids must be ${MAX_BLOG_ID_LENGTH} characters or fewer.` };
	}
	if (!BLOG_ID_PATTERN.test(value)) {
		return {
			valid: false,
			error: 'Blog ids may use lowercase letters, numbers, and hyphens, and must start and end with a letter or number.',
		};
	}
	return { valid: true, blogId: value };
}

/** Generate a readable, collision-resistant blog id. */
export function generateBlogId(): string {
	const pick = <T>(items: readonly T[]): T => {
		const index = crypto.getRandomValues(new Uint32Array(1))[0]! % items.length;
		return items[index]!;
	};
	const digits = (crypto.getRandomValues(new Uint32Array(1))[0]! % 9000) + 1000;
	return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${digits}`;
}

/** Turn arbitrary text into a candidate blog id. Returns null if nothing usable remains. */
export function slugify(value: string): string | null {
	const slug = value
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, MAX_BLOG_ID_LENGTH)
		.replace(/-+$/g, '');
	return isValidBlogId(slug) ? slug : null;
}
