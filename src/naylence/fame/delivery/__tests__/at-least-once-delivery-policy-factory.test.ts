import { AtLeastOnceDeliveryPolicyFactory } from '../at-least-once-delivery-policy-factory.js';
import { AtLeastOnceDeliveryPolicy } from '../at-least-once-delivery-policy.js';
import { RetryPolicy } from '../retry-policy.js';

describe('AtLeastOnceDeliveryPolicyFactory', () => {
  let factory: AtLeastOnceDeliveryPolicyFactory;

  beforeEach(() => {
    factory = new AtLeastOnceDeliveryPolicyFactory();
  });

  it('creates a default policy when no config is provided', async () => {
    const policy = await factory.create();

    expect(factory.isDefault).toBe(true);
    expect(policy).toBeInstanceOf(AtLeastOnceDeliveryPolicy);
    expect(policy.senderRetryPolicy).toBeUndefined();
    expect(policy.receiverRetryPolicy).toBeUndefined();
  });

  it('normalizes retry policies from record configs', async () => {
    const policy = await factory.create({
      type: 'AtLeastOnceDeliveryPolicy',
      sender_retry_policy: {
        maxRetries: 3,
        base_delay_ms: '150',
        max_delay_ms: '   ',
        jitter_ms: 'abc',
        backoff_factor: '2.5',
      },
      receiverRetryPolicy: null,
    } as Record<string, unknown>);

    const sender = policy.senderRetryPolicy;
    expect(sender).toBeInstanceOf(RetryPolicy);
    expect(sender?.maxRetries).toBe(3);
    expect(sender?.baseDelayMs).toBe(150);
    expect(sender?.maxDelayMs).toBe(10_000);
    expect(sender?.jitterMs).toBe(50);
    expect(sender?.backoffFactor).toBe(2.5);
    expect(policy.receiverRetryPolicy).toBeUndefined();
  });

  it('supports alternate property names and reuses existing retry policies', async () => {
    const existing = new RetryPolicy({
      maxRetries: 6,
      baseDelayMs: 25,
      maxDelayMs: 300,
      jitterMs: 7,
      backoffFactor: 1.2,
    });

    const policy = await factory.create({
      type: 'AtLeastOnceDeliveryPolicy',
      sender_retry_policy: undefined,
      sender_retryPolicy: {
        max_retries: '4',
        baseDelayMs: 80,
        max_delay_ms: '2500',
        jitter_ms: '17',
        backoff_factor: '1.5',
      },
      receiverRetryPolicy: existing,
    } as Record<string, unknown>);

    const sender = policy.senderRetryPolicy;
    expect(sender).toBeInstanceOf(RetryPolicy);
    expect(sender?.maxRetries).toBe(4);
    expect(sender?.baseDelayMs).toBe(80);
    expect(sender?.maxDelayMs).toBe(2_500);
    expect(sender?.jitterMs).toBe(17);
    expect(sender?.backoffFactor).toBe(1.5);
    expect(policy.receiverRetryPolicy).toBe(existing);
  });
});
