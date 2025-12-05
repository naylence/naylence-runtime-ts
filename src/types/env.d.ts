// Extend the default ProcessEnv shape so the shim can surface arbitrary keys.
declare namespace NodeJS {
  interface ProcessEnv {
    [key: string]: string | undefined;
  }
}
