import type { AuthInjectionStrategy } from '../../security/auth/auth-injection-strategy.js';
import type { OtelLifecycleControl } from '../otel-setup.js';

type SafeImportModule = typeof import('../../util/lazy-import.js');
type SetupOtelModule = typeof import('../otel-setup.js');
type AuthFactoryModule =
  typeof import('../../security/auth/auth-injection-strategy-factory.js');

jest.mock('../../util/logging.js', () => ({
  getLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
    critical: jest.fn(),
    child: jest.fn(() => ({})),
    setLevel: jest.fn(),
  }),
}));

const safeImportMock = jest.fn<
  ReturnType<SafeImportModule['safeImport']>,
  Parameters<SafeImportModule['safeImport']>
>();

jest.mock('../../util/lazy-import.js', () => ({
  safeImport: (...args: Parameters<SafeImportModule['safeImport']>) =>
    safeImportMock(...args),
  __esModule: true,
}));

const setupOtelMock = jest.fn<
  ReturnType<SetupOtelModule['setupOtel']>,
  Parameters<SetupOtelModule['setupOtel']>
>();

jest.mock('../otel-setup.js', () => ({
  setupOtel: (...args: Parameters<SetupOtelModule['setupOtel']>) =>
    setupOtelMock(...args),
  __esModule: true,
}));

const createAuthStrategyMock = jest.fn<
  Promise<AuthInjectionStrategy>,
  Parameters<
    AuthFactoryModule['AuthInjectionStrategyFactory']['createAuthInjectionStrategy']
  >
>();

jest.mock('../../security/auth/auth-injection-strategy-factory.js', () => ({
  AuthInjectionStrategyFactory: {
    createAuthInjectionStrategy: (
      ...args: Parameters<
        AuthFactoryModule['AuthInjectionStrategyFactory']['createAuthInjectionStrategy']
      >
    ) => createAuthStrategyMock(...args),
  },
  __esModule: true,
}));

describe('OpenTelemetryTraceEmitterFactory', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('normalizes config aliases before invoking dependencies', async () => {
    const emitterCtor = jest.fn();
    const lifecycle: OtelLifecycleControl = {
      forceFlush: jest.fn(),
      shutdown: jest.fn(),
    };

    safeImportMock
      .mockResolvedValueOnce({
        setupOtel: setupOtelMock,
      })
      .mockResolvedValueOnce({
        OpenTelemetryTraceEmitter: emitterCtor,
      })
      .mockResolvedValueOnce({
        trace: {
          getTracer: jest.fn(),
          getTracerProvider: jest.fn(),
        },
        SpanStatusCode: { ERROR: 2 },
      });

    setupOtelMock.mockResolvedValue(lifecycle);

    const { OpenTelemetryTraceEmitterFactory } = await import(
      '../open-telemetry-trace-emitter-factory.js'
    );

    const factory = new OpenTelemetryTraceEmitterFactory();
    await factory.create(
      {
        type: 'OpenTelemetryTraceEmitter',
        service_name: 'snake-service',
        otlp_endpoint: 'https://telemetry.example/v1/traces',
        deployment_environment: 'stage',
        sampling_strategy: 'ratio:0.5',
        otlp_headers: {
          'x-telemetry-key': 'from-config',
        },
      } as Record<string, unknown>,
      {
        headers: {
          'x-override': 'from-options',
        },
      }
    );

    expect(setupOtelMock).toHaveBeenCalledWith({
      serviceName: 'snake-service',
      endpoint: 'https://telemetry.example/v1/traces',
      environment: 'stage',
      sampler: 'ratio:0.5',
      headers: {
        'x-telemetry-key': 'from-config',
        'x-override': 'from-options',
      },
    });

    expect(emitterCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'snake-service',
        lifecycle,
        otelApi: expect.objectContaining({
          trace: expect.any(Object),
          SpanStatusCode: expect.any(Object),
        }),
      })
    );

    expect(createAuthStrategyMock).not.toHaveBeenCalled();
  });

  it('applies auth strategies and preserves header casing', async () => {
    const emitterCtor = jest.fn();
    const lifecycle: OtelLifecycleControl = {
      forceFlush: jest.fn(),
      shutdown: jest.fn(),
    };

    safeImportMock
      .mockResolvedValueOnce({
        setupOtel: setupOtelMock,
      })
      .mockResolvedValueOnce({
        OpenTelemetryTraceEmitter: emitterCtor,
      })
      .mockResolvedValueOnce({
        trace: {
          getTracer: jest.fn(),
          getTracerProvider: jest.fn(),
        },
        SpanStatusCode: { ERROR: 2 },
      });

    setupOtelMock.mockResolvedValue(lifecycle);

    const authStrategy: AuthInjectionStrategy = {
      apply: jest.fn(async (headers: Record<string, string>) => {
        headers['authorization'] = 'Bearer injected';
      }),
      cleanup: jest.fn(),
    };
    createAuthStrategyMock.mockResolvedValue(authStrategy);

    const { OpenTelemetryTraceEmitterFactory } = await import(
      '../open-telemetry-trace-emitter-factory.js'
    );

    const factory = new OpenTelemetryTraceEmitterFactory();
    await factory.create(
      {
        type: 'OpenTelemetryTraceEmitter',
        serviceName: 'auth-service',
        headers: {
          'x-static': 'config',
        },
        auth: {
          type: 'MockAuth',
        },
      },
      {
        headers: {
          'x-option': 'option',
        },
      }
    );

    expect(createAuthStrategyMock).toHaveBeenCalledWith({ type: 'MockAuth' });

    expect(authStrategy.apply).toHaveBeenCalledWith(
      expect.objectContaining({
        'x-static': 'config',
        'x-option': 'option',
      })
    );

    expect(setupOtelMock).toHaveBeenCalledWith({
      serviceName: 'auth-service',
      endpoint: null,
      environment: null,
      sampler: null,
      headers: {
        'x-static': 'config',
        'x-option': 'option',
        authorization: 'Bearer injected',
      },
    });

    expect(emitterCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceName: 'auth-service',
        lifecycle,
        authStrategy,
        otelApi: expect.objectContaining({
          trace: expect.any(Object),
          SpanStatusCode: expect.any(Object),
        }),
      })
    );

    expect(authStrategy.cleanup).not.toHaveBeenCalled();
  });
});
