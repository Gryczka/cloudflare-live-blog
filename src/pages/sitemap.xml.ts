import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { directory } from '../lib/server/blog';

export const GET: APIRoute = async () => {
	const origin = 'https://cloudflare-live-blog.dwarven.workers.dev';
	const ids = await directory(env).list();
	const urls = ['/', ...ids.map(id => `/blog/${encodeURIComponent(id)}`)];
	return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(path => `<url><loc>${origin}${path}</loc></url>`).join('')}</urlset>`, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
};
