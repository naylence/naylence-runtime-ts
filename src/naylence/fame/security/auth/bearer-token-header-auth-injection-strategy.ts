import type { AuthInjectionStrategy } from './auth-injection-strategy.js';
import { isTokenExpired } from './token.js';
import type { TokenProvider } from './token-provider.js';
import { TokenProviderFactory } from './token-provider-factory.js';
import type { BearerTokenHeaderAuthInjectionStrategyConfig } from './bearer-token-header-auth-injection-strategy-factory.js';

export interface BearerTokenHeaderAuthInjectionOptions {
  type?: 'BearerTokenHeaderAuth';
  tokenProvider: BearerTokenHeaderAuthInjectionStrategyConfig['tokenProvider'];
  headerName: string;
}

export class BearerTokenHeaderAuthInjectionStrategy implements AuthInjectionStrategy {
  private refreshLoop: Promise<void> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private timerResolver: (() => void) | null = null;
  private stopped = false;

  public constructor(private readonly options: BearerTokenHeaderAuthInjectionOptions) {}

  public async apply(connector: unknown): Promise<void> {
    const provider = await TokenProviderFactory.createTokenProvider(this.options.tokenProvider);
    await this.updateAuthHeader(connector, provider);
    this.startRefreshLoop(connector, provider);
  }

  private async updateAuthHeader(connector: unknown, provider: TokenProvider): Promise<void> {
    const token = await provider.getToken();
    const authHeader = `Bearer ${token.value}`;

    if (isSetAuthHeaderCapable(connector)) {
      connector.setAuthHeader(authHeader);
      return;
    }

    if (isHeaderMap(connector)) {
      connector[this.options.headerName] = authHeader;
      return;
    }

    console.warn(
      `Connector of type ${connector ? connector.constructor?.name ?? typeof connector : 'unknown'} ` +
        "does not support auth header injection"
    );
  }

  private startRefreshLoop(connector: unknown, provider: TokenProvider): void {
    this.stopRefreshLoop();
    this.stopped = false;
    this.refreshLoop = this.runRefreshLoop(connector, provider);
  }

  private stopRefreshLoop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    if (this.timerResolver) {
      const resolve = this.timerResolver;
      this.timerResolver = null;
      resolve();
    }
  }

  private async runRefreshLoop(connector: unknown, provider: TokenProvider): Promise<void> {
    while (!this.stopped) {
      try {
        const token = await provider.getToken();
        const delayMs = this.computeDelayMs(token);
        await this.wait(delayMs);
        if (this.stopped) {
          break;
        }

        await this.updateAuthHeader(connector, provider);
        console.debug('auth_token_refreshed', { connectorType: connectorTypeName(connector) });
      } catch (error) {
        if (this.stopped) {
          break;
        }

        console.error('auth_token_refresh_failed', error);
        await this.wait(60_000);
      }
    }
  }

  private async wait(delayMs: number): Promise<void> {
    if (delayMs <= 0 || this.stopped) {
      return;
    }

    await new Promise<void>((resolve) => {
      this.timerResolver = resolve;
      this.refreshTimer = setTimeout(() => {
        this.refreshTimer = null;
        this.timerResolver = null;
        resolve();
      }, delayMs);
    });
  }

  private computeDelayMs(token: Awaited<ReturnType<TokenProvider['getToken']>>): number {
    if (!token || isTokenExpired(token)) {
      return 60_000;
    }

    if (typeof token.expiresAt !== 'number') {
      return 3_600_000;
    }

    const now = Date.now();
    const timeUntilExpiry = token.expiresAt - now;
    const refreshLeadMs = 30_000;
    return Math.max(timeUntilExpiry - refreshLeadMs, 60_000);
  }

  public async cleanup(): Promise<void> {
    this.stopRefreshLoop();
    if (this.refreshLoop) {
      try {
        await this.refreshLoop;
      } catch (error) {
        if (!this.stopped) {
          throw error;
        }
      } finally {
        this.refreshLoop = null;
      }
    }
  }
}

interface HeaderCapableConnector {
  setAuthHeader(value: string): void;
}

function isSetAuthHeaderCapable(connector: unknown): connector is HeaderCapableConnector {
  return (
    typeof connector === 'object' &&
    connector !== null &&
    typeof (connector as Partial<HeaderCapableConnector>).setAuthHeader === 'function'
  );
}

interface HeaderMap {
  [header: string]: string;
}

function isHeaderMap(connector: unknown): connector is HeaderMap {
  return typeof connector === 'object' && connector !== null;
}

function connectorTypeName(connector: unknown): string {
  if (!connector) {
    return 'unknown';
  }

  if (typeof connector === 'object' && 'constructor' in connector && connector.constructor) {
    return connector.constructor.name ?? 'object';
  }

  return typeof connector;
}
