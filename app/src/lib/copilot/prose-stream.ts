import type { CopilotEvent } from "./events";
import { houseStyle } from "./style";

/**
 * One turn's prose on its way to the person, a few words at a time.
 *
 * The reply used to arrive in one piece after the model had finished, so a
 * three sentence answer sat behind "Reading the question" and then appeared
 * all at once. Now it is passed on as the model writes it, which raises two
 * problems this class exists to solve.
 *
 * The house style has to hold. Every reply goes through houseStyle, which
 * turns dashes into commas and "9 – 5" into "9 to 5", and a dash can arrive
 * in a different chunk from the words around it. So the end of the text is
 * held back while it could still change: a run of spaces, digits, dots,
 * commas and dashes. Every rule in houseStyle matches only those characters,
 * so once a different character follows them, nothing later can rewrite
 * what was already sent, and what is sent is always a prefix of the styled
 * whole.
 *
 * And some prose turns out not to be the answer. A model narrates before a
 * tool call ("Let me check that"), promises a card it never prepared, or
 * fails part way so the next model starts again. That text was already
 * shown, so it is taken back: a text_discard event tells the browser to cut
 * the reply back to what it was before this turn.
 */

/** The tail houseStyle could still rewrite, held until something else follows it. */
const UNSETTLED = /[\s\d.,–—]*$/;

export class ProseStream {
  private raw = "";
  private sent = "";

  /**
   * @param emit where events go
   * @param keep how much reply text earlier turns left showing, which a discard cuts back to
   */
  constructor(
    private readonly emit: (event: CopilotEvent) => void,
    private readonly keep: number,
  ) {}

  /** Characters of this turn's prose the person has seen. */
  get length(): number {
    return this.sent.length;
  }

  /** A piece of prose, as the model wrote it. */
  push(delta: string): void {
    this.raw += delta;
    const held = this.raw.match(UNSETTLED)?.[0].length ?? 0;
    this.send(houseStyle(this.raw.slice(0, this.raw.length - held)), false);
  }

  /** The turn is over and this is its whole prose: send whatever is still unsent. */
  finish(prose: string): void {
    this.raw = prose;
    this.send(houseStyle(prose), true);
  }

  /** This turn's prose is not the answer: take back whatever was shown. */
  discard(): void {
    if (this.sent.length > 0) this.emit({ type: "text_discard", keep: this.keep });
    this.raw = "";
    this.sent = "";
  }

  private send(styled: string, final: boolean): void {
    if (styled.startsWith(this.sent)) {
      const delta = styled.slice(this.sent.length);
      if (delta.length > 0) {
        this.emit({ type: "text", delta });
        this.sent = styled;
      }
      return;
    }
    // Should not happen, given what is held back. If it ever does, the
    // finished text replaces what was shown rather than being stitched on.
    if (final) {
      this.emit({ type: "text_discard", keep: this.keep });
      this.emit({ type: "text", delta: styled });
      this.sent = styled;
    }
  }
}
