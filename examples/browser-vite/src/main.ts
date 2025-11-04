import {
  BrowserWrappedKeyCredentialProvider,
  createFameEnvelope,
  enableLogging,
  hasCryptoSupport,
  operation,
  getNode,
  withFabric,
  RpcMixin,
  RpcProxy,
  generateIdAsync,
} from '@naylence/runtime/browser';

type StatusLine = string;

class CalculatorService extends RpcMixin {
  get capabilities() {
    return ['calculator', 'math'];
  }

  async add(params: any) {
    const { a, b } = params;
    const result = a + b;
    return result;
  }

  async multiply(params: any) {
    const { a, b } = params;
    const result = a * b;
    return result;
  }

  async divide(params: any) {
    const { a, b } = params;
    if (b === 0) {
      throw new Error('Division by zero');
    }
    const result = a / b;
    return result;
  }

  async *fib(params: any) {
    const { n } = params;
    let a = 0;
    let b = 1;

    for (let i = 0; i < n; i += 1) {
      yield a;
      [a, b] = [b, a + b];
    }
  }
}

function applyOperation(decorator: any, methodName: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    CalculatorService.prototype,
    methodName
  );
  if (!descriptor) {
    throw new Error(`Missing property descriptor for ${methodName}`);
  }
  decorator(CalculatorService.prototype, methodName, descriptor);
}

applyOperation(operation(), 'add');
applyOperation(operation(), 'multiply');
applyOperation(operation(), 'divide');
applyOperation(operation({ name: 'fib_stream', streaming: true }), 'fib');

async function runSmokeTest(): Promise<StatusLine[]> {
  enableLogging("trace");
  const lines: StatusLine[] = [];
  lines.push('Naylence Runtime Browser Smoke Test');

  const cryptoAvailable = hasCryptoSupport();
  lines.push(`WebCrypto available: ${cryptoAvailable}`);
  if (!cryptoAvailable) {
    throw new Error('WebCrypto is not available in this environment');
  }

//   try {
//     await registerRuntimeFactories();
//     lines.push('Runtime factories registered (best effort).');
//   } catch (error) {
//     const message =
//       error instanceof Error ? error.message : JSON.stringify(error);
//     lines.push(`Factory registration failed: ${message}`);
//   }

  const provider = new BrowserWrappedKeyCredentialProvider({
    promptPassphrase: async () => 'demo-passphrase',
    idbFactory: indexedDB,
  });

  const masterKey = await provider.get();
  lines.push(`Derived master key length: ${masterKey.byteLength}`);

  const cryptoObject = globalThis.crypto!;
  const keyPair = await cryptoObject.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    ['deriveBits', 'deriveKey']
  );

  const iv = cryptoObject.getRandomValues(new Uint8Array(12));
  const payload = new TextEncoder().encode('hello, naylence');

  const aesKey = await cryptoObject.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );

  const ciphertext = await cryptoObject.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    payload
  );

  const plaintextBuffer = await cryptoObject.subtle.decrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    ciphertext
  );

  const decoded = new TextDecoder().decode(plaintextBuffer);

  lines.push(`ECDH key pair generated: ${Boolean(keyPair.publicKey)}`);
  lines.push(`AES round trip successful: ${decoded === 'hello, naylence'}`);
  

  await withFabric({
    rootConfig: {
        plugins: ["@naylence/runtime"],
        node: {
            security: {
                type: 'DefaultSecurityManager',
                security_policy: {
                    type: 'DefaultSecurityPolicy',
                    signing: {
                    signing_material: 'raw-key',
                    inbound: {
                        signature_policy: 'required',
                        unsigned_violation_action: 'nack',
                        invalid_signature_action: 'nack',
                    },
                    response: {
                        mirror_request_signing: true,
                        always_sign_responses: false,
                        sign_error_responses: true,
                    },
                    outbound: {
                        default_signing: true,
                        sign_sensitive_operations: true,
                        sign_if_recipient_expects: true,
                    },
                    },
                    encryption: {
                    inbound: {
                        allow_plaintext: true,
                        allow_channel: false,
                        allow_sealed: false,
                        plaintext_violation_action: 'nack',
                        channel_violation_action: 'nack',
                        sealed_violation_action: 'nack',
                    },
                    response: {
                        mirror_request_level: false,
                        minimum_response_level: 'plaintext',
                        escalate_sealed_responses: false,
                    },
                    outbound: {
                        default_level: 'plaintext',
                        escalate_if_peer_supports: false,
                        prefer_sealed_for_sensitive: false,
                    },
                    },
                }
            },
        }
    }
  }, async (fabric) => {
    const fabricType =
      fabric?.constructor?.name ??
      Object.prototype.toString.call(fabric).slice(8, -1);
    lines.push(`Fabric initialized successfully: ${fabricType}`);
    
    const node = getNode();
    lines.push(`Node id: ${node.id}, sid: ${node.sid}`);
    
    const calculator = new CalculatorService();
    const address = await fabric.serve(calculator, 'calculator');
    lines.push(`Calculator service served at: ${address}`);
    
    const calculatorProxy: any = RpcProxy.remoteByAddress(address);
    const addResult = await calculatorProxy.add({ a: 3, b: 4 });
    lines.push(`Result: add(3,4) = ${addResult}`);
    const idAsync = await generateIdAsync({ mode: 'fingerprint' })
    lines.push(`Generated ID (fingerprint mode): ${idAsync}`);
    
    // const multiplyResult = await calculatorProxy.multiply({ a: 6, b: 7 });
    // lines.push(`Result: multiply(6,7) = ${multiplyResult}`);
    // const stream = await calculatorProxy.fib_stream({ _stream: true, n: 10 });
    // const fibNumbers = [];
    // for await (const value of stream) {
    //   fibNumbers.push(value);
    // }
    // lines.push(`Fib stream: ${fibNumbers.join(', ')}`);

    
    const envelope = createFameEnvelope({
        sid: node.sid || "unknown sid",
        frame: {
            type: 'Data',
            payload: 'test'
        }
    });
    const signed = node.securityManager?.envelopeSigner?.signEnvelope(
        envelope,
        {
            physicalPath: '/demo/path'
        }
    )
    lines.push(`Envelope signed with ID: ${JSON.stringify(signed)}`);
  });

  return lines;
}

async function main(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) {
    throw new Error('Missing #app container');
  }

  try {
    const lines = await runSmokeTest();
    app.innerHTML = `<pre>${lines.join('\n')}</pre>`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.innerHTML = `<pre>Smoke test failed: ${message}</pre>`;
    console.error('Browser smoke test failure', error);
  }
}

void main();
