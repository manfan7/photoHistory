import { cpSync, mkdirSync, readdirSync } from 'fs';

mkdirSync('public/wasm', { recursive: true });
for (const f of readdirSync('wasm/pkg')) {
  if (/\.(js|wasm|d\.ts)$/.test(f)) {
    cpSync(`wasm/pkg/${f}`, `public/wasm/${f}`);
    console.log('copied', f);
  }
}
