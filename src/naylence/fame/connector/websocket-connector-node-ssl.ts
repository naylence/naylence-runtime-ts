/**
 * Registers the Node.js-specific SSL certificate loader for the WebSocket connector factory.
 *
 * This file is imported only by the Node entry point so the browser bundle avoids pulling in
 * Node.js built-ins like `fs`.
 */
import { setWebSocketConnectorSslLoader } from "./websocket-connector-factory.js";

setWebSocketConnectorSslLoader(async (logger) => {
  if (typeof process === "undefined" || !process.versions?.node) {
    return undefined;
  }

  const certFile = process.env.SSL_CERT_FILE;
  if (!certFile) {
    return undefined;
  }

  try {
    const fsModule = await import("fs").catch(async () => await import("node:fs"));
    const readFileSync: unknown =
      (fsModule as { readFileSync?: unknown }).readFileSync ??
      (fsModule as { default?: { readFileSync?: unknown } }).default?.readFileSync;

    if (typeof readFileSync !== "function") {
      logger.warning("ssl_certificate_loader_unavailable", {
        cert_file: certFile,
        reason: "readFileSync_not_available",
      });
      return undefined;
    }

    return (readFileSync as (path: string) => Buffer)(certFile);
  } catch (error) {
    logger.warning("ssl_certificate_load_failed", {
      cert_file: certFile,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
});
