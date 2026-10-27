/**
 * LiveBlog — one SQLite-backed Durable Object per live blog.
 *
 * ## Why a Durable Object
 *
 * `idFromName(blogId)` is deterministic and global, so every author and every
 * reader of a given blog is routed to this one instance no matter where they
 * are. That single-instance property is what makes the hard parts trivial:
 *
 *   - Ordering is just an incrementing integer, because writes are serialized.
 *   - Fan-out is a loop over local sockets, with no external pub/sub.
 *   - Read-after-write is free, with no cache invalidation to get wrong.
 *
 * ## Storage
 *
 * SQLite (`new_sqlite_classes`), not the key-value backend. The previous
 * iteration stored the entire post list in one KV entry and rewrote all of it on
 * every publish — O(n) writes against a 128KB ceiling. Here each post is a row,
 * and `AUTOINCREMENT` gives the monotonic sequence the resume protocol needs.
 *
 * ## Two sequences, deliberately
 *
 *   - `created_seq` is assigned once and never changes. It orders the feed, so
 *     editing an old post does not make it jump to the top.
 *   - `seq` is bumped on every mutation. Clients resume with `?since=<seq>`, and
 *     one query — `WHERE seq > ?` — replays creations, edits, *and* deletions,
 *     because deletes are soft and leave a tombstone row behind.
 *
 * ## Hibernation
 *
 * Sockets are accepted with `ctx.acceptWebSocket`, so this object is evicted
 * from memory while connections stay open, and `ctx.getWebSockets()` is the
 * single source of truth for who is connected. The previous iteration kept a
 * parallel `Map` that had to be rebuilt in the constructor from serialized
 * attachments and could drift out of sync with reality; there is no such map
 * here.
 */

import { DurableObject } from 'cloudflare:workers';
import { configuredLimit } from './BlogDirectory';

import { hashToken, mintToken, verifyToken } from '../lib/capability';
import { renderMarkdown } from '../lib/markdown';
import {
	BLOG_TTL_MS,
	MAX_AUTHOR_LENGTH,
	MAX_BODY_LENGTH,
	MAX_CONNECTIONS_PER_BLOG,
	MAX_PINNED_POSTS,
	MAX_POSTS_PER_BLOG,
	MAX_REPLAY_POSTS,
	MAX_SUMMARY_LENGTH,
	MAX_TITLE_LENGTH,
	SNAPSHOT_PAGE_SIZE,
	isPostKind,
	type PostKind,
} from '../lib/limits';
import {
	err,
	ok,
	type BlogMeta,
	type BlogStatus,
	type CreateBlogResult,
	type CreatePostInput,
	type Post,
	type Result,
	type ServerMessage,
	type Snapshot,
	type UpdateMetaInput,
	type UpdatePostInput,
} from '../lib/protocol';

/**
 * Shape of a row in the `posts` table.
 *
 * The index signature is required by `sql.exec<T>()`, which constrains `T` to a
 * record of `SqlStorageValue`. Declaring the columns explicitly still gives real
 * type checking at every read site.
 */
interface PostRow {
	[key: string]: SqlStorageValue;
	created_seq: number;
	id: string;
	seq: number;
	kind: string;
	body: string;
	html: string;
	author: string | null;
	pinned: number;
	revision: number;
	created_at: number;
	updated_at: number | null;
	deleted_at: number | null;
}

/** Per-connection state. Kept tiny; the serialized cap is 16,384 bytes. */
interface ConnectionState {
	joinedAt: number;
}

/** Migration reads only public identity/status and the existing expiry deadline. */
export interface PublicBlogMetadata {
	blogId: string;
	status: BlogStatus;
	expiresAt: number;
}

export class LiveBlog extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;

		/**
		 * Let the runtime answer keep-alive pings without waking this object.
		 *
		 * This is what makes idle connections genuinely free: a hibernated DO stays
		 * hibernated through ping/pong traffic, and only real messages bring it back
		 * into memory.
		 */
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
	}

	/**
	 * Create the schema if it is absent.
	 *
	 * Called only by admitted creation. Unknown or expired reads check for the
	 * meta table and return 404 without allocating or re-creating schema.
	 *
	 * Synchronous and idempotent, so it needs no `blockConcurrencyWhile`.
	 */
	private ensureSchema(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS posts (
				created_seq INTEGER PRIMARY KEY AUTOINCREMENT,
				id          TEXT    NOT NULL UNIQUE,
				seq         INTEGER NOT NULL,
				kind        TEXT    NOT NULL DEFAULT 'update',
				body        TEXT    NOT NULL,
				html        TEXT    NOT NULL,
				author      TEXT,
				pinned      INTEGER NOT NULL DEFAULT 0,
				revision    INTEGER NOT NULL DEFAULT 1,
				created_at  INTEGER NOT NULL,
				updated_at  INTEGER,
				deleted_at  INTEGER
			);

			CREATE INDEX IF NOT EXISTS idx_posts_seq ON posts(seq);
			CREATE INDEX IF NOT EXISTS idx_posts_created_seq ON posts(created_seq DESC);
			CREATE INDEX IF NOT EXISTS idx_posts_pinned ON posts(pinned, created_seq);

			CREATE TABLE IF NOT EXISTS meta (
				k TEXT PRIMARY KEY,
				v TEXT NOT NULL
			);
		`);
	}

	/* ---------------------------------------------------------------------- */
	/*                          Lifecycle / creation                          */
	/* ---------------------------------------------------------------------- */

	/**
	 * Initialize a new blog and mint its capability token.
	 *
	 * The token is returned exactly once and never stored — only its SHA-256
	 * digest is persisted, so reading this object's storage does not grant the
	 * ability to publish.
	 */
	async createBlog(input: {
		blogId: string;
		title?: string;
		summary?: string;
	}): Promise<Result<CreateBlogResult>> {
		if (this.getMetaValue('blog_id') !== null) {
			return err('That blog id is already taken.', 409);
		}

		const editToken = mintToken();
		const tokenHash = await hashToken(editToken);
		const now = Date.now();
		// Schema allocation happens only on admitted creation, never on a read.
		this.ensureSchema();
		if (this.getMetaValue('blog_id') !== null) return err('That blog id is already taken.', 409);

		const title = normalizeText(input.title, MAX_TITLE_LENGTH) || 'Untitled live blog';
		const summary = normalizeText(input.summary, MAX_SUMMARY_LENGTH) ?? '';

		this.setMetaValues({
			blog_id: input.blogId,
			title,
			summary,
			status: 'live',
			created_at: String(now),
			lifetime_policy: 'absolute-v1',
			updated_at: String(now),
			last_write_at: String(now),
			edit_token_hash: tokenHash,
			seq_counter: '0',
		});

		await this.ensureAlarm();

		return ok({ blogId: input.blogId, editToken });
	}

	/** Whether this blog exists. Reads never auto-create one. */
	isInitialized(): boolean {
		return this.getPublicMetadata().ok;
	}

	getPublicMetadata(): Result<PublicBlogMetadata> {
		const blogId = this.getMetaValue('blog_id');
		if (!blogId || !this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'posts'").toArray().length) return err('Live blog not found.', 404);
		const expiresAt = this.expiryDeadline();
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return err('Live blog expired.', 410);
		return ok({ blogId, status: this.readMetaStatus(), expiresAt });
	}

	private expiryDeadline(): number {
		const lastWrite = Number(this.getMetaValue('last_write_at'));
		if (!Number.isFinite(lastWrite) || lastWrite <= 0) return NaN;
		const idleDeadline = lastWrite + BLOG_TTL_MS;
		// Deployed actors have no marker: retain their sliding inactivity policy.
		return this.getMetaValue('lifetime_policy') === 'absolute-v1'
			? Math.min(idleDeadline, Number(this.getMetaValue('created_at')) + BLOG_TTL_MS)
			: idleDeadline;
	}

	/* ---------------------------------------------------------------------- */
	/*                                  Reads                                 */
	/* ---------------------------------------------------------------------- */

	/**
	 * Everything a page needs for a complete first render.
	 *
	 * Called directly over RPC from the Astro page, so the server-side read is an
	 * in-process call rather than an HTTP round trip back into the Worker.
	 */
	async getSnapshot(options: { limit?: number; before?: number } = {}): Promise<Result<Snapshot>> {
		if (!this.isInitialized()) return err('Live blog not found.', 404);

		const limit = clamp(options.limit ?? SNAPSHOT_PAGE_SIZE, 1, SNAPSHOT_PAGE_SIZE);
		const before = options.before;

		// Fetch one extra row to determine `hasMore` without a second COUNT.
		const rows = before
			? this.sql
					.exec<PostRow>(
						'SELECT * FROM posts WHERE created_seq < ? ORDER BY created_seq DESC LIMIT ?',
						before,
						limit + 1,
					)
					.toArray()
			: this.sql
					.exec<PostRow>('SELECT * FROM posts ORDER BY created_seq DESC LIMIT ?', limit + 1)
					.toArray();

		const hasMore = rows.length > limit;
		const posts = rows.slice(0, limit).map(toPost);

		// Pinned "key events" read oldest-first: it is a timeline, not a feed.
		const pinned = this.sql
			.exec<PostRow>(
				'SELECT * FROM posts WHERE pinned = 1 AND deleted_at IS NULL ORDER BY created_seq ASC LIMIT ?',
				MAX_PINNED_POSTS,
			)
			.toArray()
			.map(toPost);

		return ok({
			meta: this.readMeta(),
			posts,
			pinned,
			seq: this.currentSeq(),
			readers: this.readerCount(),
			hasMore,
		});
	}

	/** A single post, for permalink pages. */
	async getPost(id: string): Promise<Result<Post>> {
		if (!this.isInitialized()) return err('Live blog not found.', 404);
		const row = this.sql.exec<PostRow>('SELECT * FROM posts WHERE id = ?', id).toArray()[0];
		if (!row) return err('Post not found.', 404);
		return ok(toPost(row));
	}

	/** Posts created or modified after `since`. Used by the resume protocol. */
	async getPostsSince(since: number): Promise<Result<{ posts: Post[]; seq: number; truncated: boolean }>> {
		if (!this.isInitialized()) return err('Live blog not found.', 404);

		const rows = this.sql
			.exec<PostRow>(
				'SELECT * FROM posts WHERE seq > ? ORDER BY seq ASC LIMIT ?',
				since,
				MAX_REPLAY_POSTS + 1,
			)
			.toArray();

		const truncated = rows.length > MAX_REPLAY_POSTS;
		return ok({
			posts: rows.slice(0, MAX_REPLAY_POSTS).map(toPost),
			seq: this.currentSeq(),
			truncated,
		});
	}

	async getMeta(): Promise<Result<BlogMeta>> {
		if (!this.isInitialized()) return err('Live blog not found.', 404);
		return ok(this.readMeta());
	}

	/* ---------------------------------------------------------------------- */
	/*                                 Writes                                 */
	/* ---------------------------------------------------------------------- */

	async createPost(token: string | null, input: CreatePostInput): Promise<Result<Post>> {
		const auth = await this.authorize(token);
		if (!auth.ok) return auth;
		const live = this.getPublicMetadata();
		if (!live.ok) return live;

		if (this.readMetaStatus() === 'ended') {
			return err('This live blog has ended and is no longer accepting posts.', 409);
		}

		const body = normalizeText(input.body, MAX_BODY_LENGTH);
		if (!body) return err('Post body cannot be empty.');
		if (input.body!.trim().length > MAX_BODY_LENGTH) {
			return err(`Posts must be ${MAX_BODY_LENGTH.toLocaleString()} characters or fewer.`);
		}

		// Authoritative cap, counted in SQL. The edge rate limiter is a cheap
		// first filter but is per-location and eventually consistent, so it
		// cannot enforce a total like this one.
		const total = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM posts').one().n;
		const maximum = configuredLimit(this.env.MAX_RETAINED_POSTS, MAX_POSTS_PER_BLOG, MAX_POSTS_PER_BLOG);
		if (total >= maximum) {
			return err(`This blog has reached its limit of ${MAX_POSTS_PER_BLOG.toLocaleString()} posts.`, 507);
		}

		const kind = isPostKind(input.kind) ? input.kind : 'update';
		const pinned = input.pinned === true;
		if (pinned && this.countPinned() >= MAX_PINNED_POSTS) {
			return err(`You can pin at most ${MAX_PINNED_POSTS} key events.`);
		}

		const id = crypto.randomUUID();
		const html = renderMarkdown(body);
		const writable = this.getPublicMetadata();
		if (!writable.ok) return writable;
		// No await between this lifetime check and any sequence/content/meta write.
		const now = Date.now();
		const seq = this.nextSeq();

		this.sql.exec(
			`INSERT INTO posts (id, seq, kind, body, html, author, pinned, revision, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
			id,
			seq,
			kind,
			body,
			html,
			normalizeText(input.author, MAX_AUTHOR_LENGTH),
			pinned ? 1 : 0,
			now,
		);

		this.touch(now);
		const post = this.requirePost(id);

		this.broadcast({ t: 'post.created', post, seq, readers: this.readerCount() });
		return ok(post);
	}

	async updatePost(token: string | null, id: string, input: UpdatePostInput): Promise<Result<Post>> {
		const auth = await this.authorize(token);
		if (!auth.ok) return auth;
		const live = this.getPublicMetadata();
		if (!live.ok) return live;

		const existing = this.sql.exec<PostRow>('SELECT * FROM posts WHERE id = ?', id).toArray()[0];
		if (!existing) return err('Post not found.', 404);
		if (existing.deleted_at !== null) return err('That post has been deleted.', 409);

		const body = input.body === undefined ? existing.body : normalizeText(input.body, MAX_BODY_LENGTH);
		if (!body) return err('Post body cannot be empty.');
		if (input.body !== undefined && input.body.trim().length > MAX_BODY_LENGTH) {
			return err(`Posts must be ${MAX_BODY_LENGTH.toLocaleString()} characters or fewer.`);
		}

		const kind = input.kind !== undefined && isPostKind(input.kind) ? input.kind : (existing.kind as PostKind);
		const author =
			input.author === undefined ? existing.author : normalizeText(input.author, MAX_AUTHOR_LENGTH);
		const pinned = input.pinned === undefined ? existing.pinned === 1 : input.pinned;

		if (pinned && existing.pinned !== 1 && this.countPinned() >= MAX_PINNED_POSTS) {
			return err(`You can pin at most ${MAX_PINNED_POSTS} key events.`);
		}

		// A no-op edit should not consume a sequence number or bump the revision,
		// otherwise every idle save would look like a correction to readers.
		const unchanged =
			body === existing.body &&
			kind === existing.kind &&
			author === existing.author &&
			(pinned ? 1 : 0) === existing.pinned;
		if (unchanged) return ok(toPost(existing));

		// `revision` only advances when the text actually changed. Pinning or
		// re-labelling a post is not a correction to the reader.
		const revision = body === existing.body ? existing.revision : existing.revision + 1;
		const html = renderMarkdown(body);
		const writable = this.getPublicMetadata();
		if (!writable.ok) return writable;
		const now = Date.now();
		const seq = this.nextSeq();

		this.sql.exec(
			`UPDATE posts
			    SET seq = ?, kind = ?, body = ?, html = ?, author = ?, pinned = ?, revision = ?, updated_at = ?
			  WHERE id = ?`,
			seq,
			kind,
			body,
			html,
			author,
			pinned ? 1 : 0,
			revision,
			now,
			id,
		);

		this.touch(now);
		const post = this.requirePost(id);

		this.broadcast({ t: 'post.updated', post, seq });
		return ok(post);
	}

	/**
	 * Soft-delete a post.
	 *
	 * The row is kept with `deleted_at` set so readers see an explicit "removed"
	 * tombstone rather than content silently vanishing — which is the honest
	 * behaviour for a news product — and so the resume protocol can replay the
	 * deletion to clients that were offline when it happened.
	 */
	async deletePost(token: string | null, id: string): Promise<Result<{ id: string }>> {
		const auth = await this.authorize(token);
		if (!auth.ok) return auth;
		const live = this.getPublicMetadata();
		if (!live.ok) return live;

		const existing = this.sql.exec<PostRow>('SELECT * FROM posts WHERE id = ?', id).toArray()[0];
		if (!existing) return err('Post not found.', 404);
		if (existing.deleted_at !== null) return ok({ id });

		const writable = this.getPublicMetadata();
		if (!writable.ok) return writable;
		const now = Date.now();
		const seq = this.nextSeq();

		this.sql.exec(
			`UPDATE posts SET seq = ?, deleted_at = ?, pinned = 0, body = '', html = '', updated_at = ? WHERE id = ?`,
			seq,
			now,
			now,
			id,
		);

		this.touch(now);
		this.broadcast({ t: 'post.deleted', id, seq });
		return ok({ id });
	}

	async updateMeta(token: string | null, input: UpdateMetaInput): Promise<Result<BlogMeta>> {
		const auth = await this.authorize(token);
		if (!auth.ok) return auth;
		const live = this.getPublicMetadata();
		if (!live.ok) return live;

		const updates: Record<string, string> = {};
		if (input.title !== undefined) {
			const title = normalizeText(input.title, MAX_TITLE_LENGTH);
			if (!title) return err('Title cannot be empty.');
			updates.title = title;
		}
		if (input.summary !== undefined) {
			updates.summary = normalizeText(input.summary, MAX_SUMMARY_LENGTH) ?? '';
		}
		if (Object.keys(updates).length === 0) return ok(this.readMeta());

		const writable = this.getPublicMetadata();
		if (!writable.ok) return writable;
		const now = Date.now();
		this.setMetaValues({ ...updates, updated_at: String(now), last_write_at: String(now) });

		const meta = this.readMeta();
		this.broadcast({ t: 'meta.updated', meta });
		return ok(meta);
	}

	/** Mark coverage as finished. Readers keep the archive; writes stop. */
	async setStatus(token: string | null, status: BlogStatus): Promise<Result<BlogMeta>> {
		const auth = await this.authorize(token);
		if (!auth.ok) return auth;

		const writable = this.getPublicMetadata();
		if (!writable.ok) return writable;
		const now = Date.now();
		this.setMetaValues({
			status,
			ended_at: status === 'ended' ? String(now) : '',
			updated_at: String(now),
			last_write_at: String(now),
		});

		const meta = this.readMeta();
		this.broadcast({ t: 'meta.updated', meta });
		if (status === 'ended') this.closeReaders('Coverage ended');
		return ok(meta);
	}

	/** Verify a capability token without performing a write. */
	async checkToken(token: string | null): Promise<boolean> {
		const auth = await this.authorize(token);
		return auth.ok && this.isInitialized();
	}

	/* ---------------------------------------------------------------------- */
	/*                              WebSockets                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * The only HTTP surface on this object: the WebSocket upgrade.
	 *
	 * Everything else is RPC. An upgrade has to be a `fetch` because it returns a
	 * 101 carrying a `webSocket`, which is not an RPC-serializable value.
	 */
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!url.pathname.endsWith('/socket')) {
			return new Response('Not found', { status: 404 });
		}
		if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
			return new Response('Expected a WebSocket upgrade.', { status: 426 });
		}
		if (!this.isInitialized()) {
			return new Response('Live blog not found.', { status: 404 });
		}
		if (request.headers.get('Origin') !== url.origin) return new Response('Origin denied.', { status: 403 });
		if (this.readMetaStatus() === 'ended') return new Response('Coverage ended; use the archive.', { status: 409 });

		// Authoritative connection cap; `getWebSockets()` is the real count.
		if (this.readerCount() >= configuredLimit(this.env.MAX_BLOG_SOCKETS, 100, MAX_CONNECTIONS_PER_BLOG)) {
			return new Response('This live blog has reached its viewer limit.', { status: 503 });
		}

		const since = Number.parseInt(url.searchParams.get('since') ?? '', 10);

		const { 0: client, 1: server } = new WebSocketPair();

		// Hibernation: the connection outlives this object being evicted from
		// memory. Without this the DO would be billed for staying resident.
		this.ctx.acceptWebSocket(server);

		const state: ConnectionState = { joinedAt: Date.now() };
		server.serializeAttachment(state);

		const currentSeq = this.currentSeq();
		send(server, { t: 'hello', seq: currentSeq, readers: this.readerCount(), status: this.readMetaStatus() });

		// Resume: replay exactly what this client missed, or tell it to re-snapshot
		// if the gap is too large to stream.
		if (Number.isFinite(since) && since >= 0 && since < currentSeq) {
			const replay = await this.getPostsSince(since);
			if (replay.ok) {
				if (replay.value.truncated) {
					send(server, { t: 'resync', seq: currentSeq });
				} else if (replay.value.posts.length > 0) {
					send(server, { t: 'sync', posts: replay.value.posts, seq: replay.value.seq });
				}
			}
		}

		this.broadcastPresence();
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Readers do not drive state, so inbound frames are ignored.
	 *
	 * Liveness is handled by the `setWebSocketAutoResponse` pair registered in the
	 * constructor — the runtime answers pings without waking this object, which is
	 * the whole point of hibernation.
	 */
	override async webSocketMessage(ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
		// Only the runtime's literal ping auto-response is supported. Other frames
		// cannot turn a read-only feed into an unbounded wake-up/message workload.
		ws.close(1008, 'Read-only feed');
	}

	override async webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
		// `web_socket_auto_reply_to_close` is on for our compatibility date, so the
		// runtime completes the close handshake. Calling `ws.close(code)` here would
		// be redundant and throws outright when `code` is reserved (1005 / 1006) —
		// a bug the previous iteration shipped.
		this.broadcastPresence();
	}

	override async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
		console.error(
			JSON.stringify({ event: 'websocket_error', blogId: this.getMetaValue('blog_id'), error: String(error) }),
		);
	}

	/* ---------------------------------------------------------------------- */
	/*                                 Alarm                                  */
	/* ---------------------------------------------------------------------- */

	/**
	 * Inactivity cleanup. Without this, every blog ever created on a public demo
	 * persists forever and bills for storage forever.
	 */
	override async alarm(): Promise<void> {
		if (!this.sql.exec("SELECT name FROM sqlite_master WHERE name = 'meta'").toArray().length) return;
		const lastWrite = Number.parseInt(this.getMetaValue('last_write_at') ?? '0', 10);
		const idleFor = Date.now() - lastWrite;

		const deadline = this.expiryDeadline();
		if (!Number.isFinite(deadline) || Date.now() >= deadline) {
			console.log(
				JSON.stringify({
					event: 'blog_expired',
					blogId: this.getMetaValue('blog_id'),
					idleDays: Math.round(idleFor / 86_400_000),
				}),
			);
			// Also clears the alarm, so this object goes quiet permanently.
			this.closeReaders('Blog expired');
			await this.ctx.storage.deleteAll();
			return;
		}

		await this.ctx.storage.setAlarm(deadline);
	}

	private async ensureAlarm(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(this.expiryDeadline());
		}
	}

	/* ---------------------------------------------------------------------- */
	/*                                Internals                               */
	/* ---------------------------------------------------------------------- */

	private async authorize(token: string | null): Promise<Result<true>> {
		const live = this.getPublicMetadata();
		if (!live.ok) return live;
		const storedHash = this.getMetaValue('edit_token_hash');
		const verified = await verifyToken(token, storedHash);
		// Hashing opens an async boundary: expiry/cleanup may have happened while
		// it was pending. Never renew a terminal legacy actor or query cleared tables.
		const current = this.getPublicMetadata();
		if (!current.ok) return current;
		if (verified && storedHash === this.getMetaValue('edit_token_hash')) return ok(true);
		return err('A valid author link is required to publish to this live blog.', 403);
	}

	/**
	 * Allocate the next mutation sequence.
	 *
	 * This read/modify/write has no await, so another event cannot interleave.
	 */
	private nextSeq(): number {
		const next = Number.parseInt(this.getMetaValue('seq_counter') ?? '0', 10) + 1;
		this.setMetaValues({ seq_counter: String(next) });
		return next;
	}

	private currentSeq(): number {
		return Number.parseInt(this.getMetaValue('seq_counter') ?? '0', 10);
	}

	private touch(now: number): void {
		this.setMetaValues({ updated_at: String(now), last_write_at: String(now) });
	}

	private readerCount(): number {
		return this.ctx.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN).length;
	}
	private closeReaders(reason: string): void {
		for (const ws of this.ctx.getWebSockets()) if (ws.readyState === WebSocket.OPEN) ws.close(1001, reason);
	}

	private countPosts(): number {
		return (
			this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM posts WHERE deleted_at IS NULL').one().n ?? 0
		);
	}

	private countPinned(): number {
		return (
			this.sql
				.exec<{ n: number }>('SELECT COUNT(*) AS n FROM posts WHERE pinned = 1 AND deleted_at IS NULL')
				.one().n ?? 0
		);
	}

	private requirePost(id: string): Post {
		const row = this.sql.exec<PostRow>('SELECT * FROM posts WHERE id = ?', id).toArray()[0];
		if (!row) throw new Error(`Post ${id} vanished immediately after write`);
		return toPost(row);
	}

	private readMetaStatus(): BlogStatus {
		return this.getMetaValue('status') === 'ended' ? 'ended' : 'live';
	}

	private readMeta(): BlogMeta {
		const endedAt = Number.parseInt(this.getMetaValue('ended_at') ?? '', 10);
		return {
			blogId: this.getMetaValue('blog_id') ?? '',
			title: this.getMetaValue('title') ?? 'Untitled live blog',
			summary: this.getMetaValue('summary') ?? '',
			status: this.readMetaStatus(),
			createdAt: Number.parseInt(this.getMetaValue('created_at') ?? '0', 10),
			updatedAt: Number.parseInt(this.getMetaValue('updated_at') ?? '0', 10),
			endedAt: Number.isFinite(endedAt) && endedAt > 0 ? endedAt : null,
			postCount: this.countPosts(),
		};
	}

	private getMetaValue(key: string): string | null {
		if (!this.sql.exec("SELECT name FROM sqlite_master WHERE name = 'meta'").toArray().length) return null;
		const row = this.sql.exec<{ v: string }>('SELECT v FROM meta WHERE k = ?', key).toArray()[0];
		return row ? row.v : null;
	}

	private setMetaValues(values: Record<string, string>): void {
		for (const [k, v] of Object.entries(values)) {
			this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
		}
	}

	/** Fan out to every live socket. `getWebSockets()` includes hibernated ones. */
	private broadcast(message: ServerMessage): void {
		const payload = JSON.stringify(message);
		for (const socket of this.ctx.getWebSockets()) {
			if (socket.readyState !== WebSocket.OPEN) continue;
			try {
				socket.send(payload);
			} catch (error) {
				// A socket can die between the readyState check and the send. Losing
				// one delivery is fine: the client resumes from its cursor on
				// reconnect and gets this message then.
				console.error(JSON.stringify({ event: 'broadcast_failed', error: String(error) }));
			}
		}
	}

	private broadcastPresence(): void {
		this.broadcast({ t: 'presence', readers: this.readerCount() });
	}
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

function toPost(row: PostRow): Post {
	const deleted = row.deleted_at !== null;
	return {
		id: row.id,
		seq: row.seq,
		kind: (isPostKind(row.kind) ? row.kind : 'update') as PostKind,
		body: deleted ? '' : row.body,
		html: deleted ? '' : row.html,
		author: row.author,
		pinned: row.pinned === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		revision: row.revision,
		deleted,
	};
}

/** Trim, collapse nothing, enforce a hard cap, and treat empty as absent. */
function normalizeText(value: string | null | undefined, maxLength: number): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed.length === 0) return null;
	return trimmed.slice(0, maxLength);
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

function send(socket: WebSocket, message: ServerMessage): void {
	try {
		socket.send(JSON.stringify(message));
	} catch (error) {
		console.error(JSON.stringify({ event: 'send_failed', error: String(error) }));
	}
}
