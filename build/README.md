# Release signing & notarization

These files configure signed, notarized production builds. **Credentials are
supplied via environment variables — never commit them.**

## macOS
Set before running `npm run dist:mac`:

| Variable | What |
|----------|------|
| `CSC_LINK` | base64 or path of your Developer ID Application `.p12` |
| `CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password from appleid.apple.com |
| `APPLE_TEAM_ID` | your 10-char Apple Team ID |

Notarization runs automatically via `build/notarize.cjs` when those Apple vars
are present; it's skipped otherwise (so local unsigned builds still work).

## Windows
| Variable | What |
|----------|------|
| `CSC_LINK` | base64 or path of your code-signing `.pfx` |
| `CSC_KEY_PASSWORD` | password for that `.pfx` |

## Auto-update publishing
`package.json` → `build.publish` points at GitHub Releases. Replace
`YOUR_GITHUB_OWNER` with your GitHub account/org, and set `GH_TOKEN` (a repo
`contents:write` token) when running `electron-builder --publish always` (the CI
workflow does this on tags).

## Icon
Add `build/icon.icns` (mac), `build/icon.ico` (win), and `build/icon.png`
(512×512, linux). electron-builder picks them up automatically.
