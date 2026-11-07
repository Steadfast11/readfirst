// electron-builder leaves node_modules out of extra resources, so the web app is copied in here.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

exports.default = async ({ appOutDir, electronPlatformName, packager }) => {
  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents/Resources')
    : path.join(appOutDir, 'resources')
  fs.cpSync(path.join(__dirname, 'dist-app'), path.join(resources, 'web'), { recursive: true })
  // Apple silicon will not run an unsigned app. Without a paid certificate, a local signature is what is left.
  if (electronPlatformName === 'darwin') execFileSync('codesign', ['--force', '--deep', '-s', '-', path.dirname(path.dirname(resources))])
}
