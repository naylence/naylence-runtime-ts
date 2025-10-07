import type { NodeLike } from '../node-like.js';
import { NodeLikeFactory } from '../node-like-factory.js';
import * as factoryModule from 'naylence-factory';
import * as configModule from '../../config/extended-fame-config.js';

describe('NodeLikeFactory.createNode', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses node configuration from the extended fame config when none is provided', async () => {
    const mockNode = { symbol: 'extended' } as unknown as NodeLike;

    const createResourceSpy = jest
      .spyOn(factoryModule, 'createResource')
      .mockResolvedValue(mockNode);
    const createDefaultResourceSpy = jest
      .spyOn(factoryModule, 'createDefaultResource')
      .mockResolvedValue(mockNode);

    jest.spyOn(configModule, 'getFameConfig').mockReturnValue({
      node: {
        type: 'CustomNode',
        region: 'us-test-1',
      },
    } as any);

    const node = await NodeLikeFactory.createNode();

    expect(node).toBe(mockNode);
    expect(createResourceSpy).toHaveBeenCalledTimes(1);
    expect(createResourceSpy).toHaveBeenCalledWith(
      'NodeLikeFactory',
      { type: 'CustomNode', region: 'us-test-1' },
      {}
    );
    expect(createDefaultResourceSpy).not.toHaveBeenCalled();
  });

  it('falls back to the default node factory when extended config lacks node options', async () => {
    const mockNode = { symbol: 'default' } as unknown as NodeLike;

    jest.spyOn(factoryModule, 'createResource').mockResolvedValue(mockNode);
    const createDefaultResourceSpy = jest
      .spyOn(factoryModule, 'createDefaultResource')
      .mockResolvedValue(mockNode);

    jest.spyOn(configModule, 'getFameConfig').mockReturnValue({} as any);

    const node = await NodeLikeFactory.createNode();

    expect(node).toBe(mockNode);
    expect(createDefaultResourceSpy).toHaveBeenCalledWith(
      'NodeLikeFactory',
      null,
      {}
    );
    expect(factoryModule.createResource).not.toHaveBeenCalled();
  });

  it('delegates to the default factory when the extended config omits the node type', async () => {
    const mockNode = { symbol: 'no-type' } as unknown as NodeLike;

    jest.spyOn(factoryModule, 'createResource').mockResolvedValue(mockNode);
    const createDefaultResourceSpy = jest
      .spyOn(factoryModule, 'createDefaultResource')
      .mockResolvedValue(mockNode);

    jest.spyOn(configModule, 'getFameConfig').mockReturnValue({
      node: {
        transport: 'memory',
      },
    } as any);

    const node = await NodeLikeFactory.createNode();

    expect(node).toBe(mockNode);
    expect(createDefaultResourceSpy).toHaveBeenCalledWith(
      'NodeLikeFactory',
      { transport: 'memory' },
      {}
    );
    expect(factoryModule.createResource).not.toHaveBeenCalled();
  });
});
