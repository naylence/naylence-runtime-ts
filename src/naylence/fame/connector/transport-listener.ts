/**
 * Abstract base class for transport listeners.
 * 
 * Transport listeners handle network-level ingress connections (HTTP, WebSocket, etc.)
 * and manage the server lifecycle tied to node lifecycle.
 */

import type { NodeEventListener } from '../node/node-event-listener.js';
import type { NodeLike } from '../node/node-like.js';

/**
 * Abstract base class for transport listeners.
 * 
 * Transport listeners handle network-level ingress connections (HTTP, WebSocket, etc.)
 * and manage the server lifecycle tied to node lifecycle.
 */
export abstract class TransportListener implements NodeEventListener {
  readonly priority = 1000;

  /**
   * Called when the node has started and the transport listener should begin accepting connections.
   * 
   * @param node The node that has started
   */
  abstract onNodeStarted(node: NodeLike): Promise<void>;

  /**
   * Called when the node is stopping and the transport listener should stop accepting connections.
   * 
   * @param node The node that is stopping
   */
  abstract onNodeStopped(node: NodeLike): Promise<void>;

  /**
   * Return a descriptor that can be used to create callback grants
   * for this listener. This will be used to automatically derive
   * callback_grants in NodeAttachFrame for reverse admission.
   * 
   * @returns Dictionary containing connector type and configuration
   */
  getCallbackGrant(): Record<string, any> | null {
    return null;
  }

  /**
   * Return a connector configuration that can be used by parents to connect
   * to this listener for reverse connections.
   * 
   * @returns Dictionary with connector configuration or null if not supported
   */
  asCallbackGrant(): Record<string, any> | null {
    return this.getCallbackGrant();
  }
}