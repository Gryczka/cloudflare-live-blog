/**
 * Types the `env` provided to tests by `cloudflare:workers` with this project's
 * bindings, so `env.LIVE_BLOG` is checked rather than `any`.
 */
declare module 'cloudflare:workers' {
	interface ProvidedEnv extends Env {}
}
