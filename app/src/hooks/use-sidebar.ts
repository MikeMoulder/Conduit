"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Sidebar layout state.
 *
 * Both values live outside React, in the browser: whether the person folded
 * the sidebar into a rail, and whether the screen is wide enough to dock it at
 * all. Reading them as external stores avoids hydrating component state from
 * an effect, which would render the wrong width first and then correct it.
 */

const COLLAPSED_KEY = "conduit:sidebar-collapsed";
const DESKTOP_QUERY = "(min-width: 1024px)";

const listeners = new Set<() => void>();

/** Used when storage is refused, so the toggle still works for the session. */
let fallback = false;

function subscribeCollapsed(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY);
    return stored === null ? fallback : stored === "1";
  } catch {
    return fallback;
  }
}

/** Folded into an icon rail or not, remembered across reloads. */
export function useSidebarCollapsed(): [boolean, (next: boolean) => void] {
  const collapsed = useSyncExternalStore(
    subscribeCollapsed,
    readCollapsed,
    () => false,
  );

  const setCollapsed = useCallback((next: boolean) => {
    fallback = next;
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // Private windows can refuse storage. The toggle still works for the
      // session, it just is not remembered.
    }
    listeners.forEach((listener) => listener());
  }, []);

  return [collapsed, setCollapsed];
}

function subscribeDesktop(listener: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/**
 * True when the sidebar is docked beside the conversation rather than opened
 * as a drawer over it. A drawer is always shown in full, so only a docked
 * sidebar can be a rail.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}
