export const NODE_META_NAMESPACE = '__node_meta';

export interface NodeMeta {
  id: string;
}

export class NodeMetaRecord implements NodeMeta {
  public id: string;

  constructor(idOrData: string | NodeMeta) {
    if (typeof idOrData === 'object' && idOrData !== null) {
      // Called from deserializer with {id}
      // Handle double-wrapped case where id might itself be an object
      this.id = typeof idOrData.id === 'string' 
        ? idOrData.id 
        : (idOrData.id as any)?.id || '';
    } else {
      // Called programmatically with id string
      this.id = idOrData;
    }
  }
}
