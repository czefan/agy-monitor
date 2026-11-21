import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const sidecarDistDir = join(distDir, 'sidecars', 'agy-monitor');
const webDistDir = join(sidecarDistDir, 'web');

const mode = process.argv[2];

if (mode === '--clean') {
  rmSync(distDir, { recursive: true, force: true });
} else if (mode === '--assemble') {
  mkdirSync(webDistDir, { recursive: true });

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  if (!pkg?.version) throw new Error('Missing version in package.json');

  const { name, displayName, version: _v, ...restManifest } = JSON.parse(
    readFileSync(join(root, 'plugin.json'), 'utf-8'),
  );
  const distManifest = {
    ...(name !== undefined ? { name } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    version: pkg.version,
    ...restManifest,
  };
  writeFileSync(join(distDir, 'plugin.json'), JSON.stringify(distManifest, null, 2) + '\n', 'utf-8');

  cpSync(join(root, 'LICENSE'), join(distDir, 'LICENSE'));
  cpSync(join(root, 'assets'), join(distDir, 'assets'), { recursive: true });

  cpSync(join(root, 'src', 'sidecar', 'sidecar.json'), join(sidecarDistDir, 'sidecar.json'));
  writeFileSync(
    join(sidecarDistDir, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + '\n',
    'utf-8',
  );
  cpSync(join(root, 'src', 'web', 'index.html'), join(webDistDir, 'index.html'));
  cpSync(join(root, 'src', 'web', 'styles.css'), join(webDistDir, 'styles.css'));

  const appJsPath = join(webDistDir, 'app.js');
  const appBody = readFileSync(appJsPath, 'utf-8').replace(/\s*export\s*\{\s*\}\s*;?\s*$/, '');
  writeFileSync(appJsPath, `(() => {\n'use strict';\n${appBody}\n})();\n`, 'utf-8');

  const readme = readFileSync(join(root, 'README.md'), 'utf-8')
    .replace(/## 界面预览\r?\n[\s\S]*?---\r?\n\r?\n/, '')
    .replace(/\r?\n---\r?\n\r?\n## 贡献与协议\r?\n[\s\S]*$/, '');
  writeFileSync(join(distDir, 'README.md'), readme, 'utf-8');
} else {
  console.error('Usage: node scripts/build.mjs <--clean|--assemble>');
  process.exit(1);
}
