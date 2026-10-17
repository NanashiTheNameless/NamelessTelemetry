// This software is licensed under NNCL v1.5 see LICENSE.md for more info
// https://github.com/NanashiTheNameless/NamelessTelemetry/blob/main/LICENSE.md
// Dependency-free tests for worker.js using node:test and an in-memory KV mock.
// Run with: node --test test/worker.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

// worker.js has no package.json marking it as ESM, so load it from a data: URL.
// Each load gets a unique URL so every test starts with fresh module state.
const src = await readFile(new URL('../worker.js', import.meta.url), 'utf8')
let loads = 0
async function loadWorker () {
  return (await import('data:text/javascript,' + encodeURIComponent(src + `\n// load ${++loads}`))).default
}

const RealDate = Date

// Freeze "now" for the worker, which reads new Date() and Date.now() at call time
function setClock (iso) {
  const fixed = RealDate.parse(iso)
  globalThis.Date = class extends RealDate {
    constructor (...args) { if (args.length) super(...args); else super(fixed) }
    static now () { return fixed }
  }
}

function restoreClock () {
  globalThis.Date = RealDate
}

// In-memory KV with prefix listing, metadata, and small pages to exercise cursors
async function makeEnv () {
  const worker = await loadWorker()
  const store = new Map()
  const kv = {
    async get (k) { return store.has(k) ? store.get(k).value : null },
    async put (k, value, opts = {}) { store.set(k, { value, metadata: opts.metadata }) },
    async delete (k) { store.delete(k) },
    async list ({ prefix = '', cursor } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
      const start = cursor ? Number(cursor) : 0
      const page = names.slice(start, start + 2)
      const next = start + 2 < names.length ? String(start + 2) : undefined
      return { keys: page.map((name) => ({ name, metadata: store.get(name).metadata })), list_complete: !next, cursor: next }
    }
  }
  const pending = []
  return { worker, store, env: { TELEMETRY: kv }, ctx: { waitUntil: (p) => pending.push(p) }, settle: () => Promise.all(pending.splice(0)) }
}

const hash = (s) => createHash('sha256').update(s).digest('hex')

function census (t, body, headers = {}) {
  const req = new Request('https://t.example/census', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  })
  return t.worker.fetch(req, t.env, t.ctx)
}

async function stats (t, query = '') {
  const res = await t.worker.fetch(new Request('https://t.example/api/stats' + query), t.env, t.ctx)
  return res.json()
}

test('counts each id once per project per UTC day', async (tt) => {
  setClock('2026-10-16T12:00:00Z')
  tt.after(restoreClock)
  const t = await makeEnv()
  for (const id of ['a', 'b', 'a', 'c']) {
    assert.equal((await census(t, { id: hash(id), project: 'My:Proj' })).status, 204)
  }
  assert.deepEqual(t.store.get('counts:2026-10-16:My:Proj'), { value: '3', metadata: { count: 3 } })
  const s = await stats(t)
  assert.deepEqual(s.projects, { 'My:Proj': { '2026-10-16': 3 } })
  assert.deepEqual(s.totals, { '2026-10-16': 3 })
  assert.equal(s.days.length, 7)
})

test('drops invalid pings and rejects bad requests', async (tt) => {
  setClock('2026-10-16T12:00:00Z')
  tt.after(restoreClock)
  const t = await makeEnv()
  assert.equal((await census(t, { id: 'not-a-hash', project: 'P1' })).status, 204)
  assert.equal((await census(t, { id: hash('a'), project: 'ExampleProject' })).status, 204)
  assert.equal((await census(t, { id: hash('a'), project: '   ' })).status, 204)
  assert.equal((await census(t, '{nope')).status, 400)
  assert.equal((await census(t, { id: hash('a'), project: 'P1' }, { 'content-type': 'text/plain' })).status, 415)
  assert.equal([...t.store.keys()].filter((k) => k.startsWith('counts:')).length, 0)
})

test('X-Project-Name header overrides the body project', async (tt) => {
  setClock('2026-10-16T12:00:00Z')
  tt.after(restoreClock)
  const t = await makeEnv()
  await census(t, { id: hash('a'), project: 'FromBody' }, { 'x-project-name': 'FromHeader' })
  assert.ok(t.store.has('counts:2026-10-16:FromHeader'))
  assert.ok(!t.store.has('counts:2026-10-16:FromBody'))
})

test('stats read legacy counts without metadata and respect range and project filters', async (tt) => {
  setClock('2026-10-16T12:00:00Z')
  tt.after(restoreClock)
  const t = await makeEnv()
  t.store.set('counts:2026-10-15:A', { value: '7' }) // legacy, no metadata
  t.store.set('counts:2026-10-14:B', { value: '2', metadata: { count: 2 } })
  t.store.set('counts:2026-09-01:A', { value: '9', metadata: { count: 9 } }) // outside 7d
  let s = await stats(t)
  assert.deepEqual(s.projects, { A: { '2026-10-15': 7 }, B: { '2026-10-14': 2 } })
  s = await stats(t, '?range=90d&project=A')
  assert.deepEqual(s.projects, { A: { '2026-09-01': 9, '2026-10-15': 7 } })
})

test('maintenance waits until 01:00 UTC, then prunes old counts and recounts recent days', async (tt) => {
  tt.after(restoreClock)
  const t = await makeEnv()
  t.store.set('counts:2025-01-01:A', { value: '5' }) // older than a year
  t.store.set('counts:2026-10-15:A', { value: '9', metadata: { count: 9 } }) // wrong: only 2 unique ids
  for (const id of ['x', 'y']) t.store.set(`seen:2026-10-15:A:${hash(id)}`, { value: '1' })

  setClock('2026-10-16T00:30:00Z')
  await stats(t)
  await t.settle()
  assert.ok(t.store.has('counts:2025-01-01:A'), 'should not prune before 01:00 UTC')
  assert.equal(t.store.get('counts:2026-10-15:A').value, '9', 'should not recount before 01:00 UTC')

  setClock('2026-10-16T01:05:00Z')
  await stats(t)
  await t.settle()
  assert.ok(!t.store.has('counts:2025-01-01:A'))
  assert.deepEqual(t.store.get('counts:2026-10-15:A'), { value: '2', metadata: { count: 2 } })
  assert.equal(t.store.get('maintenance:lastCleanupAt').value, '2026-10-16')
})

test('rate limits /census per IP when the limiter binding is present', async (tt) => {
  setClock('2026-10-16T12:00:00Z')
  tt.after(restoreClock)
  const t = await makeEnv()
  const hits = {}
  t.env.CENSUS_RATE_LIMITER = { async limit ({ key }) { hits[key] = (hits[key] || 0) + 1; return { success: hits[key] <= 2 } } }
  const ip = { 'cf-connecting-ip': '203.0.113.7' }
  assert.equal((await census(t, { id: hash('a'), project: 'P' }, ip)).status, 204)
  assert.equal((await census(t, { id: hash('b'), project: 'P' }, ip)).status, 204)
  const limited = await census(t, { id: hash('c'), project: 'P' }, ip)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get('retry-after'), '60')
  assert.equal(t.store.get('counts:2026-10-16:P').value, '2')
  // Other IPs and requests without an IP are unaffected
  assert.equal((await census(t, { id: hash('d'), project: 'P' }, { 'cf-connecting-ip': '198.51.100.1' })).status, 204)
  assert.equal((await census(t, { id: hash('e'), project: 'P' })).status, 204)
})

test('CORS preflight allows the X-Project-Name header', async () => {
  const t = await makeEnv()
  const res = await t.worker.fetch(new Request('https://t.example/census', { method: 'OPTIONS' }), t.env, t.ctx)
  assert.equal(res.status, 204)
  assert.match(res.headers.get('access-control-allow-headers'), /\bx-project-name\b/i)
})

test('maintenance marker is read from KV only once per isolate per day', async (tt) => {
  setClock('2026-10-16T12:00:00Z')
  tt.after(restoreClock)
  const t = await makeEnv()
  let markerReads = 0
  const get = t.env.TELEMETRY.get
  t.env.TELEMETRY.get = async (k) => { if (k === 'maintenance:lastCleanupAt') markerReads++; return get(k) }
  for (let i = 0; i < 3; i++) {
    await census(t, { id: hash(String(i)), project: 'P' })
    await t.settle()
  }
  assert.equal(markerReads, 1)
})

test('dashboard and stats are cached for 2 minutes under a normalized key', async (tt) => {
  setClock('2026-10-16T12:00:00Z')
  const entries = new Map()
  globalThis.caches = {
    default: {
      async match (req) { const r = entries.get(req.url); return r ? r.clone() : undefined },
      async put (req, res) { entries.set(req.url, res) }
    }
  }
  tt.after(() => { delete globalThis.caches; restoreClock() })
  const t = await makeEnv()
  t.store.set('counts:2026-10-15:A', { value: '4', metadata: { count: 4 } })
  let lists = 0
  const list = t.env.TELEMETRY.list
  t.env.TELEMETRY.list = async (o) => { if (o.prefix.startsWith('counts:')) lists++; return list(o) }

  let s = await stats(t, '?range=30d')
  await t.settle()
  const listsAfterFirst = lists
  assert.deepEqual(s.projects, { A: { '2026-10-15': 4 } })
  // Same parameters spelled differently, plus junk, must hit the same cache entry
  s = await stats(t, '?days=30&junk=' + Math.random())
  assert.deepEqual(s.projects, { A: { '2026-10-15': 4 } })
  assert.equal(lists, listsAfterFirst)

  const res = await t.worker.fetch(new Request('https://t.example/?range=30d'), t.env, t.ctx)
  assert.equal(res.headers.get('cache-control'), 'public, max-age=120')
  assert.equal(res.status, 200)
  // Census pings are never cached
  assert.equal((await census(t, { id: hash('a'), project: 'A' })).headers.get('cache-control'), null)
})
