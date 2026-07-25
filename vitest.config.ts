import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			/**
			 * Miniflare options are declared inline rather than read from wrangler.jsonc,
			 * because that file points `main` at src/worker.ts, which imports
			 * `@astrojs/cloudflare/handler` and therefore a virtual module that only
			 * exists inside Astro's build. See test/worker-under-test.ts.
			 */
			main: './test/worker-under-test.ts',
			miniflare: {
				compatibilityDate: '2026-07-01',
				compatibilityFlags: ['nodejs_compat'],
				durableObjects: {
					// `useSQLite` mirrors `new_sqlite_classes` in wrangler.jsonc. Without it
					// the SQL API is unavailable and every storage call fails.
					LIVE_BLOG: { className: 'LiveBlog', useSQLite: true },
				},
			},
		}),
	],
	test: {
		include: ['test/**/*.test.ts'],
	},
});
