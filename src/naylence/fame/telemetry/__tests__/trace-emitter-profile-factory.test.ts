import { jest } from '@jest/globals';

import type { TraceEmitter } from '../trace-emitter.js';
import { TraceEmitterFactory } from '../trace-emitter-factory.js';
import {
  PROFILE_NAME_NOOP,
  TraceEmitterProfileFactory,
} from '../trace-emitter-profile-factory.js';

describe('TraceEmitterProfileFactory', () => {
  let factory: TraceEmitterProfileFactory;
  let createTraceEmitterSpy: jest.SpiedFunction<
    typeof TraceEmitterFactory.createTraceEmitter
  >;

  beforeEach(() => {
    factory = new TraceEmitterProfileFactory();
    createTraceEmitterSpy = jest
      .spyOn(TraceEmitterFactory, 'createTraceEmitter')
      .mockResolvedValue({} as TraceEmitter);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('falls back to noop profile when config missing', async () => {
    await factory.create(undefined);

    expect(createTraceEmitterSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createTraceEmitterSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({ type: 'NoopTraceEmitter' });
  });

  it('accepts snake_case profile alias without changing telemetry attributes', async () => {
    await factory.create({
      type: 'TraceEmitterProfile',
      profile_name: 'open_telemetry',
    });

    expect(createTraceEmitterSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createTraceEmitterSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({
      type: 'OpenTelemetryTraceEmitter',
    });
    expect(profileConfig).toHaveProperty('headers');
  });

  it('accepts camelCase profile alias and normalizes casing', async () => {
    await factory.create({
      type: 'TraceEmitterProfile',
      profileName: 'OpenTelemetry',
    });

    expect(createTraceEmitterSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createTraceEmitterSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({
      type: 'OpenTelemetryTraceEmitter',
    });
  });

  it('passes through factory args when resolving trace emitter', async () => {
    const extractor = async () => undefined;
    await factory.create(
      {
        type: 'TraceEmitterProfile',
        profile: PROFILE_NAME_NOOP,
      },
      extractor
    );

    expect(createTraceEmitterSpy).toHaveBeenCalledTimes(1);
    const [, options] = createTraceEmitterSpy.mock.calls[0];
    expect(options).toMatchObject({ factoryArgs: [extractor] });
  });

  it('maps compact aliases onto canonical profile names', async () => {
    await factory.create({
      type: 'TraceEmitterProfile',
      profile: 'opentelemetry',
    });

    expect(createTraceEmitterSpy).toHaveBeenCalledTimes(1);
    const [profileConfig] = createTraceEmitterSpy.mock.calls[0];
    expect(profileConfig).toMatchObject({
      type: 'OpenTelemetryTraceEmitter',
    });
  });

  it('throws for unknown profiles after normalization', async () => {
    createTraceEmitterSpy.mockRestore();

    await expect(
      factory.create({
        type: 'TraceEmitterProfile',
        profile: 'custom-profile',
      })
    ).rejects.toThrow('Unknown trace emitter profile: custom-profile');
  });
});
