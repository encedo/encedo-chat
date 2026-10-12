# Release manifests

Signed by the operator's OFFLINE root key in a YubiKey (`scripts/release-manifest.mjs --sign-yubikey`,
or `--unsigned` + `--attach-sig` when the token is on another machine),
verified by every client against `infra/root.pub`. The files are NOT committed:
they describe a tagged release and are served from `/var/lib/onchato/release/`
on the web host (`https://onchato.com/release/manifest.json` + `.sig`), so the
release commit can stay the tagged tip. Keep this directory empty in git.
