import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const index = JSON.parse(await readFile(process.argv[2] ?? 'index.json', 'utf8'));
if (index?.format !== 'nerune-marketplace' || index.version !== 1 ||
    !Array.isArray(index.packages) || index.packages.length > 500) {
  throw Error('Invalid Nerune catalog');
}

const ids = new Set();
const releasePath = /^[a-z0-9_.-]+\/[a-z0-9_.-]+\/releases\/download\/[a-z0-9_.-]+\/[a-z0-9_.-]+\.nworker$/i;
const assetHosts = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

async function readPackage(entry) {
  const request = new URL(`https://github.com/${entry.packageUrl}`);
  let response = await fetch(request, { redirect: 'manual', signal: AbortSignal.timeout(12_000) });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const asset = new URL(response.headers.get('location') ?? '', request);
    if (asset.protocol !== 'https:' || !assetHosts.has(asset.hostname) ||
        asset.port || asset.username || asset.password) throw Error('Unexpected release host');
    response = await fetch(asset, { redirect: 'error', signal: AbortSignal.timeout(12_000) });
  }
  if (!response.ok || !response.body) throw Error(`Release download failed (${response.status})`);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Error('Package exceeds 2 MiB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function canonical(value) {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

for (const entry of index.packages) {
  if (typeof entry.packageId !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,127}$/.test(entry.packageId) ||
      entry.packageId.startsWith('nerune.') || ids.has(entry.packageId) ||
      typeof entry.packageUrl !== 'string' || !releasePath.test(entry.packageUrl) ||
      entry.packageUrl.split('/').some(part => ['.', '..', 'latest'].includes(part.toLowerCase())) ||
      !/^\d+\.\d+\.\d+$/.test(entry.version) || !/^[a-f0-9]{64}$/.test(entry.digest) ||
      !Number.isFinite(Date.parse(entry.publishedAt)) || !entry.publisher || !entry.license ||
      entry.license === 'UNLICENSED' || !entry.example?.input || !entry.example?.output) {
    throw Error(`Invalid public submission: ${entry.packageId}`);
  }
  ids.add(entry.packageId);
  const { integrity, ...payload } = await readPackage(entry);
  const manifest = payload.manifest;
  if (payload.format !== 'nerune-worker' || payload.schemaVersion !== 1 ||
      payload.compatibility?.runtime !== 'nerune' ||
      manifest?.packageId !== entry.packageId || manifest.version !== entry.version ||
      manifest.publisher !== entry.publisher || manifest.license !== entry.license ||
      integrity?.algorithm !== 'SHA-256' || integrity.digest !== entry.digest ||
      createHash('sha256').update(canonical(payload)).digest('hex') !== entry.digest) {
    throw Error(`Package manifest or digest mismatch: ${entry.packageId}`);
  }
}
console.log(`${ids.size} community packages verified.`);
