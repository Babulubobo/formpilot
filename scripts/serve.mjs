import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, `.${path.endsWith('/') ? `${path}index.html` : path}`);
    // Only serve the two public folders; project files and credentials are never exposed.
    if (!['demo', 'extension'].some(dir => file.startsWith(resolve(root, dir) + sep)) || !types[extname(file)]) {
      res.writeHead(404).end('Not found');
      return;
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end('Not found');
  }
}).listen(4173, '127.0.0.1', () => console.log('Demo: http://127.0.0.1:4173/demo/'));
