import type {
  FameAddress,
  FameDeliveryContext,
  FameEnvelope,
  FameEnvelopeHandler,
} from 'naylence-core';
import { BindingManager } from './binding-manager.js';

interface RegisteredListener {
  handler: FameEnvelopeHandler;
}

export class EnvelopeListenerManager {
  private readonly listenersByService = new Map<string, RegisteredListener>();
  private readonly addressToService = new Map<string, string>();

  constructor(private readonly bindingManager: BindingManager) {}

  async start(): Promise<void> {
    // No-op for simplified manager
  }

  async stop(): Promise<void> {
    this.listenersByService.clear();
    this.addressToService.clear();
    await this.bindingManager.clear();
  }

  async listen(serviceName: string, handler?: FameEnvelopeHandler): Promise<FameAddress> {
    const binding = await this.bindingManager.bind(serviceName);
    const addressKey = binding.address.toString();

    if (handler) {
      this.listenersByService.set(serviceName, { handler });
    }
    this.addressToService.set(addressKey, serviceName);

    return binding.address;
  }

  async listenRpc(): Promise<FameAddress> {
    throw new Error('listenRpc is not implemented yet');
  }

  async deliverToAddress(
    address: FameAddress | string,
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    const serviceName = this.addressToService.get(address.toString());
    if (!serviceName) {
      throw new Error(`No listener registered for address: ${address.toString()}`);
    }

    const entry = this.listenersByService.get(serviceName);
    if (!entry) {
      throw new Error(`Service '${serviceName}' does not have an active handler`);
    }

    await entry.handler(envelope, context);
  }

  getHandler(serviceName: string): FameEnvelopeHandler | undefined {
    return this.listenersByService.get(serviceName)?.handler;
  }
}