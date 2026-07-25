// @ts-check
import { defineConfig, sessionDrivers } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import preact from '@astrojs/preact';

export default defineConfig({
	/**
	 * Every route is rendered on demand. The reader page needs the current feed in
	 * its first HTML byte (see src/pages/blog/[blogId]/index.astro), so there is
	 * nothing meaningful to prerender.
	 */
	output: 'server',

	adapter: cloudflare({
		/**
		 * No remote image transformation. This project renders text, and the only
		 * image is a static SVG favicon, so there is no reason to configure an
		 * `IMAGES` binding the app would never call.
		 */
		imageService: 'passthrough',
	}),

	/**
	 * Preact powers the author console only. Readers never request that route, so
	 * the ~4KB runtime is not on the critical path for the audience that matters.
	 * The reader's live feed is plain TypeScript (src/islands/live-feed.ts).
	 */
	integrations: [preact({ compat: false })],

	devToolbar: { enabled: false },

	/**
	 * No sessions.
	 *
	 * Left unset, the Cloudflare adapter defaults to a KV-backed session store and
	 * auto-provisions a `SESSION` KV namespace on deploy. Nothing here calls
	 * `Astro.session` — authorization is a capability token verified inside the
	 * Durable Object — so that namespace would be an unused resource that anyone
	 * deploying this repo inherits and pays attention to for no reason.
	 *
	 * The `null` driver discards everything, which is the honest description of what
	 * this app does with sessions.
	 *
	 * The `@ts-expect-error` is a genuine gap in Astro's published types, not a
	 * mistake here: `sessionDrivers.null()` exists at runtime and resolves to
	 * `unstorage/drivers/null` (which ships with unstorage), but the typed driver
	 * map in astro/dist/core/session/drivers.d.ts omits both `null` and `memory`.
	 * If a future Astro release adds them, this comment starts failing the build and
	 * can simply be deleted.
	 */
	session: {
		// @ts-expect-error - `null` is a real runtime driver missing from Astro's types.
		driver: sessionDrivers.null(),
	},

	/**
	 * Shiki emits inline `style` attributes, which cannot be expressed as a CSP
	 * hash and would force `style-src-attr 'unsafe-inline'`. Nothing here renders
	 * `.md` files — post bodies go through src/lib/markdown.ts — so highlighting is
	 * simply turned off rather than weakening the policy for a feature we do not use.
	 */
	markdown: {
		syntaxHighlight: false,
	},

	/**
	 * Content Security Policy.
	 *
	 * Astro emits a `<meta http-equiv="content-security-policy">` element carrying
	 * per-build SHA-256 hashes for every script and style it bundles, including
	 * client islands. That means `script-src` needs neither `'unsafe-inline'` nor
	 * `'unsafe-eval'` — both of which the previous iteration of this project
	 * shipped to production because its dev server required them.
	 *
	 * The remaining directives are declared here so the whole policy lives in one
	 * place. The Worker deliberately does not set a competing CSP header; see the
	 * note in src/worker.ts.
	 *
	 * CSP is not active under `astro dev` (Vite injects unhashed scripts). Verify
	 * it with `npm run preview`.
	 */
	security: {
		csp: {
			directives: [
				"default-src 'self'",
				"img-src 'self' data:",
				"font-src 'self'",
				// Same-origin WebSockets. Per CSP3 `'self'` covers ws/wss on this host.
				"connect-src 'self'",
				"frame-ancestors 'none'",
				"base-uri 'self'",
				"form-action 'self'",
				"object-src 'none'",
			],
		},
	},

	vite: {
		build: {
			// Unminified Worker stack traces are worth more than the bytes here;
			// the Worker script is small and is not shipped to browsers.
			minify: false,
		},
	},
});
