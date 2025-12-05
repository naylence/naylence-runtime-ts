import type { CredentialProvider } from './credential-provider.js';

export type PromptResolver = () => Promise<string | null> | string | null;

export class PromptCredentialProvider implements CredentialProvider {
  private readonly credentialName: string;
  private readonly resolver: PromptResolver;
  private cachedValue: string | null | undefined = undefined;

  constructor(credentialName = 'credential', resolver?: PromptResolver) {
    this.credentialName = credentialName;
    this.resolver = resolver ?? (() => this.promptCredential());
  }

  public async get(): Promise<Uint8Array | string | null> {
    if (this.cachedValue !== undefined) {
      return this.cachedValue;
    }

    const result = await this.resolvePrompt();
    const normalized =
      result && typeof result === 'string' ? result.trim() : result;

    this.cachedValue = normalized && normalized.length > 0 ? normalized : null;
    return this.cachedValue;
  }

  private async resolvePrompt(): Promise<string | null> {
    try {
      const value = await this.resolver();
      if (typeof value === 'string') {
        return value;
      }
      return value ?? null;
    } catch {
      return null;
    }
  }

  private async promptCredential(): Promise<string | null> {
    if (typeof globalThis.prompt === 'function') {
      const response = globalThis.prompt(
        `Enter credential '${this.credentialName}': `
      );
      if (typeof response === 'string') {
        const trimmed = response.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
      return null;
    }

    const globalObject =
      typeof globalThis !== 'undefined'
        ? (globalThis as Record<string, unknown>)
        : {};
    const processObject = globalObject.process as
      | {
          stdin?: NodeJS.ReadableStream | null;
          stdout?: NodeJS.WritableStream | null;
        }
      | undefined;

    if (processObject?.stdin && processObject.stdout) {
      try {
        const moduleSpecifier = String.fromCharCode(
          114,
          101,
          97,
          100,
          108,
          105,
          110,
          101
        );
        const readlineModule = (await import(
          /* @vite-ignore */ moduleSpecifier
        )) as typeof import('readline');
        return await new Promise<string | null>((resolve) => {
          const rl = readlineModule.createInterface({
            input: processObject.stdin!,
            output: processObject.stdout!,
          });

          rl.question(
            `Enter credential '${this.credentialName}': `,
            (answer) => {
              rl.close();
              const trimmed = answer.trim();
              resolve(trimmed.length > 0 ? trimmed : null);
            }
          );
        });
      } catch {
        return null;
      }
    }

    return null;
  }
}
