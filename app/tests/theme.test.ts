import { describe, it } from "node:test";
import { expect } from "chai";

import { THEME_KEY, THEME_SCRIPT, nextPreference, resolveTheme } from "../src/lib/theme";

/**
 * Tests for the theme preference.
 *
 * What is protected is that following the device really follows it, that the
 * toggle visits every choice and comes back round, and that the script run
 * before the page paints reads the same key the toggle writes.
 */

describe("the theme preference", () => {
  it("follows the device only when asked to", () => {
    expect(resolveTheme("system", true)).to.equal("light");
    expect(resolveTheme("system", false)).to.equal("dark");
    expect(resolveTheme("light", false)).to.equal("light");
    expect(resolveTheme("dark", true)).to.equal("dark");
  });

  it("steps through device, light and dark and back round", () => {
    expect(nextPreference("system")).to.equal("light");
    expect(nextPreference("light")).to.equal("dark");
    expect(nextPreference("dark")).to.equal("system");
  });

  it("reads the stored choice under the key the toggle writes, and falls back to dark", () => {
    expect(THEME_SCRIPT).to.include(`localStorage.getItem("${THEME_KEY}")`);
    expect(THEME_SCRIPT).to.include('dataset.theme="dark"');
  });
});
