/**
 * Test harness entrypoint.
 *
 * The real entrypoint, src/worker.ts, imports `@astrojs/cloudflare/handler`, which
 * in turn imports a virtual module (`virtual:astro-cloudflare:config`) that only
 * exists inside Astro's build pipeline. Pointing the test runner at it would fail
 * to resolve.
 *
 * That is not a limitation worth fighting, because the interesting logic is
 * deliberately framework-independent: the Durable Object knows nothing about Astro,
 * and neither do the library modules. This harness exports the Durable Object so
 * `runInDurableObject` and RPC can reach it directly.
 */

export { LiveBlog } from '../src/durable-objects/LiveBlog';

export default {
	async fetch(): Promise<Response> {
		return new Response('test harness');
	},
} satisfies ExportedHandler;
