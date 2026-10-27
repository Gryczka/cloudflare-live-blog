import { isValidBlogId } from './blog-id';

export const MAX_LEGACY_BLOG_OBJECT_IDS = 1000;
export const MAX_LEGACY_BLOG_IDS = 50;

/** Control-plane configuration, never supplied by a public request. */
export type LegacyBlogManifest = {
	LEGACY_BLOG_OBJECT_IDS?: string;
	LEGACY_BLOG_IDS?: string;
};

export function legacyBlogManifest(bindings: LegacyBlogManifest): { objects: Set<string>; names: Set<string> } {
	const objects: unknown = JSON.parse(bindings.LEGACY_BLOG_OBJECT_IDS ?? '[]');
	const names: unknown = JSON.parse(bindings.LEGACY_BLOG_IDS ?? '[]');
	if (!Array.isArray(objects) || objects.length > MAX_LEGACY_BLOG_OBJECT_IDS ||
		objects.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))) {
		throw new Error('Invalid legacy blog object manifest');
	}
	if (!Array.isArray(names) || names.length > MAX_LEGACY_BLOG_IDS || names.some(id => !isValidBlogId(id))) {
		throw new Error('Invalid legacy blog name manifest');
	}
	return { objects: new Set(objects as string[]), names: new Set(names as string[]) };
}
