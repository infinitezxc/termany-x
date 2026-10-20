import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownTable } from "./markdownTable";

test("parses bordered tables with column alignment and inline markup intact", () => {
  assert.deepEqual(parseMarkdownTable([
    "| Name | Value | Link |",
    "| :--- | :---: | ---: |",
    "| **bold** | `code` | [docs](docs.md) |",
    "",
    "Following paragraph",
  ], 0), {
    headers: ["Name", "Value", "Link"],
    alignments: ["left", "center", "right"],
    rows: [["**bold**", "`code`", "[docs](docs.md)"]],
    nextIndex: 3,
  });
});

test("supports omitted outer pipes and normalizes short and long rows", () => {
  const table = parseMarkdownTable([
    "Name | Value",
    "--- | ---",
    "one |",
    "two | value | ignored",
    "Following paragraph",
  ], 0);
  assert.deepEqual(table?.rows, [["one", ""], ["two", "value"]]);
  assert.deepEqual(table?.alignments, [undefined, undefined]);
  assert.equal(table?.nextIndex, 4);
});

test("escaped pipes stay in cells, including inline code and trailing pipes", () => {
  const table = parseMarkdownTable([
    "Expression | Result",
    "--- | ---",
    "`a\\|b` | trailing\\|",
    "a\\\\| b |",
  ], 0);
  assert.deepEqual(table?.rows, [["`a|b`", "trailing|"], ["a\\\\", "b"]]);
});

test("requires a matching delimiter row instead of treating prose as a table", () => {
  for (const lines of [
    ["a | b", "ordinary | prose"],
    ["a | b", "| --- |"],
    ["a | b", "--- | --invalid"],
    ["a paragraph", "---"],
  ]) assert.equal(parseMarkdownTable(lines, 0), null);
});

test("supports header-only tables and stops before other Markdown blocks", () => {
  for (const block of ["# Heading | text", "```js | code", "> quote | text", "- list | item"]) {
    const table = parseMarkdownTable(["| Header |", "| --- |", block], 0);
    assert.deepEqual(table?.rows, []);
    assert.equal(table?.nextIndex, 2);
  }
});
