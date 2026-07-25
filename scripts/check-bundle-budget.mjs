/**
 * Fails the build if the reader page's JavaScript grows past its budget.
 *
 * The reason this exists: the point of rebuilding this project on Astro was that
 * the previous version shipped ~364KB of uncompressed JavaScript to render a list
 * of text posts. That is exactly the kind of regression that reintroduces itself
 * quietly — someone adds a UI framework component to the reader page, everything
 * still works, and nobody notices until the numbers are embarrassing again.
 *
 * So the budget is enforced in CI rather than written down in a README and trusted.
 *
 * The reader island is the only script the reader page loads. Preact is deliberately
 * excluded from this check because it is only loaded by the author console, which
 * readers never request — if Preact ever appears in a reader chunk, the size check
 * will catch it.
 */

import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Uncompressed budget for the reader island, in bytes. */
const RAW_BUDGET = 32 * 1024;
/** Over-the-wire budget, which is what users actually pay. */
const GZIP_BUDGET = 12 * 1024;

const ASSET_DIR = join('dist', 'client', '_astro');

/** Chunks that only the author console loads, so not part of the reader budget. */
const AUTHOR_ONLY = /^(AuthorConsole|preact\.module|signals\.module|hooks\.module|client)\./;

function main() {
	let entries;
	try {
		entries = readdirSync(ASSET_DIR);
	} catch {
		console.error(`Could not read ${ASSET_DIR}. Run \`astro build\` first.`);
		process.exit(1);
	}

	const readerChunks = entries
		.filter((name) => name.endsWith('.js'))
		.filter((name) => !AUTHOR_ONLY.test(name));

	if (readerChunks.length === 0) {
		console.error('Found no reader chunks. Did the island stop being bundled?');
		process.exit(1);
	}

	let raw = 0;
	let gzip = 0;
	const rows = [];

	for (const name of readerChunks) {
		const path = join(ASSET_DIR, name);
		const contents = readFileSync(path);
		const size = statSync(path).size;
		const compressed = gzipSync(contents).length;

		raw += size;
		gzip += compressed;
		rows.push({ name, size, compressed });
	}

	// A UI framework leaking into the reader path is the specific regression this
	// guards against, and it is worth naming explicitly rather than only showing up
	// as a size number.
	for (const { name } of rows) {
		const source = readFileSync(join(ASSET_DIR, name), 'utf8');
		if (/\bpreact\b/i.test(source) && !/preact\.module/.test(name)) {
			console.error(`FAIL  ${name} appears to bundle Preact into the reader path.`);
			process.exit(1);
		}
	}

	console.log('Reader JavaScript:');
	for (const { name, size, compressed } of rows.sort((a, b) => b.size - a.size)) {
		console.log(`  ${kb(size).padStart(9)} raw  ${kb(compressed).padStart(9)} gzip  ${name}`);
	}
	console.log(`  ${'—'.repeat(40)}`);
	console.log(`  ${kb(raw).padStart(9)} raw  ${kb(gzip).padStart(9)} gzip  total`);
	console.log(`Budget: ${kb(RAW_BUDGET)} raw / ${kb(GZIP_BUDGET)} gzip`);

	let failed = false;
	if (raw > RAW_BUDGET) {
		console.error(`FAIL  raw ${kb(raw)} exceeds ${kb(RAW_BUDGET)}`);
		failed = true;
	}
	if (gzip > GZIP_BUDGET) {
		console.error(`FAIL  gzip ${kb(gzip)} exceeds ${kb(GZIP_BUDGET)}`);
		failed = true;
	}

	if (failed) process.exit(1);
	console.log('PASS  reader payload is within budget.');
}

function kb(bytes) {
	return `${(bytes / 1024).toFixed(1)} KB`;
}

main();
