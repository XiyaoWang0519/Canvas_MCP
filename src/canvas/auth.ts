import { fetch } from 'undici';

import { USER_AGENT } from '../core/meta.js';
import { sleep } from '../core/async.js';

export interface CanvasAuthStrategy {
  getAuthorizationHeader(): Promise<string>;
  handleUnauthorized(): Promise<boolean>;
}

interface OAuthOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  accessToken?: string;
  refreshToken: string;
}

class PersonalAccessTokenAuth implements CanvasAuthStrategy {
  constructor(private readonly token: string) {}

  async getAuthorizationHeader(): Promise<string> {
    return `Bearer ${this.token}`;
  }

  async handleUnauthorized(): Promise<boolean> {
    return false;
  }
}

class OAuthTokenAuth implements CanvasAuthStrategy {
  private accessToken?: string;
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private refreshToken: string;
  private refreshing: Promise<void> | null = null;
  private tokenExpiresAt: number | null = null;

  constructor(options: OAuthOptions) {
    this.baseUrl = options.baseUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.refreshToken = options.refreshToken;
    this.accessToken = options.accessToken;
  }

  async getAuthorizationHeader(): Promise<string> {
    if (this.shouldRefreshSoon()) {
      await this.refreshTokenPair();
    }

    if (!this.accessToken) {
      await this.refreshTokenPair();
    }

    if (!this.accessToken) {
      throw new Error('Missing Canvas access token after refresh.');
    }

    return `Bearer ${this.accessToken}`;
  }

  async handleUnauthorized(): Promise<boolean> {
    await this.refreshTokenPair(true);
    return Boolean(this.accessToken);
  }

  private shouldRefreshSoon(): boolean {
    if (!this.tokenExpiresAt) {
      return false;
    }

    const refreshThreshold = this.tokenExpiresAt - 60_000;
    return Date.now() >= refreshThreshold;
  }

  private async refreshTokenPair(force = false): Promise<void> {
    if (this.refreshing) {
      await this.refreshing;
      return;
    }

    this.refreshing = this.performRefresh(force);

    try {
      await this.refreshing;
    } finally {
      this.refreshing = null;
    }
  }

  private async performRefresh(force: boolean): Promise<void> {
    const url = new URL('/login/oauth2/token', this.baseUrl);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId
    });

    if (this.clientSecret) {
      body.set('client_secret', this.clientSecret);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': USER_AGENT
      },
      body: body.toString()
    });

    if (!response.ok) {
      if (!force) {
        // Small delay before surfacing non-forced refresh errors to avoid hot loops.
        await sleep(300);
      }
      throw new Error(`Canvas OAuth token refresh failed with status ${response.status}`);
    }

    const payload = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    this.accessToken = payload.access_token;

    if (payload.refresh_token) {
      this.refreshToken = payload.refresh_token;
    }

    if (payload.expires_in && Number.isFinite(payload.expires_in)) {
      this.tokenExpiresAt = Date.now() + Math.max(payload.expires_in - 60, 0) * 1000;
    } else {
      this.tokenExpiresAt = null;
    }
  }
}

export function createAuthStrategy(options: {
  baseUrl: string;
  pat?: string;
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
}): CanvasAuthStrategy {
  if (options.pat) {
    return new PersonalAccessTokenAuth(options.pat);
  }

  if (options.clientId && options.clientSecret && options.refreshToken) {
    return new OAuthTokenAuth({
      baseUrl: options.baseUrl,
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      accessToken: options.accessToken,
      refreshToken: options.refreshToken
    });
  }

  throw new Error('No Canvas authentication method configured.');
}
