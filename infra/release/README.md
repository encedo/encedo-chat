# Release manifests

Signed by the operator's OFFLINE root key in a YubiKey (`scripts/release-manifest.mjs --sign-yubikey`,
or `--unsigned` + `--attach-sig` when the token is on another machine),
verified by every client against `infra/root.pub`. The files are NOT committed:
they describe a tagged release and are served from `/var/lib/onchato/release/`
on the web host (`https://onchato.com/release/manifest.json` + `.sig`), so the
release commit can stay the tagged tip. Keep this directory empty in git.

⚠️ `release-manifest.mjs` writes a manifest from scratch. Without `--with-web`
it carries no `web` entry, so uploading it on its own un-approves the web build
that is live (the hourly monitor turns PENDING). After it, run
`scripts/approve-web.mjs --host <host> <tag>` for the tag that is live, which
puts the entry back and changes nothing else — the full order is
`relay/DEPLOY.md` step 9.
