export interface SafeImportOptions {
  /**
   * Human-friendly name of the optional dependency. Used in the default error message when the module is missing.
   */
  dependencyName: string;
  /**
   * Optional custom message to surface when the dependency cannot be loaded.
   */
  helpMessage?: string;
}

function isModuleNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message || '';
  if (
    message.includes('Cannot find module') ||
    message.includes('ERR_MODULE_NOT_FOUND') ||
    message.includes('MODULE_NOT_FOUND')
  ) {
    return true;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') {
    return code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND';
  }

  return false;
}

/**
 * Wraps a dynamic import loader and enriches "module not found" failures with an actionable error message.
 */
export async function safeImport<T>(
  loader: () => Promise<T>,
  dependencyNameOrOptions: string | SafeImportOptions,
  maybeOptions?: Omit<SafeImportOptions, 'dependencyName'>
): Promise<T> {
  const options: SafeImportOptions =
    typeof dependencyNameOrOptions === 'string'
      ? { dependencyName: dependencyNameOrOptions, ...(maybeOptions ?? {}) }
      : dependencyNameOrOptions;

  const dependencyName = options.dependencyName;

  try {
    return await loader();
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      const message =
        options.helpMessage ??
        `Missing optional dependency "${dependencyName}". Install it to enable this feature.`;
      const enrichedError = new Error(message);
      try {
        (enrichedError as Error & { cause?: unknown }).cause = error;
      } catch {
        // Ignore environments that do not support attaching a cause.
      }
      throw enrichedError;
    }

    throw error;
  }
}
