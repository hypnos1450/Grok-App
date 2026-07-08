// xAI OAuth 2.0 authorization-code + PKCE flow (loopback redirect).
// This is the same public desktop client flow used by the Grok CLI, so a
// SuperGrok or X Premium+ subscription can be used instead of an API key.
import crypto from 'node:crypto'
import http from 'node:http'
import { shell } from 'electron'

export const XAI_API_BASE_URL = 'https://api.x.ai/v1'
const XAI_OAUTH_ISSUER = 'https://auth.x.ai'
const XAI_OAUTH_AUTHORIZE_URL = `${XAI_OAUTH_ISSUER}/oauth2/authorize`
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`
// Public desktop OAuth client ID used by the Grok CLI flow — not a secret.
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828'
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access'
const REDIRECT_PORT = 56121
const CALLBACK_TIMEOUT_MS = 180_000

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** epoch ms */
  expiresAt: number
  idToken?: string
  tokenEndpoint: string
}

interface Discovery {
  authorizationEndpoint: string
  tokenEndpoint: string
}

function assertXaiUrl(url: string, field: string): string {
  const parsed = new URL(url)
  const host = parsed.hostname.toLowerCase()
  if (parsed.protocol !== 'https:' || (host !== 'x.ai' && !host.endsWith('.x.ai'))) {
    throw new Error(`OAuth discovery returned an unexpected ${field}: ${url}`)
  }
  return url
}

async function discover(): Promise<Discovery> {
  const res = await fetch(XAI_OAUTH_DISCOVERY_URL, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`xAI OIDC discovery failed (HTTP ${res.status})`)
  const doc = (await res.json()) as Record<string, unknown>
  const authorizationEndpoint = String(doc.authorization_endpoint ?? '').trim()
  const tokenEndpoint = String(doc.token_endpoint ?? '').trim()
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error('xAI OIDC discovery missing endpoints')
  }
  return {
    authorizationEndpoint: assertXaiUrl(authorizationEndpoint, 'authorization_endpoint'),
    tokenEndpoint: assertXaiUrl(tokenEndpoint, 'token_endpoint')
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

interface Listener {
  redirectUri: string
  waitForCallback(timeoutMs: number): Promise<URL>
  close(): Promise<void>
}

/** Start the loopback callback server, preferring the port xAI expects. */
async function startListener(): Promise<Listener> {
  let resolveCb: (u: URL) => void
  let rejectCb: (e: Error) => void
  const callbackPromise = new Promise<URL>((res, rej) => {
    resolveCb = res
    rejectCb = rej
  })

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      `<html><body style="font-family:system-ui;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>Signed in to xAI</h2><p>You can close this tab and return to Grok Harness.</p></div></body></html>`
    )
    resolveCb(url)
  })

  const port = await new Promise<number>((res, rej) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Fall back to a random port; xAI accepts any 127.0.0.1 loopback URI.
        server.removeAllListeners('error')
        server.once('error', rej)
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address()
          res(typeof addr === 'object' && addr ? addr.port : 0)
        })
      } else {
        rej(err)
      }
    })
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const addr = server.address()
      res(typeof addr === 'object' && addr ? addr.port : REDIRECT_PORT)
    })
  })

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    waitForCallback: (timeoutMs) => {
      const timer = setTimeout(
        () => rejectCb(new Error('Timed out waiting for the browser sign-in to complete.')),
        timeoutMs
      )
      return callbackPromise.finally(() => clearTimeout(timer))
    },
    close: () =>
      new Promise((res) => {
        server.close(() => res())
      })
  }
}

async function parseTokenResponse(
  res: Response,
  startedAt: number,
  tokenEndpoint: string,
  fallbackRefresh = ''
): Promise<TokenSet> {
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`xAI token request failed (HTTP ${res.status})${text ? `: ${text}` : ''}`)
  }
  const payload = JSON.parse(text) as Record<string, unknown>
  const accessToken = String(payload.access_token ?? '').trim()
  const refreshToken = String(payload.refresh_token ?? fallbackRefresh).trim()
  if (!accessToken) throw new Error('xAI token response missing access_token')
  if (!refreshToken) throw new Error('xAI token response missing refresh_token')
  const expiresIn = Number(payload.expires_in)
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? startedAt + expiresIn * 1000
      : jwtExpiry(accessToken) ?? startedAt + 3600 * 1000
  return {
    accessToken,
    refreshToken,
    expiresAt,
    idToken: String(payload.id_token ?? '').trim() || undefined,
    tokenEndpoint
  }
}

function jwtExpiry(token?: string): number | undefined {
  if (!token || !token.includes('.')) return undefined
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/** Best-effort email extraction from the id_token for display purposes. */
export function emailFromIdToken(idToken?: string): string | undefined {
  if (!idToken || !idToken.includes('.')) return undefined
  try {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'))
    return typeof claims.email === 'string' ? claims.email : undefined
  } catch {
    return undefined
  }
}

/**
 * Run the full interactive sign-in: open the system browser to auth.x.ai,
 * capture the loopback callback, and exchange the code for tokens.
 */
export async function runOAuthFlow(): Promise<TokenSet> {
  const discovery = await discover()
  const listener = await startListener()
  try {
    const verifier = b64url(crypto.randomBytes(48))
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
    const state = crypto.randomBytes(24).toString('hex')
    const nonce = crypto.randomBytes(24).toString('hex')

    const authorizeUrl = new URL(XAI_OAUTH_AUTHORIZE_URL)
    authorizeUrl.searchParams.set('response_type', 'code')
    authorizeUrl.searchParams.set('client_id', XAI_OAUTH_CLIENT_ID)
    authorizeUrl.searchParams.set('redirect_uri', listener.redirectUri)
    authorizeUrl.searchParams.set('scope', XAI_OAUTH_SCOPE)
    authorizeUrl.searchParams.set('code_challenge', challenge)
    authorizeUrl.searchParams.set('code_challenge_method', 'S256')
    authorizeUrl.searchParams.set('state', state)
    authorizeUrl.searchParams.set('nonce', nonce)
    authorizeUrl.searchParams.set('plan', 'generic')
    authorizeUrl.searchParams.set('referrer', 'grok-cli')

    await shell.openExternal(authorizeUrl.toString())

    const callback = await listener.waitForCallback(CALLBACK_TIMEOUT_MS)
    const oauthError = callback.searchParams.get('error')
    if (oauthError) {
      throw new Error(callback.searchParams.get('error_description') ?? oauthError)
    }
    const code = callback.searchParams.get('code')
    if (!code) throw new Error('OAuth callback missing authorization code')
    if (callback.searchParams.get('state') !== state) throw new Error('OAuth state mismatch')

    const startedAt = Date.now()
    const res = await fetch(discovery.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: listener.redirectUri,
        client_id: XAI_OAUTH_CLIENT_ID,
        code_verifier: verifier,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      })
    })
    return await parseTokenResponse(res, startedAt, discovery.tokenEndpoint)
  } finally {
    await listener.close().catch(() => undefined)
  }
}

export async function refreshTokens(tokens: TokenSet): Promise<TokenSet> {
  const tokenEndpoint = tokens.tokenEndpoint || (await discover()).tokenEndpoint
  assertXaiUrl(tokenEndpoint, 'token_endpoint')
  const startedAt = Date.now()
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: tokens.refreshToken
    })
  })
  const next = await parseTokenResponse(res, startedAt, tokenEndpoint, tokens.refreshToken)
  return { ...next, idToken: next.idToken ?? tokens.idToken }
}
