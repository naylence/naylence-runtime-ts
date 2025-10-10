export const NODE_META_NAMESPACE = '__node_meta';

export interface NodeMeta {
  id: string;
}

export class NodeMetaRecord implements NodeMeta {
  constructor(public id: string) {}

  static fromJSON(data: NodeMeta): NodeMetaRecord {
    return new NodeMetaRecord(data.id);
  }
}
