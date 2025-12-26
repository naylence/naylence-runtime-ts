export interface RegisterProfileOptions {
  allowOverride?: boolean;
  source?: string;
}

export type ProfileConfig = Record<string, unknown>;

const registry = new Map<string, Map<string, ProfileConfig>>();

function normalizeKey(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a non-empty string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must be a non-empty string`);
  }

  return trimmed;
}

function cloneConfig<T extends ProfileConfig>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function registerProfile(
  baseType: string,
  name: string,
  config: ProfileConfig,
  options?: RegisterProfileOptions
): void {
  const normalizedBase = normalizeKey(baseType, 'baseType');
  const normalizedName = normalizeKey(name, 'profile name');

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Profile '${normalizedName}' config must be an object`);
  }

  const profiles =
    registry.get(normalizedBase) ?? new Map<string, ProfileConfig>();

  if (profiles.has(normalizedName) && options?.allowOverride !== true) {
    const sourceLabel = options?.source ? ` (${options.source})` : '';
    throw new Error(
      `Profile '${normalizedName}' already registered for ${normalizedBase}${sourceLabel}`
    );
  }

  profiles.set(normalizedName, config);
  registry.set(normalizedBase, profiles);
}

export function getProfile(
  baseType: string,
  name: string
): ProfileConfig | null {
  const normalizedBase = normalizeKey(baseType, 'baseType');
  const normalizedName = normalizeKey(name, 'profile name');
  const profiles = registry.get(normalizedBase);
  if (!profiles) {
    return null;
  }

  const profile = profiles.get(normalizedName);
  return profile ? cloneConfig(profile) : null;
}

export function listProfiles(baseType: string): string[] {
  const normalizedBase = normalizeKey(baseType, 'baseType');
  const profiles = registry.get(normalizedBase);
  return profiles ? Array.from(profiles.keys()) : [];
}

export function clearProfiles(baseType?: string): void {
  if (!baseType) {
    registry.clear();
    return;
  }

  const normalizedBase = normalizeKey(baseType, 'baseType');
  registry.delete(normalizedBase);
}
