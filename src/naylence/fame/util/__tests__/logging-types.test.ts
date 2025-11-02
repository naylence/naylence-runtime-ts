/**
 * Tests for logging type helpers
 */

import {
  normalizeEnvelopeSnapshot,
  type EnvelopeSnapshotInput,
} from '../logging-types.js';

describe('normalizeEnvelopeSnapshot', () => {
  test('normalizes camelCase envelope fields', () => {
    const input: EnvelopeSnapshotInput = {
      traceId: 'trace-123',
      id: 'env-456',
      flowId: 'flow-789',
    };

    const result = normalizeEnvelopeSnapshot(input);

    expect(result).toEqual({
      trace_id: 'trace-123',
      id: 'env-456',
      flow_id: 'flow-789',
    });
  });

  test('falls back to snake_case when camelCase missing', () => {
    const input: EnvelopeSnapshotInput = {
      trace_id: 'trace-snake',
      id: 'env-legacy',
      flow_id: 'flow-snake',
    };

    const result = normalizeEnvelopeSnapshot(input);

    expect(result).toEqual({
      trace_id: 'trace-snake',
      id: 'env-legacy',
      flow_id: 'flow-snake',
    });
  });

  test('prefers camelCase when both representations supplied', () => {
    const input: EnvelopeSnapshotInput = {
      traceId: 'trace-camel',
      trace_id: 'trace-snake',
      flowId: 'flow-camel',
      flow_id: 'flow-snake',
    };

    const result = normalizeEnvelopeSnapshot(input);

    expect(result).toEqual({
      trace_id: 'trace-camel',
      flow_id: 'flow-camel',
    });
  });
});
