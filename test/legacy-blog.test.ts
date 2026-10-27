import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, vi } from 'vitest';
import { resolveBlogStub } from '../src/lib/server/blog';
import { BLOG_TTL_MS } from '../src/lib/limits';

async function legacyBlog(ended = false) {
	const name = `legacy-${crypto.randomUUID()}`;
	const stub = env.LIVE_BLOG.getByName(name);
	const created = await stub.createBlog({ blogId: name, title: 'Existing public archive' });
	if (!created.ok) throw new Error(created.error);
	const post = await stub.createPost(created.value.editToken, { body: 'Existing published update' });
	if (!post.ok) throw new Error(post.error);
	if (ended) await stub.setStatus(created.value.editToken, 'ended');
	const lastWrite = Date.now() - 86400000;
	const alarm = Date.now() + 86400000;
	await runInDurableObject(stub, async (_instance, state) => {
		state.storage.sql.exec("DELETE FROM meta WHERE k = 'lifetime_policy'");
		state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'created_at'", String(Date.now() - 90 * 86400000));
		state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'last_write_at'", String(lastWrite));
		await state.storage.setAlarm(alarm);
	});
	return { name, stub, post: post.value, expiresAt: lastWrite + BLOG_TTL_MS, alarm };
}

function bindings(objects: string[] = [], names: string[] = []) {
	const dispatch = vi.fn((id: DurableObjectId) => env.LIVE_BLOG.get(id));
	const hash = vi.fn((name: string) => env.LIVE_BLOG.idFromName(name));
	const namespace = new Proxy(env.LIVE_BLOG, {
		get(target, property) {
			if (property === 'get') return dispatch;
			if (property === 'idFromName') return hash;
			const value = Reflect.get(target, property, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return {
		value: { ...env, LIVE_BLOG: namespace, LEGACY_BLOG_OBJECT_IDS: JSON.stringify(objects), LEGACY_BLOG_IDS: JSON.stringify(names) },
		dispatch, hash,
	};
}

it('imports an existing hash-only archive older than the new lifetime, without changing its policy or alarm', async () => {
	const legacy = await legacyBlog(true);
	const controlPlaneHash = env.LIVE_BLOG.idFromName(legacy.name).toString();
	const gate = bindings([controlPlaneHash]);
	expect(await env.BLOG_DIRECTORY.getByName('global').exists(legacy.name)).toBe(false);
	const resolved = await resolveBlogStub(gate.value, legacy.name);
	expect(resolved).not.toBeNull();
	expect(gate.dispatch).toHaveBeenCalledTimes(1);
	const metadata = await resolved!.getPublicMetadata();
	expect(metadata).toEqual({ ok: true, value: { blogId: legacy.name, status: 'ended', expiresAt: legacy.expiresAt } });
	const snapshot = await resolved!.getSnapshot();
	expect(snapshot.ok).toBe(true);
	if (snapshot.ok) expect(snapshot.value.posts[0]?.body).toBe('Existing published update');
	expect((await resolved!.getPost(legacy.post.id)).ok).toBe(true);
	expect((await resolved!.getPostsSince(0)).ok).toBe(true);
	expect(await env.BLOG_DIRECTORY.getByName('global').list()).toContain(legacy.name);
	await runInDurableObject(legacy.stub, async (_instance, state) => {
		expect(state.storage.sql.exec("SELECT v FROM meta WHERE k = 'lifetime_policy'").toArray()).toHaveLength(0);
		expect(await state.storage.getAlarm()).toBe(legacy.alarm);
	});
});

it('rejects nonallowlisted names without dispatch, even if an actor exists; invalid syntax is not hashed', async () => {
	const legacy = await legacyBlog();
	const gate = bindings([env.BLOG_DIRECTORY.idFromName(legacy.name).toString()]);
	expect(await resolveBlogStub(gate.value, legacy.name)).toBeNull();
	expect(await resolveBlogStub(gate.value, 'unknown-valid-name')).toBeNull();
	expect(gate.hash).toHaveBeenCalledTimes(2);
	expect(await resolveBlogStub(gate.value, '../bad-name')).toBeNull();
	expect(gate.hash).toHaveBeenCalledTimes(2);
	expect(gate.dispatch).not.toHaveBeenCalled();
});

it('does not register empty, expired or mismatched allowlisted actors or initialize their schema', async () => {
	const empty = `empty-${crypto.randomUUID()}`;
	const expired = await legacyBlog();
	const mismatch = await legacyBlog();
	await runInDurableObject(expired.stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'last_write_at'", String(Date.now() - 40 * 86400000));
	});
	await runInDurableObject(mismatch.stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE meta SET v = 'different-public-name' WHERE k = 'blog_id'");
	});
	const gate = bindings([empty, expired.name, mismatch.name].map(name => env.LIVE_BLOG.idFromName(name).toString()));
	for (const name of [empty, expired.name, mismatch.name]) {
		expect(await resolveBlogStub(gate.value, name)).toBeNull();
		expect(await env.BLOG_DIRECTORY.getByName('global').exists(name)).toBe(false);
	}
	expect(gate.dispatch).toHaveBeenCalledTimes(3);
	const result = await expired.stub.getPublicMetadata();
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.status).toBe(410);
	await runInDurableObject(env.LIVE_BLOG.getByName(empty), async (_instance, state) => {
		expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('meta', 'posts')").toArray()).toHaveLength(0);
		expect(await state.storage.getAlarm()).toBeNull();
	});
});

it('keeps optional plaintext manifests gated by real metadata, without blind registration', async () => {
	const legacy = await legacyBlog();
	const missing = `missing-${crypto.randomUUID()}`;
	const gate = bindings([], [legacy.name, missing]);
	expect(await resolveBlogStub(gate.value, legacy.name)).not.toBeNull();
	expect(await resolveBlogStub(gate.value, missing)).toBeNull();
	expect(await env.BLOG_DIRECTORY.getByName('global').exists(missing)).toBe(false);
});

it('allows verified archives beyond the new-admission cap and refreshes sliding expiry rather than hiding them', async () => {
	const legacy = await legacyBlog();
	const registry = env.BLOG_DIRECTORY.getByName('global');
	await runInDurableObject(registry, (_instance, state) => {
		for (let n = 0; n < 50; n++) state.storage.sql.exec('INSERT OR IGNORE INTO blogs(id, expires) VALUES (?, ?)', `admitted-${n}`, Date.now() + BLOG_TTL_MS);
	});
	const gate = bindings([env.LIVE_BLOG.idFromName(legacy.name).toString()]);
	expect(await resolveBlogStub(gate.value, legacy.name)).not.toBeNull();
	expect(await registry.reserve('new-over-cap')).toBe('budget');
	await runInDurableObject(legacy.stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'last_write_at'", String(Date.now()));
	});
	await runInDurableObject(registry, async (instance, state) => {
		state.storage.sql.exec('UPDATE blogs SET expires = ? WHERE id = ?', Date.now() - 1, legacy.name);
		await instance.alarm();
	});
	expect(await registry.exists(legacy.name)).toBe(false);
	expect(await resolveBlogStub(gate.value, legacy.name)).not.toBeNull();
	expect((await registry.lookup(legacy.name))!.expires).toBeGreaterThan(legacy.expiresAt);
});

it('fails closed on malformed or oversized control-plane manifests before actor dispatch', async () => {
	for (const objects of [['not-a-hash'], Array(1001).fill('a'.repeat(64))]) {
		const gate = bindings(objects);
		await expect(resolveBlogStub(gate.value, 'valid-name')).rejects.toThrow('Invalid legacy blog object manifest');
		expect(gate.dispatch).not.toHaveBeenCalled();
	}
});

it('does not let a stale migration read shorten a newer legacy inactivity deadline', async () => {
	const legacy = await legacyBlog();
	const stale = await legacy.stub.getPublicMetadata();
	if (!stale.ok) throw new Error(stale.error);
	const gate = bindings([env.LIVE_BLOG.idFromName(legacy.name).toString()]);
	await resolveBlogStub(gate.value, legacy.name);
	await runInDurableObject(legacy.stub, (_instance, state) => {
		state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'last_write_at'", String(Date.now()));
	});
	await resolveBlogStub(gate.value, legacy.name);
	const registry = env.BLOG_DIRECTORY.getByName('global');
	const newer = await registry.lookup(legacy.name);
	expect(newer!.expires).toBeGreaterThan(stale.value.expiresAt);
	await registry.registerLegacy(legacy.name, stale.value);
	expect(await registry.lookup(legacy.name)).toEqual(newer);
});

it('clears expired legacy storage and alarms without recreating tables or rearming on another cleanup/read', async () => {
	const legacy = await legacyBlog();
	await runInDurableObject(legacy.stub, async (instance, state) => {
		state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'last_write_at'", String(Date.now() - 40 * 86400000));
		await instance.alarm();
		await instance.alarm();
		expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('meta', 'posts')").toArray()).toHaveLength(0);
		expect(await state.storage.getAlarm()).toBeNull();
	});
	expect((await legacy.stub.getPublicMetadata()).ok).toBe(false);
	expect((await legacy.stub.getSnapshot()).ok).toBe(false);
	await runInDurableObject(legacy.stub, async (_instance, state) => {
		expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('meta', 'posts')").toArray()).toHaveLength(0);
		expect(await state.storage.getAlarm()).toBeNull();
	});
});
