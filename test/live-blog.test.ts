/**
 * Durable Object behaviour tests.
 *
 * These cover the guarantees the rest of the app is built on: that sequences are
 * monotonic, that writes require a capability, that hard caps are enforced against
 * real counts, that deletes leave a replayable tombstone, and that the resume
 * protocol returns exactly the delta.
 */

import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LiveBlog } from '../src/durable-objects/LiveBlog';
import { MAX_PINNED_POSTS } from '../src/lib/limits';

type Stub = DurableObjectStub<LiveBlog>;

const namespace = env.LIVE_BLOG as unknown as DurableObjectNamespace<LiveBlog>;

function stubFor(name: string): Stub {
	return namespace.get(namespace.idFromName(name));
}

/** Create a blog and return its stub plus the one-time edit token. */
async function newBlog(name = `blog-${crypto.randomUUID()}`): Promise<{ stub: Stub; token: string }> {
	const stub = stubFor(name);
	const created = await stub.createBlog({ blogId: name, title: 'Test coverage' });
	if (!created.ok) throw new Error(`setup failed: ${created.error}`);
	return { stub, token: created.value.editToken };
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: string; status: number }): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.status}: ${result.error}`);
	return result.value;
}

describe('createBlog', () => {
	it('returns a token exactly once and refuses to re-create', async () => {
		const name = `blog-${crypto.randomUUID()}`;
		const stub = stubFor(name);

		const first = await stub.createBlog({ blogId: name, title: 'First' });
		expect(first.ok).toBe(true);

		const second = await stub.createBlog({ blogId: name, title: 'Hijack' });
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.status).toBe(409);
	});

	it('never persists the raw token', async () => {
		const name = `blog-${crypto.randomUUID()}`;
		const { token } = await newBlog(name);

		await runInDurableObject(stubFor(name), (_instance, state) => {
			const rows = state.storage.sql.exec('SELECT k, v FROM meta').toArray();
			const serialized = JSON.stringify(rows);
			// Only the digest is stored, so a storage dump does not grant write access.
			expect(serialized).not.toContain(token);
			expect(serialized).toContain('edit_token_hash');
		});
	});

	it('defaults an empty title rather than storing a blank one', async () => {
		const name = `blog-${crypto.randomUUID()}`;
		const stub = stubFor(name);
		await stub.createBlog({ blogId: name, title: '   ' });
		expect(unwrap(await stub.getMeta()).title).toBe('Untitled live blog');
	});
});

describe('reads on a nonexistent blog', () => {
	it('404s instead of implicitly creating one', async () => {
		const stub = stubFor(`ghost-${crypto.randomUUID()}`);
		const snapshot = await stub.getSnapshot({});
		expect(snapshot.ok).toBe(false);
		if (!snapshot.ok) expect(snapshot.status).toBe(404);
		expect(await stub.isInitialized()).toBe(false);
	});
});

describe('authorization', () => {
	let stub: Stub;
	let token: string;

	beforeEach(async () => {
		({ stub, token } = await newBlog());
	});

	it('rejects writes with no token', async () => {
		const result = await stub.createPost(null, { body: 'nope' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(403);
	});

	it('rejects writes with a wrong token', async () => {
		const result = await stub.createPost('not-the-token', { body: 'nope' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(403);
	});

	it('accepts writes with the right token', async () => {
		expect((await stub.createPost(token, { body: 'yes' })).ok).toBe(true);
	});

	it('guards update, delete, meta, and status the same way', async () => {
		const post = unwrap(await stub.createPost(token, { body: 'original' }));

		expect((await stub.updatePost(null, post.id, { body: 'hacked' })).ok).toBe(false);
		expect((await stub.deletePost(null, post.id)).ok).toBe(false);
		expect((await stub.updateMeta(null, { title: 'hacked' })).ok).toBe(false);
		expect((await stub.setStatus(null, 'ended')).ok).toBe(false);

		// Nothing changed.
		expect(unwrap(await stub.getPost(post.id)).body).toBe('original');
	});
});

describe('sequencing', () => {
	let stub: Stub;
	let token: string;

	beforeEach(async () => {
		({ stub, token } = await newBlog());
	});

	it('assigns strictly increasing sequences', async () => {
		const a = unwrap(await stub.createPost(token, { body: 'a' }));
		const b = unwrap(await stub.createPost(token, { body: 'b' }));
		const c = unwrap(await stub.createPost(token, { body: 'c' }));
		expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
	});

	it('bumps the sequence on edit so reconnecting clients replay the change', async () => {
		const post = unwrap(await stub.createPost(token, { body: 'original' }));
		const edited = unwrap(await stub.updatePost(token, post.id, { body: 'corrected' }));
		expect(edited.seq).toBeGreaterThan(post.seq);
	});

	it('bumps the sequence on delete', async () => {
		const post = unwrap(await stub.createPost(token, { body: 'temp' }));
		unwrap(await stub.deletePost(token, post.id));
		expect(unwrap(await stub.getPost(post.id)).seq).toBeGreaterThan(post.seq);
	});

	it('does not consume a sequence or bump revision on a no-op edit', async () => {
		const post = unwrap(await stub.createPost(token, { body: 'same' }));
		const again = unwrap(await stub.updatePost(token, post.id, { body: 'same' }));

		// Otherwise every idle save would look like a correction to readers.
		expect(again.seq).toBe(post.seq);
		expect(again.revision).toBe(1);
	});

	it('keeps feed order by creation, so editing an old post does not resurface it', async () => {
		const first = unwrap(await stub.createPost(token, { body: 'oldest' }));
		await stub.createPost(token, { body: 'newest' });
		await stub.updatePost(token, first.id, { body: 'oldest, corrected' });

		const snapshot = unwrap(await stub.getSnapshot({}));
		expect(snapshot.posts[0]?.body).toBe('newest');
		expect(snapshot.posts[1]?.body).toBe('oldest, corrected');
	});
});

describe('revisions and corrections', () => {
	it('increments revision only when the text changes', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'v1' }));
		expect(post.revision).toBe(1);

		const edited = unwrap(await stub.updatePost(token, post.id, { body: 'v2' }));
		expect(edited.revision).toBe(2);

		// Pinning is not a correction.
		const pinned = unwrap(await stub.updatePost(token, post.id, { pinned: true }));
		expect(pinned.revision).toBe(2);
	});

	it('re-renders HTML on edit', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'plain' }));
		expect(post.html).toBe('<p>plain</p>');

		const edited = unwrap(await stub.updatePost(token, post.id, { body: '**bold**' }));
		expect(edited.html).toBe('<p><strong>bold</strong></p>');
	});
});

describe('deletion', () => {
	it('leaves a replayable tombstone rather than removing the row', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'secret' }));
		unwrap(await stub.deletePost(token, post.id));

		const fetched = unwrap(await stub.getPost(post.id));
		expect(fetched.deleted).toBe(true);
		// The body is withheld from clients even though the row survives.
		expect(fetched.body).toBe('');
		expect(fetched.html).toBe('');
	});

	it('unpins on delete so the key-events rail cannot point at nothing', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'big news', pinned: true }));
		expect(unwrap(await stub.getSnapshot({})).pinned).toHaveLength(1);

		unwrap(await stub.deletePost(token, post.id));
		expect(unwrap(await stub.getSnapshot({})).pinned).toHaveLength(0);
	});

	it('is idempotent', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'x' }));
		expect((await stub.deletePost(token, post.id)).ok).toBe(true);
		expect((await stub.deletePost(token, post.id)).ok).toBe(true);
	});

	it('refuses to edit a deleted post', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'x' }));
		unwrap(await stub.deletePost(token, post.id));

		const result = await stub.updatePost(token, post.id, { body: 'resurrect' });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.status).toBe(409);
	});

	it('excludes deleted posts from postCount', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'x' }));
		await stub.createPost(token, { body: 'y' });
		expect(unwrap(await stub.getMeta()).postCount).toBe(2);

		unwrap(await stub.deletePost(token, post.id));
		expect(unwrap(await stub.getMeta()).postCount).toBe(1);
	});
});

describe('resume protocol', () => {
	it('returns only what changed after the cursor', async () => {
		const { stub, token } = await newBlog();
		const a = unwrap(await stub.createPost(token, { body: 'a' }));
		const b = unwrap(await stub.createPost(token, { body: 'b' }));

		const delta = unwrap(await stub.getPostsSince(a.seq));
		expect(delta.posts.map((p) => p.id)).toEqual([b.id]);
		expect(delta.truncated).toBe(false);
	});

	it('replays an edit to a post the client already had', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'v1' }));
		const cursor = post.seq;
		unwrap(await stub.updatePost(token, post.id, { body: 'v2' }));

		// One query covers create, update, and delete because all three move `seq`.
		const delta = unwrap(await stub.getPostsSince(cursor));
		expect(delta.posts).toHaveLength(1);
		expect(delta.posts[0]?.body).toBe('v2');
	});

	it('replays a deletion as a tombstone', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'x' }));
		const cursor = post.seq;
		unwrap(await stub.deletePost(token, post.id));

		const delta = unwrap(await stub.getPostsSince(cursor));
		expect(delta.posts[0]?.deleted).toBe(true);
	});

	it('returns nothing when the client is current', async () => {
		const { stub, token } = await newBlog();
		const post = unwrap(await stub.createPost(token, { body: 'x' }));
		const delta = unwrap(await stub.getPostsSince(post.seq));
		expect(delta.posts).toHaveLength(0);
	});
});

describe('guardrails', () => {
	it('rejects an empty body', async () => {
		const { stub, token } = await newBlog();
		expect((await stub.createPost(token, { body: '   ' })).ok).toBe(false);
	});

	it('caps pinned key events', async () => {
		const { stub, token } = await newBlog();
		for (let i = 0; i < MAX_PINNED_POSTS; i++) {
			expect((await stub.createPost(token, { body: `pin ${i}`, pinned: true })).ok).toBe(true);
		}

		const overflow = await stub.createPost(token, { body: 'one too many', pinned: true });
		expect(overflow.ok).toBe(false);

		// Unpinned posts still work once the pin budget is spent.
		expect((await stub.createPost(token, { body: 'unpinned is fine' })).ok).toBe(true);
	});

	it('allows re-pinning a post that is already pinned without hitting the cap', async () => {
		const { stub, token } = await newBlog();
		const posts = [];
		for (let i = 0; i < MAX_PINNED_POSTS; i++) {
			posts.push(unwrap(await stub.createPost(token, { body: `pin ${i}`, pinned: true })));
		}
		// Editing an already-pinned post must not be counted as a new pin.
		const result = await stub.updatePost(token, posts[0]!.id, { body: 'edited', pinned: true });
		expect(result.ok).toBe(true);
	});

	it('truncates a body that exceeds the limit rather than storing it whole', async () => {
		const { stub, token } = await newBlog();
		const result = await stub.createPost(token, { body: 'x'.repeat(50_000) });
		expect(result.ok).toBe(false);
	});

	it('blocks publishing once coverage has ended, and allows it again on reopen', async () => {
		const { stub, token } = await newBlog();
		unwrap(await stub.setStatus(token, 'ended'));

		const blocked = await stub.createPost(token, { body: 'after the end' });
		expect(blocked.ok).toBe(false);
		if (!blocked.ok) expect(blocked.status).toBe(409);

		unwrap(await stub.setStatus(token, 'live'));
		expect((await stub.createPost(token, { body: 'reopened' })).ok).toBe(true);
	});
});

describe('metadata', () => {
	it('updates title and summary', async () => {
		const { stub, token } = await newBlog();
		const meta = unwrap(await stub.updateMeta(token, { title: 'New headline', summary: 'New standfirst' }));
		expect(meta.title).toBe('New headline');
		expect(meta.summary).toBe('New standfirst');
	});

	it('refuses a blank title', async () => {
		const { stub, token } = await newBlog();
		expect((await stub.updateMeta(token, { title: '  ' })).ok).toBe(false);
	});

	it('records endedAt only while ended', async () => {
		const { stub, token } = await newBlog();
		expect(unwrap(await stub.getMeta()).endedAt).toBeNull();

		unwrap(await stub.setStatus(token, 'ended'));
		expect(unwrap(await stub.getMeta()).endedAt).toBeGreaterThan(0);

		unwrap(await stub.setStatus(token, 'live'));
		expect(unwrap(await stub.getMeta()).endedAt).toBeNull();
	});
});

describe('pagination', () => {
	it('reports hasMore and walks backwards with a cursor', async () => {
		const { stub, token } = await newBlog();
		for (let i = 0; i < 8; i++) {
			await stub.createPost(token, { body: `post ${i}` });
		}

		const first = unwrap(await stub.getSnapshot({ limit: 3 }));
		expect(first.posts).toHaveLength(3);
		expect(first.hasMore).toBe(true);
		expect(first.posts[0]?.body).toBe('post 7');

		const second = unwrap(await stub.getSnapshot({ limit: 3, before: 6 }));
		expect(second.posts.map((p) => p.body)).toEqual(['post 4', 'post 3', 'post 2']);

		const last = unwrap(await stub.getSnapshot({ limit: 50 }));
		expect(last.hasMore).toBe(false);
	});
});

describe('cleanup alarm', () => {
	it('is armed when a blog is created', async () => {
		const name = `blog-${crypto.randomUUID()}`;
		await newBlog(name);
		await runInDurableObject(stubFor(name), async (_instance, state) => {
			expect(await state.storage.getAlarm()).not.toBeNull();
		});
	});

	it('re-arms instead of deleting an active blog', async () => {
		const name = `blog-${crypto.randomUUID()}`;
		const { stub, token } = await newBlog(name);
		await stub.createPost(token, { body: 'recent activity' });

		await runInDurableObject(stubFor(name), async (instance, state) => {
			await instance.alarm!();
			expect(await state.storage.getAlarm()).not.toBeNull();
		});

		expect(unwrap(await stub.getMeta()).postCount).toBe(1);
	});

	it('wipes a blog that has been idle past its TTL', async () => {
		const name = `blog-${crypto.randomUUID()}`;
		const { stub, token } = await newBlog(name);
		await stub.createPost(token, { body: 'ancient history' });

		await runInDurableObject(stubFor(name), async (instance, state) => {
			// Backdate the last write past the 30-day TTL.
			const longAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
			state.storage.sql.exec('UPDATE meta SET v = ? WHERE k = ?', String(longAgo), 'last_write_at');
			await instance.alarm!();
		});

		// deleteAll() also clears the alarm, so the object goes quiet permanently.
		expect(await stub.isInitialized()).toBe(false);
		await runInDurableObject(stubFor(name), async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBeNull();
		});
	});
});

describe('WebSocket upgrade', () => {
	it('rejects a plain GET with 426', async () => {
		const { stub } = await newBlog();
		const response = await stub.fetch('https://example.com/socket');
		expect(response.status).toBe(426);
	});

	it('accepts an upgrade and reports presence', async () => {
		const { stub } = await newBlog();
		const response = await stub.fetch('https://example.com/socket?since=0', {
			headers: { Upgrade: 'websocket' },
		});
		expect(response.status).toBe(101);
		expect(response.webSocket).toBeTruthy();

		response.webSocket!.accept();
		const readers = unwrap(await stub.getSnapshot({})).readers;
		expect(readers).toBeGreaterThanOrEqual(1);
	});

	it('404s an upgrade against a blog that does not exist', async () => {
		const stub = stubFor(`ghost-${crypto.randomUUID()}`);
		const response = await stub.fetch('https://example.com/socket', {
			headers: { Upgrade: 'websocket' },
		});
		expect(response.status).toBe(404);
	});

	it('404s any other path', async () => {
		const { stub } = await newBlog();
		expect((await stub.fetch('https://example.com/whatever')).status).toBe(404);
	});
});
