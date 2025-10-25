import {
  DeliveryOriginType,
  FameDeliveryContext,
  FameEnvelope,
  FameAddress,
  KeyRequestFrame,
  parseAddress,
  parseAddressComponents,
} from '@naylence/core';

import { isPoolLogical, matchesPoolLogical } from '../util/logicals.js';
import { normalizePath } from '../util/util.js';
import { HRWLoadBalancingStrategy } from './load-balancing/hrw-load-balancing-strategy.js';
import type { LoadBalancingStrategy } from './load-balancing/load-balancing-strategy.js';
import {
  DeliverLocal,
  Drop,
  ForwardChild,
  ForwardPeer,
  ForwardUp,
  type RouterState,
  type RoutingAction,
} from './router.js';
import type { RoutingPolicy } from './routing-policy.js';

const CONTROL_DROP_FRAMES = new Set(['NodeHello', 'NodeWelcome', 'NodeReject']);
const CONTROL_UP_FRAMES = new Set([
  'AddressBind',
  'AddressUnbind',
  'NodeHeartbeat',
]);
const ROUTABLE_FRAMES = new Set([
  'Data',
  'DeliveryAck',
  'SecureOpen',
  'SecureAccept',
  'SecureClose',
  'KeyRequest',
]);

export interface HybridPathRoutingPolicyOptions {
  loadBalancingStrategy?: LoadBalancingStrategy;
}

export class HybridPathRoutingPolicy implements RoutingPolicy {
  private readonly loadBalancingStrategy: LoadBalancingStrategy;

  constructor(options: HybridPathRoutingPolicyOptions = {}) {
    this.loadBalancingStrategy =
      options.loadBalancingStrategy ?? new HRWLoadBalancingStrategy();
  }

  public async decide(
    envelope: FameEnvelope,
    state: RouterState,
    context: FameDeliveryContext | null = null
  ): Promise<RoutingAction> {
    const frame = envelope.frame;
    if (!frame?.type) {
      return new Drop();
    }

    const frameType = frame.type;

    if (CONTROL_DROP_FRAMES.has(frameType)) {
      return new Drop();
    }

    if (CONTROL_UP_FRAMES.has(frameType)) {
      if (state.hasParent && !this.isFromUpstream(context)) {
        return new ForwardUp();
      }
      return new Drop();
    }

    let destination: FameAddress | string | null = null;
    if (frameType === 'KeyRequest') {
      const keyRequest = frame as KeyRequestFrame;
      destination = keyRequest.address ?? null;
      if (!destination) {
        return new Drop();
      }
    } else {
      if (!ROUTABLE_FRAMES.has(frameType) || !envelope.to) {
        return new Drop();
      }
      destination = envelope.to;
    }

    const destinationKey = normalizeAddressKey(destination);
    const [name, location] = parseAddress(destinationKey);
    const [, host, parsedPath] = parseAddressComponents(destinationKey);

    let path: string | null;
    if (parsedPath === null) {
      path = null;
    } else if (host !== null) {
      path = parsedPath;
    } else {
      path = location;
    }

    if (state.local.has(destinationKey)) {
      return new DeliverLocal(toFameAddress(destination));
    }

    const childSegment = state.downstreamAddressRoutes.get(destinationKey);
    if (childSegment) {
      if (this.originRouteMatches(context, childSegment)) {
        return new Drop();
      }
      return new ForwardChild(childSegment);
    }

    const peerSegment = state.peerAddressRoutes.get(destinationKey);
    if (peerSegment) {
      return new ForwardPeer(peerSegment);
    }

    if (host) {
      const poolChosen = this.findHostPoolRoute(name, host, state, envelope);
      if (poolChosen) {
        if (this.originRouteMatches(context, poolChosen)) {
          return new Drop();
        }
        return new ForwardChild(poolChosen);
      }
    }

    if (path !== null) {
      const logicalPath = computeLogical(path, state.physicalSegments);
      const normalizedLogical = normalizePath(logicalPath);
      const poolMembers = findPoolMembers(state, name, normalizedLogical);

      if (poolMembers) {
        const chosen = this.loadBalancingStrategy.choose(
          [name, logicalPath],
          Array.from(poolMembers),
          envelope
        );
        if (chosen) {
          if (this.originRouteMatches(context, chosen)) {
            return new Drop();
          }
          return new ForwardChild(chosen);
        }
      }
    }

    if (path !== null) {
      const destSegments = splitPath(path);

      if (destSegments.length > 0) {
        const first = destSegments[0];
        if (state.peerSegments.has(first)) {
          return new ForwardPeer(first);
        }

        if (
          state.physicalSegments.length > 0 &&
          startsWithSegments(destSegments, state.physicalSegments)
        ) {
          const remainder = destSegments.slice(state.physicalSegments.length);
          if (remainder.length === 0) {
            if (state.local.has(destinationKey)) {
              return new DeliverLocal(toFameAddress(destination));
            }
            return new Drop();
          }

          const nextSegment = remainder[0];
          if (state.childSegments.has(nextSegment)) {
            if (this.originRouteMatches(context, nextSegment)) {
              return new Drop();
            }
            return new ForwardChild(nextSegment);
          }
        } else if (state.physicalSegments.length === 0) {
          if (state.childSegments.has(first)) {
            if (this.originRouteMatches(context, first)) {
              return new Drop();
            }
            return new ForwardChild(first);
          }
        }
      }
    }

    if (state.hasParent && !this.isFromUpstream(context)) {
      return new ForwardUp();
    }

    return new Drop();
  }

  private originRouteMatches(
    context: FameDeliveryContext | null | undefined,
    childSegment: string
  ): boolean {
    return (
      context?.originType === DeliveryOriginType.DOWNSTREAM &&
      context.fromSystemId === childSegment
    );
  }

  private isFromUpstream(
    context: FameDeliveryContext | null | undefined
  ): boolean {
    return context?.originType === DeliveryOriginType.UPSTREAM;
  }

  private findHostPoolRoute(
    name: string,
    host: string,
    state: RouterState,
    envelope: FameEnvelope
  ): string | null {
    for (const [[poolName, poolPattern], poolMembers] of state.pools) {
      if (poolName !== name) {
        continue;
      }

      if (
        !isPoolLogical(poolPattern) ||
        !matchesPoolLogical(host, poolPattern)
      ) {
        continue;
      }

      const chosen = this.loadBalancingStrategy.choose(
        [poolName, poolPattern],
        Array.from(poolMembers),
        envelope
      );
      if (chosen) {
        return chosen;
      }
    }

    return null;
  }
}

function computeLogical(
  path: string,
  physicalSegments: readonly string[]
): string {
  const segments = splitPath(path);
  if (
    physicalSegments.length > 0 &&
    startsWithSegments(segments, physicalSegments)
  ) {
    const remainder = segments.slice(physicalSegments.length);
    return '/' + remainder.join('/');
  }
  return '/' + segments.join('/');
}

function startsWithSegments(
  pathSegments: readonly string[],
  prefix: readonly string[]
): boolean {
  if (prefix.length > pathSegments.length) {
    return false;
  }

  for (let i = 0; i < prefix.length; i++) {
    if (pathSegments[i] !== prefix[i]) {
      return false;
    }
  }

  return true;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function findPoolMembers(
  state: RouterState,
  name: string,
  logical: string
): ReadonlySet<string> | null {
  for (const [[poolName, poolPattern], members] of state.pools) {
    if (poolName === name && poolPattern === logical) {
      return members;
    }
  }
  return null;
}

function normalizeAddressKey(address: FameAddress | string): string {
  return typeof address === 'string' ? address : address.toString();
}

function toFameAddress(address: FameAddress | string): FameAddress {
  return address instanceof FameAddress ? address : new FameAddress(address);
}
