import type { RunEventResponse } from '../api';

export const RUN_EVENT_PAGE_SIZE = 200;

export type RunEventBuffer = {
  runId: string;
  lastSequence: number;
  events: RunEventResponse[];
};

export function createRunEventBuffer(runId: string): RunEventBuffer {
  return { runId, lastSequence: -1, events: [] };
}

export function appendRunEventPage(
  buffer: RunEventBuffer,
  page: RunEventResponse[],
): RunEventBuffer {
  const additions: RunEventResponse[] = [];
  let lastSequence = buffer.lastSequence;

  for (const event of page) {
    if (event.run_id !== buffer.runId) {
      throw new Error('An event belongs to a different run.');
    }
    if (event.sequence <= buffer.lastSequence) continue;
    if (event.sequence !== lastSequence + 1) {
      throw new Error('The run event sequence has a gap or is out of order.');
    }
    additions.push(event);
    lastSequence = event.sequence;
  }

  if (additions.length === 0) return buffer;
  return {
    runId: buffer.runId,
    lastSequence,
    events: [...buffer.events, ...additions],
  };
}
