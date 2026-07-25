/**
 * The author console.
 *
 * This is the only Preact in the project, and it is loaded only on
 * `/blog/:id/author`. Readers never request this route, so the framework runtime
 * is not on the critical path for the audience that matters — which is the whole
 * argument for islands over a single client-rendered app.
 *
 * It is a genuine little application: composing, editing, deleting, pinning,
 * renaming, and ending coverage, each with optimistic UI and rollback. That is
 * exactly the kind of stateful surface a UI framework earns its bytes on, and
 * exactly what the reader's plain-TypeScript island is not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { AuthorClient, AuthorClientError } from '../../lib/author-client';
import { readTokenFromFragment } from '../../lib/capability';
import {
	MAX_AUTHOR_LENGTH,
	MAX_BODY_LENGTH,
	MAX_SUMMARY_LENGTH,
	MAX_TITLE_LENGTH,
	POST_KINDS,
	type PostKind,
} from '../../lib/limits';
import { renderMarkdown, toPlainText } from '../../lib/markdown';
import type { BlogMeta, Post } from '../../lib/protocol';

interface Props {
	blogId: string;
}

type Phase = 'checking' | 'unauthorized' | 'ready';

interface Feedback {
	kind: 'error' | 'success';
	message: string;
}

const AUTHOR_STORAGE_KEY = 'live-blog:byline';

export default function AuthorConsole({ blogId }: Props) {
	const [phase, setPhase] = useState<Phase>('checking');
	const [client, setClient] = useState<AuthorClient | null>(null);
	const [meta, setMeta] = useState<BlogMeta | null>(null);
	const [posts, setPosts] = useState<Post[]>([]);
	const [feedback, setFeedback] = useState<Feedback | null>(null);

	const [body, setBody] = useState('');
	const [byline, setByline] = useState('');
	const [kind, setKind] = useState<PostKind>('update');
	const [pinned, setPinned] = useState(false);
	const [publishing, setPublishing] = useState(false);
	const [showPreview, setShowPreview] = useState(false);

	const [editingId, setEditingId] = useState<string | null>(null);
	const [editingBody, setEditingBody] = useState('');

	const composerRef = useRef<HTMLTextAreaElement>(null);

	/* ------------------------------ bootstrap ----------------------------- */

	useEffect(() => {
		// The token lives in the fragment, which is why this must happen in the
		// browser: the server never receives it and so cannot gate the route itself.
		const token = readTokenFromFragment(window.location.hash);
		if (!token) {
			setPhase('unauthorized');
			return;
		}

		const authorClient = new AuthorClient(blogId, token);
		let cancelled = false;

		(async () => {
			const authorized = await authorClient.verify();
			if (cancelled) return;

			if (!authorized) {
				setPhase('unauthorized');
				return;
			}

			try {
				const snapshot = await authorClient.snapshot();
				if (cancelled) return;
				setMeta(snapshot.meta);
				setPosts(snapshot.posts);
				setClient(authorClient);
				setPhase('ready');
			} catch {
				if (!cancelled) setPhase('unauthorized');
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [blogId]);

	// Remember the byline across sessions; retyping it for every post is friction
	// a live blogger does not need.
	useEffect(() => {
		try {
			const saved = window.localStorage.getItem(AUTHOR_STORAGE_KEY);
			if (saved) setByline(saved);
		} catch {
			/* storage can be unavailable in private modes */
		}
	}, []);

	useEffect(() => {
		try {
			if (byline) window.localStorage.setItem(AUTHOR_STORAGE_KEY, byline);
		} catch {
			/* ignore */
		}
	}, [byline]);

	/* -------------------------------- helpers ------------------------------ */

	const notify = useCallback((next: Feedback | null) => {
		setFeedback(next);
		if (next?.kind === 'success') {
			window.setTimeout(() => setFeedback((current) => (current === next ? null : current)), 2500);
		}
	}, []);

	const handleError = useCallback(
		(error: unknown, fallback: string) => {
			const message = error instanceof AuthorClientError ? error.message : fallback;
			notify({ kind: 'error', message });
		},
		[notify],
	);

	const preview = useMemo(() => (showPreview ? renderMarkdown(body) : ''), [showPreview, body]);
	const overLimit = body.trim().length > MAX_BODY_LENGTH;

	/* -------------------------------- actions ----------------------------- */

	const publish = useCallback(
		async (event: Event) => {
			event.preventDefault();
			if (!client || publishing) return;

			const trimmed = body.trim();
			if (!trimmed) {
				notify({ kind: 'error', message: 'Write something before publishing.' });
				return;
			}
			if (trimmed.length > MAX_BODY_LENGTH) {
				notify({
					kind: 'error',
					message: `Posts must be ${MAX_BODY_LENGTH.toLocaleString()} characters or fewer.`,
				});
				return;
			}

			setPublishing(true);
			try {
				const created = await client.createPost({
					body: trimmed,
					author: byline.trim() || null,
					kind,
					pinned,
				});
				setPosts((current) => [created, ...current]);
				setBody('');
				setPinned(false);
				setShowPreview(false);
				notify({ kind: 'success', message: 'Published. Readers have it already.' });
				composerRef.current?.focus();
			} catch (error) {
				handleError(error, 'Could not publish that post.');
			} finally {
				setPublishing(false);
			}
		},
		[client, publishing, body, byline, kind, pinned, notify, handleError],
	);

	/**
	 * Pin/unpin optimistically, then roll back if the server disagrees.
	 *
	 * Worth it because pinning is the one action an author takes mid-breaking-news,
	 * when a round trip of latency is most noticeable.
	 */
	const togglePinned = useCallback(
		async (post: Post) => {
			if (!client) return;
			const next = !post.pinned;

			setPosts((current) => current.map((p) => (p.id === post.id ? { ...p, pinned: next } : p)));

			try {
				const updated = await client.updatePost(post.id, { pinned: next });
				setPosts((current) => current.map((p) => (p.id === post.id ? updated : p)));
			} catch (error) {
				setPosts((current) => current.map((p) => (p.id === post.id ? { ...p, pinned: post.pinned } : p)));
				handleError(error, 'Could not change that pin.');
			}
		},
		[client, handleError],
	);

	const saveEdit = useCallback(
		async (post: Post) => {
			if (!client) return;
			const trimmed = editingBody.trim();
			if (!trimmed) {
				notify({ kind: 'error', message: 'A post cannot be empty. Delete it instead.' });
				return;
			}

			try {
				const updated = await client.updatePost(post.id, { body: trimmed });
				setPosts((current) => current.map((p) => (p.id === post.id ? updated : p)));
				setEditingId(null);
				setEditingBody('');
				notify({
					kind: 'success',
					message: 'Updated. Readers see an "Updated" badge on corrected posts.',
				});
			} catch (error) {
				handleError(error, 'Could not save that edit.');
			}
		},
		[client, editingBody, notify, handleError],
	);

	const removePost = useCallback(
		async (post: Post) => {
			if (!client) return;
			if (!window.confirm('Remove this post? Readers will see that a post was removed.')) return;

			try {
				await client.deletePost(post.id);
				setPosts((current) =>
					current.map((p) => (p.id === post.id ? { ...p, deleted: true, html: '', body: '', pinned: false } : p)),
				);
				notify({ kind: 'success', message: 'Post removed.' });
			} catch (error) {
				handleError(error, 'Could not remove that post.');
			}
		},
		[client, notify, handleError],
	);

	const saveMeta = useCallback(
		async (title: string, summary: string) => {
			if (!client) return;
			try {
				setMeta(await client.updateMeta({ title, summary }));
				notify({ kind: 'success', message: 'Headline updated for everyone reading.' });
			} catch (error) {
				handleError(error, 'Could not update the headline.');
			}
		},
		[client, notify, handleError],
	);

	const toggleCoverage = useCallback(async () => {
		if (!client || !meta) return;
		const next = meta.status === 'ended' ? 'live' : 'ended';
		if (next === 'ended' && !window.confirm('End coverage? Publishing will be blocked until you reopen it.')) {
			return;
		}
		try {
			setMeta(await client.setStatus(next));
			notify({
				kind: 'success',
				message: next === 'ended' ? 'Coverage marked as ended.' : 'Coverage reopened.',
			});
		} catch (error) {
			handleError(error, 'Could not change coverage status.');
		}
	}, [client, meta, notify, handleError]);

	/* --------------------------------- views ------------------------------ */

	if (phase === 'checking') {
		return <p class="notice">Checking your author link…</p>;
	}

	if (phase === 'unauthorized') {
		return (
			<div class="notice notice--error">
				<p>
					<strong>This author link is not valid.</strong>
				</p>
				<p>
					Publishing requires the private author link created with this live blog. The key travels
					in the part of the URL after <code>#</code>, so make sure you copied the whole thing.
				</p>
				<p>
					<a href={`/blog/${encodeURIComponent(blogId)}`}>Read this live blog instead</a> or{' '}
					<a href="/">start your own</a>.
				</p>
			</div>
		);
	}

	const ended = meta?.status === 'ended';

	return (
		<>
			{feedback && (
				<p class={`notice notice--${feedback.kind === 'error' ? 'error' : 'success'}`} role="status">
					{feedback.message}
				</p>
			)}

			<section class="panel">
				<h2 class="panel__title">Compose</h2>

				{ended && (
					<p class="notice">
						Coverage is marked as ended. Reopen it below to publish again.
					</p>
				)}

				<form onSubmit={publish}>
					<div class="composer__row">
						<label class="field">
							<span class="field__label">Byline</span>
							<input
								class="input"
								type="text"
								value={byline}
								maxLength={MAX_AUTHOR_LENGTH}
								placeholder="Anonymous"
								onInput={(event) => setByline((event.target as HTMLInputElement).value)}
							/>
						</label>

						<label class="field">
							<span class="field__label">Type</span>
							<select
								class="select"
								value={kind}
								onChange={(event) => setKind((event.target as HTMLSelectElement).value as PostKind)}
							>
								{POST_KINDS.map((option) => (
									<option key={option} value={option}>
										{option[0]!.toUpperCase() + option.slice(1)}
									</option>
								))}
							</select>
						</label>
					</div>

					<label class="field">
						<span class="field__label">Update</span>
						<textarea
							ref={composerRef}
							class="textarea"
							value={body}
							rows={7}
							placeholder="What just happened? Markdown works: **bold**, *italic*, [links](https://example.com), - lists, > quotes."
							onInput={(event) => setBody((event.target as HTMLTextAreaElement).value)}
							onKeyDown={(event) => {
								// Ctrl/Cmd+Enter publishes. Live blogging is a typing-speed activity.
								if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
									void publish(event as unknown as Event);
								}
							}}
						/>
						<span class={`field__hint${overLimit ? ' field__hint--warn' : ''}`}>
							<span>Markdown supported. Ctrl/Cmd + Enter to publish.</span>
							<span>
								{body.trim().length.toLocaleString()} / {MAX_BODY_LENGTH.toLocaleString()}
							</span>
						</span>
					</label>

					<div class="composer__toolbar">
						<label class="checkbox">
							<input
								type="checkbox"
								checked={pinned}
								onChange={(event) => setPinned((event.target as HTMLInputElement).checked)}
							/>
							Pin as a key event
						</label>

						<span class="manage-item__actions">
							<button
								class="button button--small"
								type="button"
								onClick={() => setShowPreview((current) => !current)}
							>
								{showPreview ? 'Hide preview' : 'Preview'}
							</button>
							<button
								class="button button--primary"
								type="submit"
								disabled={publishing || overLimit || !body.trim() || ended}
							>
								{publishing ? 'Publishing…' : 'Publish'}
							</button>
						</span>
					</div>
				</form>

				{showPreview && (
					<div class="preview">
						<h3 class="panel__title">Preview</h3>
						{/*
						 * `preview` comes from the same renderer the server uses, which
						 * escapes all input before emitting any tags — so what is shown here
						 * is byte-identical to what readers will get.
						 */}
						<div class="post__body" dangerouslySetInnerHTML={{ __html: preview }} />
					</div>
				)}
			</section>

			{meta && <BlogSettings meta={meta} onSave={saveMeta} onToggleCoverage={toggleCoverage} ended={ended} />}

			<section class="panel">
				<h2 class="panel__title">Published ({posts.length})</h2>

				{posts.length === 0 ? (
					<p class="card__hint">Nothing published yet.</p>
				) : (
					<ul class="manage-list">
						{posts.map((post) => (
							<li key={post.id} class={`manage-item${post.deleted ? ' manage-item--deleted' : ''}`}>
								<div class="manage-item__meta">
									<time dateTime={new Date(post.createdAt).toISOString()}>
										{new Date(post.createdAt).toLocaleTimeString()}
									</time>
									{post.author && <span>{post.author}</span>}
									{post.kind !== 'update' && <span>{post.kind}</span>}
									{post.pinned && <span class="post__badge post__badge--key">Key event</span>}
									{post.revision > 1 && (
										<span class="post__badge post__badge--corrected">
											Updated ×{post.revision - 1}
										</span>
									)}
								</div>

								{post.deleted ? (
									<p class="post__tombstone">Removed.</p>
								) : editingId === post.id ? (
									<>
										<textarea
											class="textarea"
											value={editingBody}
											rows={5}
											onInput={(event) => setEditingBody((event.target as HTMLTextAreaElement).value)}
										/>
										<div class="manage-item__actions">
											<button
												class="button button--small button--primary"
												type="button"
												onClick={() => void saveEdit(post)}
											>
												Save correction
											</button>
											<button
												class="button button--small"
												type="button"
												onClick={() => {
													setEditingId(null);
													setEditingBody('');
												}}
											>
												Cancel
											</button>
										</div>
									</>
								) : (
									<>
										<p class="manage-item__excerpt">{toPlainText(post.body, 220)}</p>
										<div class="manage-item__actions">
											<button
												class="button button--small"
												type="button"
												onClick={() => {
													setEditingId(post.id);
													setEditingBody(post.body);
												}}
											>
												Edit
											</button>
											<button
												class="button button--small"
												type="button"
												onClick={() => void togglePinned(post)}
											>
												{post.pinned ? 'Unpin' : 'Pin'}
											</button>
											<a
												class="button button--small"
												href={`/blog/${encodeURIComponent(blogId)}/post/${encodeURIComponent(post.id)}`}
											>
												View
											</a>
											<button
												class="button button--small button--danger"
												type="button"
												onClick={() => void removePost(post)}
											>
												Remove
											</button>
										</div>
									</>
								)}
							</li>
						))}
					</ul>
				)}
			</section>
		</>
	);
}

/* -------------------------------------------------------------------------- */

interface SettingsProps {
	meta: BlogMeta;
	ended: boolean;
	onSave: (title: string, summary: string) => void | Promise<void>;
	onToggleCoverage: () => void | Promise<void>;
}

function BlogSettings({ meta, ended, onSave, onToggleCoverage }: SettingsProps) {
	const [title, setTitle] = useState(meta.title);
	const [summary, setSummary] = useState(meta.summary);

	// Keep local fields in step when the socket reports a change made elsewhere.
	useEffect(() => {
		setTitle(meta.title);
		setSummary(meta.summary);
	}, [meta.title, meta.summary]);

	const dirty = title.trim() !== meta.title || summary.trim() !== meta.summary;

	return (
		<section class="panel">
			<h2 class="panel__title">Headline</h2>

			<label class="field">
				<span class="field__label">Title</span>
				<input
					class="input"
					type="text"
					value={title}
					maxLength={MAX_TITLE_LENGTH}
					onInput={(event) => setTitle((event.target as HTMLInputElement).value)}
				/>
			</label>

			<label class="field">
				<span class="field__label">Standfirst</span>
				<input
					class="input"
					type="text"
					value={summary}
					maxLength={MAX_SUMMARY_LENGTH}
					onInput={(event) => setSummary((event.target as HTMLInputElement).value)}
				/>
			</label>

			<div class="manage-item__actions">
				<button
					class="button button--small button--primary"
					type="button"
					disabled={!dirty || !title.trim()}
					onClick={() => void onSave(title.trim(), summary.trim())}
				>
					Save headline
				</button>
				<button class="button button--small" type="button" onClick={() => void onToggleCoverage()}>
					{ended ? 'Reopen coverage' : 'End coverage'}
				</button>
			</div>
		</section>
	);
}
