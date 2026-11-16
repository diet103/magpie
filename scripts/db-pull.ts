// Downloads last night's snapshot from R2 to ./data/tracker-latest.db for browsing in a SQLite GUI.
// Uses a read-only R2 token: R2_ACCOUNT_ID, R2_BUCKET, R2_READONLY_ACCESS_KEY_ID, R2_READONLY_SECRET_ACCESS_KEY.
//   npm run db:pull                 latest daily snapshot
//   npm run db:pull -- --out x.db   somewhere else
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { AwsClient } from 'aws4fetch';

const { values } = parseArgs({ options: { out: { type: 'string', default: 'data/tracker-latest.db' }, prefix: { type: 'string', default: 'snapshots/daily/' } } });
const account = process.env.R2_ACCOUNT_ID;
const bucket = process.env.R2_BUCKET;
const accessKeyId = process.env.R2_READONLY_ACCESS_KEY_ID ?? process.env.LITESTREAM_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_READONLY_SECRET_ACCESS_KEY ?? process.env.LITESTREAM_SECRET_ACCESS_KEY;
if (!account || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('Set R2_ACCOUNT_ID, R2_BUCKET, R2_READONLY_ACCESS_KEY_ID and R2_READONLY_SECRET_ACCESS_KEY (in .env is fine).');
  process.exit(2);
}
const base = process.env.R2_ENDPOINT ?? `https://${account}.r2.cloudflarestorage.com`;
const aws = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });

const keys: string[] = [];
let token: string | undefined;
do {
  const q = new URLSearchParams({ 'list-type': '2', prefix: values.prefix! });
  if (token) q.set('continuation-token', token);
  const res = await aws.fetch(`${base}/${bucket}?${q}`);
  if (!res.ok) throw new Error(`Listing ${values.prefix} failed: HTTP ${res.status} ${await res.text()}`);
  const xml = await res.text();
  for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1]);
  token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] : undefined;
} while (token);

const latest = keys.filter((k) => k.endsWith('.db.gz')).sort().at(-1);
if (!latest) {
  console.error(`No snapshots under ${values.prefix} yet.`);
  process.exit(1);
}
const res = await aws.fetch(`${base}/${bucket}/${latest}`);
if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
const db = gunzipSync(new Uint8Array(await res.arrayBuffer()));
mkdirSync(dirname(values.out!), { recursive: true });
writeFileSync(values.out!, db);
console.log(`${latest} -> ${values.out} (${db.byteLength} bytes). Treat it as a read-only copy.`);
