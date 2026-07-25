/**
 * Wire types shared by the Durable Object, the Astro pages, and the browser
 * islands.
 *
 * Two design decisions are encoded here and worth stating up front.
 *
 * 1. Every mutation carries a monotonic `seq`.
 *
 *    `seq` comes from a SQLite AUTOINCREMENT column, so it is strictly
 *    increasing per blog and never reused. Clients remember the highest `seq`
 *    they have applied and reconnect with `?since=<seq>`, which lets the server
 *    replay exactly what was missed. The previous iteration of this project had
 *    no cursor at all and papered over gaps by re-downloading the entire post
 *    list on every socket open — three times on a cold load.
 *
 * 2. The server sends rendered `html`, not just markdown.
 *
 *    Markdown is rendered once, on write, in the Durable Object. Readers get
 *    safe HTML they can insert directly, which keeps a markdown parser out of
 *    the reader bundle entirely. See src/lib/markdown.ts for why that HTML is
 *    trustworthy by construction.
 */

import type { PostKind } from './limits';

/** A single post, as exposed to clients. */
export interface Post {
	id: string;
	seq: number;
	kind: PostKind;
	/** Markdown source. Present so the author console can edit it. */
	body: string;
	/** Rendered HTML, safe to insert. Empty when `deleted` is true. */
	html: string;
	author: string | null;
	pinned: boolean;
	createdAt: number;
	updatedAt: number | null;
	/** 1 on first publish, incremented on each edit. Drives "corrected" badges. */
	revision: number;
	/** Soft-deleted posts are kept so readers see a tombstone, not a silent gap. */
	deleted: boolean;
}

export type BlogStatus = 'live' | 'ended';

export interface BlogMeta {
	blogId: string;
	title: string;
	summary: string;
	status: BlogStatus;
	createdAt: number;
	updatedAt: number;
	endedAt: number | null;
	postCount: number;
}

/** Everything a page needs for a complete first render. */
export interface Snapshot {
	meta: BlogMeta;
	/** Newest first. */
	posts: Post[];
	/** Pinned "key events", oldest first — a timeline, not a feed. */
	pinned: Post[];
	/** Highest `seq` in this blog. Clients resume from here. */
	seq: number;
	/** Live reader count at render time. */
	readers: number;
	/** Whether more history exists below `posts`. */
	hasMore: boolean;
}

/* -------------------------------------------------------------------------- */
/*                          Server → client messages                          */
/* -------------------------------------------------------------------------- */

/** Sent immediately on connect, before any replay. */
export interface HelloMessage {
	t: 'hello';
	seq: number;
	readers: number;
	status: BlogStatus;
}

/** Replay of posts the client missed while disconnected. */
export interface SyncMessage {
	t: 'sync';
	posts: Post[];
	seq: number;
}

/**
 * The client's gap was larger than MAX_REPLAY_POSTS. It should re-fetch a
 * snapshot over HTTP rather than have the socket serialize an unbounded set.
 */
export interface ResyncMessage {
	t: 'resync';
	seq: number;
}

export interface PostCreatedMessage {
	t: 'post.created';
	post: Post;
	seq: number;
	readers: number;
}

export interface PostUpdatedMessage {
	t: 'post.updated';
	post: Post;
	seq: number;
}

export interface PostDeletedMessage {
	t: 'post.deleted';
	id: string;
	seq: number;
}

export interface MetaUpdatedMessage {
	t: 'meta.updated';
	meta: BlogMeta;
}

/** Reader count changed. Cheap, and it makes DO fan-out visible in the UI. */
export interface PresenceMessage {
	t: 'presence';
	readers: number;
}

export type ServerMessage =
	| HelloMessage
	| SyncMessage
	| ResyncMessage
	| PostCreatedMessage
	| PostUpdatedMessage
	| PostDeletedMessage
	| MetaUpdatedMessage
	| PresenceMessage;

/* -------------------------------------------------------------------------- */
/*                              Write payloads                                */
/* -------------------------------------------------------------------------- */

export interface CreatePostInput {
	body: string;
	author?: string | null;
	kind?: PostKind;
	pinned?: boolean;
}

export interface UpdatePostInput {
	body?: string;
	author?: string | null;
	kind?: PostKind;
	pinned?: boolean;
}

export interface UpdateMetaInput {
	title?: string;
	summary?: string;
}

/** Result of creating a blog. The token is returned exactly once. */
export interface CreateBlogResult {
	blogId: string;
	editToken: string;
}

/** Discriminated result type so callers must handle failure explicitly. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string; status: number };

export function ok<T>(value: T): Result<T> {
	return { ok: true, value };
}

export function err<T = never>(error: string, status = 400): Result<T> {
	return { ok: false, error, status };
}
