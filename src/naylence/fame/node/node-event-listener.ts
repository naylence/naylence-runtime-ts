/**
 * Node event listener interface for clean, event-driven node lifecycle management.
 */

import type {
  FameAddress,
  FameConnector,
  FameDeliveryContext,
  FameEnvelope,
  NodeWelcomeFrame,
} from 'naylence-core';

import type { AttachInfo } from './admission/node-attach-client.js';
// Import NodeLike from the proper module
import type { NodeLike } from './node-like.js';

/**
 * Protocol for components that need to respond to node lifecycle events.
 * 
 * This protocol enables clean, event-driven initialization and management of
 * various node subsystems (security, routing, monitoring, etc.), replacing
 * ad-hoc initialization patterns with a structured event-based approach.
 * 
 * Components implementing this protocol can be registered with nodes to
 * receive lifecycle events and perform their specific setup, processing,
 * and cleanup tasks at the appropriate times.
 * 
 * All methods have default implementations (empty/pass-through), so implementing
 * classes only need to override the events they care about.
 */
export interface NodeEventListener {
  /**
   * The priority of this event listener for ordering during event dispatch.
   * 
   * Lower values mean higher priority (executed first). Event listeners with
   * the same priority are ordered according to their original placement in
   * the event_listeners list.
   * 
   * Default priority is 1000 to allow both higher priority (< 1000) and
   * lower priority (> 1000) listeners to be easily added.
   */
  readonly priority: number;

  /**
   * Called when a node has been started and is ready for operation.
   * 
   * This event is dispatched after the node has:
   * - Established its physical path and SID
   * - Connected to upstream (if applicable)
   * - Completed handshake (if applicable)
   * - Set up accepted logicals
   */
  onNodeStarted?(node: NodeLike): Promise<void>;

  /**
   * Called when a child node receives a welcome frame during admission.
   * 
   * This event allows components to handle setup and initialization
   * based on the welcome frame from the parent.
   */
  onWelcome?(welcomeFrame: NodeWelcomeFrame): Promise<void>;

  /**
   * Called when a heartbeat acknowledgment is received from upstream.
   * 
   * This event allows components to perform processing on heartbeat frames
   * as needed by their specific requirements.
   */
  onHeartbeatReceived?(envelope: FameEnvelope): Promise<void>;

  /**
   * Called when a heartbeat is sent to upstream.
   */
  onHeartbeatSent?(envelope: FameEnvelope): Promise<void>;

  /**
   * Called when a node has been fully initialized but before it starts.
   * 
   * This event is dispatched after the node has completed construction,
   * including all sub-components like routing capabilities, but before
   * the node actually starts operating. This is the ideal place to:
   * - Perform final configuration based on node capabilities
   * - Set up cross-component dependencies
   * - Initialize subsystem contexts with node information
   */
  onNodeInitialized?(node: NodeLike): Promise<void>;

  /**
   * Called when a sentinel successfully attaches to a peer.
   * 
   * This event is dispatched after the sentinel has:
   * - Successfully connected to a peer
   * - Received peer attachment information
   * - But before normal peer-to-peer operation begins
   * 
   * This is the ideal place to handle peer-specific setup, including:
   * - Processing peer information and capabilities
   * - Setting up peer-specific configurations
   * - Updating subsystems with peer routing information
   */
  onNodeAttachToPeer?(node: NodeLike, attachInfo: AttachInfo, connector: FameConnector): Promise<void>;

  /**
   * Called when a child node successfully attaches to an upstream parent.
   * 
   * This event is dispatched after the node has:
   * - Received attachment information from the parent
   * - Updated its physical path and SID
   * - But before normal operation begins
   * 
   * This is the ideal place to handle parent-specific setup, policy
   * validation, and other attach-specific initialization logic.
   */
  onNodeAttachToUpstream?(node: NodeLike, attachInfo: AttachInfo): Promise<void>;

  /**
   * Called when an envelope is received by the node.
   * 
   * This event allows components to perform processing on incoming envelopes
   * as needed by their specific requirements.
   * 
   * @returns The processed envelope or null to halt processing
   */
  onEnvelopeReceived?(node: NodeLike, envelope: FameEnvelope, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called when a node is about to deliver an envelope locally.
   * 
   * This event allows components to process, transform, or filter
   * envelopes before local delivery. Components can:
   * - Apply validation policies (security, routing, content validation)
   * - Transform or decrypt envelope content
   * - Log or monitor delivery events
   * - Reject envelopes by returning null
   * 
   * @returns Transformed envelope for continued processing, or null to halt delivery
   */
  onDeliverLocal?(node: NodeLike, address: FameAddress, envelope: FameEnvelope, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called when a node is about to process an envelope for delivery.
   * 
   * This event allows components to handle all envelope processing
   * including validation, transformation, and other inbound processing.
   * Components can:
   * - Decrypt or transform envelopes and frames
   * - Verify signatures or apply validation policies
   * - Log or monitor envelope processing
   * - Transform envelope content
   * - Reject envelopes by returning null
   * 
   * @returns Transformed envelope for continued processing, or null to halt delivery
   */
  onDeliver?(node: NodeLike, envelope: FameEnvelope, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called when a node is about to forward an envelope upstream.
   * 
   * This event allows components to handle outbound processing
   * including transformation, validation, and other outbound processing.
   * Components can:
   * - Encrypt or transform envelopes for upstream transmission
   * - Sign envelopes or apply validation
   * - Apply outbound policies and monitoring
   * - Transform envelope content
   * - Reject forwarding by returning null
   * 
   * @returns Transformed envelope for continued processing, or null to halt forwarding
   */
  onForwardUpstream?(node: NodeLike, envelope: FameEnvelope, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called when a sentinel is about to forward an envelope to a downstream route.
   * 
   * This event allows components to handle outbound processing
   * for routing-specific forwarding including transformation, validation, and other
   * outbound processing for downstream routes.
   * Components can:
   * - Transform or encrypt envelopes for downstream transmission
   * - Apply validation and routing policies
   * - Monitor and log routing operations
   * - Transform envelope content
   * - Reject forwarding by returning null
   * 
   * @returns Transformed envelope for continued processing, or null to halt forwarding
   */
  onForwardToRoute?(node: NodeLike, nextSegment: string, envelope: FameEnvelope, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called when a sentinel is about to forward an envelope to a peer.
   * 
   * This event allows components to handle outbound processing
   * for peer forwarding including transformation, validation, and other outbound
   * processing for peer-to-peer communication.
   * Components can:
   * - Transform or encrypt envelopes for peer transmission
   * - Apply validation and peer-specific policies
   * - Monitor and log peer communications
   * - Transform envelope content
   * - Reject forwarding by returning null
   * 
   * @returns Transformed envelope for continued processing, or null to halt forwarding
   */
  onForwardToPeer?(node: NodeLike, peerSegment: string, envelope: FameEnvelope, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called after a node completes forwarding an envelope upstream.
   * 
   * This event allows components to handle post-forwarding processing
   * including cleanup, logging, metrics collection, and error handling.
   * Components can:
   * - Log forwarding completion and status
   * - Collect metrics and monitoring data
   * - Handle errors and perform cleanup
   * - Update state based on forwarding results
   * - Perform audit logging
   * 
   * @returns The envelope for continued processing
   */
  onForwardUpstreamComplete?(node: NodeLike, envelope: FameEnvelope, result?: any, error?: Error, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called after a sentinel completes forwarding an envelope to a downstream route.
   * 
   * This event allows components to handle post-forwarding processing
   * for routing-specific operations including cleanup, logging, and error handling.
   * Components can:
   * - Log routing completion and status
   * - Collect routing metrics and monitoring data
   * - Handle routing errors and perform cleanup
   * - Update routing state based on results
   * - Perform routing audit logging
   * 
   * @returns The envelope for continued processing
   */
  onForwardToRouteComplete?(node: NodeLike, nextSegment: string, envelope: FameEnvelope, result?: any, error?: Error, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called after a sentinel completes forwarding an envelope to a peer.
   * 
   * This event allows components to handle post-forwarding processing
   * for peer communication including cleanup, logging, and error handling.
   * Components can:
   * - Log peer communication completion and status
   * - Collect peer metrics and monitoring data
   * - Handle peer communication errors and perform cleanup
   * - Update peer state based on results
   * - Perform peer audit logging
   * 
   * @returns The envelope for continued processing
   */
  onForwardToPeerComplete?(node: NodeLike, peerSegment: string, envelope: FameEnvelope, result?: any, error?: Error, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called when a sentinel is about to forward an envelope to multiple peers.
   * 
   * This event allows components to handle outbound processing
   * for multi-peer forwarding including transformation, validation, and other outbound
   * processing for broadcast-style peer communication.
   * Components can:
   * - Transform or encrypt envelopes for peer transmission
   * - Apply validation and broadcast policies
   * - Monitor and log broadcast operations
   * - Transform envelope content
   * - Reject forwarding by returning null
   * 
   * @returns Transformed envelope for continued processing, or null to halt forwarding
   */
  onForwardToPeers?(node: NodeLike, envelope: FameEnvelope, peers?: any, excludePeers?: any, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called after a sentinel completes forwarding an envelope to multiple peers.
   * 
   * This event allows components to handle post-forwarding processing
   * for multi-peer communication including cleanup, logging, and error handling.
   * Components can:
   * - Log broadcast completion and status
   * - Collect broadcast metrics and monitoring data
   * - Handle broadcast errors and perform cleanup
   * - Update peer state based on results
   * - Perform broadcast audit logging
   * 
   * @returns The envelope for continued processing
   */
  onForwardToPeersComplete?(node: NodeLike, envelope: FameEnvelope, peers?: any, excludePeers?: any, result?: any, error?: Error, context?: FameDeliveryContext): Promise<FameEnvelope | null>;

  /**
   * Called when a child node is attaching to handle security validation.
   * 
   * This event allows components to validate keys and security compatibility
   * between the parent (us) and the attaching child node.
   */
  onChildAttach?(options: {
    childSystemId: string;
    childKeys?: any;
    nodeLike: NodeLike;
    originType?: any;
    assignedPath?: string;
    oldAssignedPath?: string;
    isRebind?: boolean;
  }): Promise<void>;

  /**
   * Called when the node receives an epoch change notification.
   * 
   * This event is dispatched when the node's epoch changes, which typically
   * happens when the upstream parent's routing state changes. This is an
   * ideal place to handle:
   * - State updates and re-announcements to upstream
   * - Address rebinding and capability re-advertisement
   * - Routing table updates
   * - Any epoch-specific subsystem state updates
   */
  onEpochChange?(node: NodeLike, epoch: string): Promise<void>;

  /**
   * Called when a node is preparing to stop but has not yet fully shut down.
   * 
   * This event is dispatched before the node begins its shutdown sequence,
   * allowing components to perform pre-shutdown tasks such as:
   * - Flushing caches or buffers
   * - Notifying dependent services
   * - Preparing for resource cleanup
   */
  onNodePreparingToStop?(node: NodeLike): Promise<void>;

  /**
   * Called when a node is being stopped and should clean up resources.
   * 
   * This event is dispatched during node shutdown, allowing components
   * to clean up resources, stop background tasks, and gracefully shut down
   * their services (monitoring, security, routing, etc.).
   */
  onNodeStopped?(node: NodeLike): Promise<void>;
}

/**
 * Abstract base class providing default implementations for NodeEventListener.
 * 
 * This class provides a convenient base for implementing node event listeners
 * where you only need to override specific lifecycle methods. All methods
 * have sensible default implementations.
 */
export abstract class BaseNodeEventListener implements NodeEventListener {
  /**
   * Default priority is 1000 to allow both higher priority (< 1000) and
   * lower priority (> 1000) listeners to be easily added.
   */
  public readonly priority: number;

  constructor(priority: number = 1000) {
    this.priority = priority;
  }

  async onNodeStarted?(_node: NodeLike): Promise<void> {
    // Default implementation does nothing
  }

  async onWelcome?(_welcomeFrame: NodeWelcomeFrame): Promise<void> {
    // Default implementation does nothing
  }

  async onHeartbeatReceived?(_envelope: FameEnvelope): Promise<void> {
    // Default implementation does nothing
  }

  async onHeartbeatSent?(_envelope: FameEnvelope): Promise<void> {
    // Default implementation does nothing
  }

  async onNodeInitialized?(_node: NodeLike): Promise<void> {
    // Default implementation does nothing
  }

  async onNodeAttachToPeer?(_node: NodeLike, _attachInfo: AttachInfo, _connector: FameConnector): Promise<void> {
    // Default implementation does nothing
  }

  async onNodeAttachToUpstream?(_node: NodeLike, _attachInfo: AttachInfo): Promise<void> {
    // Default implementation does nothing
  }

  async onEnvelopeReceived?(_node: NodeLike, envelope: FameEnvelope, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onDeliverLocal?(_node: NodeLike, _address: FameAddress, envelope: FameEnvelope, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onDeliver?(_node: NodeLike, envelope: FameEnvelope, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onForwardUpstream?(_node: NodeLike, envelope: FameEnvelope, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onForwardToRoute?(_node: NodeLike, _nextSegment: string, envelope: FameEnvelope, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onForwardToPeer?(_node: NodeLike, _peerSegment: string, envelope: FameEnvelope, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onForwardUpstreamComplete?(_node: NodeLike, envelope: FameEnvelope, _result?: any, _error?: Error, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onForwardToRouteComplete?(_node: NodeLike, _nextSegment: string, envelope: FameEnvelope, _result?: any, _error?: Error, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onForwardToPeerComplete?(_node: NodeLike, _peerSegment: string, envelope: FameEnvelope, _result?: any, _error?: Error, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onForwardToPeers?(_node: NodeLike, envelope: FameEnvelope, _peers?: any, _excludePeers?: any, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onForwardToPeersComplete?(_node: NodeLike, envelope: FameEnvelope, _peers?: any, _excludePeers?: any, _result?: any, _error?: Error, _context?: FameDeliveryContext): Promise<FameEnvelope | null> {
    // Default implementation passes envelope through unchanged
    return envelope;
  }

  async onChildAttach?(_options: {
    childSystemId: string;
    childKeys?: any;
    nodeLike: NodeLike;
    originType?: any;
    assignedPath?: string;
    oldAssignedPath?: string;
    isRebind?: boolean;
  }): Promise<void> {
    // Default implementation does nothing
  }

  async onEpochChange?(_node: NodeLike, _epoch: string): Promise<void> {
    // Default implementation does nothing
  }

  async onNodePreparingToStop?(_node: NodeLike): Promise<void> {
    // Default implementation does nothing
  }

  async onNodeStopped?(_node: NodeLike): Promise<void> {
    // Default implementation does nothing
  }
}