/**
 * World-sidebar session marker: the official `StateDot` state (running
 * activity, pending user interaction, finished-but-unopened reminder) for the
 * session cards this package renders in place of the disabled official
 * workspace browser.
 */
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives';

/** List-row activity facts the marker reads (the client Session list summary). */
export interface SessionMarkerFacts {
  /** The Session is running a turn or has running descendants. */
  readonly running: boolean;
  /** Finished running while not selected and not yet opened — the green reminder. */
  readonly completed?: boolean | undefined;
}

/**
 * Derive one Session row's marker with the official priority: a pending user
 * interaction outranks own activity, which outranks the completion reminder;
 * an idle Session shows no marker.
 * @param session - list-row activity facts.
 * @param pendingKind - domain-owned pending interaction kind for this Session, when one is published.
 * @returns the dot state to render, or undefined when the row shows none.
 */
export function sessionMarker(session: SessionMarkerFacts, pendingKind: string | undefined): StateDotState | undefined {
  switch (pendingKind) {
    case 'approval':
    case 'plan-review':
    case 'question':
      return 'warning';
    default: break;
  }
  if (session.running) return 'ongoing';
  if (session.completed === true) return 'done';
  return undefined;
}
