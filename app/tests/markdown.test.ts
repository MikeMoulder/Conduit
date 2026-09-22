/**
 * Tests for the prose renderer.
 *
 * The parser is tested rather than the rendering. What goes wrong with markdown
 * is not the colour of a bold span, it is a list that was read as a paragraph,
 * or an asterisk that survived into the page, or a link that turned into
 * something clickable when it should not have. All of those are decisions the
 * block and inline parsers make.
 *
 * The first case is the one that prompted this. A model wrote a paragraph and
 * then five bullets with no blank line between them, and the previous renderer
 * split on blank lines only, so the whole thing arrived as one run-on paragraph
 * with asterisks in it.
 */

import { describe, it } from "node:test";
import { assert } from "chai";

import { parseMarkdown, parseInline } from "../src/components/chat/markdown";

describe("reading blocks", () => {
  it("separates bullets that follow a paragraph with no blank line", () => {
    // Verbatim shape of the answer that exposed the problem.
    const blocks = parseMarkdown(
      [
        "To do this, I need you to specify the new limits:",
        "* **Maximum assets:** How many positions, up to 8.",
        "* **Maximum position size:** The largest share in a single asset.",
        "* **Minimum cash:** What must always remain in cash.",
      ].join("\n"),
    );

    assert.lengthOf(blocks, 2);
    assert.equal(blocks[0].kind, "paragraph");
    assert.equal(blocks[1].kind, "list");
    assert.isFalse((blocks[1] as { ordered: boolean }).ordered);
    assert.lengthOf((blocks[1] as { items: string[] }).items, 3);
    assert.equal(
      (blocks[1] as { items: string[] }).items[0],
      "**Maximum assets:** How many positions, up to 8.",
    );
  });

  it("accepts every bullet character a model might reach for", () => {
    for (const marker of ["*", "-", "+"]) {
      const blocks = parseMarkdown(`${marker} one\n${marker} two`);
      assert.lengthOf(blocks, 1, `${marker} was not read as a list`);
      assert.lengthOf((blocks[0] as { items: string[] }).items, 2);
    }
  });

  it("reads a numbered list as ordered", () => {
    const blocks = parseMarkdown("1. first\n2. second\n3) third");
    assert.lengthOf(blocks, 1);
    assert.isTrue((blocks[0] as { ordered: boolean }).ordered);
    assert.deepEqual((blocks[0] as { items: string[] }).items, [
      "first",
      "second",
      "third",
    ]);
  });

  it("does not merge a bulleted list into a numbered one", () => {
    const blocks = parseMarkdown("* one\n1. two");
    assert.lengthOf(blocks, 2);
    assert.isFalse((blocks[0] as { ordered: boolean }).ordered);
    assert.isTrue((blocks[1] as { ordered: boolean }).ordered);
  });

  it("keeps the lines of a paragraph separate", () => {
    // They render with a break between them rather than joined. Strict
    // markdown would flow them into one sentence, which is right for a
    // document and wrong for a chat window: a model asked for one item per
    // line writes exactly that, without reaching for bullet characters.
    const blocks = parseMarkdown("one line\nand its continuation");
    assert.lengthOf(blocks, 1);
    assert.deepEqual((blocks[0] as { lines: string[] }).lines, [
      "one line",
      "and its continuation",
    ]);
  });

  it("separates paragraphs on a blank line", () => {
    const blocks = parseMarkdown("first\n\nsecond");
    assert.lengthOf(blocks, 2);
    assert.equal(blocks[0].kind, "paragraph");
    assert.equal(blocks[1].kind, "paragraph");
  });

  it("returns nothing for nothing", () => {
    assert.lengthOf(parseMarkdown(""), 0);
    assert.lengthOf(parseMarkdown("\n\n  \n"), 0);
  });
});

/** Inline nodes reduced to a shape a test can assert on. */
function shapes(text: string) {
  return parseInline(text).map((t) => `${t.kind}:${t.text}`);
}

describe("reading inline marks", () => {
  it("reads bold, italic and code", () => {
    assert.deepEqual(shapes("a **bold** b"), [
      "text:a ",
      "bold:bold",
      "text: b",
    ]);
    assert.deepEqual(shapes("an *emphasis* here"), [
      "text:an ",
      "italic:emphasis",
      "text: here",
    ]);
    assert.deepEqual(shapes("call `get_prices` now"), [
      "text:call ",
      "code:get_prices",
      "text: now",
    ]);
  });

  it("reads the underscore spellings too", () => {
    assert.deepEqual(shapes("__strong__"), ["bold:strong"]);
    assert.deepEqual(shapes("_soft_"), ["italic:soft"]);
  });

  it("handles a bold label at the start of a list item", () => {
    assert.deepEqual(shapes("**Maximum assets:** up to 8"), [
      "bold:Maximum assets:",
      "text: up to 8",
    ]);
  });

  it("leaves a lone asterisk alone rather than eating it", () => {
    assert.deepEqual(shapes("2 * 3 = 6"), ["text:2 * 3 = 6"]);
    assert.deepEqual(shapes("a * b"), ["text:a * b"]);
  });

  it("links only what carries a safe scheme", () => {
    assert.deepEqual(shapes("[explorer](https://explorer.solana.com/tx/abc)"), [
      "link:explorer",
    ]);

    // Anything else is shown as the characters that were written. A renderer
    // that turns model output into a javascript: link is a hole, and the way
    // not to have one is to have no branch that can produce it.
    for (const bad of [
      "[click](javascript:alert(1))",
      "[file](file:///etc/passwd)",
      "[rel](/mandate)",
    ]) {
      const parsed = parseInline(bad);
      assert.isEmpty(
        parsed.filter((t) => t.kind === "link"),
        `${bad} should not have become a link`,
      );
      // Nothing may be swallowed either. What was written is what is shown.
      assert.equal(parsed.map((t) => t.text).join(""), bad);
    }
  });

  it("passes plain prose through untouched", () => {
    const plain = "SpaceX trades at a 22 percent discount to its underlying.";
    assert.deepEqual(shapes(plain), [`text:${plain}`]);
  });
});
