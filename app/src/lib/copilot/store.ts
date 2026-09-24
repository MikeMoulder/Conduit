import { actionTitle, type Card, type PendingAction, type Source } from "./events";

/**
 * Conversation state, kept outside React.
 *
 * The thread is external mutable state that arrives from a network stream, so
 * it is modelled as an external store and read with `useSyncExternalStore`
 * rather than mirrored into component state. That is the API React provides for
 * exactly this, and it removes the whole class of bug where an effect
 * synchronises one copy of the truth into another and the two drift.
 *
 * It also avoids setting state inside an effect to hydrate from localStorage,
 * which is both a lint error in this project and a real extra render.
 *
 * Nothing here is authoritative about the chain. Conversations are a record of
 * what was said, not of what happened, and every figure in them was read from
 * an account at the time it was shown. Clearing this loses the transcript and
 * nothing else.
 */

const STORAGE_KEY = "conduit.conversations.v1";
const MAX_STORED = 30;

export interface Step {
  id: string;
  label: string;
  detail?: string;
  /** Present when the step is a tool rather than a status line. */
  name?: string;
  state: "running" | "ok" | "failed";
  durationMs?: number;
  summary?: string;
  error?: string;
}

export interface Turn {
  id: string;
  role: "user" | "assistant";
  /**
   * Set on a user turn the interface sent rather than the person: the outcome
   * of an approval card, so the copilot can say what happened and what is next.
   * Shown as a status line, never as a bubble the person appears to have typed.
   */
  event?: boolean;
  /**
   * Approval cards that were never answered before the page reloaded. Kept as
   * titles so the text around them, which still says "approve this", is not
   * left pointing at nothing.
   */
  expired?: string[];
  /** Results of approval cards, drawn where the card was. */
  outcomes?: Card[];
  text: string;
  steps: Step[];
  cards: Card[];
  actions: PendingAction[];
  sources: Source[];
  meta?: { model: string; totalMs: number; toolCalls: number };
  error?: { message: string; detail?: string };
  streaming: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  turns: Turn[];
  updatedAt: number;
}

interface State {
  conversations: Conversation[];
  currentId: string | null;
  busy: boolean;
  /** True once localStorage has been read, so the sidebar can avoid flashing. */
  hydrated: boolean;
}

const EMPTY: State = {
  conversations: [],
  currentId: null,
  busy: false,
  hydrated: false,
};

let state: State = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/**
 * Actions are stripped before storing. An approval that was never given should
 * not come back offering itself a week later against a portfolio that has moved
 * on, and a run in progress is not a thing that survives a reload.
 */
function persist() {
  try {
    const stored = state.conversations.slice(0, MAX_STORED).map((c) => ({
      ...c,
      turns: c.turns.map((t) => ({
        ...t,
        actions: [],
        expired: [...(t.expired ?? []), ...t.actions.map(actionTitle)],
        streaming: false,
      })),
    }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Private windows, blocked storage, quota. The conversation still works,
    // it just will not be there next time.
  }
}

function load(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Must return the same reference until something actually changes, or
 * `useSyncExternalStore` re-renders forever.
 */
export function getSnapshot(): State {
  return state;
}

export function getServerSnapshot(): State {
  return EMPTY;
}

/** Called once from the client, on mount. */
export function hydrate(): void {
  if (state.hydrated) return;
  const conversations = load();
  state = { ...state, conversations, hydrated: true };
  emit();
}

const id = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function update(mutate: (draft: State) => State, save = true) {
  state = mutate(state);
  if (save) persist();
  emit();
}

function mapCurrent(
  draft: State,
  mutate: (conversation: Conversation) => Conversation,
): State {
  return {
    ...draft,
    conversations: draft.conversations.map((c) =>
      c.id === draft.currentId ? mutate(c) : c,
    ),
  };
}

export function newConversation(): void {
  update((draft) => ({ ...draft, currentId: null }), false);
}

export function selectConversation(conversationId: string): void {
  update((draft) => ({ ...draft, currentId: conversationId }), false);
}

export function deleteConversation(conversationId: string): void {
  update((draft) => ({
    ...draft,
    conversations: draft.conversations.filter((c) => c.id !== conversationId),
    currentId: draft.currentId === conversationId ? null : draft.currentId,
  }));
}

/** A title short enough for the sidebar, taken from what was actually asked. */
function titleFrom(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 47)}...` : flat;
}

/** Opens a turn for the question and an empty one for the answer. */
export function beginTurn(
  question: string,
  options: { event?: boolean } = {},
): { turnId: string } {
  const turnId = id();

  const userTurn: Turn = {
    id: id(),
    role: "user",
    event: options.event,
    text: question,
    steps: [],
    cards: [],
    actions: [],
    sources: [],
    streaming: false,
  };

  const assistantTurn: Turn = {
    id: turnId,
    role: "assistant",
    text: "",
    steps: [],
    cards: [],
    actions: [],
    sources: [],
    streaming: true,
  };

  update((draft) => {
    if (draft.currentId) {
      return {
        ...mapCurrent(draft, (c) => ({
          ...c,
          turns: [...c.turns, userTurn, assistantTurn],
          updatedAt: Date.now(),
        })),
        busy: true,
      };
    }

    const conversation: Conversation = {
      id: id(),
      title: titleFrom(question),
      turns: [userTurn, assistantTurn],
      updatedAt: Date.now(),
    };

    return {
      ...draft,
      conversations: [conversation, ...draft.conversations],
      currentId: conversation.id,
      busy: true,
    };
  });

  return { turnId };
}

export function patchTurn(turnId: string, mutate: (turn: Turn) => Turn): void {
  update((draft) =>
    mapCurrent(draft, (c) => ({
      ...c,
      turns: c.turns.map((t) => (t.id === turnId ? mutate(t) : t)),
      updatedAt: Date.now(),
    })),
  );
}

export function finishTurn(turnId: string): void {
  update((draft) => ({
    ...mapCurrent(draft, (c) => ({
      ...c,
      turns: c.turns.map((t) =>
        t.id === turnId ? { ...t, streaming: false } : t,
      ),
    })),
    busy: false,
  }));
}

/**
 * Resolves an action: it leaves the pending list, and its outcome, when there
 * is one, is kept on the turn.
 *
 * The outcome used to live only inside the card component, so removing the
 * action unmounted the card and the result vanished with it. On the turn it is
 * part of the transcript, and survives a reload like everything else there.
 */
export function resolveAction(
  turnId: string,
  action: PendingAction,
  outcome: Card | null,
): void {
  patchTurn(turnId, (turn) => ({
    ...turn,
    actions: turn.actions.filter((a) => a !== action),
    outcomes: outcome ? [...(turn.outcomes ?? []), outcome] : turn.outcomes,
  }));
}

export function currentConversation(): Conversation | null {
  return state.conversations.find((c) => c.id === state.currentId) ?? null;
}
