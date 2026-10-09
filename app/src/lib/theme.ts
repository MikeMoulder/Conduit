/**
 * The theme preference and how it resolves, shared by the layout's head
 * script and the toggle.
 *
 * Kept out of the client hook on purpose: the layout is a server component,
 * and importing a constant from a "use client" module there hands back a
 * client reference instead of the string.
 */

export type ThemePreference = "system" | "light" | "dark";

export const THEME_KEY = "conduit:theme";
export const LIGHT_QUERY = "(prefers-color-scheme: light)";

/** The theme a preference comes to on this device right now. */
export function resolveTheme(preference: ThemePreference, deviceLight: boolean): "light" | "dark" {
  return preference === "system" ? (deviceLight ? "light" : "dark") : preference;
}

/** The order the toggle steps through. */
export function nextPreference(current: ThemePreference): ThemePreference {
  return current === "system" ? "light" : current === "light" ? "dark" : "system";
}

/**
 * Runs in the head before the page paints, so a light preference never
 * flashes dark first. A string because it must run before any bundle loads.
 */
export const THEME_SCRIPT = `(function(){try{var p=localStorage.getItem("${THEME_KEY}");var l=window.matchMedia("${LIGHT_QUERY}").matches;document.documentElement.dataset.theme=p==="light"||p==="dark"?p:(l?"light":"dark");}catch(e){document.documentElement.dataset.theme="dark";}})();`;
