/**
 * AG-UI protocol event shapes emitted on the run stream.
 *
 * Wire format: each event is one HTTP stream frame with `event: ag_ui` and
 * the JSON event as `data`. The stream is AG-UI native — the only other frame
 * type is the transport-level `heartbeat`.
 */

import {
  EventType,
  type AGUIEvent,
  type AGUIEventOf,
  type Interrupt,
} from "@ag-ui/core";

export type AgUiEvent = AGUIEvent;
export type AgUiEventType = AgUiEvent["type"];
export type AgUiRunFinishedEvent = AGUIEventOf<EventType.RUN_FINISHED>;

export function runFinishedInterruptEvent(
  threadId: string,
  runId: string,
  interrupts: Interrupt | readonly Interrupt[]
): AgUiRunFinishedEvent {
  const interruptList = Array.isArray(interrupts)
    ? [...interrupts]
    : [interrupts];
  return {
    type: EventType.RUN_FINISHED,
    threadId,
    runId,
    outcome: {
      type: "interrupt",
      interrupts: interruptList,
    },
  };
}
