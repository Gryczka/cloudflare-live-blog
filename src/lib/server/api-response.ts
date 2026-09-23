import type { Result } from '../protocol';

export function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}

export async function readJson<T>(request: Request): Promise<Result<T>> {
	const contentType = request.headers.get('Content-Type') ?? '';
	if (!contentType.includes('application/json')) {
		return { ok: false, error: 'Expected a JSON request body.', status: 415 };
	}
	try {
		const parsed = (await request.json()) as T;
		if (parsed === null || typeof parsed !== 'object') {
			return { ok: false, error: 'Expected a JSON object.', status: 400 };
		}
		return { ok: true, value: parsed };
	} catch {
		return { ok: false, error: 'Request body was not valid JSON.', status: 400 };
	}
}
