import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';

import type { BlogCreationRateLimiter } from '../src/durable-objects/BlogCreationRateLimiter';
import { hashIdentifier } from '../src/lib/capability';
import {
	BLOG_CREATION_LIMITER_IDLE_TTL_MS,
	MAX_BLOG_CREATIONS_PER_WINDOW,
	RATE_LIMIT_WINDOW_MS,
	rateLimitWindowStart,
} from '../src/lib/limits';
import { reserveBlogCreation } from '../src/lib/server/blog-creation-rate-limit';

type Stub = DurableObjectStub<BlogCreationRateLimiter>;

const namespace =
	env.BLOG_CREATION_RATE_LIMITER as unknown as DurableObjectNamespace<BlogCreationRateLimiter>;

async function stubFor(identifier: string): Promise<Stub> {
	return namespace.getByName(await hashIdentifier(identifier));
}

describe('BlogCreationRateLimiter', () => {
	it('allows five reservations for one hashed IP and blocks the next', async () => {
		const timestamp = Date.now();
		const now = vi.spyOn(Date, 'now').mockReturnValue(timestamp);

		try {
			const ip = `192.0.2.${crypto.getRandomValues(new Uint8Array(1))[0]}`;
			const results = [];
			for (let i = 0; i < MAX_BLOG_CREATIONS_PER_WINDOW + 1; i++) {
				results.push(await reserveBlogCreation(env, ip));
			}

			expect(results).toEqual([...Array(MAX_BLOG_CREATIONS_PER_WINDOW).fill('allowed'), 'exhausted']);
		} finally {
			now.mockRestore();
		}
	});

	it('resets at the exact Unix-aligned fixed-window boundary', async () => {
		const boundary = rateLimitWindowStart(Date.now()) + RATE_LIMIT_WINDOW_MS;
		const now = vi.spyOn(Date, 'now').mockReturnValue(boundary - 1);

		try {
			const ip = `boundary-${crypto.randomUUID()}`;
			for (let i = 0; i < MAX_BLOG_CREATIONS_PER_WINDOW; i++) {
				expect(await reserveBlogCreation(env, ip)).toBe('allowed');
			}
			expect(await reserveBlogCreation(env, ip)).toBe('exhausted');

			now.mockReturnValue(boundary);
			expect(await reserveBlogCreation(env, ip)).toBe('allowed');
			expect(rateLimitWindowStart(boundary - 1)).toBe(boundary - RATE_LIMIT_WINDOW_MS);
			expect(rateLimitWindowStart(boundary)).toBe(boundary);
		} finally {
			now.mockRestore();
		}
	});

	it('serializes concurrent reservations without overrunning the limit', async () => {
		const timestamp = Date.now();
		const now = vi.spyOn(Date, 'now').mockReturnValue(timestamp);

		try {
			const ip = `concurrent-${crypto.randomUUID()}`;
			const results = await Promise.all(
				Array.from({ length: MAX_BLOG_CREATIONS_PER_WINDOW + 5 }, () => reserveBlogCreation(env, ip)),
			);
			expect(results.filter((result) => result === 'allowed')).toHaveLength(MAX_BLOG_CREATIONS_PER_WINDOW);
			expect(results.filter((result) => result === 'exhausted')).toHaveLength(5);
		} finally {
			now.mockRestore();
		}
	});

	it('does not persist the raw connecting IP', async () => {
		const ip = '203.0.113.42';
		expect(await reserveBlogCreation(env, ip)).toBe('allowed');

		await runInDurableObject(await stubFor(ip), (_instance, state) => {
			const rows = state.storage.sql.exec('SELECT * FROM creation_rate_limit').toArray();
			expect(JSON.stringify(rows)).not.toContain(ip);
		});
	});

	it('fails closed when the platform connecting IP is missing', async () => {
		expect(await reserveBlogCreation(env, null)).toBe('unavailable');
		expect(await reserveBlogCreation(env, '')).toBe('unavailable');
	});

	it('fails closed when limiter RPC rejects', async () => {
		const brokenBindings = {
			BLOG_CREATION_RATE_LIMITER: {
				getByName: () => ({
					reserve: async () => {
						throw new Error('simulated RPC failure');
					},
				}),
			},
		} as unknown as Env;

		expect(await reserveBlogCreation(brokenBindings, '198.51.100.7')).toBe('unavailable');
	});

	it('fails closed when its SQLite operation fails', async () => {
		const stub = await stubFor(`storage-failure-${crypto.randomUUID()}`);
		expect(await stub.reserve()).toBe('allowed');

		await runInDurableObject(stub, async (instance, state) => {
			state.storage.sql.exec('DROP TABLE creation_rate_limit');
			state.storage.sql.exec('CREATE TABLE creation_rate_limit (unexpected INTEGER)');
			expect(await instance.reserve()).toBe('unavailable');
		});
	});

	it('refreshes its inactivity alarm, clears state, and recreates its schema while warm', async () => {
		const start = Date.now();
		const now = vi.spyOn(Date, 'now').mockReturnValue(start);
		const stub = await stubFor(`cleanup-${crypto.randomUUID()}`);

		try {
			expect(await stub.reserve()).toBe('allowed');
			await runInDurableObject(stub, async (_instance, state) => {
				expect(await state.storage.getAlarm()).toBe(start + BLOG_CREATION_LIMITER_IDLE_TTL_MS);
			});

			now.mockReturnValue(start + 1_000);
			expect(await stub.reserve()).toBe('allowed');
			await runInDurableObject(stub, async (_instance, state) => {
				expect(await state.storage.getAlarm()).toBe(start + 1_000 + BLOG_CREATION_LIMITER_IDLE_TTL_MS);
			});

			expect(await runDurableObjectAlarm(stub)).toBe(true);
			expect(await stub.reserve()).toBe('allowed');
			await runInDurableObject(stub, async (_instance, state) => {
				const rows = state.storage.sql
					.exec<{ reservations: number }>('SELECT reservations FROM creation_rate_limit')
					.toArray();
				expect(rows).toEqual([{ reservations: 1 }]);
				expect(await state.storage.getAlarm()).toBe(start + 1_000 + BLOG_CREATION_LIMITER_IDLE_TTL_MS);
			});
		} finally {
			now.mockRestore();
		}
	});
});
