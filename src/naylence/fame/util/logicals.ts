import { parseAddressComponents } from "naylence-core";

const POOL_WILDCARD_PREFIX = "*.";

const DNS_HOSTNAME_PATTERN = /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?)+$/;
const DNS_LABEL_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

function getEnv(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }

  return process.env?.[name];
}

export function getFameRoot(): string {
  return getEnv("FAME_ROOT") ?? "fame.fabric";
}

export function isPoolLogical(logical: string | null | undefined): boolean {
  return Boolean(logical?.startsWith(POOL_WILDCARD_PREFIX));
}

export function matchesPoolLogical(logical: string, poolPattern: string): boolean {
  if (!isPoolLogical(poolPattern)) {
    return false;
  }

  const suffix = poolPattern.slice(POOL_WILDCARD_PREFIX.length);
  if (!suffix) {
    return false;
  }

  return (logical.endsWith(`.${suffix}`) && logical !== suffix) || logical === suffix;
}

export function validateLogicalSegment(segment: string): [boolean, string | null] {
  if (!segment) {
    return [false, "Empty path segment"];
  }

  if (segment.length > 63) {
    return [false, `Path segment '${segment}' exceeds 63 characters`];
  }

  if (!/^[a-zA-Z0-9-]+$/.test(segment)) {
    return [
      false,
      `Path segment '${segment}' must contain only alphanumeric characters and hyphens`,
    ];
  }

  if (segment.startsWith("-") || segment.endsWith("-")) {
    return [false, `Path segment '${segment}' cannot start or end with hyphen`];
  }

  if (segment.includes("--")) {
    return [false, `Path segment '${segment}' cannot contain consecutive hyphens`];
  }

  return [true, null];
}

export function validateLogical(logical: string): [boolean, string | null] {
  if (!logical) {
    return [false, "Empty logical"];
  }

  if (!logical.startsWith("/")) {
    return [false, `Logical '${logical}' must start with '/'`];
  }

  const segments = logical.split("/").filter(Boolean);

  if (segments.length === 0) {
    return logical === "/"
      ? [true, null]
      : [false, "Logical must contain at least one non-empty segment"];
  }

  for (const segment of segments) {
    const [valid, error] = validateLogicalSegment(segment);
    if (!valid) {
      return [false, `Invalid logical '${logical}': ${error}`];
    }
  }

  const hostname = logicalToHostname(logical);
  if (hostname.length > 253) {
    return [false, `Logical '${logical}' converts to hostname exceeding 253 characters`];
  }

  return [true, null];
}

export function logicalToHostname(logical: string): string {
  if (!logical) {
    throw new Error("Empty logical");
  }

  if (!logical.startsWith("/")) {
    throw new Error(`Logical '${logical}' cannot start without '/'`);
  }

  const segments = logical.split("/").filter(Boolean);

  if (segments.length === 0) {
    if (logical === "/") {
      return getFameRoot();
    }
    throw new Error("Logical must contain at least one non-empty segment");
  }

  return segments.reverse().join(".");
}

export function hostnameToLogical(hostname: string): string {
  if (!hostname) {
    throw new Error("Empty hostname");
  }

  if (hostname === getFameRoot()) {
    return "/";
  }

  const segments = hostname.split(".");
  if (segments.some((segment) => !segment)) {
    throw new Error(`Invalid hostname '${hostname}' contains empty segments`);
  }

  return `/${segments.reverse().join("/")}`;
}

export function logicalsToHostnames(logicals: string[]): string[] {
  return logicals.map(logicalToHostname);
}

export function hostnamesToLogicals(hostnames: string[]): string[] {
  return hostnames.map(hostnameToLogical);
}

export function validateHostLogical(hostLogical: string): [boolean, string | null] {
  if (!hostLogical) {
    return [false, "Empty host logical"];
  }

  if (hostLogical.includes("*")) {
    if (!hostLogical.startsWith("*.")) {
      return [false, `Host logical '${hostLogical}' contains wildcard not in leftmost position`];
    }

    const baseDomain = hostLogical.slice(2);
    if (!baseDomain) {
      return [false, `Host logical '${hostLogical}' has wildcard but no base domain`];
    }

    if (!DNS_HOSTNAME_PATTERN.test(baseDomain)) {
      return [
        false,
        `Host logical '${hostLogical}' base domain '${baseDomain}' is not a valid DNS hostname`,
      ];
    }

    if (hostLogical.length > 253) {
      return [false, `Host logical '${hostLogical}' exceeds 253 characters`];
    }

    const labels = baseDomain.split(".");
    for (const label of labels) {
      if (!DNS_LABEL_PATTERN.test(label)) {
        return [
          false,
          `Host logical '${hostLogical}' contains invalid label '${label}' in base domain`,
        ];
      }
    }

    return [true, null];
  }

  if (!DNS_HOSTNAME_PATTERN.test(hostLogical)) {
    return [false, `Host logical '${hostLogical}' is not a valid DNS hostname`];
  }

  if (hostLogical.length > 253) {
    return [false, `Host logical '${hostLogical}' exceeds 253 characters`];
  }

  const labels = hostLogical.split(".");
  for (const label of labels) {
    if (!DNS_LABEL_PATTERN.test(label)) {
      return [false, `Host logical '${hostLogical}' contains invalid label '${label}'`];
    }
  }

  return [true, null];
}

export function validateHostLogicals(
  hostLogicals: string[] | null | undefined
): [boolean, string | null] {
  if (!hostLogicals || hostLogicals.length === 0) {
    return [true, null];
  }

  for (const hostLogical of hostLogicals) {
    const [valid, error] = validateHostLogical(hostLogical);
    if (!valid) {
      return [false, error];
    }
  }

  return [true, null];
}

export function createLogicalUri(logical: string, useHostnameNotation = false): string {
  if (useHostnameNotation) {
    const hostname = logicalToHostname(logical);
    return `naylence://${hostname}/`;
  }
  return `naylence://${logical}`;
}

export function createHostLogicalUri(hostLogical: string): string {
  return `naylence://${hostLogical}/`;
}

export function convertWildcardLogicalToDnsConstraint(logicalPattern: string): string {
  return logicalPattern.startsWith("*.") ? logicalPattern.slice(1) : logicalPattern;
}

export function logicalPatternsToDnsConstraints(logicalPatterns: string[]): string[] {
  return logicalPatterns.map(convertWildcardLogicalToDnsConstraint);
}

export function matchesPoolAddress(address: string, poolAddress: string): boolean {
  try {
    const [addrParticipant, addrHost, addrPath] = parseAddressComponents(address);
    const [poolParticipant, poolHost, poolPath] = parseAddressComponents(poolAddress);

    if (addrParticipant !== poolParticipant) {
      return false;
    }

    if (addrHost && poolHost) {
      if (!matchesPoolLogical(addrHost, poolHost)) {
        return false;
      }

      if (addrPath && poolPath) {
        return addrPath === poolPath;
      }

      return addrPath === poolPath;
    }

    if (!addrHost && !poolHost && addrPath && poolPath) {
      return addrPath === poolPath;
    }

    return false;
  } catch (error) {
    if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.debug("matchesPoolAddress failed", error);
    }
    return false;
  }
}

export function extractPoolBase(poolPattern: string): string | null {
  if (!isPoolLogical(poolPattern)) {
    return null;
  }
  return poolPattern.slice(POOL_WILDCARD_PREFIX.length);
}

export function extractPoolAddressBase(poolAddress: string): string | null {
  try {
    const [participant, host, path] = parseAddressComponents(poolAddress);
    if (host && isPoolLogical(host)) {
      const base = extractPoolBase(host);
      if (!base) {
        return null;
      }
      return path ? `${participant}@${base}${path}` : `${participant}@${base}`;
    }
    return null;
  } catch {
    return null;
  }
}

export function isPoolAddress(address: string): boolean {
  try {
    const [, host] = parseAddressComponents(address);
    return Boolean(host && isPoolLogical(host));
  } catch {
    return false;
  }
}
