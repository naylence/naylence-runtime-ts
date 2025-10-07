import {
  AddressBindFrame,
  AddressUnbindFrame,
  Binding,
  CapabilityAdvertiseFrame,
  CapabilityWithdrawFrame,
  type CreateFameEnvelopeOptions,
  FameAddress,
  FameDeliveryContext,
  FameEnvelope,
  FameResponseType,
  formatAddress,
  formatAddressFromComponents,
  generateId,
  localDeliveryContext,
  parseAddress,
  parseAddressComponents,
} from 'naylence-core';
import type {
  AddressBindAckFrame,
  AddressUnbindAckFrame,
  CapabilityAdvertiseAckFrame,
  CapabilityWithdrawAckFrame,
} from 'naylence-core';
import { InMemoryReadWriteChannel } from '../channel/in-memory/in-memory-channel.js';
import type { KeyValueStore } from '../storage/key-value-store.js';
import { InMemoryKeyValueStore } from '../storage/in-memory-storage.js';
import type { EnvelopeFactory } from 'naylence-core';
import { currentTraceId } from '../util/envelope-context.js';
import { getLogger } from '../util/logging.js';
import { isPoolLogical, matchesPoolLogical } from '../util/logicals.js';

const logger = getLogger('binding-manager');

const SYSTEM_INBOX = '__sys__';
const DEFAULT_ACK_TIMEOUT_MS = 20_000;

type ForwardUpstreamFn = (
  envelope: FameEnvelope,
  context?: FameDeliveryContext
) => Promise<void>;

type BindingFactory = (address: FameAddress) => Binding;

export interface BindingStoreEntry {
  address: string;
  encryptionKeyId?: string | null;
  physicalPath?: string | null;
}

export interface BindingManagerOptions {
  hasUpstream: boolean;
  getId: () => string;
  getPhysicalPath: () => string;
  getAcceptedLogicals: () => Iterable<string>;
  forwardUpstream: ForwardUpstreamFn;
  envelopeFactory: EnvelopeFactory;
  deliveryTracker: DeliveryTrackerAdapter;
  getEncryptionKeyId?: () => string | null | undefined;
  bindingStore?: KeyValueStore<BindingStoreEntry>;
  bindingFactory?: BindingFactory;
  ackTimeoutMs?: number;
}

export interface DeliveryTrackerAdapter {
  track(
    envelope: FameEnvelope,
    options: { timeoutMs: number; expectedResponseType: FameResponseType }
  ): Promise<unknown>;
  awaitAck(envelopeId: string, timeoutMs?: number): Promise<FameEnvelope>;
  onEnvelopeDelivered(
    inboxName: string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<unknown>;
}

function toKey(address: FameAddress | string): string {
  return address.toString();
}

export class BindingManager {
  private readonly hasUpstream: boolean;
  private readonly getId: () => string;
  private readonly getPhysicalPath: () => string;
  private readonly getAcceptedLogicalsFn: () => Iterable<string>;
  private readonly forwardUpstream: ForwardUpstreamFn;
  private readonly getEncryptionKeyId:
    | (() => string | null | undefined)
    | undefined;
  private readonly bindingStore: KeyValueStore<BindingStoreEntry>;
  private readonly bindingFactory: BindingFactory;
  private readonly envelopeFactory: EnvelopeFactory;
  private readonly deliveryTracker: DeliveryTrackerAdapter;
  private readonly ackTimeoutMs: number;

  private readonly bindings = new Map<string, Binding>();
  private readonly capabilitiesByAddress = new Map<string, Set<string>>();

  constructor(options: BindingManagerOptions) {
    this.hasUpstream = options.hasUpstream;
    this.getId = options.getId;
    this.getPhysicalPath = options.getPhysicalPath;
    this.getAcceptedLogicalsFn = options.getAcceptedLogicals;
    this.forwardUpstream = options.forwardUpstream;
    this.getEncryptionKeyId = options.getEncryptionKeyId;
    this.bindingStore =
      options.bindingStore ?? new InMemoryKeyValueStore<BindingStoreEntry>();
    this.bindingFactory = options.bindingFactory ?? this.defaultBindingFactory;
    this.envelopeFactory = options.envelopeFactory;
    this.deliveryTracker = options.deliveryTracker;
    this.ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  }

  getBinding(address: FameAddress | string): Binding | undefined {
    const key = toKey(address);
    const direct = this.bindings.get(key);
    if (direct) {
      return direct;
    }
    return this.matchPool(address.toString());
  }

  getAddresses(): FameAddress[] {
    return Array.from(this.bindings.values()).map((binding) => binding.address);
  }

  hasBinding(address: FameAddress | string): boolean {
    return this.getBinding(address) !== undefined;
  }

  async restore(): Promise<void> {
    const stored = await this.bindingStore.list();
    for (const entry of Object.values(stored)) {
      if (!entry?.address) {
        continue;
      }
      const key = entry.address;
      if (!this.bindings.has(key)) {
        const binding = this.bindingFactory(new FameAddress(key));
        this.bindings.set(key, binding);
        logger.debug('restored_binding', { address: key });
      }
    }

    if (!this.hasUpstream) {
      return;
    }

    await this.rebindAddressesUpstream();
    await this.readvertiseCapabilitiesUpstream();
  }

  async bind(
    participant: string,
    capabilities?: string[] | null
  ): Promise<Binding> {
    logger.debug('binding_participant', { participant });

    const { prefixAddress, addresses, propagateAddress, capabilityAddress } =
      this.computeBindingAddresses(participant);

    for (const address of addresses) {
      if (!this.bindings.has(address)) {
        const binding = this.bindingFactory(new FameAddress(address));
        this.bindings.set(address, binding);
        logger.debug('bound_address', { address, participant });
      }
    }

    let propagatedAddress: FameAddress | null = null;
    if (propagateAddress && this.hasUpstream) {
      propagatedAddress = propagateAddress;
      try {
        await this.bindAddressUpstream(propagatedAddress);
      } catch (error) {
        for (const address of addresses) {
          this.bindings.delete(address);
        }
        throw error;
      }
    }

    if (
      capabilities &&
      capabilities.length &&
      this.hasUpstream &&
      capabilityAddress
    ) {
      try {
        await this.advertiseCapabilities(capabilityAddress, capabilities);
      } catch (error) {
        if (propagatedAddress) {
          try {
            await this.unbindAddressUpstream(propagatedAddress);
          } catch (rollbackError) {
            logger.error('bind_rollback_failed', {
              address: propagatedAddress.toString(),
              error: (rollbackError as Error).message,
            });
          }
        }
        for (const address of addresses) {
          this.bindings.delete(address);
        }
        throw error;
      }
    }

    for (const address of addresses) {
      await this.bindingStore.set(address, { address });
    }

    logger.debug('bind_success', {
      participant,
      address: prefixAddress.toString(),
      capabilities,
      totalBindings: this.bindings.size,
    });

    const binding = this.bindings.get(prefixAddress.toString());
    if (!binding) {
      throw new Error('Binding was not created');
    }

    if (capabilities && capabilities.length && capabilityAddress) {
      const key = capabilityAddress.toString();
      const current = this.capabilitiesByAddress.get(key) ?? new Set<string>();
      capabilities.forEach((cap) => current.add(cap));
      this.capabilitiesByAddress.set(key, current);
    }

    return binding;
  }

  async unbind(participant: string): Promise<void> {
    const {
      prefixAddress,
      instanceAddress,
      addresses,
      propagateAddress,
      capabilityAddress,
    } = this.computeBindingAddresses(participant, { requireExisting: true });

    if (this.hasUpstream && capabilityAddress) {
      const key = capabilityAddress.toString();
      const caps = Array.from(this.capabilitiesByAddress.get(key) ?? []);
      if (caps.length) {
        await this.withdrawCapabilities(capabilityAddress, caps);
        this.capabilitiesByAddress.delete(key);
      }
    }

    if (this.hasUpstream && propagateAddress) {
      await this.unbindAddressUpstream(propagateAddress);
    }

    for (const address of addresses) {
      if (this.bindings.delete(address)) {
        await this.bindingStore.delete(address);
      }
    }

    logger.debug('unbind_success', {
      participant,
      address: prefixAddress.toString(),
      totalBindings: this.bindings.size,
    });

    if (instanceAddress) {
      this.capabilitiesByAddress.delete(instanceAddress.toString());
    }
  }

  async clear(): Promise<void> {
    this.bindings.clear();
    this.capabilitiesByAddress.clear();
    const entries = await this.bindingStore.list();
    await Promise.all(
      Object.keys(entries).map((key) => this.bindingStore.delete(key))
    );
  }

  async handleAck(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    await this.deliveryTracker.onEnvelopeDelivered(
      SYSTEM_INBOX,
      envelope,
      context
    );
  }

  async rebindAddressesUpstream(): Promise<void> {
    if (!this.hasUpstream) {
      return;
    }

    for (const address of this.bindings.keys()) {
      if (!this.shouldRebind(address)) {
        continue;
      }
      try {
        await this.bindAddressUpstream(new FameAddress(address));
      } catch (error) {
        logger.error('rebind_failed', {
          address,
          error: (error as Error).message,
        });
      }
    }
  }

  async readvertiseCapabilitiesUpstream(): Promise<void> {
    if (!this.hasUpstream) {
      return;
    }

    for (const [
      address,
      capabilities,
    ] of this.capabilitiesByAddress.entries()) {
      if (!capabilities.size) {
        continue;
      }
      try {
        await this.advertiseCapabilities(
          new FameAddress(address),
          Array.from(capabilities)
        );
      } catch (error) {
        logger.error('capability_replay_failed', {
          address,
          error: (error as Error).message,
        });
      }
    }
  }

  private matchPool(address: string): Binding | undefined {
    const [name] = parseAddress(address);
    try {
      const [, host] = parseAddressComponents(address);
      if (!host) {
        return undefined;
      }
      return this.matchHostPool(name, host);
    } catch {
      return undefined;
    }
  }

  private matchHostPool(name: string, host: string): Binding | undefined {
    const candidates: Array<{ specificity: number; binding: Binding }> = [];

    for (const [storedAddress, binding] of this.bindings.entries()) {
      try {
        const [storedName, storedHost] = parseAddressComponents(storedAddress);
        if (storedName !== name || !storedHost || !isPoolLogical(storedHost)) {
          continue;
        }
        if (!matchesPoolLogical(host, storedHost)) {
          continue;
        }
        const specificity = storedHost.split('.').length;
        candidates.push({ specificity, binding });
      } catch {
        continue;
      }
    }

    if (!candidates.length) {
      return undefined;
    }

    candidates.sort((a, b) => b.specificity - a.specificity);
    return candidates[0]?.binding;
  }

  private computeBindingAddresses(
    participant: string,
    options: { requireExisting?: boolean } = {}
  ) {
    let name: string;
    let location: string;
    if (participant.includes('@')) {
      [name, location] = parseAddress(participant);
    } else {
      name = participant;
      location = this.getPhysicalPath();
    }

    const baseAddress = formatAddress(name, location);
    let host: string | null = null;
    let isHostBased = false;
    try {
      const [, parsedHost] = parseAddressComponents(baseAddress.toString());
      if (parsedHost) {
        host = parsedHost;
        isHostBased = true;
      }
    } catch {
      // ignore parse errors and treat as path-based
    }

    const acceptedLogicals = this.getAcceptedLogicalsSnapshot();

    let poolClaim: string | null = null;
    let logical: string | null = null;

    if (isHostBased && host) {
      // For host-based addresses (e.g., "svc@api.service"), check the host portion
      logical = host;
      if (!this.isAcceptedLogicalHost(logical, acceptedLogicals)) {
        poolClaim = this.findHostPoolClaim(acceptedLogicals, host);
        logical = null; // Not a logical, might be a pool
      }
    } else {
      // For path-based addresses (e.g., "svc@/path"), check the name portion
      // This allows binding like bind("svc") to work when "svc" is in requestedLogicals
      if (this.isAcceptedLogicalHost(name, acceptedLogicals)) {
        logical = name;
      }
    }

    let prefixAddress: FameAddress;
    let instanceAddress: FameAddress | null = null;
    if (poolClaim) {
      prefixAddress = formatAddressFromComponents(name, poolClaim);
      const targetHost =
        host && host.includes('*')
          ? host.replace('*', this.getId())
          : poolClaim.replace('*', this.getId());
      instanceAddress = formatAddressFromComponents(name, targetHost);
    } else if (
      logical &&
      this.isAcceptedLogicalHost(logical, acceptedLogicals)
    ) {
      prefixAddress = baseAddress;
    } else if (location === this.getPhysicalPath()) {
      prefixAddress = baseAddress;
    } else {
      if (options.requireExisting !== true) {
        throw new Error(
          `Cannot bind '${participant}': location '${location}' not permitted`
        );
      }
      prefixAddress = baseAddress;
    }

    const addresses = new Set<string>();
    addresses.add(prefixAddress.toString());
    if (instanceAddress) {
      addresses.add(instanceAddress.toString());
    }

    const propagateAddress = this.hasUpstream
      ? this.computePropagateAddress(prefixAddress, poolClaim, logical)
      : null;

    const capabilityAddress = instanceAddress ?? prefixAddress;

    return {
      prefixAddress,
      instanceAddress,
      addresses,
      propagateAddress,
      capabilityAddress,
    };
  }

  private computePropagateAddress(
    prefixAddress: FameAddress,
    poolClaim: string | null,
    logical: string | null
  ): FameAddress | null {
    if (!this.hasUpstream) {
      return null;
    }

    // Only propagate pool claims or accepted logical addresses upstream
    // Physical addresses are NEVER propagated (matches Python implementation)
    if (poolClaim) {
      const [name] = parseAddress(prefixAddress.toString());
      return formatAddressFromComponents(name, poolClaim);
    }

    // Check if this is an accepted logical address (non-pool)
    if (
      logical &&
      this.isAcceptedLogicalHost(logical, this.getAcceptedLogicalsSnapshot())
    ) {
      return prefixAddress;
    }

    // Physical addresses or non-accepted logicals are not propagated
    return null;
  }

  private async bindAddressUpstream(address: FameAddress): Promise<void> {
    const frame: AddressBindFrame = {
      type: 'AddressBind',
      address: address.toString(),
      physicalPath: this.getPhysicalPath(),
      encryptionKeyId: this.getEncryptionKeyId
        ? (this.getEncryptionKeyId() ?? undefined)
        : undefined,
    };

    const ackEnvelope = await this.sendAndWaitForAck(frame);
    const ack = ackEnvelope.frame as AddressBindAckFrame;
    if (!ack.ok) {
      throw new Error(`Bind to '${address}' was rejected`);
    }
  }

  private async unbindAddressUpstream(address: FameAddress): Promise<void> {
    const frame: AddressUnbindFrame = {
      type: 'AddressUnbind',
      address: address.toString(),
    };

    const ackEnvelope = await this.sendAndWaitForAck(frame);
    const ack = ackEnvelope.frame as AddressUnbindAckFrame;
    if (!ack.ok) {
      throw new Error(`Unbind of '${address}' was rejected`);
    }
  }

  private async advertiseCapabilities(
    address: FameAddress,
    capabilities: string[]
  ): Promise<void> {
    if (!capabilities.length) {
      return;
    }

    const frame: CapabilityAdvertiseFrame = {
      type: 'CapabilityAdvertise',
      address: address.toString(),
      capabilities,
    };

    const ackEnvelope = await this.sendAndWaitForAck(frame);
    const ack = ackEnvelope.frame as CapabilityAdvertiseAckFrame;
    if (!ack.ok) {
      throw new Error(
        `Capability advertise rejected: ${capabilities.join(', ')}`
      );
    }
  }

  async withdrawCapabilities(
    address: FameAddress,
    capabilities: string[]
  ): Promise<void> {
    if (!capabilities.length) {
      return;
    }

    const frame: CapabilityWithdrawFrame = {
      type: 'CapabilityWithdraw',
      address: address.toString(),
      capabilities,
    };

    const ackEnvelope = await this.sendAndWaitForAck(frame);
    const ack = ackEnvelope.frame as CapabilityWithdrawAckFrame;
    if (!ack.ok) {
      throw new Error(
        `Capability withdraw rejected: ${capabilities.join(', ')}`
      );
    }

    const key = address.toString();
    const existing = this.capabilitiesByAddress.get(key);
    if (!existing) {
      return;
    }
    capabilities.forEach((cap) => existing.delete(cap));
    if (!existing.size) {
      this.capabilitiesByAddress.delete(key);
    }
  }

  private async sendAndWaitForAck(
    frame:
      | AddressBindFrame
      | AddressUnbindFrame
      | CapabilityAdvertiseFrame
      | CapabilityWithdrawFrame
  ) {
    const corrId = generateId();
    const replyTo = formatAddress(SYSTEM_INBOX, this.getPhysicalPath());

    const traceId = currentTraceId();
    const envelopeOptions: CreateFameEnvelopeOptions = {
      frame,
      corrId,
      replyTo,
    };
    if (traceId) {
      envelopeOptions.traceId = traceId;
    }

    const envelope = this.envelopeFactory.createEnvelope(envelopeOptions);

    await this.deliveryTracker.track(envelope, {
      timeoutMs: this.ackTimeoutMs,
      expectedResponseType: FameResponseType.ACK,
    });

    envelope.rtype = FameResponseType.ACK;
    const ackPromise = this.deliveryTracker.awaitAck(envelope.id);
    await this.forwardUpstream(envelope, localDeliveryContext(this.getId()));
    return ackPromise;
  }

  private findHostPoolClaim(
    acceptedLogicals: Set<string>,
    logical: string
  ): string | null {
    for (const pattern of acceptedLogicals) {
      if (isPoolLogical(pattern) && matchesPoolLogical(logical, pattern)) {
        return pattern;
      }
    }
    return null;
  }

  private isAcceptedLogicalHost(
    logical: string,
    acceptedLogicals: Set<string>
  ): boolean {
    return acceptedLogicals.has(logical) && !isPoolLogical(logical);
  }

  private shouldRebind(address: string): boolean {
    try {
      const [, host] = parseAddressComponents(address);
      if (!host) {
        return false;
      }
      const accepted = this.getAcceptedLogicalsSnapshot();
      const poolClaim = this.findHostPoolClaim(accepted, host);
      const exact = this.isAcceptedLogicalHost(host, accepted);
      return Boolean(poolClaim || exact);
    } catch {
      return false;
    }
  }

  private getAcceptedLogicalsSnapshot(): Set<string> {
    const values = this.getAcceptedLogicalsFn();
    return values instanceof Set
      ? new Set(values)
      : new Set(Array.from(values));
  }

  private defaultBindingFactory(address: FameAddress): Binding {
    const channel = new InMemoryReadWriteChannel();
    return new Binding(channel, address);
  }
}
