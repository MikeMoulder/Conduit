import { describe, it } from "node:test";
import { expect } from "chai";

import { houseStyle } from "../src/lib/copilot/style";

/**
 * Tests for the house style applied to every reply.
 *
 * What is protected is that no reply reaches a person with an em or en dash
 * or a list number written twice, whatever the model wrote, and that nothing
 * else about the text changes.
 */

describe("the house style", () => {
  it("turns an em dash between words into a comma", () => {
    expect(houseStyle("Tesla is down today — the Semi ramp is the story.")).to.equal(
      "Tesla is down today, the Semi ramp is the story.",
    );
  });

  it("does the same with no spaces around the dash", () => {
    expect(houseStyle("NVDA—up 1.4%")).to.equal("NVDA, up 1.4%");
  });

  it("turns a number range into words", () => {
    expect(houseStyle("between 9–5 percent")).to.equal("between 9 to 5 percent");
  });

  it("writes a doubled list number once", () => {
    expect(houseStyle("1. 1.Give me demo cash\n2. 2. Open my main wallet")).to.equal(
      "1. Give me demo cash\n2. Open my main wallet",
    );
  });

  it("leaves ordinary text, hyphens and decimals alone", () => {
    const text = "A pre-IPO name is up 2.5% today.\n1. Buy $100 of NVDA";
    expect(houseStyle(text)).to.equal(text);
  });
});
