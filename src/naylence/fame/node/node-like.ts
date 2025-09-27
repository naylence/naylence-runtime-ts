/**
 * NodeLike protocol interface for Fame node implementations.
 * 
 * This interface defines the contract that all Fame nodes must implement,
 * providing a comprehensive API for node lifecycle, messaging, and routing.
 */

import type {
  FameAddress,
  FameConnector,
  FameDeliveryContext,
  FameEnvelope,
  DeliveryAckFrame,
  EnvelopeFactory,
  FameEnvelopeHandler,
  FameRPCHandler,
  Binding,
} from 'naylence-core';

import type { AdmissionClient } from './admission/admission-client.js';
import type { NodeEventListener } from './node-event-listener.js';
import type { DeliveryPolicy } from '../delivery/delivery-policy.js';
import type { SecurityManager } from '../security/security-manager.js';
import type { StorageProvider } from '../storage/storage-provider.js';
import { CryptoProvider } from '../security/index.js';

/**
 * The main NodeLike protocol interface.
 * 
 * This protocol is implemented by all Fame node types and provides
 * a comprehensive API for node lifecycle management, messaging,
 * routing, and service invocation.
 */
export interface NodeLike {
  /** Unique node identifier */
  readonly id: string;

  /** System identifier (may be null for standalone nodes) */
  readonly sid: string | null;

  /** Physical path in the Fame network hierarchy */
  readonly physicalPath: string;

  /** Set of accepted logical addresses */
  readonly acceptedLogicals: Set<string>;

  /** Factory for creating Fame envelopes */
  readonly envelopeFactory: EnvelopeFactory;

  /** Default delivery policy for this node */
  readonly deliveryPolicy: DeliveryPolicy | null;

  /** Default binding path for services */
  readonly defaultBindingPath: string;

  /** Whether this node has a parent in the hierarchy */
  readonly hasParent: boolean;

  /** Security manager for this node */
  readonly securityManager: SecurityManager | null;

  /** Admission client for connecting to parents */
  readonly admissionClient: AdmissionClient | null;

  /** List of registered event listeners */
  readonly eventListeners: NodeEventListener[];

  /** Upstream connector for parent communication */
  readonly upstreamConnector: FameConnector | null;

  /** Public URL for this node (if available) */
  readonly publicUrl: string | null;

  /** Storage provider for persistent data */
  readonly storageProvider: StorageProvider;

  readonly cryptoProvider: CryptoProvider;

  /**
   * Add an event listener to this node.
   * 
   * @param listener The event listener to add
   */
  addEventListener(listener: NodeEventListener): void;

  /**
   * Remove an event listener from this node.
   * 
   * @param listener The event listener to remove
   */
  removeEventListener(listener: NodeEventListener): void;

  /**
   * Start the node and all its services.
   */
  start(): Promise<void>;

  /**
   * Stop the node and clean up resources.
   */
  stop(): Promise<void>;

  /**
   * Bind a participant address for message handling.
   * 
   * @param participant The participant identifier to bind
   * @returns A binding object for the participant
   */
  bind(participant: string): Promise<Binding>;

  /**
   * Unbind a participant address.
   * 
   * @param participant The participant identifier to unbind
   */
  unbind(participant: string): Promise<void>;

  /**
   * Send an envelope with optional delivery guarantees.
   * 
   * @param envelope The envelope to send
   * @param context Optional delivery context
   * @param deliveryPolicy Optional delivery policy override
   * @param deliveryFn Optional custom delivery function
   * @param timeoutMs Optional timeout in milliseconds
   * @returns Delivery acknowledgment if required
   */
  send(
    envelope: FameEnvelope,
    context?: FameDeliveryContext,
    deliveryPolicy?: DeliveryPolicy,
    deliveryFn?: (envelope: FameEnvelope, context?: FameDeliveryContext) => Promise<any>,
    timeoutMs?: number
  ): Promise<DeliveryAckFrame | null>;

  /**
   * Listen for messages on a specific recipient address.
   * 
   * @param recipient The recipient identifier
   * @param handler The message handler function
   * @param pollTimeoutMs Optional polling timeout
   * @returns The bound address for the listener
   */
  listen(
    recipient: string,
    handler: FameEnvelopeHandler,
    pollTimeoutMs?: number
  ): Promise<FameAddress>;

  /**
   * Listen for RPC calls on a specific service.
   * 
   * @param serviceName The service name
   * @param handler The RPC handler function
   * @param pollTimeoutMs Polling timeout in milliseconds
   * @returns The bound address for the service
   */
  listenRpc(
    serviceName: string,
    handler: FameRPCHandler,
    pollTimeoutMs: number
  ): Promise<FameAddress>;

  /**
   * Invoke an RPC method on a target address.
   * 
   * @param targetAddr The target service address
   * @param method The method name to invoke
   * @param params The method parameters
   * @param timeoutMs Timeout in milliseconds
   * @returns The method result
   */
  invoke(
    targetAddr: FameAddress,
    method: string,
    params: Record<string, any>,
    timeoutMs: number
  ): Promise<any>;

  /**
   * Invoke an RPC method by capability discovery.
   * 
   * @param capabilities List of required capabilities
   * @param method The method name to invoke
   * @param params The method parameters
   * @param timeoutMs Timeout in milliseconds
   * @returns The method result
   */
  invokeByCapability(
    capabilities: string[],
    method: string,
    params: Record<string, any>,
    timeoutMs: number
  ): Promise<any>;

  /**
   * Invoke a streaming RPC method on a target address.
   * 
   * @param targetAddr The target service address
   * @param method The method name to invoke
   * @param params The method parameters
   * @param timeoutMs Timeout in milliseconds
   * @returns AsyncIterator for streaming results
   */
  invokeStream(
    targetAddr: FameAddress,
    method: string,
    params: Record<string, any>,
    timeoutMs: number
  ): AsyncIterableIterator<any>;

  /**
   * Invoke a streaming RPC method by capability discovery.
   * 
   * @param capabilities List of required capabilities
   * @param method The method name to invoke
   * @param params The method parameters
   * @param timeoutMs Timeout in milliseconds
   * @returns AsyncIterator for streaming results
   */
  invokeByCapabilityStream(
    capabilities: string[],
    method: string,
    params: Record<string, any>,
    timeoutMs: number
  ): AsyncIterableIterator<any>;

  /**
   * Deliver an envelope through the node's routing system.
   * 
   * @param envelope The envelope to deliver
   * @param context Optional delivery context
   */
  deliver(envelope: FameEnvelope, context?: FameDeliveryContext): Promise<void>;

  /**
   * Deliver an envelope to a local address.
   * 
   * @param address The local address to deliver to
   * @param envelope The envelope to deliver
   * @param context Optional delivery context
   */
  deliverLocal(
    address: FameAddress,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void>;

  /**
   * Forward an envelope to the upstream parent.
   * 
   * @param envelope The envelope to forward
   * @param context Optional delivery context
   */
  forwardUpstream(envelope: FameEnvelope, context?: FameDeliveryContext): Promise<void>;

  /**
   * Check if an address is handled locally by this node.
   * 
   * @param address The address to check
   * @returns True if the address is local
   */
  hasLocal(address: FameAddress): boolean;

  /**
   * Gather supported callback grants from transport listeners.
   * 
   * @returns List of callback grant configurations
   */
  gatherSupportedCallbackGrants(): Record<string, any>[];

  /**
   * Dispatch a generic event to all event listeners.
   * 
   * @param eventName The name of the event
   * @param args Event arguments
   * @param kwargs Event keyword arguments
   */
  dispatchEvent(eventName: string, ...args: any[]): Promise<void>;

  /**
   * Dispatch an envelope-related event to all event listeners.
   * 
   * @param eventName The name of the event
   * @param args Event arguments
   * @param kwargs Event keyword arguments
   * @returns Modified envelope or null
   */
  dispatchEnvelopeEvent(eventName: string, ...args: any[]): Promise<FameEnvelope | null>;
}

/**
 * Utility function to check if an object implements the NodeLike interface.
 * 
 * @param obj The object to check
 * @returns True if the object implements NodeLike
 */
export function isNodeLike(obj: any): obj is NodeLike {
  return obj &&
    typeof obj.id === 'string' &&
    typeof obj.physicalPath === 'string' &&
    obj.acceptedLogicals instanceof Set &&
    typeof obj.hasParent === 'boolean' &&
    Array.isArray(obj.eventListeners) &&
    typeof obj.addEventListener === 'function' &&
    typeof obj.removeEventListener === 'function' &&
    typeof obj.start === 'function' &&
    typeof obj.stop === 'function' &&
    typeof obj.bind === 'function' &&
    typeof obj.unbind === 'function' &&
    typeof obj.send === 'function' &&
    typeof obj.listen === 'function' &&
    typeof obj.listenRpc === 'function' &&
    typeof obj.invoke === 'function' &&
    typeof obj.invokeByCapability === 'function' &&
    typeof obj.deliver === 'function' &&
    typeof obj.deliverLocal === 'function' &&
    typeof obj.forwardUpstream === 'function' &&
    typeof obj.hasLocal === 'function' &&
    typeof obj.gatherSupportedCallbackGrants === 'function';
}