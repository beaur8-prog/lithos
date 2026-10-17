"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EditorState, ChangeSet } = require("@codemirror/state");
const { collab, sendableUpdates, receiveUpdates, getSyncedVersion } = require("@codemirror/collab");
const { Vault } = require("../electron/vault.cjs");
const { ShareServer } = require("../electron/share-server.cjs");

async function fixture(t, raw = "---\nsecret: hidden-property\n---\nHello world\n") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lithos-collab-test-"));
  await fs.mkdir(path.join(root, "vault"));
  const vault = await new Vault(path.join(root, "vault"), { watch: false }).init();
  await vault.createFile("Together.md", raw);
  await vault.createFile("Private.md", "PRIVATE CONTENT");
  const server = await new ShareServer({ directory: path.join(root, "shares"), webRoot: path.join(__dirname, "../dist-share"),
    getVault: () => vault, tunnel: { origin: "https://test.example", async start() {}, stop() {} } }).init();
  const share = (await server.create(vault, "Together.md")).shares[0];
  await server.collaboration.configure(vault, share.token, true, "0427");
  const base = `http://127.0.0.1:${server.port}/s/${share.token}`;
  const request = async (action, body, session, extra = {}) => {
    const response = await fetch(`${base}/edit/${action}`, { method: "POST", headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.session}` } : {}), ...extra }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const auth = async (name) => {
    const response = await request("auth", { pin: "0427", name });
    assert.equal(response.status, 200, response.data.error);
    return response.data;
  };
  t.after(async () => { await server.close(); vault.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, vault, server, share, base, request, auth };
}
const client = (auth) => EditorState.create({ doc: auth.content, extensions: [collab({ startVersion: auth.version, clientID: auth.clientID })] });
const wire = (state, auth) => ({ epoch: auth.epoch, version: getSyncedVersion(state), updates: sendableUpdates(state).map((u) => ({ changes: u.changes.toJSON() })) });
const receive = (state, result) => state.update(receiveUpdates(state, result.updates.map((u) => ({ ...u, changes: ChangeSet.fromJSON(u.changes) })))).state;

test("two editors merge concurrent insertions, deletions, and retries without losing either person's input", async (t) => {
  const { auth, request, vault, base, server, share } = await fixture(t);
  const a = await auth("Alice"), b = await auth("민수");
  let ca = client(a), cb = client(b);
  ca = ca.update({ changes: { from: 6, insert: "Alice " } }).state;
  cb = cb.update({ changes: [{ from: 6, insert: "민수 " }, { from: 10, to: 11 }] }).state;
  const wa = wire(ca, a), wb = wire(cb, b);
  const first = await request("updates", wa, a);
  assert.equal(first.status, 200);
  const second = await request("updates", wb, b);
  assert.equal(second.status, 200);
  cb = receive(cb, second.data);
  const retry = await request("updates", wa, a);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.version, second.data.version, "retry must not append Alice twice");
  ca = receive(ca, retry.data);
  assert.equal(ca.doc.toString(), cb.doc.toString());
  assert.match(ca.doc.toString(), /Alice /);
  assert.match(ca.doc.toString(), /민수 /);
  assert.equal(sendableUpdates(ca).length, 0);
  assert.equal(sendableUpdates(cb).length, 0);
  assert.equal(await vault.readFile("Together.md"), "---\nsecret: hidden-property\n---\n" + ca.doc.toString());
  const publicData = await (await fetch(base + "/data")).json();
  assert.equal(publicData.content, ca.doc.toString());
  assert.equal(publicData.editingEnabled, true);
  assert.equal(JSON.stringify(publicData).includes("hidden-property"), false);
  assert.equal(JSON.stringify(publicData).includes("pinHash"), false);
  assert.equal(JSON.stringify(server.state()).includes("pinHash"), false);
  assert.deepEqual(second.data.participants.map((p) => p.name), ["Alice", "민수"]);
  assert.deepEqual(server.collaboration.lockedPaths(vault.id), ["Together.md"]);
  const backup = await fs.readdir(path.join(server.directory, "edit-backups"));
  assert.equal(backup.length, 1);
  assert.match(await fs.readFile(path.join(server.directory, "edit-backups", backup[0]), "utf8"), /hidden-property/);
  await assert.rejects(server.update(vault, share.token), /공동 편집을 끈/);
});

test("authentication enforces four digits, throttles guesses, checks origin and bearer session, and invalidates changed PINs", async (t) => {
  const { auth, request, server, vault, share } = await fixture(t);
  await assert.rejects(server.collaboration.configure(vault, share.token, true, "123"), /숫자 4자리/);
  for (let i = 0; i < 5; i++) assert.equal((await request("auth", { pin: "9999" })).status, 401);
  assert.equal((await request("auth", { pin: "0427" })).status, 429);
  server.collaboration.attempts.get(share.token).until = Date.now() - 1;
  const a = await auth("One");
  const body = wire(client(a), a);
  assert.equal((await request("updates", body)).status, 401);
  assert.equal((await request("updates", body, a, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await request("updates", body, a)).status, 400, "empty batches are invalid");
  await server.collaboration.configure(vault, share.token, true, "9876");
  assert.equal((await request("updates", body, a)).status, 401);
  assert.equal((await request("auth", { pin: "0427" })).status, 401);
  assert.equal((await request("auth", { pin: "9876" })).status, 200);
  await server.collaboration.configure(vault, share.token, false);
  assert.equal((await request("auth", { pin: "9876" })).status, 403);
  assert.deepEqual(server.collaboration.lockedPaths(vault.id), []);
});

test("remote links do not expose unapproved local files and disk changes pause stale edits", async (t) => {
  const { auth, request, server, vault, share, base } = await fixture(t);
  const a = await auth("Remote");
  let state = client(a).update({ changes: { from: 0, insert: "[Get private](/Private.md?download=1)\n![[Private.md]]\n" } }).state;
  const update = await request("updates", wire(state, a), a);
  assert.equal(update.status, 200);
  state = receive(state, update.data);
  assert.deepEqual((await (await fetch(base + "/data")).json()).downloads, {});
  await vault.writeFile("Together.md", "Changed by another application");
  state = state.update({ changes: { from: 0, insert: "Must not overwrite" } }).state;
  assert.equal((await request("updates", wire(state, a), a)).status, 409);
  assert.equal(await vault.readFile("Together.md"), "Changed by another application");
  server.collaboration.rooms.clear();
  assert.equal((await request("auth", { pin: "0427" })).status, 409);
  await server.collaboration.configure(vault, share.token, true, "0427");
  assert.equal((await auth("Reset")).content, "Changed by another application");
});

test("expiry, revocation, oversized/invalid changes and stale versions never modify the original", async (t) => {
  const { auth, request, vault, server, share } = await fixture(t);
  const a = await auth("One");
  const original = await vault.readFile("Together.md");
  assert.equal((await request("updates", { epoch: a.epoch, version: 900, updates: [] }, a)).status, 409);
  assert.equal((await request("updates", { epoch: a.epoch, version: 0, updates: [{ changes: ["broken"] }] }, a)).status, 400);
  const state = client(a).update({ changes: { from: 0, insert: "X".repeat(1024 * 1024) } }).state;
  assert.equal((await request("updates", wire(state, a), a)).status, 413);
  assert.equal(await vault.readFile("Together.md"), original);
  const record = server.records.get(share.token);
  record.expiresAt = Date.now() - 1;
  assert.equal((await request("auth", { pin: "0427" })).status, 404);
  record.expiresAt = null;
  await server.revoke(share.token);
  assert.equal((await request("updates", wire(state, a), a)).status, 404);
  assert.equal(server.collaboration.sessions.size, 0);
});

test("sessions reset after server restart while saved content and PIN remain available", async (t) => {
  const { auth, request, server, share, vault } = await fixture(t, "First\n");
  const a = await auth("Before restart");
  const state = client(a).update({ changes: { from: 6, insert: "Persisted\n" } }).state;
  assert.equal((await request("updates", wire(state, a), a)).status, 200);
  const restarted = await new ShareServer({ directory: server.directory, webRoot: server.webRoot,
    tunnel: { origin: "https://test.example", async start() {}, stop() {} } }).init();
  t.after(() => restarted.close());
  await restarted.listen();
  const response = await fetch(`http://127.0.0.1:${restarted.port}/s/${share.token}/edit/auth`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin: "0427" }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.content, "First\nPersisted\n");
  assert.notEqual(result.epoch, a.epoch);
  assert.equal(await vault.readFile("Together.md"), result.content);
});

test("failed share persistence rolls the source back and permits an idempotent retry", async (t) => {
  const { auth, request, server, vault } = await fixture(t);
  const a = await auth("Save failure");
  const state = client(a).update({ changes: { from: 0, insert: "New " } }).state;
  const original = await vault.readFile("Together.md");
  const persist = server.persist.bind(server);
  server.persist = async () => { throw new Error("Disk full"); };
  assert.equal((await request("updates", wire(state, a), a)).status, 503);
  assert.equal(await vault.readFile("Together.md"), original);
  server.persist = persist;
  assert.equal((await request("updates", wire(state, a), a)).status, 200);
  assert.match(await vault.readFile("Together.md"), /New Hello/);
});

test("three editors converge when local typing continues while an older batch is in flight", async (t) => {
  const { auth, request, base, vault } = await fixture(t, "Plan\n");
  const people = await Promise.all([auth("A"), auth("B"), auth("C")]);
  const states = people.map(client);
  const initialBatches = states.map((s, i) => {
    states[i] = s.update({ changes: { from: 5, insert: `[${i}]` } }).state;
    return wire(states[i], people[i]);
  });
  // Every browser keeps typing before its first send has been acknowledged.
  for (let i = 0; i < states.length; i++)
    states[i] = states[i].update({ changes: { from: states[i].doc.length, insert: `한글${i}🙂\n` } }).state;
  for (const i of [2, 0, 1]) {
    const response = await request("updates", initialBatches[i], people[i]);
    assert.equal(response.status, 200);
    states[i] = receive(states[i], response.data);
  }
  for (const i of [1, 0, 2]) {
    const response = await request("updates", wire(states[i], people[i]), people[i]);
    assert.equal(response.status, 200);
    states[i] = receive(states[i], response.data);
  }
  for (let i = 0; i < states.length; i++) {
    const response = await fetch(`${base}/edit/updates?version=${getSyncedVersion(states[i])}&epoch=${people[i].epoch}`, { headers: { Authorization: `Bearer ${people[i].session}` } });
    assert.equal(response.status, 200);
    states[i] = receive(states[i], await response.json());
  }
  for (const state of states) {
    assert.equal(state.doc.toString(), states[0].doc.toString());
    assert.equal(sendableUpdates(state).length, 0);
    for (let i = 0; i < 3; i++) assert.ok(state.doc.toString().includes(`한글${i}🙂`));
  }
  assert.equal(await vault.readFile("Together.md"), states[0].doc.toString());
});
