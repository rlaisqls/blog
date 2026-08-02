import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { glob } from 'node:fs/promises';

let refs = 0;
const broken = [];

for await (const file of glob('dist/**/index.html')) {
	const html = await readFile(file, 'utf8');
	for (const [, src] of html.matchAll(/data-sidebar-src="([^"]+)"/g)) {
		refs++;
		if (!existsSync(decodeURIComponent(`dist${src}index.html`))) broken.push(`${file} -> ${src}`);
	}
}

if (broken.length) {
	console.error(`Broken sidebar fragment refs:\n${broken.slice(0, 10).join('\n')}`);
	process.exit(1);
}
console.log(`✓ ${refs} sidebar fragment refs resolve`);
