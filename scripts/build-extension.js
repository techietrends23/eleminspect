#!/usr/bin/env node
// Builds dist/eleminspect.zip (unpacked install) and dist/eleminspect.crx (signed package).
// The signing key comes from EXTENSION_PEM (CI secret) or EXTENSION_PEM_FILE (local runs). It is never written into the repo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const distDir = path.join(root, 'dist');
const stageRoot = path.join(distDir, 'stage');
const stageDir = path.join(stageRoot, 'eleminspect');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

// Only these files ship in the extension. Tooling, workflows and docs stay out of the package.
const PACKAGE_FILES = [
  'manifest.json',
  'content-script.js',
  'selector-generator.js',
  'element-check-catalog.js',
  'locator-match.js',
  'inspector-controls.js',
  'popup.html',
  'popup.js',
  'devtools.html',
  'devtools.js',
  'devtools-panel.html',
  'devtools-panel.js',
  'styles/panel.css',
];

// Every file the manifest points at must be in the package list.
const referenced = [
  ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
  manifest.action && manifest.action.default_popup,
  manifest.devtools_page,
  manifest.background && manifest.background.service_worker,
].filter(Boolean);
const notPackaged = referenced.filter((file) => !PACKAGE_FILES.includes(file));
if (notPackaged.length) {
  throw new Error(`Manifest references files that are not in PACKAGE_FILES: ${notPackaged.join(', ')}`);
}

function loadSigningKey() {
  if (process.env.EXTENSION_PEM) return process.env.EXTENSION_PEM;
  if (process.env.EXTENSION_PEM_FILE) return fs.readFileSync(process.env.EXTENSION_PEM_FILE, 'utf8');
  throw new Error('No signing key: set EXTENSION_PEM (CI) or EXTENSION_PEM_FILE (local).');
}

// Chrome derives the extension ID from the public key: SHA-256 of the SPKI DER, first 16 bytes, hex digits mapped to a-p.
function extensionIdFromPem(pem) {
  const der = crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' });
  const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((char) => String.fromCharCode('a'.charCodeAt(0) + parseInt(char, 16))).join('');
}

async function main() {
  const keyPem = loadSigningKey();

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  for (const file of PACKAGE_FILES) {
    const source = path.join(root, file);
    if (!fs.existsSync(source)) throw new Error(`Missing file: ${file}`);
    const target = path.join(stageDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  execFileSync('zip', ['-qr', path.join(distDir, 'eleminspect.zip'), 'eleminspect'], { cwd: stageRoot });

  const Crx = require(path.join(root, '.build-tools', 'node_modules', 'crx'));
  const crx = new Crx({ privateKey: Buffer.from(keyPem) });
  await crx.load(stageDir);
  const crxBuffer = await crx.pack();
  fs.writeFileSync(path.join(distDir, 'eleminspect.crx'), crxBuffer);

  const extensionId = extensionIdFromPem(keyPem);
  const commit = process.env.GITHUB_SHA || 'local build';
  const notes = [
    `eleminspect ${manifest.version}`,
    '',
    `Commit: ${commit}`,
    `Extension ID: ${extensionId}`,
    '',
    'Install the .zip: unzip it, open chrome://extensions, turn on Developer mode, then choose Load unpacked and select the unzipped folder.',
    'The .crx is the signed package for distribution.',
  ].join('\n');
  fs.writeFileSync(path.join(distDir, 'RELEASE_NOTES.md'), `${notes}\n`);
  fs.rmSync(stageRoot, { recursive: true, force: true });

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## eleminspect build\n\n${notes}\n`);
  }
  console.log(notes);
  console.log(`Built ${path.relative(root, distDir)}/eleminspect.crx (${crxBuffer.length} bytes)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
