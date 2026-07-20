# One-time signing setup (TerminalClaw mobile)

Same approach as the other apps (`~/whosout/IOS-BUILDS-VIA-GITHUB.md`; working
references: scrcpy-native, notes-app). The existing Apple Distribution
certificate is reused — only the provisioning profile is per-app, because this
app has its own bundle id (`com.zacmorriss.terminalclaw`).

## 1. Create the ad-hoc profile for com.zacmorriss.terminalclaw

Interactive (any machine with your Expo login):

```
cd ~/terminalclaw/mobile
npx eas-cli login          # if needed
npx eas-cli credentials -p ios
```

Pick the **production/ad-hoc** flow and "Set up all the required credentials".
Reuse the existing Apple Distribution cert when offered. Make sure every device
you want is registered first (`npx eas-cli device:create`).

Then export: `npx eas-cli credentials` → iOS → *Download credentials from EAS
to credentials.json*. That yields `dist-cert.p12` (+ password inside
credentials.json) and `profile.mobileprovision`.

## 2. Load into GitHub and arm the workflow

Secrets live on the **terminalclaw** repo (the workflow is
`.github/workflows/ios-signed.yml` at the repo root, building `mobile/`):

```
cd ~/terminalclaw
base64 -w0 mobile/dist-cert.p12           | gh secret set IOS_DIST_CERT_P12
echo -n '<p12 password>'                  | gh secret set IOS_CERT_PASSWORD
base64 -w0 mobile/profile.mobileprovision | gh secret set IOS_PROVISIONING_PROFILE
gh variable set SIGNING_READY -b true
shred -u mobile/dist-cert.p12 mobile/profile.mobileprovision mobile/credentials.json
```

Kick a build with `gh workflow run ios-signed.yml` (or push to `mobile/`).
The signed IPA lands on the repo's `app-latest` release as `terminalclaw.ipa`.

Note: this repo is **public** — the release IPA is downloadable by anyone, but
it is ad-hoc signed (runs only on your registered UDIDs) and contains no
hostnames or secrets (machines are added in-app and stored in the keychain).
If that still feels wrong, move `mobile/` to a private repo later.

## 3. In the app

Add each machine with its dashboard URL (e.g. `https://minotaur.zacmorriss.com`)
and its layer-2 gate password. You get a 30-day token per box (stored in the
iOS keychain); when it expires, tap the machine and log in again.

Requirement per box: the hostname must reach the box's Caddy gate directly —
i.e. **no Cloudflare Access in front** (same decision as scrcpy-native; the
gate + rate-limited login + signed tokens are the auth). If a hostname still
has Access enabled, exempt it or use a separate hostname for the app.
