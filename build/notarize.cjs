// electron-builder afterSign hook: notarize the macOS app with Apple.
// Runs only when signing credentials are present, so local unsigned builds and
// non-mac builds are unaffected. Requires these env vars (set in CI secrets):
//   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
const { notarize } = require('@electron/notarize')

exports.default = async function notarizeHook(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('Skipping notarization: Apple credentials not set.')
    return
  }

  const appName = context.packager.appInfo.productFilename
  console.log(`Notarizing ${appName}…`)
  await notarize({
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID
  })
  console.log('Notarization complete.')
}
