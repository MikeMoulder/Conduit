"use client";

import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/hooks/use-theme";
import { nextPreference, type ThemePreference } from "@/lib/theme";

const LABEL: Record<ThemePreference, string> = {
  system: "Theme: matches your device",
  light: "Theme: light",
  dark: "Theme: dark",
};

/** One button that steps through device, light and dark. Icon only in the rail. */
export function ThemeToggle({ rail }: { rail: boolean }) {
  const [preference, setPreference] = useTheme();
  const Icon = preference === "light" ? Sun : preference === "dark" ? Moon : Monitor;
  const name = preference === "system" ? "Device" : preference === "light" ? "Light" : "Dark";

  return (
    <button
      type="button"
      onClick={() => setPreference(nextPreference(preference))}
      aria-label={LABEL[preference]}
      title={LABEL[preference]}
      className={`flex items-center gap-2.5 rounded-lg text-sm text-ink-muted transition-colors hover:bg-raised hover:text-ink ${
        rail ? "mx-auto size-10 justify-center" : "w-full px-3 py-2"
      }`}
    >
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      {!rail ? <span>Theme: {name}</span> : null}
    </button>
  );
}
