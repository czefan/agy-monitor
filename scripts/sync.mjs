import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const targetDir = join(homedir(), '.gemini', 'config', 'plugins', 'agy-monitor');

if (!existsSync(join(distDir, 'plugin.json'))) {
  console.error('dist/ not found. Run `pnpm build` first.');
  process.exit(1);
}

function syncDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  const srcEntries = readdirSync(src, { withFileTypes: true });
  const srcNames = new Set(srcEntries.map((e) => e.name));

  for (const entry of readdirSync(dst, { withFileTypes: true })) {
    if (!srcNames.has(entry.name)) {
      try {
        rmSync(join(dst, entry.name), { recursive: true, force: true });
      } catch (err) {
        if (err?.code !== 'EPERM' && err?.code !== 'EBUSY') throw err;
      }
    }
  }

  for (const entry of srcEntries) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      syncDir(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

syncDir(distDir, targetDir);
console.log(`Synced to ${targetDir}`);
