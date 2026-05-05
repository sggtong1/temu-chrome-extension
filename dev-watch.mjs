// File watcher for Chrome extension development.
// On any source file change, writes a timestamp to a watched file so the
// extension's background service worker can detect it and call chrome.runtime.reload().
//
// Usage:
//   node dev-watch.mjs
//
// In Chrome DevTools (background service worker console):
//   The extension auto-reloads when files change.

import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELOAD_FILE = path.join(__dirname, 'dev-reload.json');

const watcher = chokidar.watch([
  'manifest.json',
  'background/**/*.js',
  'content/**/*.js',
  'options/**/*.{js,html,css}',
], {
  ignored: /node_modules/,
  persistent: true,
  ignoreInitial: true,
});

function triggerReload(filePath) {
  const ts = Date.now();
  fs.writeFileSync(RELOAD_FILE, JSON.stringify({ ts, file: filePath }));
  console.log(`[${new Date().toLocaleTimeString()}] changed: ${filePath} → reload signal sent`);
}

watcher.on('change', triggerReload);
watcher.on('add', triggerReload);

console.log('👀 Watching for changes... (Ctrl+C to stop)');
console.log('Make sure dev-reload.json is listed in web_accessible_resources in manifest.json');
