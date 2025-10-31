declare module '@naylence/factory/plugins' {
  export type PluginModuleLoader = (
    specifier: string
  ) => Promise<Record<string, unknown>>;

  export const _internal: {
    setDynamicImporter(loader: PluginModuleLoader | null): void;
  };
}
