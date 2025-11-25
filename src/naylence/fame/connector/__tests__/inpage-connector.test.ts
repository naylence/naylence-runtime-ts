import { FameTransportClose } from '../../errors/errors.js';
import {
  InPageConnector,
  INPAGE_CONNECTOR_TYPE,
} from '../inpage-connector.js';

describe('InPageConnector', () => {
  const originalWindow = (globalThis as Record<string, unknown>).window;
  const originalDocument = (globalThis as Record<string, unknown>).document;
  const originalMessageEvent = (globalThis as Record<string, unknown>).MessageEvent;

  beforeAll(() => {
    // Create a mock window with necessary event listener methods
    const mockWindow = {
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    (globalThis as Record<string, unknown>).window = mockWindow;
    
    // Create a mock document with necessary properties and methods
    (globalThis as Record<string, unknown>).document = {
      hidden: false,
      visibilityState: 'visible',
      hasFocus: () => true,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    if (typeof globalThis.MessageEvent === 'undefined') {
      class PolyfillMessageEvent<T> extends Event {
        public data: T;
        constructor(type: string, init: MessageEventInit<T>) {
          super(type, init);
          this.data = init.data as T;
        }
      }

      (globalThis as Record<string, unknown>).MessageEvent = PolyfillMessageEvent;
    }
  });

  afterAll(() => {
    if (originalWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = originalWindow;
    }

    if (originalDocument === undefined) {
      delete (globalThis as Record<string, unknown>).document;
    } else {
      (globalThis as Record<string, unknown>).document = originalDocument;
    }

    if (originalMessageEvent === undefined) {
      delete (globalThis as Record<string, unknown>).MessageEvent;
    } else {
      (globalThis as Record<string, unknown>).MessageEvent = originalMessageEvent;
    }
  });

  it('delivers binary frames between peers sharing a channel', async () => {
    const sender = new InPageConnector({
      type: INPAGE_CONNECTOR_TYPE,
      channelName: 'test-channel',
    });
    const receiver = new InPageConnector({
      type: INPAGE_CONNECTOR_TYPE,
      channelName: 'test-channel',
    });

    const payload = new Uint8Array([1, 2, 3, 4]);

    await (sender as unknown as { _transportSendBytes(data: Uint8Array): Promise<void> })._transportSendBytes(payload);
    const received = await (receiver as unknown as { _transportReceive(): Promise<Uint8Array> })._transportReceive();

    expect(Array.from(received)).toEqual(Array.from(payload));

    await sender.close();
    await receiver.close();
  });

  it('drains the inbox with a FameTransportClose when closed', async () => {
    const connector = new InPageConnector({
      type: INPAGE_CONNECTOR_TYPE,
      channelName: 'drain-channel',
    });

    const receivePromise = (async () => {
      try {
        return await (connector as unknown as { _transportReceive(): Promise<Uint8Array> })._transportReceive();
      } catch (error) {
        return error as unknown;
      }
    })();

    await connector.close(4000, 'shutdown');
    const result = await receivePromise;

    expect(result).toBeInstanceOf(FameTransportClose);
    const closeError = result as FameTransportClose;
    expect(closeError.code).toBe(4000);
    expect(closeError.message).toBe('shutdown');
  });
});
