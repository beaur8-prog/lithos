"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const filename = path.resolve(__dirname, "../src/model.ts");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  },
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename;
loaded.paths = module.paths;
loaded._compile(compiled, filename);
const {
  resolveLink,
  localLinkForNavigation,
  extractLinks,
  headings,
  findHeadingOffset,
  toggleTaskAtOffset,
  safeExternalUrl,
  maskMarkdownCode,
} = loaded.exports;

test("Markdown paths stay relative while wiki paths resolve from the vault and nearest duplicate", () => {
  const paths = [
    "Index.md",
    "Target.md",
    "A/Index.md",
    "A/Target.md",
    "A/Nested/Index.md",
    "B/Target.md",
    "A/Image one.png",
  ];
  assert.equal(
    resolveLink("Target.md", "A/Index.md", paths, "markdown"),
    "A/Target.md",
  );
  assert.equal(resolveLink("Target", "A/Index.md", paths), "Target.md");
  assert.equal(resolveLink("./Target", "A/Index.md", paths), "A/Target.md");
  assert.equal(
    resolveLink("../Target.md", "A/Nested/Index.md", paths, "markdown"),
    "A/Target.md",
  );
  assert.equal(
    resolveLink("/Target.md", "A/Index.md", paths, "markdown"),
    "Target.md",
  );
  assert.equal(
    resolveLink(
      "Target",
      "A/Nested/Index.md",
      paths.filter((p) => p !== "Target.md"),
    ),
    "A/Target.md",
  );
  assert.equal(
    resolveLink("Target.md", "Missing/Index.md", paths, "markdown"),
    null,
  );
  assert.equal(
    resolveLink("../../Target.md", "A/Index.md", paths, "markdown"),
    null,
  );
  assert.equal(
    resolveLink("Image%20one.png", "A/Index.md", paths, "markdown"),
    "A/Image one.png",
  );
  assert.equal(resolveLink("#Heading", "A/Index.md", paths), "A/Index.md");
  assert.equal(resolveLink("", "A/Index.md", paths), null);
});

test("canonical navigation preserves anchors, encoded filenames and missing relative locations", () => {
  const paths = ["Folder/Index.md", "Folder/My # Note.md"];
  assert.equal(
    localLinkForNavigation(
      "My%20%23%20Note.md#My%20heading",
      "Folder/Index.md",
      paths,
      "markdown",
    ),
    "/Folder/My%20%23%20Note.md#My heading",
  );
  assert.equal(
    localLinkForNavigation(
      "./New note.md#Heading",
      "Folder/Index.md",
      paths,
      "markdown",
    ),
    "/Folder/New%20note.md#Heading",
  );
  assert.equal(
    localLinkForNavigation(
      "../../escape.md",
      "Folder/Index.md",
      paths,
      "markdown",
    ),
    null,
  );
  assert.equal(
    localLinkForNavigation("javascript:alert(1)", "Folder/Index.md", paths),
    null,
  );
});

test("external URLs never resolve as notes and unsupported protocols cannot be opened", () => {
  const paths = [
    "javascript:alert(1).md",
    "mailto:person@example.com.md",
    "Index.md",
  ];
  for (const raw of [
    "https://example.com",
    "//example.com/path",
    "mailto:person@example.com",
    "javascript:alert(1)",
    "data:text/html,test",
    "java-script:payload",
  ]) {
    assert.equal(resolveLink(raw, "Index.md", paths), null, raw);
    assert.equal(localLinkForNavigation(raw, "Index.md", paths), null, raw);
  }
  assert.equal(
    safeExternalUrl("HTTPS://example.com/path"),
    "https://example.com/path",
  );
  assert.equal(
    safeExternalUrl("//example.com/path"),
    "https://example.com/path",
  );
  for (const raw of [
    "javascript:alert(1)",
    "mailto:person@example.com",
    "https://user:password@example.com",
    "https://example.com/\nsecret",
  ])
    assert.equal(safeExternalUrl(raw), null, raw);
});

test("backlink extraction ignores code/frontmatter and preserves relative Markdown semantics", () => {
  const content =
    '---\nexample: "[[Metadata]]"\n---\n[[Wiki#Heading|Alias]] [relative](Target.md#Heading) ![image](<Image one.png>) [named][ref]\n\n[ref]: ../Other.md "title"\n\n`[[Inline]]`\n~~~md\n[[Fence]] [x](Hidden.md)\n~~~~\n<!-- [[Comment]] -->\n[web](https://example.com) [network](//example.com)';
  assert.deepEqual(extractLinks(content), [
    "Wiki#Heading|Alias",
    "./Target.md#Heading",
    "./Image one.png",
    "../Other.md",
  ]);
  assert.deepEqual(extractLinks("[local](Folder/Note(1).md)"), [
    "./Folder/Note(1).md",
  ]);
  const clean = maskMarkdownCode(content);
  assert.equal(clean.length, content.length);
  assert.equal(clean.indexOf("[[Wiki"), content.indexOf("[[Wiki"));
});

test("heading lookup includes all levels, formatting and encoded local anchors while excluding code", () => {
  const content =
    "---\ntitle: example\n---\n# Intro\n\n~~~md\n## Not a heading\n~~~\n#### A **formatted** heading ###\n###### 마지막 제목\n";
  const found = headings(content);
  assert.deepEqual(
    found.map((x) => [x.level, x.text]),
    [
      [1, "Intro"],
      [4, "A formatted heading"],
      [6, "마지막 제목"],
    ],
  );
  assert.equal(
    findHeadingOffset(content, "A%20formatted%20heading"),
    content.indexOf("#### A"),
  );
  assert.equal(
    findHeadingOffset(content, "a-formatted-heading"),
    content.indexOf("#### A"),
  );
  assert.equal(
    findHeadingOffset(content, "마지막 제목"),
    content.indexOf("######"),
  );
  assert.equal(
    findHeadingOffset("   ### Indented heading", "Indented heading"),
    3,
  );
});

test("task checkbox edits use exact source offsets and never alter fenced examples or other tasks", () => {
  const content =
    "---\nexample: task\n---\n```md\n- [ ] code example\n```\n- [ ] first real task\n1. [x] ordered task\n> - [ ] quoted task\n";
  const first = content.indexOf("- [ ] first");
  const result = toggleTaskAtOffset(content, first, true);
  assert.equal(
    result,
    content.slice(0, first) +
      content.slice(first).replace("- [ ] first", "- [x] first"),
  );
  assert.ok(result.includes("- [ ] code example"));
  const ordered = content.indexOf("1. [x]");
  assert.equal(
    toggleTaskAtOffset(content, ordered, false),
    content.replace("1. [x]", "1. [ ]"),
  );
  const quoted = content.indexOf("> - [ ]");
  assert.equal(
    toggleTaskAtOffset(content, quoted, true),
    content.replace("> - [ ]", "> - [x]"),
  );
  for (const offset of [-1, 0, content.length, NaN])
    assert.equal(toggleTaskAtOffset(content, offset, true), content);
  const crlf = "- [ ] first\r\n12) [X] second\r\n";
  assert.equal(
    toggleTaskAtOffset(crlf, crlf.indexOf("12)"), false),
    "- [ ] first\r\n12) [ ] second\r\n",
  );
});
