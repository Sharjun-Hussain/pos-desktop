<div align="center">
  <h1>Inzeedo ERP - Standalone Desktop Shell</h1>
  <p>Dedicated hardware wrapper and standalone execution environment for legacy systems.</p>
</div>

---

## 📖 Overview

The **Standalone Desktop Shell** is a lightweight Electron-based application that serves as an alternative deployment target. It provides a dedicated hardware wrapper, a licensing service, and an initial setup wizard for specialized, offline, or highly locked-down point-of-sale environments.

## ⚡ Key Features

- **Setup Wizard**: Out-of-the-box configuration GUI for first-time installation and hardware setup.
- **Licensing Service**: Integrated module (`licensing-service.js`) to manage offline software licensing and machine binding.
- **Hardware Abstraction**: Deep integration with local hardware devices, bypassing browser security restrictions for direct serial/USB communication.
- **Standalone Execution**: Designed to package the web interface assets into a single distributable executable without requiring a local web server to be actively managed by the user.

## 🛠 Tech Stack

- **Framework**: [Electron](https://www.electronjs.org/)
- **Build System**: [electron-builder](https://www.electron.build/)
- **Core Languages**: Node.js, HTML/JS for Wizard UIs

## 🚀 Getting Started

### Prerequisites
- Node.js >= 16.x (Check compatibility with specific native modules)
- npm or yarn

### Installation

1. Clone the repository and navigate to the `desktop` directory:
   ```bash
   cd pos/important/desktop
   ```
2. Install dependencies:
   ```bash
   npm install
   ```

### Running Locally
To launch the Electron application wrapper locally for testing:
```bash
npm start
```
*Note: Ensure the local API or bundled static assets are available for the wrapper to load.*

## 📦 Build & Distribution

This module relies heavily on `electron-builder` for cross-platform distribution. The configuration is defined in `electron-builder.yml`.

To compile the application into an executable (`.exe`, etc.):
```bash
npm run dist
# or
npx electron-builder
```
Ensure all required signing keys are present in the `keys` directory before generating production builds to prevent OS security warnings.
