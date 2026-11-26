import { mkdir, readFile, writeFile } from 'node:fs/promises';

const project = new URL('../', import.meta.url);
const read = (file) => readFile(new URL(file, project), 'utf8');
const files = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['public/icon.svg', 'image/svg+xml'],
};
const assets = {};

for (const [url, [file, type]] of Object.entries(files)) {
  assets[url] = { type, body: await read(file) };
}

const [api, worker] = await Promise.all([read('src/api.mjs'), read('src/worker.mjs')]);
await mkdir(new URL('dist/server/', project), { recursive: true });
await writeFile(new URL('dist/server/api.mjs', project), api);
await writeFile(new URL('dist/server/assets.mjs', project), `export default ${JSON.stringify(assets)};\n`);
await writeFile(new URL('dist/server/index.js', project), worker);
