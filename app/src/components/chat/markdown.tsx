import { Fragment, type ReactNode } from "react";

/**
 * The small amount of markdown a model actually writes.
 *
 * Written rather than installed. A library would handle far more of the
 * specification than anything here will ever produce, and the part that matters
 * is what it does with the rest: a general renderer has to decide what to do
 * about raw HTML in its input, and the safest answer to that question is to have
 * no code path that can produce any. Nothing below builds an element from a
 * string. Every node is a React element constructed from a parsed token, so
 * there is no `dangerouslySetInnerHTML` to audit and no way for model output to
 * become markup.
 *
 * Parsing is separate from rendering so the decisions can be tested. What goes
 * wrong with markdown is never the colour of a bold span. It is a list read as
 * a paragraph, an asterisk that survived into the page, or a link that became
 * clickable when it should not have.
 *
 * Handles paragraphs, bulleted and numbered lists, bold, italic, inline code
 * and links. Anything else renders as the literal text that was written, which
 * is the right failure: an unrecognised construct should look like a stray
 * character rather than vanish.
 */

export interface InlineToken {
  kind: "text" | "bold" | "italic" | "code" | "link";
  text: string;
  href?: string;
}

/** Bold, italic, code and links, in one pass so nesting cannot double apply. */
const INLINE =
  /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)\s]+\))/g;

const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

export function parseInline(text: string): InlineToken[] {
  const tokens = text
    .split(INLINE)
    .filter((part) => part !== "")
    .map((part): InlineToken => {
      const paired = (mark: string, min: number) =>
        part.startsWith(mark) && part.endsWith(mark) && part.length > min;

      if (paired("**", 4) || paired("__", 4)) {
        return { kind: "bold", text: part.slice(2, -2) };
      }
      if (paired("`", 2)) {
        return { kind: "code", text: part.slice(1, -1) };
      }
      if (paired("*", 2) || paired("_", 2)) {
        return { kind: "italic", text: part.slice(1, -1) };
      }

      const link = LINK.exec(part);
      if (link) {
        const [, label, href] = link;
        // Only schemes a link can safely carry. Anything else stays the text it
        // was written as. Having no branch that can produce a javascript: href
        // is a better guarantee than remembering to sanitise one.
        if (/^https?:\/\//i.test(href)) {
          return { kind: "link", text: label, href };
        }
        return { kind: "text", text: part };
      }

      return { kind: "text", text: part };
    });

  // Adjacent plain runs are joined. They occur whenever something looked like a
  // mark and was rejected, such as a link with an unsafe scheme, and leaving
  // them split would mean a fragment per fragment for no reason and an
  // awkward shape for anything reading the result back.
  const merged: InlineToken[] = [];
  for (const token of tokens) {
    const last = merged[merged.length - 1];
    if (token.kind === "text" && last?.kind === "text") {
      last.text += token.text;
    } else {
      merged.push({ ...token });
    }
  }

  return merged;
}

export type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] };

const BULLET = /^\s*[*+-]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

/**
 * Groups lines into blocks.
 *
 * A list item is recognised by how its line starts rather than by a blank line
 * before it, which is the case that matters. Models routinely write a paragraph
 * and then bullets with nothing between them, and splitting on blank lines
 * alone turns all of it into one run-on paragraph with asterisks in it.
 */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };

  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      flush();
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = NUMBERED.exec(line);

    if (bullet || numbered) {
      flush();
      const ordered = Boolean(numbered);
      const item = (bullet?.[1] ?? numbered?.[1] ?? "").trim();
      const last = blocks[blocks.length - 1];

      if (last?.kind === "list" && last.ordered === ordered) {
        last.items.push(item);
      } else {
        blocks.push({ kind: "list", ordered, items: [item] });
      }
      continue;
    }

    paragraph.push(line);
  }

  flush();
  return blocks;
}

function render(text: string, keyPrefix: string): ReactNode[] {
  return parseInline(text).map((token, i) => {
    const key = `${keyPrefix}-${i}`;

    switch (token.kind) {
      case "bold":
        return (
          <strong key={key} className="font-semibold text-zinc-50">
            {token.text}
          </strong>
        );
      case "italic":
        return (
          <em key={key} className="italic">
            {token.text}
          </em>
        );
      case "code":
        return (
          <code
            key={key}
            className="rounded bg-zinc-800/80 px-1 py-0.5 font-mono text-[0.9em] text-zinc-200"
          >
            {token.text}
          </code>
        );
      case "link":
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-emerald-400 underline underline-offset-4"
          >
            {token.text}
          </a>
        );
      default:
        return <Fragment key={key}>{token.text}</Fragment>;
    }
  });
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseMarkdown(text);

  return (
    <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-zinc-200">
      {blocks.map((block, i) => {
        if (block.kind === "list") {
          const List = block.ordered ? "ol" : "ul";
          return (
            <List key={i} className="flex flex-col gap-1.5">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2.5">
                  {block.ordered ? (
                    <span className="shrink-0 font-mono text-[13px] leading-relaxed text-zinc-500">
                      {j + 1}.
                    </span>
                  ) : (
                    <span
                      aria-hidden
                      className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-emerald-500"
                    />
                  )}
                  <span className="min-w-0">{render(item, `${i}-${j}`)}</span>
                </li>
              ))}
            </List>
          );
        }

        /**
         * Each line stays a line.
         *
         * Strict markdown would join these into one flowing paragraph, and for
         * a document that is right. For a chat window it is wrong, and visibly
         * so: a model asked to list five things one per line does exactly that
         * without reaching for bullet characters, and joining them produced a
         * single run-on sentence of five bolded labels. What was written on
         * separate lines appears on separate lines.
         */
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {render(line, `${i}-${j}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}
