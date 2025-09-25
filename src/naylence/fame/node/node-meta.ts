export interface NodeMeta {
  id: string;
}

export class NodeMetaRecord implements NodeMeta {
  constructor(public id: string) {}
}
