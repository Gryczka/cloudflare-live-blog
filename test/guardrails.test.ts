import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it } from 'vitest';

it('does not allocate schema for unknown reads, including after expiry', async () => {
	const stub = env.LIVE_BLOG.getByName(`ghost-${crypto.randomUUID()}`);
	expect((await stub.getSnapshot()).ok).toBe(false);
	await runInDurableObject(stub, (_instance, state) => {
		expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('meta', 'posts')").toArray()).toHaveLength(0);
	});
	await stub.createBlog({ blogId: 'expiry-test' });
	await runInDurableObject(stub, async (instance, state) => {
		state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'created_at'", String(Date.now() - 31 * 86400000));
		await instance.alarm();
	});
	expect((await stub.getSnapshot()).ok).toBe(false);
	await runInDurableObject(stub, async (_instance, state) => {
		expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('meta', 'posts')").toArray()).toHaveLength(0);
		expect(await state.storage.getAlarm()).toBeNull();
	});
});

it('counts deleted tombstones toward the hard retained-row cap', async () => {
	const stub = env.LIVE_BLOG.getByName(`retained-${crypto.randomUUID()}`);
	const created = await stub.createBlog({ blogId: 'retained-test' });
	if (!created.ok) throw new Error(created.error);
	const post = await stub.createPost(created.value.editToken, { body: 'removed' });
	if (!post.ok) throw new Error(post.error);
	await stub.deletePost(created.value.editToken, post.value.id);
	await runInDurableObject(stub, (_instance, state) => {
		state.storage.sql.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n < 4999)
			INSERT INTO posts(id,seq,body,html,created_at,deleted_at) SELECT 'deleted-' || n,n,'','',1,1 FROM rows`);
	});
	const result = await stub.createPost(created.value.editToken, { body: 'cannot recycle capacity' });
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.status).toBe(507);
});

it('closes live readers on end and rejects archive socket upgrades', async () => {
	const stub = env.LIVE_BLOG.getByName(`ended-${crypto.randomUUID()}`);
	const created = await stub.createBlog({ blogId: 'ended-test' });
	if (!created.ok) throw new Error(created.error);
	const request = new Request('https://example.com/socket', { headers: { Upgrade: 'websocket', Origin: 'https://example.com' } });
	const upgrade = await stub.fetch(request);
	expect(upgrade.status).toBe(101);
	upgrade.webSocket!.accept();
	await stub.setStatus(created.value.editToken, 'ended');
	expect((await stub.fetch(request)).status).toBe(409);
	expect((await stub.getSnapshot()).ok).toBe(true);
	await runInDurableObject(stub, (_instance, state) => {
		expect(state.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN)).toHaveLength(0);
	});
});

it('bounds the public directory and does not claim unknown IDs', async () => {
	const directory = env.BLOG_DIRECTORY.getByName(`directory-${crypto.randomUUID()}`);
	expect(await directory.exists('unknown')).toBe(false);
	for (let i = 0; i < 5; i++) expect(await directory.reserve(`blog-${i}`)).toBe('ok');
	expect(await directory.reserve('blog-0')).toBe('taken');
	expect(await directory.reserve('blog-six')).toBe('budget');
	expect(await directory.exists('blog-six')).toBe(false);
});
