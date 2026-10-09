"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

import { LIGHT_QUERY, THEME_KEY, resolveTheme, type ThemePreference } from "@/lib/theme";

/**
 * Light or dark, and whether that follows the device.
 *
 * The preference lives in the browser and is read as an external store, like
 * the sidebar, so nothing renders one theme and then corrects to another.
 * What is drawn is set on the html element as data-theme, first by the
 * script in the layout before the page paints, then here when the person
 * changes it or the device switches while they have chosen to follow it.
 */

const listeners = new Set<() => void>();
let fallback: ThemePreference = "system";

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === "light" || stored === "dark" || stored === "system" ? stored : fallback;
  } catch {
    return fallback;
  }
}

function apply(preference: ThemePreference) {
  document.documentElement.dataset.theme = resolveTheme(preference, window.matchMedia(LIGHT_QUERY).matches);
}

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const preference = useSyncExternalStore(subscribe, readPreference, () => "system" as const);

  // Following the device means following it when it changes, too.
  useEffect(() => {
    if (preference !== "system") return;
    const query = window.matchMedia(LIGHT_QUERY);
    const follow = () => apply("system");
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    fallback = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Refused storage still changes the theme for this visit.
    }
    apply(next);
    listeners.forEach((listener) => listener());
  }, []);

  return [preference, setPreference];
}
