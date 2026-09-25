/**
 * The house style, enforced on every reply before it is sent.
 *
 * The system prompt asks for it, and a small model forgets. Two rules are
 * mechanical enough to guarantee here instead of hoping:
 *
 * - No em or en dashes. A range of numbers becomes "to" ("9 to 5"), and any
 *   other dash becomes a comma.
 * - A list number written twice ("1. 1. Open your wallet") is written once.
 *
 * Pure, so it is tested directly.
 */
export function houseStyle(text: string): string {
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2")
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/, ,/g, ",")
    .replace(/^(\s*\d+\.)\s*\d+\.\s*/gm, "$1 ");
}
