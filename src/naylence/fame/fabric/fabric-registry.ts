/**
 * Fabric Registry
 *
 * Provides a mapping from nodes to their associated fabrics.
 * This allows agents to retrieve the fabric they were registered on
 * without relying on the global fabric stack.
 */

import type { FameFabric } from '@naylence/core';
import type { NodeLike } from '../node/node-like.js';

/**
 * WeakMap to store the node-to-fabric mapping.
 * Using WeakMap ensures that nodes can be garbage collected
 * when no longer referenced elsewhere.
 */
const nodeToFabric = new WeakMap<NodeLike, FameFabric>();

/**
 * @internal
 * Associates a node with its fabric. This should only be called
 * by fabric implementations when they create or adopt a node.
 *
 * @param node - The node to associate
 * @param fabric - The fabric that owns the node
 */
export function _setFabricForNode(node: NodeLike, fabric: FameFabric): void {
  nodeToFabric.set(node, fabric);
}

/**
 * Retrieves the fabric associated with a node.
 *
 * This is useful for agents that need to access the fabric they
 * were registered on, particularly in environments where multiple
 * fabrics exist (e.g., React with multiple FabricProviders).
 *
 * @param node - The node to look up
 * @returns The fabric associated with the node, or undefined if not found
 */
export function getFabricForNode(node: NodeLike): FameFabric | undefined {
  return nodeToFabric.get(node);
}
