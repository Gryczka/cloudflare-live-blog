/**
 * Landing-page island: create a live blog and surface the two links.
 *
 * Deliberately tiny and framework-free. The author link is assembled here from
 * the token the API returns, and the token is placed after `#` so that navigating
 * to the author console never transmits it to the server.
 */

interface CreateResponse {
	blogId: string;
	editToken: string;
	readerUrl: string;
	authorUrl: string;
	error?: string;
}

function start(): void {
	const form = document.querySelector<HTMLFormElement>('[data-create-form]');
	if (!form) return;

	const submit = form.querySelector<HTMLButtonElement>('[data-create-submit]');
	const errorEl = form.querySelector<HTMLElement>('[data-create-error]');
	const result = document.querySelector<HTMLElement>('[data-create-result]');
	const readerInput = document.querySelector<HTMLInputElement>('[data-reader-url]');
	const authorInput = document.querySelector<HTMLInputElement>('[data-author-url]');
	const openAuthor = document.querySelector<HTMLAnchorElement>('[data-open-author]');

	form.addEventListener('submit', async (event) => {
		event.preventDefault();
		if (!submit) return;

		const data = new FormData(form);
		const title = String(data.get('title') ?? '').trim();
		const summary = String(data.get('summary') ?? '').trim();

		if (!title) {
			showError(errorEl, 'Give the live blog a title.');
			return;
		}

		submit.disabled = true;
		const originalLabel = submit.textContent;
		submit.textContent = 'Creating…';
		hideError(errorEl);

		try {
			const response = await fetch('/api/blogs', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ title, summary: summary || undefined }),
			});

			const payload = (await response.json()) as CreateResponse;

			if (!response.ok) {
				showError(errorEl, payload.error ?? 'Could not create the live blog.');
				return;
			}

			if (readerInput) readerInput.value = payload.readerUrl;
			if (authorInput) authorInput.value = payload.authorUrl;
			if (openAuthor) openAuthor.href = payload.authorUrl;

			form.hidden = true;
			result?.removeAttribute('hidden');
			result?.scrollIntoView({ behavior: 'smooth', block: 'center' });
		} catch {
			showError(errorEl, 'Network error. Check your connection and try again.');
		} finally {
			submit.disabled = false;
			submit.textContent = originalLabel;
		}
	});

	for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
		button.addEventListener('click', async () => {
			const target = button.dataset.copy === 'author' ? authorInput : readerInput;
			if (!target?.value) return;
			try {
				await navigator.clipboard.writeText(target.value);
			} catch {
				// Clipboard access can be denied; selecting the text is a usable fallback.
				target.select();
				return;
			}
			const original = button.textContent;
			button.textContent = 'Copied';
			window.setTimeout(() => {
				button.textContent = original;
			}, 1500);
		});
	}
}

function showError(element: HTMLElement | null, message: string): void {
	if (!element) return;
	element.textContent = message;
	element.removeAttribute('hidden');
}

function hideError(element: HTMLElement | null): void {
	element?.setAttribute('hidden', '');
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
	start();
}
