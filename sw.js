// Layerline streaming worker (v2).
// Videos from Google Drive play straight from Drive: the editor's video players
// ask for "drive-stream/<file id>", and this worker fetches only the byte ranges
// they need, using the signed-in user's access token. Fetched pieces are kept in
// memory (1 MB blocks, up to ~200 MB) so split clips and seeks don't re-download.
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files/';
const PREFIX = '/drive-stream/';
const BLOCK = 1024 * 1024;
const OPEN_ENDED_BLOCKS = 1;          // how much to send when a player asks for "everything from here"
const READ_AHEAD = 8;
const MAX_RUN = 2;                    // blocks per Drive request, so a player is never stuck behind a big transfer                 // blocks to fetch ahead of what the player asked for
const MAX_CACHE = 200 * 1024 * 1024;

let token = null;
const metaCache = new Map();          // id -> Promise<{size, type}>
const blocks = new Map();             // `${id}:${n}` -> Uint8Array (Map order = least recently used first)
const inflight = new Map();           // `${id}:${n}` -> Promise
let cacheBytes = 0;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'token') token = e.data.token || null;
  if (e.data && e.data.type === 'clear-cache') { blocks.clear(); cacheBytes = 0; }
  if (e.data && e.data.type === 'forget' && e.data.id) { // the page now has its own full copy of this file
    for (const [k, v] of [...blocks]) if (k.startsWith(e.data.id + ':')) { blocks.delete(k); cacheBytes -= v.length; }
  }
  if (e.data && e.data.type === 'claim') e.waitUntil(self.clients.claim()); // take over pages opened with a hard reload
});

async function askToken(clientId, refresh) {
  const list = [];
  if (clientId) { const c = await self.clients.get(clientId); if (c) list.push(c); }
  if (!list.length) list.push(...await self.clients.matchAll({ type: 'window' }));
  for (const c of list) {
    const t = await new Promise(res => {
      const ch = new MessageChannel();
      const to = setTimeout(() => res(null), 20000);
      ch.port1.onmessage = ev => { clearTimeout(to); res(ev.data && ev.data.token); };
      c.postMessage({ type: 'need-token', refresh: !!refresh }, [ch.port2]);
    });
    if (t) { token = t; return t; }
  }
  return null;
}

// fetch from Drive with the token, refreshing it once on 401
async function driveFetch(url, headers, clientId) {
  let t = token || await askToken(clientId, false);
  if (!t) { const e = new Error('signed out'); e.status = 401; throw e; }
  let r = await fetch(url, { headers: Object.assign({ Authorization: 'Bearer ' + t }, headers || {}), cache: 'no-store' });
  if (r.status === 401) {
    t = await askToken(clientId, true);
    if (t) r = await fetch(url, { headers: Object.assign({ Authorization: 'Bearer ' + t }, headers || {}), cache: 'no-store' });
  }
  if (!r.ok) { const e = new Error('drive ' + r.status); e.status = r.status; throw e; }
  return r;
}

function getMeta(id, clientId) {
  if (!metaCache.has(id)) {
    const p = driveFetch(`${DRIVE_FILES}${encodeURIComponent(id)}?fields=size,mimeType&supportsAllDrives=true`, null, clientId)
      .then(r => r.json())
      .then(j => {
        let type = j.mimeType || 'application/octet-stream';
        if (type === 'video/quicktime') type = 'video/mp4'; // lets every browser try .mov files
        return { size: Number(j.size), type };
      });
    p.catch(() => metaCache.delete(id));
    metaCache.set(id, p);
  }
  return metaCache.get(id);
}

function remember(key, data) {
  if (blocks.has(key)) return;
  blocks.set(key, data); cacheBytes += data.length;
  for (const [k, v] of blocks) { if (cacheBytes <= MAX_CACHE) break; blocks.delete(k); cacheBytes -= v.length; }
}
function recall(key) {
  const v = blocks.get(key);
  if (v) { blocks.delete(key); blocks.set(key, v); }
  return v;
}

// make sure blocks first..last of a file are in memory, fetching missing runs in one request each
async function loadBlocks(id, first, last, size, clientId) {
  const waits = [];
  let n = first;
  while (n <= last) {
    const key = `${id}:${n}`;
    if (blocks.has(key)) { n++; continue; }
    if (inflight.has(key)) { waits.push(inflight.get(key)); n++; continue; }
    let end = n;
    while (end + 1 <= last && end + 1 - n < MAX_RUN && !blocks.has(`${id}:${end + 1}`) && !inflight.has(`${id}:${end + 1}`)) end++;
    const lo = n, hi = end; // fixed copies: n moves on before this request finishes
    const from = lo * BLOCK, to = Math.min(size - 1, (hi + 1) * BLOCK - 1);
    const run = (async () => {
      const r = await driveFetch(`${DRIVE_FILES}${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { Range: `bytes=${from}-${to}` }, clientId);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (r.status === 200 && buf.length === size) {
        // server ignored the range and sent the whole file: keep only what we asked for
        for (let b = lo; b <= hi; b++) remember(`${id}:${b}`, buf.slice(b * BLOCK, Math.min(size, (b + 1) * BLOCK)));
      } else {
        for (let b = lo; b <= hi; b++) remember(`${id}:${b}`, buf.slice((b - lo) * BLOCK, Math.min(buf.length, (b - lo + 1) * BLOCK)));
      }
    })();
    for (let b = lo; b <= hi; b++) inflight.set(`${id}:${b}`, run);
    run.finally(() => { for (let b = lo; b <= hi; b++) inflight.delete(`${id}:${b}`); }).catch(() => {});
    waits.push(run);
    n = end + 1;
  }
  await Promise.all(waits);
}

async function stream(id, req, clientId) {
  let meta;
  try { meta = await getMeta(id, clientId); }
  catch (e) { return new Response(e.status === 401 ? 'Sign in to Google to play this clip.' : 'Couldn’t reach Google Drive.', { status: e.status === 401 ? 401 : 502 }); }
  const { size, type } = meta;
  if (!size) return new Response('', { status: 204 });
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') || '');
  let start = 0, end;
  if (m && m[1] === '' && m[2]) { start = Math.max(0, size - Number(m[2])); end = size - 1; }      // "bytes=-N": last N bytes
  else {
    start = m && m[1] ? Number(m[1]) : 0;
    end = m && m[2] ? Math.min(Number(m[2]), size - 1) : Math.min(size - 1, (Math.floor(start / BLOCK) + OPEN_ENDED_BLOCKS) * BLOCK - 1);
  }
  if (start >= size) return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  const first = Math.floor(start / BLOCK), last = Math.floor(end / BLOCK);
  try { await loadBlocks(id, first, last, size, clientId); }
  catch (e) { return new Response(e.status === 401 ? 'Sign in to Google to play this clip.' : 'Couldn’t reach Google Drive.', { status: e.status === 401 ? 401 : 502 }); }
  const out = new Uint8Array(end - start + 1);
  let w = 0;
  for (let b = first; b <= last; b++) {
    const data = recall(`${id}:${b}`);
    if (!data) return new Response('Couldn’t reach Google Drive.', { status: 502 });
    const s = b === first ? start - b * BLOCK : 0;
    const e = b === last ? end - b * BLOCK + 1 : data.length;
    out.set(data.subarray(s, e), w); w += e - s;
  }
  // read ahead so playback doesn't wait on Drive for the next piece
  const lastBlock = Math.floor((size - 1) / BLOCK);
  if (last < lastBlock) loadBlocks(id, last + 1, Math.min(lastBlock, last + READ_AHEAD), size, clientId).catch(() => {});
  return new Response(out, {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': String(out.length), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const i = url.pathname.indexOf(PREFIX);
  if (i < 0) return;
  const id = decodeURIComponent(url.pathname.slice(i + PREFIX.length));
  if (!id) return;
  e.respondWith(stream(id, e.request, e.clientId));
});
