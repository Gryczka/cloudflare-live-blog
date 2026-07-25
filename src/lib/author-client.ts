/**
 * Typed HTTP client for the author console.
 *
 * Every write carries the capability token in a header. The token is read from
 * `location.hash` by the console and never placed in a query string or path, so it
 * cannot end up in server logs, `Referer` headers, or browser history entries that
 * get synced.
 */

import { EDIT_TOKEN_HEADER } from './capability';
import type { BlogMeta, BlogStatus, CreatePostInput, Post, Snapshot, UpdatePostInput } from './protocol';

export class AuthorClient {
	constructor(
		private readonly blogId: string,
		private readonly token: string,
	) {}

	async verify(): Promise<boolean> {
		try {
			const response = await this.request('GET', 'session');
			return response.ok;
		} catch {
			return false;
		}
	}

	async snapshot(before?: number): Promise<Snapshot> {
		return this.json<Snapshot>('GET', `snapshot${before ? `?before=${before}` : ''}`);
	}

	async createPost(input: CreatePostInput): Promise<Post> {
		return this.json<Post>('POST', 'posts', input);
	}

	async updatePost(postId: string, input: UpdatePostInput): Promise<Post> {
		return this.json<Post>('PATCH', `posts/${encodeURIComponent(postId)}`, input);
	}

	async deletePost(postId: string): Promise<void> {
		await this.json<{ id: string }>('DELETE', `posts/${encodeURIComponent(postId)}`);
	}

	async updateMeta(input: { title?: string; summary?: string }): Promise<BlogMeta> {
		return this.json<BlogMeta>('PATCH', 'meta', input);
	}

	async setStatus(status: BlogStatus): Promise<BlogMeta> {
		return this.json<BlogMeta>('PUT', 'status', { status });
	}

	private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await this.request(method, path, body);
		const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
		if (!response.ok) {
			throw new AuthorClientError(payload.error ?? `Request failed (${response.status})`, response.status);
		}
		return payload;
	}

	private request(method: string, path: string, body?: unknown): Promise<Response> {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			[EDIT_TOKEN_HEADER]: this.token,
		};
		if (body !== undefined) headers['Content-Type'] = 'application/json';

		return fetch(`/api/blogs/${encodeURIComponent(this.blogId)}/${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}
}

export class AuthorClientError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = 'AuthorClientError';
	}
}
