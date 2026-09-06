# onchato icons - see docs/icon-spec.md
#
# Everything under assets/icon/ is generated. Edit scripts/build-icons.mjs (the
# geometry and the two colours live at the top of it), never the SVGs.

.PHONY: icons icons-app clean-icons

icons:
	npm install --silent
	node scripts/build-icons.mjs

# The app's own icon trees, from the same sources: the Tauri CLI writes the two
# formats sharp cannot (.icns, the Windows Square*Logo set) and the Android
# mipmaps, taking our foreground and monochrome layers through the manifest.
# Run `make icons` first - this consumes what it writes.
icons-app: icons
	cd impl && npx tauri icon ../assets/icon/tauri-src/icon.json -o src-tauri/icons

# The set is reproducible from the script, so throwing it away costs one build.
clean-icons:
	rm -rf assets/icon/src assets/icon/web assets/icon/android assets/icon/ios assets/icon/lockup assets/icon/preview
