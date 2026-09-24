import type { PublicKey } from "@solana/web3.js";

import type { ToolDeclaration } from "../gemini";
import type { Card, PendingAction, Source } from "./events";

/**
 * The shape every copilot tool shares.
 *
 * In its own module so the tool files can be split by subject, the mandate
 * tools in one and the main wallet tools in another, without importing each
 * other to reach a type.
 */

export interface ToolContext {
  /** The connected wallet. Null when nobody is connected. */
  owner: PublicKey | null;
  /** Lets a slow tool report progress into the step list. */
  onProgress?: (label: string, detail?: string) => void;
}

export interface ToolOutcome {
  /** Compact, for the model. */
  result: Record<string, unknown>;
  /** One line for the step list. */
  summary: string;
  /** Rich, for the person. */
  card?: Card;
  sources?: Source[];
  /** Set when the tool prepared something that needs a human decision. */
  action?: PendingAction;
}

export interface CopilotTool {
  declaration: ToolDeclaration;
  /** What the step list says while this runs. */
  label: string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

/** Thrown when a tool cannot proceed. The message goes back to the model. */
export class ToolError extends Error {}
