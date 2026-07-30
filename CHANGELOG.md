# Inzeedo POS Desktop App - Changelog

## [1.2.5] - 2026-07-30

### Added

- **Remember Me Functionality**: Added a local credential saving mechanism to the desktop app. Users can now check "Remember my credentials" during login so they don't have to type their credentials on every app launch.

### Fixed

- **White Screen Fix**: Resolved a critical issue causing the application to show a white screen on fresh installs and subsequent reboots by correctly configuring desktop database dependencies.
- **Dependency Bundling**: Completely synchronized internal desktop node modules with the latest backend requirements (`archiver-zip-encrypted`, `crypto-js`, `googleapis`, `semver`) to resolve runtime crashes during the setup wizard and daemon startup.
- **Environment Targeting**: Fixed an issue where the `.exe` setup wizard mistakenly booted the backend into VPS mode instead of desktop mode, blocking frontend file serving.

## [1.2.4] - Previous Releases

- Integrated dual HRM authentication workflows.
- Stabilized electron `fork()` process mechanics for IPC background worker.
- Applied new white-labelled UI enhancements.
