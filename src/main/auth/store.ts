// Credential storage and lifecycle. Tokens are encrypted with Electron's
// safeStorage (Keychain / DPAPI / libsecret) and written under userData.
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { AuthState } from '@shared/types'
import { TokenSet, emailFromIdToken, refreshTokens, runOAuthFlow } from './oauth'

const REFRESH_SKEW_MS = 120_000

interface StoredCredentials {
  method: 'oauth' | 'apiKey'
  tokens?: TokenSet
  apiKey?: string
  email?: string
}

function credFile(): string {
  return path.join(app.getPath('userData'), 'credentials.bin')
}

function readStored(): StoredCredentials | null {
  try {
    const raw = fs.readFileSync(credFile())
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
    return JSON.parse(json) as StoredCredentials
  } catch {
    return null
  }
}

function writeStored(creds: StoredCredentials | null): void {
  const file = credFile()
  if (!creds) {
    fs.rmSync(file, { force: true })
    return
  }
  const json = JSON.stringify(creds)
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf8')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data, { mode: 0o600 })
}

export class AuthManager {
  private creds: StoredCredentials | null = null
  private loaded = false
  private pendingLogin = false
  private refreshInFlight: Promise<TokenSet> | null = null

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.creds = readStored()
      this.loaded = true
    }
  }

  getState(): AuthState {
    this.ensureLoaded()
    if (this.pendingLogin) return { method: null, pending: true }
    if (!this.creds) return { method: null }
    return { method: this.creds.method, email: this.creds.email }
  }

  async loginOAuth(): Promise<void> {
    this.pendingLogin = true
    try {
      const tokens = await runOAuthFlow()
      this.creds = {
        method: 'oauth',
        tokens,
        email: emailFromIdToken(tokens.idToken)
      }
      writeStored(this.creds)
    } finally {
      this.pendingLogin = false
    }
  }

  setApiKey(key: string): void {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('API key is empty')
    this.creds = { method: 'apiKey', apiKey: trimmed }
    writeStored(this.creds)
  }

  logout(): void {
    this.creds = null
    writeStored(null)
  }

  isAuthenticated(): boolean {
    this.ensureLoaded()
    return this.creds !== null
  }

  usingOAuth(): boolean {
    this.ensureLoaded()
    return this.creds?.method === 'oauth'
  }

  /** Return a bearer credential, refreshing the OAuth access token if stale. */
  async getBearer(): Promise<string> {
    this.ensureLoaded()
    if (!this.creds) throw new Error('Not signed in. Connect your xAI account in Settings.')
    if (this.creds.method === 'apiKey') return this.creds.apiKey ?? ''
    const tokens = this.creds.tokens
    if (!tokens) throw new Error('OAuth tokens missing. Sign in again.')
    if (tokens.expiresAt > Date.now() + REFRESH_SKEW_MS) return tokens.accessToken
    return (await this.forceRefresh()).accessToken
  }

  /** Refresh now (used on 401s). Deduplicates concurrent refreshes. */
  async forceRefresh(): Promise<TokenSet> {
    this.ensureLoaded()
    if (this.creds?.method !== 'oauth' || !this.creds.tokens) {
      throw new Error('No OAuth session to refresh.')
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = refreshTokens(this.creds.tokens)
        .then((next) => {
          this.creds = {
            ...this.creds!,
            tokens: next,
            email: this.creds!.email ?? emailFromIdToken(next.idToken)
          }
          writeStored(this.creds)
          return next
        })
        .catch((err) => {
          // A terminally-dead refresh token means the user must sign in again.
          const msg = err instanceof Error ? err.message : String(err)
          if (/invalid_grant|HTTP 40[013]/.test(msg)) {
            this.logout()
            throw new Error('Your xAI session expired. Please sign in again.')
          }
          throw err
        })
        .finally(() => {
          this.refreshInFlight = null
        })
    }
    return this.refreshInFlight
  }
}

export const authManager = new AuthManager()
