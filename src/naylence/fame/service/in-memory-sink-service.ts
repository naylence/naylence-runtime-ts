import {
  extractEnvelopeAndContext,
  generateId,
  makeFameAddress,
  FameFabric,
  Subscription,
  Binding,
  type FameAddress,
  type FameBindingChannelMessage,
  type FameDeliveryContext,
  type FameEnvelope,
  type FameServiceFactory,
  type WriteChannel,
} from "naylence-core";

import {
  InMemoryFanoutBroker,
  type InMemoryFanoutBrokerConfig,
} from "../channel/in-memory/in-memory-fanout-broker.js";
import { getLogger } from "../util/logging.js";
import { SinkService, type CreateSinkParams, type SubscribeParams } from "./sink-service.js";

const logger = getLogger("in-memory-sink-service");

type DeliverFunction = (envelope: FameEnvelope, context?: FameDeliveryContext) => Promise<unknown>;

type SubscribeChannel = WriteChannel & { close?: () => Promise<void> };

export interface SinkBindingManager {
  bind(participant: string): Promise<Binding>;
}

class FameFabricWriteChannel implements WriteChannel {
  constructor(
    private readonly deliver: DeliverFunction,
    private readonly destination: FameAddress
  ) {}

  async send(message: FameBindingChannelMessage): Promise<void> {
    const [envelope, context] = extractEnvelopeAndContext(message);

    if (!envelope) {
      return;
    }

    const copy: FameEnvelope = {
      ...envelope,
      to: this.destination.toString(),
    };

    await this.deliverWithContext(copy, context);
  }

  async close(): Promise<void> {
    // no-op close to satisfy WriteChannel contract
  }

  private async deliverWithContext(
    envelope: FameEnvelope,
    context?: FameDeliveryContext
  ): Promise<void> {
    try {
      await this.deliver(envelope, context);
    } catch (error) {
      logger.error("sink_delivery_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export interface InMemorySinkServiceOptions {
  bindingManager: SinkBindingManager;
  deliver?: DeliverFunction;
  brokerConfig?: InMemoryFanoutBrokerConfig;
  name?: string;
}

export class InMemorySinkService extends SinkService {
  readonly name: string;

  private readonly bindingManager: SinkBindingManager;
  private readonly deliver: DeliverFunction;
  private readonly brokerConfig: InMemoryFanoutBrokerConfig | undefined;
  private readonly subscriptions = new Map<string, Subscription[]>();
  private readonly fanouts = new Map<string, InMemoryFanoutBroker>();
  private readonly subscriptionIndex = new WeakMap<Subscription, string>();

  constructor(options: InMemorySinkServiceOptions) {
    super();
    this.bindingManager = options.bindingManager;
    this.deliver =
      options.deliver ??
      (async (envelope, _context) => {
        if (!envelope.to) {
          throw new Error("Sink delivery envelope requires a destination address");
        }

        const deliverEnvelope: FameEnvelope = {
          ...envelope,
          to: typeof envelope.to === "string" ? envelope.to : envelope.to.toString(),
        };

        const fabric = FameFabric.current() as unknown as {
          send(env: FameEnvelope): Promise<unknown>;
        };
        await fabric.send(deliverEnvelope);
      });
    this.brokerConfig = options.brokerConfig;
    this.name = options.name ?? "sink-service";
  }

  async stop(): Promise<void> {
    for (const broker of this.fanouts.values()) {
      try {
        await broker.stop();
      } catch (error) {
        logger.error("failed_to_stop_fanout_broker", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.fanouts.clear();
    this.subscriptions.clear();
  }

  async handleRpcRequest(method: string, params: Record<string, any>): Promise<any> {
    switch (method) {
      case "createSink":
      case "create_sink":
      case "sink/create":
        return await this.createSink(params as CreateSinkParams);
      case "subscribe":
        return await this.subscribe(params as SubscribeParams);
      default:
        throw new Error(`Unknown RPC method: ${method}`);
    }
  }

  async createSink(params: CreateSinkParams): Promise<FameAddress> {
    const key = params?.name?.trim() || `sink-${generateId()}`;

    const binding = await this.bindingManager.bind(key);
    if (!binding) {
      throw new Error("Binding manager did not return a binding");
    }

    const sinkAddress = binding.address;
    const broker = new InMemoryFanoutBroker(binding.channel, this.brokerConfig);

    this.fanouts.set(sinkAddress.toString(), broker);

    await broker.start();

    logger.debug("created_sink", {
      sink_name: key,
      sink_address: sinkAddress.toString(),
    });

    return sinkAddress;
  }

  async subscribe(params: SubscribeParams): Promise<void> {
    const sinkAddress = params?.sinkAddress;
    const subscriberAddress = params?.subscriberAddress;

    if (!sinkAddress || !subscriberAddress) {
      throw new Error("sinkAddress and subscriberAddress are required");
    }

    const broker = this.fanouts.get(sinkAddress);
    if (!broker) {
      throw new Error(`No sink found for ${sinkAddress}`);
    }

    const destination = makeFameAddress(subscriberAddress);
    const channel: SubscribeChannel = new FameFabricWriteChannel(this.deliver, destination);

    broker.addSubscriber(channel);

    const subscription = new Subscription(channel, destination);
    const existing = this.subscriptions.get(sinkAddress) ?? [];
    existing.push(subscription);
    this.subscriptions.set(sinkAddress, existing);
    this.subscriptionIndex.set(subscription, sinkAddress);

    logger.debug("subscribed_to_sink", {
      sink_address: sinkAddress,
      subscriber_address: subscriberAddress,
    });
  }

  async unsubscribe(subscription: Subscription): Promise<void> {
    const sinkAddress = this.subscriptionIndex.get(subscription) ?? subscription.address.toString();
    const current = this.subscriptions.get(sinkAddress);
    if (!current) {
      return;
    }

    const updated = current.filter((sub) => sub !== subscription);
    if (updated.length === 0) {
      this.subscriptions.delete(sinkAddress);
    } else {
      this.subscriptions.set(sinkAddress, updated);
    }

    this.subscriptionIndex.delete(subscription);

    const broker = this.fanouts.get(sinkAddress);
    if (broker) {
      broker.removeSubscriber(subscription.channel as WriteChannel);
    }

    if (typeof (subscription.channel as SubscribeChannel).close === "function") {
      await (subscription.channel as SubscribeChannel).close?.();
    }
  }
}

export class InMemorySinkServiceFactory implements FameServiceFactory<InMemorySinkService> {
  create(
    config: Partial<InMemorySinkServiceOptions> & { bindingManager: SinkBindingManager }
  ): InMemorySinkService {
    if (!config.bindingManager) {
      throw new Error("bindingManager is required to create InMemorySinkService");
    }

    const options: InMemorySinkServiceOptions = {
      bindingManager: config.bindingManager,
      ...(config.deliver !== undefined ? { deliver: config.deliver } : {}),
      ...(config.brokerConfig !== undefined ? { brokerConfig: config.brokerConfig } : {}),
      ...(config.name !== undefined ? { name: config.name } : {}),
    };

    return new InMemorySinkService(options);
  }
}
