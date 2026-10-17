"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Vault, seedVault } = require("../electron/vault.cjs");

async function fixture(t, options = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "lithos-test-"));
  const root = path.join(base, "vault");
  await fs.mkdir(root);
  const vault = await new Vault(root, { watch: false, ...options }).init();
  t.after(async () => {
    vault.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, vault };
}

test("writes Markdown atomically, creates folders, and preserves every queued save", async (t) => {
  const { root, vault } = await fixture(t);
  await vault.createFile("Projects/한글.md", "# First");
  await assert.rejects(
    vault.createFile("Projects/한글.md", "overwrite"),
    /EEXIST/,
  );
  await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      vault.writeFile("Projects/한글.md", `# Version ${i}`),
    ),
  );
  assert.equal(await vault.readFile("Projects/한글.md"), "# Version 19");
  const state = await vault.getState();
  assert.equal(state.root, await fs.realpath(root));
  assert.ok(
    state.files.some(
      (file) => file.path === "Projects" && file.type === "folder",
    ),
  );
  assert.ok(
    state.files.some(
      (file) => file.path === "Projects/한글.md" && file.extension === "md",
    ),
  );
  assert.deepEqual(
    (await fs.readdir(path.join(root, "Projects"))).filter((file) =>
      file.startsWith("."),
    ),
    [],
  );
});

test("all public file operations reject traversal, absolute paths and hidden metadata", async (t) => {
  const { base, vault } = await fixture(t);
  await fs.writeFile(path.join(base, "private.md"), "private");
  const invalid = [
    "../private.md",
    "inside/../../private.md",
    "/etc/passwd",
    "C:/private.md",
    "a\\b.md",
    ".obsidian/config.json",
    ".lithos/workspace.json",
    "a/.git/HEAD",
    "bad\0name.md",
    "",
  ];
  for (const value of invalid) {
    await assert.rejects(vault.readFile(value));
    await assert.rejects(vault.writeFile(value, "changed"));
    await assert.rejects(vault.createFile(value, "changed"));
    await assert.rejects(vault.trash(value));
    await assert.rejects(vault.assetUrl(value));
  }
  assert.equal(
    await fs.readFile(path.join(base, "private.md"), "utf8"),
    "private",
  );
});

test("symlink files and directories cannot leak reads, writes, trash or workspace state", async (t) => {
  const { base, root, vault } = await fixture(t);
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.md"), "private");
  await fs.symlink(outside, path.join(root, "link"));
  await fs.symlink(
    path.join(outside, "private.md"),
    path.join(root, "linked.md"),
  );
  await assert.rejects(vault.readFile("link/private.md"), /Symbolic/);
  await assert.rejects(vault.writeFile("link/new.md", "escaped"), /Symbolic/);
  await assert.rejects(vault.writeFile("linked.md", "changed"), /Symbolic/);
  await assert.rejects(vault.trash("link"), /Symbolic/);
  await assert.rejects(vault.assetUrl("linked.md"), /Symbolic/);
  assert.deepEqual((await vault.getState()).files, []);
  await fs.symlink(outside, path.join(root, ".lithos"));
  await assert.rejects(vault.saveWorkspace({ tabs: [] }), /Symbolic/);
  assert.equal(
    await fs.readFile(path.join(outside, "private.md"), "utf8"),
    "private",
  );
  await assert.rejects(fs.access(path.join(outside, "new.md")));
});

test("a replaced vault root cannot redirect operations through a symlink", async (t) => {
  const { base, root, vault } = await fixture(t);
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.rename(root, `${root}-original`);
  await fs.symlink(outside, root);
  await assert.rejects(
    vault.writeFile("leaked.md", "no"),
    /no longer available/,
  );
  await assert.rejects(fs.access(path.join(outside, "leaked.md")));
});

test("rename changes resolved wiki links and canvas references while preserving aliases, headings and code", async (t) => {
  const { vault } = await fixture(t);
  await vault.createFile("Notes/Old.md", "# Old\n[[Other]]");
  await vault.createFile("Other.md", "# Other");
  await vault.createFile(
    "Index.md",
    "[[Old]] [[Notes/Old#Section|Display]] ![[Old.md#^block]] [[Missing]]\n`[[Old]]`\n```md\n[[Old]]\n```",
  );
  await vault.createFile(
    "Map.canvas",
    JSON.stringify({
      nodes: [
        { id: "file", type: "file", file: "Notes/Old.md" },
        { id: "text", type: "text", text: "[[Old|An idea]]" },
      ],
      edges: [],
      unknown: "preserved",
    }),
  );
  const result = await vault.rename("Notes/Old.md", "Notes/New.md");
  assert.equal(result.updatedLinks, 2);
  assert.equal(
    await vault.readFile("Index.md"),
    "[[New]] [[Notes/New#Section|Display]] ![[New.md#^block]] [[Missing]]\n`[[Old]]`\n```md\n[[Old]]\n```",
  );
  const canvas = JSON.parse(await vault.readFile("Map.canvas"));
  assert.equal(canvas.nodes[0].file, "Notes/New.md");
  assert.equal(canvas.nodes[1].text, "[[New|An idea]]");
  assert.equal(canvas.unknown, "preserved");
  await assert.rejects(vault.readFile("Notes/Old.md"), /ENOENT/);
  assert.equal(await vault.readFile("Notes/New.md"), "# Old\n[[Other]]");
});

test("moving a folder rewrites relative links from moved notes and only intended duplicate-name targets", async (t) => {
  const { vault } = await fixture(t);
  await vault.createFile("Shared.md", "# Shared");
  await vault.createFile(
    "A/Note.md",
    "[[../Shared#Heading|shared]] [[./Other]]",
  );
  await vault.createFile("A/Other.md", "# A");
  await vault.createFile("B/Other.md", "# B");
  await vault.createFile("B/Index.md", "[[./Other]] [[A/Other]]");
  await vault.rename("A", "Archive/A");
  assert.equal(
    await vault.readFile("Archive/A/Note.md"),
    "[[../../Shared#Heading|shared]] [[./Other]]",
  );
  assert.equal(
    await vault.readFile("B/Index.md"),
    "[[./Other]] [[Archive/A/Other]]",
  );
  await assert.rejects(vault.rename("B", "B/nested"), /inside itself/);
  await assert.rejects(
    vault.rename("Shared.md", "B/Other.md"),
    /already exists/,
  );
  assert.equal(await vault.readFile("B/Other.md"), "# B");
});

test("a failed backlink write rolls the rename and completed backlink writes back", async (t) => {
  const { vault } = await fixture(t);
  await vault.createFile("Old.md", "# Original");
  await vault.createFile("A.md", "[[Old|Alias]]");
  await vault.createFile("B.md", "[[Old#Heading]]");
  const atomicWrite = vault.atomicWrite.bind(vault);
  let writes = 0;
  vault.atomicWrite = async (...args) => {
    if (++writes === 2) throw new Error("Simulated disk write failure");
    return atomicWrite(...args);
  };
  await assert.rejects(
    vault.rename("Old.md", "New.md"),
    /Simulated disk write failure/,
  );
  assert.equal(await vault.readFile("Old.md"), "# Original");
  assert.equal(await vault.readFile("A.md"), "[[Old|Alias]]");
  assert.equal(await vault.readFile("B.md"), "[[Old#Heading]]");
  await assert.rejects(vault.readFile("New.md"), /ENOENT/);
});

test("rename preserves Markdown headings, encoded paths, titles, reference definitions and code examples", async (t) => {
  const { vault } = await fixture(t);
  await vault.createFile("Notes/Old name.md", "# Target");
  const original = [
    '[note](Notes/Old%20name.md#Some%20heading "A title")',
    "[angled](<Notes/Old name.md#Heading> 'Another title')",
    '[ref]: Notes/Old%20name.md#Heading "Reference title"',
    "[external](https://example.com/Notes/Old%20name.md)",
    "`[code](Notes/Old%20name.md)`",
    "```md",
    "[fenced](Notes/Old%20name.md)",
    "```",
    "    [indented](Notes/Old%20name.md)",
    "[unresolved](Missing.md)",
    "[heading](#Some-heading)",
  ].join("\n");
  await vault.createFile("Index.md", original);
  await vault.rename("Notes/Old name.md", "Notes/New name.md");
  const renamed = await vault.readFile("Index.md");
  assert.ok(
    renamed.includes('[note](Notes/New%20name.md#Some%20heading "A title")'),
  );
  assert.ok(
    renamed.includes("[angled](<Notes/New name.md#Heading> 'Another title')"),
  );
  assert.ok(
    renamed.includes('[ref]: Notes/New%20name.md#Heading "Reference title"'),
  );
  for (const unchanged of original.split("\n").slice(3))
    assert.ok(renamed.includes(unchanged));
});

test("moving a source folder updates relative Markdown note links and image destinations", async (t) => {
  const { vault } = await fixture(t);
  await vault.createFile("Shared.md", "# Shared");
  await vault.createFile("assets/image (draft).png", "image fixture");
  await vault.createFile("A/Other.md", "# Local");
  await vault.createFile(
    "A/Note.md",
    '[shared](../Shared.md#Heading "keep me")\n[local](./Other.md)\n![image](../assets/image%20%28draft%29.png "Image title")',
  );
  await vault.rename("A", "Archive/A");
  assert.equal(
    await vault.readFile("Archive/A/Note.md"),
    '[shared](../../Shared.md#Heading "keep me")\n[local](./Other.md)\n![image](../../assets/image%20%28draft%29.png "Image title")',
  );
  await vault.rename("assets/image (draft).png", "assets/final image.png");
  assert.ok(
    (await vault.readFile("Archive/A/Note.md")).includes(
      '![image](../../assets/final%20image.png "Image title")',
    ),
  );
});

test("Markdown paths resolve relative to their note and support balanced parentheses", async (t) => {
  const { vault } = await fixture(t);
  await vault.createFile("Note.md", "# Root");
  await vault.createFile("Folder/Note.md", "# Local");
  await vault.createFile("Folder/with(draft).md", "# Parentheses");
  await vault.createFile(
    "Folder/Index.md",
    '[local](Note.md) [root](../Note.md) [draft](with(draft).md "title")',
  );
  await vault.rename("Note.md", "Root renamed.md");
  assert.equal(
    await vault.readFile("Folder/Index.md"),
    '[local](Note.md) [root](../Root%20renamed.md) [draft](with(draft).md "title")',
  );
  await vault.rename("Folder/with(draft).md", "Folder/final(draft).md");
  assert.equal(
    await vault.readFile("Folder/Index.md"),
    '[local](Note.md) [root](../Root%20renamed.md) [draft](final%28draft%29.md "title")',
  );
});

test("trash is reversible and will never overwrite a newer file when restoring", async (t) => {
  const { root, vault } = await fixture(t);
  await vault.createFile("Folder/Note.md", "original");
  const result = await vault.trash("Folder");
  const entries = await vault.getTrash();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "Folder");
  assert.equal(result.trashed.id, entries[0].id);
  assert.equal((await vault.getState()).files.length, 0);
  assert.equal(
    await fs.readFile(
      path.join(root, ".lithos-trash", entries[0].id, "content/Note.md"),
      "utf8",
    ),
    "original",
  );
  await vault.createFile("Folder/Note.md", "new");
  await assert.rejects(vault.restoreTrash(entries[0].id), /already exists/);
  assert.equal(await vault.readFile("Folder/Note.md"), "new");
  await vault.trash("Folder");
  await vault.restoreTrash(entries[0].id);
  assert.equal(await vault.readFile("Folder/Note.md"), "original");
  await assert.rejects(vault.restoreTrash("../escape"));
});

test("workspace is stored separately and attachments get collision-free names", async (t) => {
  const { base, vault } = await fixture(t);
  await vault.saveWorkspace({
    tabs: ["Note.md"],
    active: "Note.md",
    sidebar: false,
  });
  assert.deepEqual(await vault.getWorkspace(), {
    tabs: ["Note.md"],
    active: "Note.md",
    sidebar: false,
  });
  assert.deepEqual((await vault.getState()).files, []);
  const attachment = path.join(base, "image.png");
  await fs.writeFile(attachment, Buffer.from([137, 80, 78, 71]));
  assert.deepEqual(await vault.importPaths([attachment]), [
    "attachments/image.png",
  ]);
  assert.deepEqual(await vault.importPaths([attachment]), [
    "attachments/image 1.png",
  ]);
  assert.match(
    await vault.assetUrl("attachments/image 1.png"),
    /^lithos-asset:\/\/[a-f0-9]+\/attachments\/image%201\.png$/,
  );
});

test("sample vault contains connected Korean notes and interoperable canvas", async (t) => {
  const { root, vault } = await fixture(t);
  await seedVault(root);
  const state = await vault.getState();
  assert.ok(state.files.some((file) => file.path === "시작하기.md"));
  assert.ok(state.files.some((file) => file.path === "프로젝트/작은 시작.md"));
  const canvas = JSON.parse(await vault.readFile("생각의 지도.canvas"));
  assert.equal(canvas.nodes.length, 3);
  assert.equal(canvas.edges.length, 2);
  for (const node of canvas.nodes.filter((node) => node.type === "file"))
    assert.ok(await vault.readFile(node.file));
});

test("external filesystem changes are reported by the vault watcher", async (t) => {
  const { root, vault } = await fixture(t, { watch: true });
  const changed = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No filesystem change event received")),
      5000,
    );
    vault.on("changed", (event) => {
      if (event.type === "external") {
        clearTimeout(timer);
        resolve(event);
      }
    });
  });
  await fs.writeFile(
    path.join(root, "external.md"),
    "# Written outside the app",
  );
  const event = await changed;
  assert.ok(event.paths.length === 0 || event.paths.includes("external.md"));
  assert.equal(
    await vault.readFile("external.md"),
    "# Written outside the app",
  );
});
