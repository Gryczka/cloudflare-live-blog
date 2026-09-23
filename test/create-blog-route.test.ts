import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { LiveBlog } from '../src/durable-objects/LiveBlog';
import { MAX_BLOG_CREATIONS_PER_WINDOW } from '../src/lib/limits';
import { handleCreateBlog } from '../src/lib/server/create-blog';

const namespace = env.LIVE_BLOG as unknown as DurableObjectNamespace<LiveBlog>;

function liveBlogStub(blogId: string): DurableObjectStub<LiveBlog> {
	return namespace.get(namespace.idFromName(blogId));
}

function createRequest(blogId: string, connectingIp?: string): Request {
	const headers = new Headers({ 'Content-Type': 'application/json' });
	if (connectingIp) headers.set('CF-Connecting-IP', connectingIp);
	return new Request('https://live.example/api/blogs', {
		method: 'POST',
		headers,
		body: JSON.stringify({ blogId, title: 'Route test' }),
	});
}

async function create(blogId: string, connectingIp?: string, bindings: Env = env): Promise<Response> {
	const request = createRequest(blogId, connectingIp);
	return handleCreateBlog(request, bindings, new URL(request.url));
}

describe('POST /api/blogs', () => {
	it('returns 503 without a connecting IP, logs no identifiers, and creates nothing', async () => {
		const blogId = `missing-ip-${crypto.randomUUID()}`;
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

		try {
			const response = await create(blogId);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				error: 'Live blog creation is temporarily unavailable. Try again shortly.',
			});
			expect(error).toHaveBeenCalledOnce();
			expect(error).toHaveBeenCalledWith('{"event":"blog_creation_rate_limiter_unavailable"}');
			expect(JSON.stringify(error.mock.calls)).not.toContain(blogId);
			expect(await liveBlogStub(blogId).isInitialized()).toBe(false);
		} finally {
			error.mockRestore();
		}
	});

	it('returns a sanitized 503 when limiter RPC fails and creates nothing', async () => {
		const blogId = `limiter-failure-${crypto.randomUUID()}`;
		const connectingIp = '198.51.100.77';
		const sensitiveDetail = `${connectingIp}:${blogId}`;
		const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const brokenBindings = {
			LIVE_BLOG: env.LIVE_BLOG,
			BLOG_CREATION_RATE_LIMITER: {
				getByName: () => ({
					reserve: async () => {
						throw new Error(sensitiveDetail);
					},
				}),
			},
		} as unknown as Env;

		try {
			const response = await create(blogId, connectingIp, brokenBindings);
			expect(response.status).toBe(503);
			expect(error).toHaveBeenCalledWith('{"event":"blog_creation_rate_limiter_unavailable"}');
			expect(JSON.stringify(error.mock.calls)).not.toContain(sensitiveDetail);
			expect(JSON.stringify(error.mock.calls)).not.toContain(connectingIp);
			expect(JSON.stringify(error.mock.calls)).not.toContain(blogId);
			expect(await liveBlogStub(blogId).isInitialized()).toBe(false);
		} finally {
			error.mockRestore();
		}
	});

	it('returns 429 only for exhaustion, does not create the denied blog, and isolates IPs', async () => {
		const firstIp = `192.0.2.${crypto.getRandomValues(new Uint8Array(1))[0]}`;
		const secondIp = `203.0.113.${crypto.getRandomValues(new Uint8Array(1))[0]}`;
		const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		try {
			for (let i = 0; i < MAX_BLOG_CREATIONS_PER_WINDOW; i++) {
				const response = await create(`allowed-${crypto.randomUUID()}`, firstIp);
				expect(response.status).toBe(201);
			}

			const deniedBlogId = `denied-${crypto.randomUUID()}`;
			const denied = await create(deniedBlogId, firstIp);
			expect(denied.status).toBe(429);
			expect(await denied.json()).toEqual({
				error: 'Too many live blogs created from here. Try again in a minute.',
			});
			expect(await liveBlogStub(deniedBlogId).isInitialized()).toBe(false);

			const independent = await create(deniedBlogId, secondIp);
			expect(independent.status).toBe(201);
			expect(await liveBlogStub(deniedBlogId).isInitialized()).toBe(true);
		} finally {
			log.mockRestore();
		}
	});
});
