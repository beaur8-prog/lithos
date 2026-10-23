"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { Vault } = require("../electron/vault.cjs");
const { ShareServer } = require("../electron/share-server.cjs");
const { snapshot } = require("../electron/share-snapshot.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lithos-share-test-"));
  const vault = await new Vault(path.join(root, "vault"), { watch: false })
    .init()
    .catch(async () => {
      await fs.mkdir(path.join(root, "vault"));
      return new Vault(path.join(root, "vault"), { watch: false }).init();
    });
  const directory = path.join(root, "private-shares");
  const webRoot = path.join(root, "web");
  await fs.mkdir(path.join(webRoot, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(webRoot, "share.html"),
    '<!doctype html><html><head><title>Lithos · 공유 노트</title></head><body><script src="/static/assets/reader.js"></script></body></html>',
  );
  await fs.writeFile(
    path.join(webRoot, "assets", "reader.js"),
    "console.log('reader')",
  );
  const tunnel = {
    origin: "https://test.example",
    error: "",
    async start() {},
    stop() {},
  };
  const server = await new ShareServer({ directory, webRoot, tunnel }).init();
  await vault.createFile("Example.md", "# Hello\n\nA shared paragraph.");
  t.after(async () => {
    await server.close();
    vault.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, vault, server, directory, webRoot, tunnel };
}

test("link previews receive the note title in the first HTML response without executing JavaScript", async (t) => {
  const { vault, server } = await fixture(t);
  const title = '회의 & "결정" <다음 단계> \'검토\' 😀 $&';
  await vault.createFile(title + ".md", "---\nprivate: do-not-preview\n---\n# Note body");
  const share = (await server.create(vault, title + ".md", 7)).shares[0];
  const url = `http://127.0.0.1:${server.port}/s/${share.token}`;
  const response = await fetch(url);
  const html = await response.text();
  const escaped = '회의 &amp; &quot;결정&quot; &lt;다음 단계&gt; &#39;검토&#39; 😀 $&amp;';
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.ok(html.includes(`<title>${escaped} · Lithos</title>`));
  assert.ok(html.includes(`<meta property="og:title" content="${escaped}"`));
  assert.ok(html.includes(`<meta name="twitter:title" content="${escaped}"`));
  assert.match(html, /<script src="\/static\/assets\/reader.js"><\/script>/);
  assert.doesNotMatch(html, /<다음 단계>|do-not-preview|Note body/);
  assert.equal((html.match(/<title>/g) || []).length, 1);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  const head = await fetch(url, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await (await fetch(url + "/data")).json()).title, title);
});

test("each share serves its own current title and withdrawn links reveal no preview metadata", async (t) => {
  const { vault, server } = await fixture(t);
  const first = (await server.create(vault, "Example.md", 0)).shares[0];
  await vault.createFile("두 번째 노트.md", "Second body");
  const second = (await server.create(vault, "두 번째 노트.md", 7)).shares.find((s) => s.token !== first.token);
  const url = (share) => `http://127.0.0.1:${server.port}/s/${share.token}`;
  assert.match(await (await fetch(url(first))).text(), /<title>Example · Lithos<\/title>/);
  const secondHtml = await (await fetch(url(second) + "/")).text();
  assert.match(secondHtml, /<title>두 번째 노트 · Lithos<\/title>/);
  assert.doesNotMatch(secondHtml, /Example/);
  // Title metadata follows the saved share record without a new URL or HTML build.
  await server.persist({ ...server.records.get(first.token), title: "갱신된 제목" });
  assert.match(await (await fetch(url(first))).text(), /<title>갱신된 제목 · Lithos<\/title>/);
  assert.equal(server.state().shares.find((s) => s.token === first.token).url, first.url);
  server.records.get(second.token).expiresAt = Date.now() - 1;
  await server.revoke(first.token);
  for (const share of [first, second]) {
    const response = await fetch(url(share));
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /og:title|Example|두 번째 노트|갱신된 제목/);
  }
});

test("shares only the selected snapshot, strips frontmatter, and protects all private routes", async (t) => {
  const { vault, server } = await fixture(t);
  await vault.writeFile(
    "Example.md",
    "---\npassword: do-not-share\n---\n# Visible\n[[Secret]]",
  );
  await vault.createFile("Secret.md", "PRIVATE NOTE CONTENT");
  const state = await server.create(vault, "Example.md", 30);
  const share = state.shares[0];
  assert.match(share.token, /^[a-f0-9]{48}$/);
  const base = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${base}/s/${share.token}/data`);
  const body = await response.json();
  assert.equal(body.content, "# Visible\n[[Secret]]");
  assert.deepEqual(Object.keys(body).sort(), [
    "content",
    "downloads",
    "editingEnabled",
    "expiresAt",
    "images",
    "title",
    "updatedAt",
  ]);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  for (const suffix of [
    "/",
    "/Example.md",
    "/vault/Secret.md",
    `/s/${"0".repeat(48)}`,
    `/s/${share.token}/asset/${"0".repeat(32)}`,
    "/static/assets/../../private-shares/anything.json",
  ]) {
    assert.equal((await fetch(base + suffix)).status, 404, suffix);
  }
  assert.equal(
    (
      await fetch(`${base}/s/${share.token}`, {
        method: "POST",
        body: "overwrite",
      })
    ).status,
    405,
  );
  assert.equal(
    (await fetch(`${base}/s/${share.token}`, { method: "HEAD" })).status,
    200,
  );
  assert.match(
    await (await fetch(`${base}/static/assets/reader.js`)).text(),
    /reader/,
  );
  assert.equal(
    await vault.readFile("Example.md"),
    "---\npassword: do-not-share\n---\n# Visible\n[[Secret]]",
  );
});

test("downloads selected attachments byte-for-byte with Unicode filenames and safe headers", async (t) => {
  const { vault, server } = await fixture(t);
  await vault.createFolder("자료");
  const filename = "보고서 #1 (최종).pdf";
  const bytes = Buffer.from("%PDF-1.7\n한글 첨부\x00\xff\n");
  await fs.writeFile(path.join(vault.root, "자료", filename), bytes);
  const url = `자료/${encodeURIComponent(filename)}`;
  await vault.writeFile("Example.md", `[보고서](${url})\n\n[참조][doc]\n\n[doc]: ${url}\n\n[[자료/${encodeURIComponent(filename)}|위키 파일]]`);
  const share = (await server.create(vault, "Example.md", 7, true)).shares[0];
  assert.equal(share.downloadCount, 1);
  const base = `http://127.0.0.1:${server.port}/s/${share.token}`;
  const data = await (await fetch(base + "/data")).json();
  const file = data.downloads[url];
  assert.equal(file.name, filename);
  assert.equal(file.size, bytes.length);
  assert.equal(Object.keys(data.downloads).length, 2);
  const downloadUrl = `${base}/download/${file.id}`;
  const response = await fetch(downloadUrl);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.match(response.headers.get("content-disposition"), /filename\*=UTF-8''/);
  assert.equal(decodeURIComponent(response.headers.get("content-disposition").split("UTF-8''")[1]), filename);
  assert.match(response.headers.get("content-security-policy"), /sandbox/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  const head = await fetch(downloadUrl, { method: "HEAD" });
  assert.equal(Number(head.headers.get("content-length")), bytes.length);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const partial = await fetch(downloadUrl, { headers: { Range: "bytes=2-7" } });
  assert.equal(partial.status, 206);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), bytes.subarray(2, 8));
  const suffix = await fetch(downloadUrl, { headers: { Range: "bytes=-4" } });
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-4));
  for (const range of ["bytes=999-", "bytes=3-1", "bytes=-0", "bytes=0-1,3-4", "bytes=-"])
    assert.equal((await fetch(downloadUrl, { headers: { Range: range } })).status, 416);
});

test("file sharing is opt-in and never recursively publishes notes, code references, hidden files or escaped paths", async (t) => {
  const { root, vault, server } = await fixture(t);
  await vault.createFile("Private.md", "---\nsecret: original metadata\n---\nPRIVATE NOTE");
  await vault.createFile("File.txt", "ONLY THIS FILE");
  await vault.createFile("Code.txt", "NOT IN CODE");
  await fs.writeFile(path.join(root, "outside.txt"), "OUTSIDE");
  await fs.writeFile(path.join(vault.root, ".hidden.txt"), "HIDDEN");
  await fs.symlink(path.join(root, "outside.txt"), path.join(vault.root, "escape.txt"));
  await vault.writeFile("Example.md", '[file](File.txt)\n\n![[File.txt]]\n\n[[Private]] [private](Private.md)\n\n`[code](Code.txt)`\n\n```mermaid\nA["[code](Code.txt)"]\n```\n\n[hidden](.hidden.txt) [escape](../outside.txt) [link](escape.txt) [url](file:///etc/passwd) [encoded](%2e%2e/outside.txt)');
  const original = (await server.create(vault, "Example.md", 7)).shares[0];
  assert.equal(original.downloadCount, 0);
  const share = (await server.update(vault, original.token, true)).shares[0];
  assert.equal(share.downloadCount, 1);
  assert.equal(server.records.get(share.token).warnings.length, 4);
  const record = server.records.get(share.token);
  assert.equal(Object.keys(record.downloads).length, 2);
  assert.deepEqual(await fs.readdir(path.join(server.directory, "downloads", record.downloadSet)), [Object.values(record.downloads)[0].id]);
  assert.ok(!JSON.stringify(record.downloads).includes("Private"));
  await vault.writeFile("Example.md", '[explicit note download](Private.md?download=1)');
  await server.update(vault, share.token, true);
  const current = server.records.get(share.token);
  const file = Object.values(current.downloads)[0];
  const response = await fetch(`http://127.0.0.1:${server.port}/s/${share.token}/download/${file.id}`);
  assert.match(await response.text(), /secret: original metadata/);
});

test("download snapshots survive source deletion and restart, update explicitly, and stop with the share", async (t) => {
  const { vault, server, directory, webRoot, tunnel } = await fixture(t);
  await vault.createFile("Download.txt", "first version");
  await vault.writeFile("Example.md", "[받기](Download.txt)");
  const share = (await server.create(vault, "Example.md", 30, true)).shares[0];
  const oldSet = server.records.get(share.token).downloadSet;
  const file = server.records.get(share.token).downloads["Download.txt"];
  const url = `http://127.0.0.1:${server.port}/s/${share.token}/download/${file.id}`;
  await vault.writeFile("Download.txt", "second version");
  assert.equal(await (await fetch(url)).text(), "first version");
  const updated = (await server.update(vault, share.token)).shares[0];
  assert.equal(updated.url, share.url);
  assert.equal(updated.expiresAt, share.expiresAt);
  assert.equal(await (await fetch(url)).text(), "second version");
  await assert.rejects(fs.stat(path.join(directory, "downloads", oldSet)), /ENOENT/);
  await fs.unlink(path.join(vault.root, "Download.txt"));
  assert.equal(await (await fetch(url)).text(), "second version");
  const restored = await new ShareServer({ directory, webRoot, tunnel }).init();
  t.after(() => restored.close());
  await restored.listen();
  assert.equal(await (await fetch(`http://127.0.0.1:${restored.port}/s/${share.token}/download/${file.id}`)).text(), "second version");
  const other = (await server.create(vault, "Private.md", 30).catch(async () => {
    await vault.createFile("Private.md", "unrelated");
    return server.create(vault, "Private.md", 30);
  })).shares.find((s) => s.token !== share.token);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/s/${other.token}/download/${file.id}`)).status, 404);
  server.records.get(share.token).expiresAt = Date.now() - 1;
  assert.equal((await fetch(url)).status, 404);
  server.records.get(share.token).expiresAt = share.expiresAt;
  await server.revoke(share.token);
  assert.equal((await fetch(url)).status, 404);
});

test("failed oversized update preserves the previous file and cleans staging, disabling downloads removes access", async (t) => {
  const { vault, server, directory } = await fixture(t);
  await vault.createFile("File.zip", "original zip bytes");
  await vault.writeFile("Example.md", "[받기](File.zip)");
  const share = (await server.create(vault, "Example.md", 7, true)).shares[0];
  const record = server.records.get(share.token);
  const file = record.downloads["File.zip"];
  const url = `http://127.0.0.1:${server.port}/s/${share.token}/download/${file.id}`;
  await fs.truncate(path.join(vault.root, "File.zip"), 250 * 1024 * 1024 + 1);
  await assert.rejects(server.update(vault, share.token), /250 MB/);
  assert.equal(await (await fetch(url)).text(), "original zip bytes");
  assert.deepEqual(await fs.readdir(path.join(directory, "downloads")), [record.downloadSet]);
  await server.update(vault, share.token, false);
  assert.equal((await fetch(url)).status, 404);
  assert.deepEqual(await fs.readdir(path.join(directory, "downloads")), []);
});

test("includes inline, reference, and wiki images but never code, arbitrary files, or symlinks", async (t) => {
  const { root, vault, server } = await fixture(t);
  await vault.createFolder("folder");
  await fs.writeFile(
    path.join(vault.root, "folder", "image.png"),
    Buffer.from("PNG fixture"),
  );
  await fs.writeFile(
    path.join(vault.root, "image.png"),
    Buffer.from("WRONG ROOT IMAGE"),
  );
  await fs.writeFile(path.join(vault.root, "private.txt"), "private");
  await fs.writeFile(path.join(root, "outside.png"), "outside");
  await fs.symlink(
    path.join(root, "outside.png"),
    path.join(vault.root, "escape.png"),
  );
  const content =
    "![inline](image.png)\n\n![reference][photo]\n\n[photo]: image.png\n\n![[folder/image.png|200]]\n\n`![[private.txt]]`\n\n```\n![[outside.png]]\n```\n\n![secret](../private.txt)\n\n![outside](../../outside.png)\n\n![[escape.png]]";
  await vault.createFile("folder/Note.md", content);
  const prepared = await snapshot(vault, "folder/Note.md");
  assert.equal(Object.keys(prepared.assets).length, 1);
  assert.equal(Object.keys(prepared.images).length, 2);
  assert.equal(prepared.warnings.length, 3);
  assert.equal(
    Buffer.from(Object.values(prepared.assets)[0].data, "base64").toString(),
    "PNG fixture",
  );
  const share = (await server.create(vault, "folder/Note.md", 7)).shares[0];
  const id = Object.values(prepared.images)[0];
  const image = await fetch(
    `http://127.0.0.1:${server.port}/s/${share.token}/asset/${id}`,
  );
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(await image.text(), "PNG fixture");
});

test("updates explicitly, preserves the URL, and revokes persisted content and assets", async (t) => {
  const { vault, server, directory, webRoot, tunnel } = await fixture(t);
  const original = (await server.create(vault, "Example.md", 0)).shares[0];
  await vault.writeFile("Example.md", "# Edited");
  const dataUrl = `http://127.0.0.1:${server.port}/s/${original.token}/data`;
  assert.match(
    (await (await fetch(dataUrl)).json()).content,
    /shared paragraph/,
  );
  const updated = (await server.update(vault, original.token)).shares[0];
  assert.equal(updated.url, original.url);
  assert.equal((await (await fetch(dataUrl)).json()).content, "# Edited");
  const reloaded = await new ShareServer({ directory, webRoot, tunnel }).init();
  assert.equal(reloaded.state().shares[0].token, original.token);
  await server.revoke(original.token);
  assert.equal((await fetch(dataUrl)).status, 404);
  const empty = await new ShareServer({ directory, webRoot, tunnel }).init();
  assert.equal(empty.state().shares.length, 0);
});

test("expired links deny document, data, and image requests without waiting for cleanup", async (t) => {
  const { vault, server } = await fixture(t);
  const share = (await server.create(vault, "Example.md", 7)).shares[0];
  server.records.get(share.token).expiresAt = Date.now() - 1;
  for (const suffix of ["", "/data", `/asset/${"a".repeat(32)}`]) {
    assert.equal(
      (await fetch(`http://127.0.0.1:${server.port}/s/${share.token}${suffix}`))
        .status,
      404,
    );
  }
  assert.equal(server.state().shares[0].url, "");
  await assert.rejects(server.update(vault, share.token), /만료/);
});

test("validates note paths, expiry, ownership, and note size before sharing", async (t) => {
  const { vault, server } = await fixture(t);
  await assert.rejects(server.create(vault, "../Example.md", 7), /traversal/);
  await assert.rejects(server.create(vault, "Example.md", -1), /만료/);
  await assert.rejects(server.create(vault, "file.canvas", 7), /마크다운/);
  const share = (await server.create(vault, "Example.md", 7)).shares[0];
  await assert.rejects(
    server.update({ id: "other-vault" }, share.token),
    /보관함/,
  );
  await assert.rejects(server.revoke("../anything"), /올바르지/);
  await vault.writeFile("Example.md", "a".repeat(1024 * 1024 + 1));
  await assert.rejects(server.create(vault, "Example.md", 7), /1 MB/);
});

test("failed external connection never publishes a new document", async (t) => {
  const { vault, server, tunnel, directory } = await fixture(t);
  await vault.createFile("file.txt", "only a fixture");
  await vault.writeFile("Example.md", "[download](file.txt)");
  tunnel.start = async () => {
    throw new Error("offline");
  };
  await assert.rejects(server.create(vault, "Example.md", 7, true), /offline/);
  assert.equal(server.records.size, 0);
  assert.deepEqual(await fs.readdir(path.join(directory, "downloads")), []);
});

test("preserves Mermaid source without treating diagram labels as embedded files", async (t) => {
  const { vault, server } = await fixture(t);
  const source = '# Diagram\n\n```mermaid\nflowchart TD\n  A["![[private.png]]"] --> B["한글 노트"]\n```\n\nAfter diagram.';
  await vault.writeFile("Example.md", source);
  await fs.writeFile(path.join(vault.root, "private.png"), "not shared");
  const share = (await server.create(vault, "Example.md", 7)).shares[0];
  const response = await fetch(`http://127.0.0.1:${server.port}/s/${share.token}/data`);
  const data = await response.json();
  assert.equal(data.content, source);
  assert.deepEqual(data.images, {});
  assert.equal(Object.keys(server.records.get(share.token).assets).length, 0);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  assert.doesNotMatch(response.headers.get("content-security-policy"), /unsafe-eval/);
});
