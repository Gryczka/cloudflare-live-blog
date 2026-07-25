/**
 * The reader island.
 *
 * This is the only JavaScript a reader downloads. It is plain TypeScript with no
 * UI framework, because the feed already exists in the server HTML — this script
 * only has to patch it as events arrive.
 *
 * It replaces a Zustand store plus a React tree that, between them, shipped
 * ~477KB of JavaScript and rendered the feed entirely on the client, so nothing
 * was visible until hydration finished and a fetch resolved.
 *
 * Four bugs from that implementation are specifically fixed here.
 *
 * 1. Reconnect storms. The old code closed the existing socket, whose `onclose`
 *    then scheduled *another* reconnect while the replacement was still
 *    connecting, with a fixed 3s delay, no attempt cap, and no cancellation on
 *    unmount. Here there is exactly one socket and one timer, both owned, with
 *    exponential backoff plus jitter and an explicit `closing` flag.
 *
 * 2. Redundant full fetches. The old code fetched the entire post list on mount,
 *    again on every socket open, and again after every publish. Here the initial
 *    state comes from the server HTML and the socket resumes from a cursor, so the
 *    steady state transfers only what changed.
 *
 * 3. Cross-blog state leakage. The old store was a module singleton with no blog
 *    key, so navigating between two blogs showed the wrong posts. This island is
 *    scoped to one root element and reads its blog id from the DOM.
 *
 * 4. Content jumping under the reader. Inserting at the top of the feed shifted
 *    whatever was being read. Scroll position is now compensated explicitly.
 */

import { renderKeyEvent, renderPost } from '../lib/render-post';
import type { BlogMeta, Post, ServerMessage } from '../lib/protocol';

/*
 * A note on the DOM calls below.
 *
 * This project's tsconfig loads the Workers runtime types globally, because the
 * Worker and the Durable Object need them. Those types declare an `Element`
 * interface for HTMLRewriter, which TypeScript merges with the DOM's `Element` —
 * so `append`, `prepend`, `before` and `after` all appear to accept
 * `string | ReadableStream | Response` instead of nodes.
 *
 * Rather than fight that with casts, this file uses the `Node`-level APIs
 * (`appendChild`, `insertBefore`, `replaceChild`), which are not shadowed and are
 * unambiguous about what they do.
 */

interface FeedConfig {
	blogId: string;
	seq: number;
	status: string;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 12;
const PING_INTERVAL_MS = 45_000;
/** Above this scroll offset we consider the reader to have left the top. */
const AT_TOP_THRESHOLD_PX = 120;

/**
 * Configuration comes from `data-*` attributes on the feed root rather than an
 * inline JSON script block. Data blocks are not executed and so are generally not
 * blocked by CSP, but attributes sidestep the question entirely — and they keep
 * the island scoped to one element, which is what stops the cross-blog state
 * leakage the previous global store suffered from.
 */
function start(): void {
	const root = document.querySelector<HTMLElement>('[data-live-feed]');
	if (!root) return;

	const blogId = root.dataset.blogId;
	if (!blogId) return;

	const seq = Number.parseInt(root.dataset.seq ?? '0', 10);

	const config: FeedConfig = {
		blogId,
		seq: Number.isFinite(seq) && seq >= 0 ? seq : 0,
		status: root.dataset.status ?? 'live',
	};

	new LiveFeed(root, config).connect();
}

class LiveFeed {
	private readonly root: HTMLElement;
	private readonly blogId: string;

	private readonly feed: HTMLElement | null;
	private readonly keyEvents: HTMLElement | null;
	private readonly emptyState: HTMLElement | null;
	private readonly statusDot: HTMLElement | null;
	private readonly statusLabel: HTMLElement | null;
	private readonly readerCount: HTMLElement | null;
	private readonly newPostsPill: HTMLButtonElement | null;
	private readonly loadMoreButton: HTMLButtonElement | null;
	private readonly titleEl: HTMLElement | null;
	private readonly summaryEl: HTMLElement | null;

	/** Highest sequence applied. The resume cursor. */
	private seq: number;

	private socket: WebSocket | null = null;
	private reconnectTimer: number | null = null;
	private pingTimer: number | null = null;
	private attempts = 0;
	/** Set when we are tearing down on purpose, to suppress reconnection. */
	private closing = false;

	private pendingNewPosts = 0;

	constructor(root: HTMLElement, config: FeedConfig) {
		this.root = root;
		this.blogId = config.blogId;
		this.seq = config.seq;

		this.feed = root.querySelector('[data-feed]');
		this.keyEvents = document.querySelector('[data-key-events]');
		this.emptyState = root.querySelector('[data-empty-state]');
		this.statusDot = document.querySelector('[data-status-dot]');
		this.statusLabel = document.querySelector('[data-status-label]');
		this.readerCount = document.querySelector('[data-reader-count]');
		this.newPostsPill = document.querySelector('[data-new-posts]');
		this.loadMoreButton = document.querySelector('[data-load-more]');
		this.titleEl = document.querySelector('[data-blog-title]');
		this.summaryEl = document.querySelector('[data-blog-summary]');

		this.bindUi();
		this.refreshTimestamps();
		window.setInterval(() => this.refreshTimestamps(), 30_000);
	}

	/* ------------------------------- lifecycle ------------------------------ */

	connect(): void {
		if (this.closing) return;
		this.clearReconnect();

		// Replace any previous socket without letting its handlers fire. Detaching
		// `onclose` first is what prevents the old reconnect storm.
		if (this.socket) {
			this.detach(this.socket);
			try {
				this.socket.close(1000, 'replaced');
			} catch {
				/* already closing */
			}
			this.socket = null;
		}

		this.setStatus('connecting', 'Connecting…');

		const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
		const url = `${scheme}//${location.host}/api/blogs/${encodeURIComponent(this.blogId)}/socket?since=${this.seq}`;

		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch {
			this.scheduleReconnect();
			return;
		}

		this.socket = socket;

		socket.onopen = () => {
			this.attempts = 0;
			this.setStatus('live', 'Live');
			this.startPing();
		};

		socket.onmessage = (event) => {
			if (typeof event.data !== 'string') return;
			// A pong from the runtime's auto-response is not JSON; ignore it cheaply.
			if (event.data === 'pong') return;
			try {
				this.apply(JSON.parse(event.data) as ServerMessage);
			} catch {
				/* ignore malformed frame */
			}
		};

		socket.onerror = () => {
			// `onclose` always follows, so recovery is handled there.
			this.setStatus('offline', 'Reconnecting…');
		};

		socket.onclose = () => {
			this.stopPing();
			if (this.closing || this.socket !== socket) return;
			this.socket = null;
			this.scheduleReconnect();
		};
	}

	private detach(socket: WebSocket): void {
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
	}

	private scheduleReconnect(): void {
		if (this.closing || this.reconnectTimer !== null) return;

		if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
			this.setStatus('offline', 'Offline — refresh to reconnect');
			return;
		}

		// Exponential backoff with jitter. Jitter matters: without it, every reader
		// of a popular blog reconnects in lockstep after a blip.
		const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts);
		const delay = backoff / 2 + Math.random() * (backoff / 2);
		this.attempts += 1;

		this.setStatus('offline', `Reconnecting in ${Math.round(delay / 1000)}s…`);
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}

	private clearReconnect(): void {
		if (this.reconnectTimer !== null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}

	/**
	 * Application-level keep-alive.
	 *
	 * The Durable Object registers a `ping`/`pong` auto-response pair, so these
	 * frames are answered by the runtime without waking it — idle connections stay
	 * open at no cost.
	 */
	private startPing(): void {
		this.stopPing();
		this.pingTimer = window.setInterval(() => {
			if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('ping');
		}, PING_INTERVAL_MS);
	}

	private stopPing(): void {
		if (this.pingTimer !== null) {
			window.clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private teardown(): void {
		this.closing = true;
		this.clearReconnect();
		this.stopPing();
		if (this.socket) {
			this.detach(this.socket);
			try {
				this.socket.close(1000, 'navigating away');
			} catch {
				/* already closing */
			}
			this.socket = null;
		}
	}

	/* -------------------------------- messages ------------------------------ */

	private apply(message: ServerMessage): void {
		switch (message.t) {
			case 'hello':
				this.setReaders(message.readers);
				if (message.status === 'ended') this.markEnded();
				break;

			case 'sync':
				// Replay of everything missed while disconnected, in sequence order.
				for (const post of message.posts) this.upsert(post, { announce: false });
				this.seq = Math.max(this.seq, message.seq);
				this.flushPending();
				break;

			case 'resync':
				// The gap was too large to stream. A reload is the cheapest correct
				// recovery, and it re-renders the feed on the server anyway.
				this.setStatus('offline', 'Too far behind — reloading…');
				window.setTimeout(() => location.reload(), 500);
				break;

			case 'post.created':
				this.upsert(message.post, { announce: true });
				this.seq = Math.max(this.seq, message.seq);
				this.setReaders(message.readers);
				break;

			case 'post.updated':
				this.upsert(message.post, { announce: false });
				this.seq = Math.max(this.seq, message.seq);
				break;

			case 'post.deleted':
				this.markDeleted(message.id);
				this.seq = Math.max(this.seq, message.seq);
				break;

			case 'meta.updated':
				this.applyMeta(message.meta);
				break;

			case 'presence':
				this.setReaders(message.readers);
				break;
		}
	}

	/* --------------------------------- DOM ---------------------------------- */

	/**
	 * Insert or replace a post.
	 *
	 * New posts go to the top. Because that shifts everything below it, the scroll
	 * position is corrected by the exact height added, so the reader's viewport
	 * stays anchored on whatever they were reading.
	 */
	private upsert(post: Post, options: { announce: boolean }): void {
		if (!this.feed) return;

		const markup = renderPost(post, { blogId: this.blogId });
		const existing = this.feed.querySelector(`[data-post-id="${cssEscape(post.id)}"]`);

		if (existing) {
			const replacement = elementFrom(markup);
			if (replacement) existing.parentNode?.replaceChild(replacement, existing);
			this.refreshTimestamps();
			this.syncKeyEvent(post);
			return;
		}

		const element = elementFrom(markup);
		if (!element) return;

		const wasAtTop = window.scrollY <= AT_TOP_THRESHOLD_PX;
		const previousHeight = document.documentElement.scrollHeight;

		element.classList.add('post--entering');
		this.feed.insertBefore(element, this.feed.firstChild);
		this.emptyState?.setAttribute('hidden', '');

		if (!wasAtTop) {
			// Preserve the reader's position rather than letting content jump.
			const delta = document.documentElement.scrollHeight - previousHeight;
			if (delta > 0) window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
			if (options.announce) {
				this.pendingNewPosts += 1;
				this.showPill();
			}
		}

		// Drop the entrance class after the animation so re-renders do not replay it.
		window.setTimeout(() => element.classList.remove('post--entering'), 600);

		this.refreshTimestamps();
		this.syncKeyEvent(post);
	}

	private markDeleted(id: string): void {
		const existing = this.feed?.querySelector(`[data-post-id="${cssEscape(id)}"]`);
		if (!existing) return;
		existing.classList.add('post--deleted');
		existing.classList.remove('post--pinned');
		const body = existing.querySelector('.post__body');
		if (body) {
			const tombstone = document.createElement('p');
			tombstone.className = 'post__tombstone';
			tombstone.textContent = 'This post was removed by the author.';
			body.parentNode?.replaceChild(tombstone, body);
		}
		this.keyEvents?.querySelector(`[data-post-id="${cssEscape(id)}"]`)?.remove();
		this.reconcileKeyEventsVisibility();
	}

	/** Keep the pinned rail consistent with pin/unpin and edits. */
	private syncKeyEvent(post: Post): void {
		if (!this.keyEvents) return;
		const existing = this.keyEvents.querySelector(`[data-post-id="${cssEscape(post.id)}"]`);

		if (!post.pinned || post.deleted) {
			existing?.remove();
			this.reconcileKeyEventsVisibility();
			return;
		}

		const markup = renderKeyEvent(post, this.blogId);
		const element = elementFrom(markup);
		if (!element) return;

		if (existing) {
			existing.parentNode?.replaceChild(element, existing);
		} else {
			// The rail reads oldest-first, so append.
			this.keyEvents.appendChild(element);
		}
		this.reconcileKeyEventsVisibility();
	}

	private reconcileKeyEventsVisibility(): void {
		const container = document.querySelector('[data-key-events-panel]');
		if (!container || !this.keyEvents) return;
		container.toggleAttribute('hidden', this.keyEvents.children.length === 0);
	}

	private applyMeta(meta: BlogMeta): void {
		if (this.titleEl) this.titleEl.textContent = meta.title;
		if (this.summaryEl) {
			this.summaryEl.textContent = meta.summary;
			this.summaryEl.toggleAttribute('hidden', meta.summary.length === 0);
		}
		document.title = `${meta.title} — Live blog`;
		if (meta.status === 'ended') this.markEnded();
	}

	private markEnded(): void {
		this.root.dataset.status = 'ended';
		document.querySelector('[data-ended-notice]')?.removeAttribute('hidden');
		this.setStatus('ended', 'Coverage ended');
	}

	private setReaders(count: number): void {
		if (!this.readerCount) return;
		this.readerCount.textContent = String(count);
		const label = this.readerCount.closest('[data-reader-count-label]');
		label?.setAttribute('aria-label', `${count} ${count === 1 ? 'person' : 'people'} reading now`);
	}

	private setStatus(state: 'connecting' | 'live' | 'offline' | 'ended', label: string): void {
		if (this.root.dataset.status === 'ended' && state !== 'ended') return;
		if (this.statusDot) this.statusDot.dataset.state = state;
		if (this.statusLabel) this.statusLabel.textContent = label;
	}

	private showPill(): void {
		if (!this.newPostsPill) return;
		const count = this.pendingNewPosts;
		this.newPostsPill.textContent = `${count} new ${count === 1 ? 'post' : 'posts'}`;
		this.newPostsPill.removeAttribute('hidden');
	}

	private flushPending(): void {
		this.pendingNewPosts = 0;
		this.newPostsPill?.setAttribute('hidden', '');
	}

	/** Upgrade absolute server-rendered times to localized relative labels. */
	private refreshTimestamps(): void {
		const now = Date.now();
		for (const element of document.querySelectorAll<HTMLElement>('[data-created]')) {
			const created = Number.parseInt(element.dataset.created ?? '', 10);
			if (!Number.isFinite(created)) continue;
			const time = element.querySelector<HTMLTimeElement>('.post__time');
			if (!time) continue;
			time.textContent = relativeTime(created, now);
			time.title = new Date(created).toLocaleString();
		}
	}

	/* ---------------------------------- UI ---------------------------------- */

	private bindUi(): void {
		this.newPostsPill?.addEventListener('click', () => {
			window.scrollTo({ top: 0, behavior: 'smooth' });
			this.flushPending();
		});

		window.addEventListener('scroll', () => {
			if (window.scrollY <= AT_TOP_THRESHOLD_PX) this.flushPending();
		}, { passive: true });

		this.loadMoreButton?.addEventListener('click', () => void this.loadMore());

		// Reconnect promptly when the tab comes back or the network returns, rather
		// than waiting out the remaining backoff.
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible' && !this.socket && !this.closing) {
				this.attempts = 0;
				this.connect();
			}
		});
		window.addEventListener('online', () => {
			if (!this.socket && !this.closing) {
				this.attempts = 0;
				this.connect();
			}
		});

		// `pagehide` fires in cases `beforeunload` does not, including iOS.
		window.addEventListener('pagehide', () => this.teardown());
	}

	/** Append a page of older history. */
	private async loadMore(): Promise<void> {
		const button = this.loadMoreButton;
		if (!button || !this.feed) return;

		const oldest = this.feed.lastElementChild as HTMLElement | null;
		const before = oldest?.dataset.seq;
		if (!before) return;

		button.disabled = true;
		const original = button.textContent;
		button.textContent = 'Loading…';

		try {
			const response = await fetch(
				`/api/blogs/${encodeURIComponent(this.blogId)}/snapshot?before=${encodeURIComponent(before)}`,
				{ headers: { Accept: 'application/json' } },
			);
			if (!response.ok) throw new Error(`status ${response.status}`);

			const snapshot = (await response.json()) as { posts: Post[]; hasMore: boolean };
			for (const post of snapshot.posts) {
				if (this.feed.querySelector(`[data-post-id="${cssEscape(post.id)}"]`)) continue;
				const element = elementFrom(renderPost(post, { blogId: this.blogId }));
				if (element) this.feed.appendChild(element);
			}
			this.refreshTimestamps();

			if (!snapshot.hasMore) button.remove();
			else button.textContent = original;
		} catch {
			button.textContent = 'Could not load — retry';
		} finally {
			button.disabled = false;
		}
	}
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

/**
 * `data-post-id` values are UUIDs generated server-side, so they cannot contain
 * quotes. This guard exists so the selector stays correct if that ever changes.
 */
function cssEscape(value: string): string {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, '\\$&');
}

function elementFrom(markup: string): HTMLElement | null {
	const template = document.createElement('template');
	template.innerHTML = markup.trim();
	return template.content.firstElementChild as HTMLElement | null;
}

function relativeTime(timestamp: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
	if (seconds < 10) return 'just now';
	if (seconds < 60) return `${seconds}s ago`;

	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;

	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;

	// Past a day, an absolute local time is more useful than "3d ago".
	return new Date(timestamp).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
	});
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
	start();
}
