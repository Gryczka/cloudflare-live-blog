import { DurableObject } from 'cloudflare:workers';

import {
	BLOG_CREATION_LIMITER_IDLE_TTL_MS,
	MAX_BLOG_CREATIONS_PER_WINDOW,
	rateLimitWindowStart,
} from '../lib/limits';

export type BlogCreationRateLimitDecision = 'allowed' | 'exhausted' | 'unavailable';

/** One SQLite-backed fixed-window counter per hashed connecting IP. */
export class BlogCreationRateLimiter extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.ensureSchema();
	}

	private ensureSchema(): void {
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS creation_rate_limit (
				singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
				window_start INTEGER NOT NULL,
				reservations INTEGER NOT NULL
			);
		`);
	}

	async reserve(): Promise<BlogCreationRateLimitDecision> {
		try {
			this.ensureSchema();
			const now = Date.now();
			const windowStart = rateLimitWindowStart(now);
			const reservation = this.sql
				.exec<{ reservations: number }>(
					`INSERT INTO creation_rate_limit (singleton, window_start, reservations)
					 VALUES (1, ?, 1)
					 ON CONFLICT(singleton) DO UPDATE SET
					   window_start = excluded.window_start,
					   reservations = CASE
					     WHEN creation_rate_limit.window_start = excluded.window_start
					       THEN creation_rate_limit.reservations + 1
					     ELSE 1
					   END
					 WHERE creation_rate_limit.window_start != excluded.window_start
					    OR creation_rate_limit.reservations < ?
					 RETURNING reservations`,
					windowStart,
					MAX_BLOG_CREATIONS_PER_WINDOW,
				)
				.toArray()[0];

			await this.ctx.storage.setAlarm(now + BLOG_CREATION_LIMITER_IDLE_TTL_MS);
			return reservation === undefined ? 'exhausted' : 'allowed';
		} catch {
			return 'unavailable';
		}
	}

	override async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
