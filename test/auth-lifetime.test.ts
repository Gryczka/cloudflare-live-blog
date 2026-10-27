import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it, vi } from 'vitest';
import type { LiveBlog } from '../src/durable-objects/LiveBlog';
import { BLOG_TTL_MS } from '../src/lib/limits';
import type { Result } from '../src/lib/protocol';

const mutations = ['createPost', 'updatePost', 'deletePost', 'updateMeta', 'setStatus'] as const;
type Mutation = (typeof mutations)[number];

function mutate(instance: LiveBlog, method: Mutation, token: string, postId: string): Promise<Result<unknown>> {
	switch (method) {
		case 'createPost': return instance.createPost(token, { body: 'Late new post' });
		case 'updatePost': return instance.updatePost(token, postId, { body: 'Late correction', pinned: true });
		case 'deletePost': return instance.deletePost(token, postId);
		case 'updateMeta': return instance.updateMeta(token, { title: 'Late title', summary: 'Late summary' });
		case 'setStatus': return instance.setStatus(token, 'ended');
	}
}

async function fixture() {
	const name = `auth-race-${crypto.randomUUID()}`;
	const stub = env.LIVE_BLOG.getByName(name);
	const created = await stub.createBlog({ blogId: name, title: 'Before authentication race' });
	if (!created.ok) throw new Error(created.error);
	const token = created.value.editToken;
	const post = await stub.createPost(token, { body: 'Original published content' });
	if (!post.ok) throw new Error(post.error);
	return { stub, token, postId: post.value.id };
}

for (const policy of ['absolute-v1', 'legacy'] as const) {
	describe(`${policy} asynchronous author lifetime`, () => {
		for (const cleanup of [false, true]) {
			it.each(mutations)(`rejects %s when digest crosses expiry ${cleanup ? 'with cleanup during auth' : 'without an alarm'}`, async (method) => {
				const { stub, token, postId } = await fixture();
				await runInDurableObject(stub, async (instance, state) => {
					const base = Date.now();
					const deadline = base + 60_000;
					state.storage.sql.exec("UPDATE meta SET v = ? WHERE k IN ('created_at', 'last_write_at')", String(deadline - BLOG_TTL_MS));
					if (policy === 'legacy') state.storage.sql.exec("DELETE FROM meta WHERE k = 'lifetime_policy'");
					await state.storage.setAlarm(deadline);
					const before = {
						posts: state.storage.sql.exec('SELECT * FROM posts ORDER BY id').toArray(),
						meta: state.storage.sql.exec('SELECT * FROM meta ORDER BY k').toArray(),
						sequences: state.storage.sql.exec('SELECT * FROM sqlite_sequence').toArray(),
					};
					let now = base;
					const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
					const original = crypto.subtle.digest.bind(crypto.subtle);
					const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
						const result = await original(algorithm, data);
						// The valid token began hashing while alive; its result arrives too late.
						now = deadline + 1;
						if (cleanup) await instance.alarm();
						return result;
					});
					try {
						const result = await mutate(instance, method, token, postId);
						expect(digest).toHaveBeenCalledTimes(1);
						expect(result).toMatchObject({ ok: false, status: cleanup ? 404 : 410 });
						if (cleanup) {
							expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").toArray()).toEqual([]);
							expect(await state.storage.getAlarm()).toBeNull();
						} else {
							expect(state.storage.sql.exec('SELECT * FROM posts ORDER BY id').toArray()).toEqual(before.posts);
							expect(state.storage.sql.exec('SELECT * FROM meta ORDER BY k').toArray()).toEqual(before.meta);
							expect(state.storage.sql.exec('SELECT * FROM sqlite_sequence').toArray()).toEqual(before.sequences);
							expect(await state.storage.getAlarm()).toBe(deadline);
							expect(instance.getPublicMetadata()).toMatchObject({ ok: false, status: 410 });
						}
					} finally {
						digest.mockRestore();
						clock.mockRestore();
					}
				});
			});
		}
	});
}
