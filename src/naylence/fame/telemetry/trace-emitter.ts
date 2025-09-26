import type { NodeEventListener } from '../node/node-event-listener.js';

export interface TraceEmitter extends NodeEventListener {
  record?(event: Record<string, unknown>): Promise<void> | void;
}
