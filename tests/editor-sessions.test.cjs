"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { EditorState, StateEffect, Transaction } = require("@codemirror/state");
const { history, undo, redo, undoDepth, isolateHistory } = require("@codemirror/commands");
const loaded = new Map();
function loadTS(filename) {
  if (loaded.has(filename)) return loaded.get(filename).exports;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = module.paths;
  const requireOriginal = mod.require.bind(mod);
  mod.require = (name) => name.startsWith(".")
    ? loadTS(path.resolve(path.dirname(filename), name + ".ts")) : requireOriginal(name);
  loaded.set(filename, mod);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, filename);
  return mod.exports;
}
const { EditorSessions, isLargeNote, textChange } = loadTS(path.resolve(__dirname, "../src/editorSessions.ts"));
const { NoteIndex } = loadTS(path.resolve(__dirname, "../src/noteIndex.ts"));
function run(command, state) {
  let result = state;
  command({ state, dispatch: (transaction) => { result = transaction.state; } });
  return result;
}

test("note A keeps undo, redo and selection after visiting B and rebuilding the editor", () => {
  const sessions = new EditorSessions();
  let a = sessions.restore("A", "원본 😀", [history()]);
  a = a.update({ changes: { from: a.doc.length, insert: "\n추가" }, selection: { anchor: 8 } }).state;
  sessions.remember("A", a);
  sessions.restore("B", "다른 문서", [history()]);
  a = sessions.restore("A", "원본 😀\n추가", [history()]);
  assert.equal(a.selection.main.head, 8);
  a = run(undo, a);
  assert.equal(a.doc.toString(), "원본 😀");
  sessions.remember("A", a);
  sessions.restore("B", "다른 문서", [history()]);
  a = run(redo, sessions.restore("A", "원본 😀", [history()]));
  assert.equal(a.doc.toString(), "원본 😀\n추가");
});

test("reading mode, returning to edit, and checkbox edits preserve meaningful undo steps", () => {
  const original = "- [ ] check\n";
  let state = EditorState.create({ doc: original, extensions: [history()] });
  state = state.update({ changes: textChange(original, "- [x] check\n"),
    annotations: [Transaction.userEvent.of("input.check"), isolateHistory.of("full")] }).state;
  state = state.update({ effects: StateEffect.reconfigure.of([history(), EditorState.readOnly.of(true)]) }).state;
  state = state.update({ effects: StateEffect.reconfigure.of([history(), EditorState.readOnly.of(false)]) }).state;
  state = run(undo, state);
  assert.equal(state.doc.toString(), original);
  assert.equal(run(redo, state).doc.toString(), "- [x] check\n");
});

test("external changes and vault resets cannot restore an old document through undo", () => {
  const sessions = new EditorSessions();
  let state = sessions.restore("same.md", "initial", [history()]);
  state = state.update({ changes: { from: 7, insert: " local" } }).state;
  sessions.remember("same.md", state);
  state = sessions.restore("same.md", "external", [history()]);
  assert.equal(state.doc.toString(), "external");
  assert.equal(undoDepth(state), 0);
  sessions.clear();
  assert.equal(undoDepth(sessions.restore("same.md", "external", [history()])), 0);
});

test("session cache evicts older notes without evicting the currently edited large note", () => {
  const sessions = new EditorSessions(2, 20);
  let a = sessions.restore("A", "a", [history()]);
  a = a.update({ changes: { from: 1, insert: " edited" } }).state;
  sessions.remember("A", a);
  sessions.restore("B", "b", [history()]);
  sessions.restore("C", "c".repeat(100), [history()]);
  assert.equal(undoDepth(sessions.restore("A", "a edited", [history()])), 0);
});

test("large notes retain exact Unicode text through edit, undo, redo and tab restoration", () => {
  const original = "한글 😀\n".repeat(180000);
  const changed = "FIRST\n" + original + "\nLAST";
  const sessions = new EditorSessions();
  let state = sessions.restore("large.md", original, [history()]);
  state = state.update({ changes: textChange(original, changed) }).state;
  sessions.remember("large.md", state);
  state = sessions.restore("large.md", changed, [history()]);
  state = run(undo, state);
  assert.equal(state.doc.toString(), original);
  assert.equal(run(redo, state).doc.toString(), changed);
  assert.equal(isLargeNote(original), true);
  assert.equal(isLargeNote("short\n".repeat(10000)), true);
  assert.equal(isLargeNote("# 제목\n\n일반 문서"), false);
});

test("metadata is reused for unchanged notes and bounded for documents with many paragraphs", () => {
  const index = new NoteIndex();
  const a = index.get("A", "# First\n[[B]] #tag");
  assert.equal(index.get("A", a.content), a);
  assert.deepEqual(a.links, ["B"]);
  assert.equal(index.get("A", "# Changed").headings[0].text, "Changed");
  const large = index.get("Large", "paragraph\n\n".repeat(100000));
  assert.equal(large.large, true);
  assert.equal(large.wordCount, null);
  assert.deepEqual(large.links, []);
  index.retain([]);
  assert.notEqual(index.get("A", a.content), a);
});
