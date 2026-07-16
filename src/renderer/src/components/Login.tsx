import { useState } from 'react'
import { AuthState } from '@shared/types'

export default function Login({ onAuthed }: { onAuthed: (a: AuthState) => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [apiKey, setApiKey] = useState('')

  const loginOAuth = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await window.harness.auth.loginOAuth()
    if (!res.ok) {
      setBusy(false)
      setError(res.error ?? 'Sign-in failed')
      return
    }
    // Catch xAI's OAuth-allowlist 403 now, not on the first real message.
    const probe = await window.harness.auth.probe()
    setBusy(false)
    if (!probe.ok && probe.status === 403) {
      await window.harness.auth.logout()
      setError(probe.message ?? 'This account is not allowlisted for API access.')
      return
    }
    onAuthed(await window.harness.auth.getState())
  }

  const saveKey = async (): Promise<void> => {
    setError(null)
    const res = await window.harness.auth.setApiKey(apiKey)
    if (res.ok) {
      onAuthed(await window.harness.auth.getState())
    } else {
      setError(res.error ?? 'Invalid API key')
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">Conduit</div>
        <div className="login-sub">An agent workbench for Grok 4.5 and Grok 4.3</div>

        <button className="btn primary" onClick={() => void loginOAuth()} disabled={busy}>
          {busy ? 'Waiting for browser sign-in…' : 'Sign in with xAI'}
        </button>
        <div className="login-note">
          Uses your SuperGrok or X Premium+ subscription — no API key needed. Your browser will
          open to accounts.x.ai.
        </div>

        <div className="login-divider">or</div>

        {showKey ? (
          <>
            <input
              className="login-input"
              type="password"
              placeholder="xai-…"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && apiKey.trim() && void saveKey()}
              autoFocus
            />
            <button className="btn" onClick={() => void saveKey()} disabled={!apiKey.trim()}>
              Use API key
            </button>
          </>
        ) : (
          <button className="btn" onClick={() => setShowKey(true)}>
            Use an xAI API key instead
          </button>
        )}

        {error && <div className="login-error">{error}</div>}
      </div>
    </div>
  )
}
