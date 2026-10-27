import { DurableObject } from 'cloudflare:workers';
import { isValidBlogId } from '../lib/blog-id';
import { BLOG_TTL_MS } from '../lib/limits';
import { MAX_LEGACY_BLOG_IDS, MAX_LEGACY_BLOG_OBJECT_IDS } from '../lib/legacy-blog-manifest';
import type { PublicBlogMetadata } from './LiveBlog';

export function configuredLimit(value: string | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error('Invalid blog budget');
	return parsed;
}

/** A bounded directory: new admissions plus verified existing legacy actors. */
export class BlogDirectory extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS blogs (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, legacy INTEGER NOT NULL DEFAULT 0);
			CREATE TABLE IF NOT EXISTS counts (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)`);
		if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(blogs)').toArray().some(column => column.name === 'legacy')) {
			ctx.storage.sql.exec('ALTER TABLE blogs ADD COLUMN legacy INTEGER NOT NULL DEFAULT 0');
		}
		ctx.blockConcurrencyWhile(async () => {
			if (this.list().length && (await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 86400000);
		});
	}
	lookup(id: string): { expires: number; legacy: boolean } | null {
		const row = this.ctx.storage.sql.exec<{ expires: number; legacy: number }>('SELECT expires, legacy FROM blogs WHERE id = ?', id).toArray()[0];
		return row ? { expires: row.expires, legacy: row.legacy === 1 } : null;
	}
	exists(id: string): boolean {
		return (this.ctx.storage.sql.exec<{ expires: number }>('SELECT expires FROM blogs WHERE id = ?', id).toArray()[0]?.expires ?? 0) > Date.now();
	}
	/** The gated resolver and successful legacy writes supply public actor metadata. */
	async registerLegacy(id: string, metadata: PublicBlogMetadata): Promise<boolean> {
		if (!isValidBlogId(id) || metadata.blogId !== id || !Number.isFinite(metadata.expiresAt) || metadata.expiresAt <= Date.now()) return false;
		this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec('DELETE FROM blogs WHERE expires <= ?', Date.now());
			if (!this.lookup(id) && this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM blogs WHERE legacy = 1').one().n >= MAX_LEGACY_BLOG_OBJECT_IDS + MAX_LEGACY_BLOG_IDS) {
				throw new Error('Legacy directory allowance exhausted');
			}
			// A slow earlier read cannot shorten the deadline after a newer write.
			this.ctx.storage.sql.exec('INSERT INTO blogs(id, expires, legacy) VALUES (?, ?, 1) ON CONFLICT(id) DO UPDATE SET expires = MAX(blogs.expires, excluded.expires), legacy = 1', id, metadata.expiresAt);
		});
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 86400000);
		return true;
	}
	async reserve(id: string): Promise<'ok' | 'taken' | 'budget'> {
		const now = Date.now();
		const outcome = this.ctx.storage.transactionSync(() => {
			this.ctx.storage.sql.exec('DELETE FROM blogs WHERE expires <= ?', now);
			if (this.exists(id)) return 'taken' as const;
			const hour = Math.floor(now / 3600000);
			this.ctx.storage.sql.exec('DELETE FROM counts WHERE id < ?', hour);
			const count = this.ctx.storage.sql.exec<{ n: number }>('SELECT n FROM counts WHERE id = ?', hour).toArray()[0]?.n ?? 0;
			if (count >= configuredLimit(this.env.NEW_BLOGS_PER_HOUR, 5, 100) || this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM blogs').one().n >= configuredLimit(this.env.MAX_ACTIVE_BLOGS, 50, 100)) return 'budget' as const;
			this.ctx.storage.sql.exec('INSERT INTO counts VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1', hour);
			this.ctx.storage.sql.exec('INSERT INTO blogs(id, expires, legacy) VALUES (?, ?, 0)', id, now + BLOG_TTL_MS);
			return 'ok' as const;
		});
		if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + 86400000);
		return outcome;
	}
	list(): string[] {
		return this.ctx.storage.sql.exec<{ id: string }>('SELECT id FROM blogs WHERE expires > ? ORDER BY id LIMIT 1150', Date.now()).toArray().map(row => row.id);
	}
	async alarm(): Promise<void> {
		this.ctx.storage.sql.exec('DELETE FROM blogs WHERE expires <= ?', Date.now());
		this.ctx.storage.sql.exec('DELETE FROM counts WHERE id < ?', Math.floor(Date.now() / 3600000));
		if (this.list().length) await this.ctx.storage.setAlarm(Date.now() + 86400000);
	}
}
