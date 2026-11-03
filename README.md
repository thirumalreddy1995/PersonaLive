# PersonaLive Desktop Studio

> Real-time AI Face Transformation & Replacement Desktop Studio with facial landmark tracking, natural blinking, speech articulation, and virtual camera routing.

---

## 🚀 Quick Start (Running Locally)

### Prerequisites
- **Node.js:** v18.0.0 or later (Node 20+ or 22+ recommended)
- **Package Manager:** `npm`, `pnpm`, `yarn`, or `bun`

### 1. Clone or Download the Project
```bash
git clone <your-repository-url>
cd personalive-desktop
```

### 2. Install Dependencies
```bash
npm install
```
*(or `pnpm install` / `bun install`)*

### 3. Start the Development Server
```bash
npm run dev
```

### 4. Open in Your Browser
Once the dev server starts, open:
```
http://localhost:3000
```

---

## 🔑 Default Sign-In Credentials

When you launch the app, sign in using the pre-configured administrator credentials:
- **Email:** `admin@personalive.ai`
- **Password:** `admin123`
*(Or click the blue **"1-Click Sign In as Admin"** button on the login screen).*

---

## 🧪 Running Unit Tests

To run the facial kinematics math tests (Eye Aspect Ratio, Mouth Aspect Ratio, Head Pose Rodrigues estimation, 1-Euro smoothing filter, quality evaluator, and C2PA consent hashing):

```bash
npx --yes tsx --test src/utils/faceMath.test.ts
```

---

## 📦 Building for Production

To build the optimized static production bundle:

```bash
npm run build
```
The output will be placed in the `dist/` directory.

To preview the production build locally:
```bash
npm run preview
```

---

## 🖥️ Desktop App Installation & Automated Push Updates

PersonaLive Desktop Studio provides two distribution methods for running as a standalone desktop application with automated updates whenever you push code changes.

### 🌟 Method 1: Desktop PWA (Fastest, Zero Friction & Instant Background Auto-Updates)

This method requires **no installer packaging**, takes **10 seconds**, and updates automatically whenever you push code changes.

#### How to Install on Your Computer:
1. Open the app in **Google Chrome**, **Microsoft Edge**, or **Brave**:
   ```
   http://localhost:3000 (or your hosted production URL)
   ```
2. Click the **"Install Desktop App"** button in the Studio top titlebar (or the install icon `⊕` in the browser URL bar).
3. Click **Install**.
4. The studio opens immediately in its own native desktop window. An icon is automatically placed on your **Windows Desktop & Start Menu** or **macOS Launchpad & Dock**.

#### How Auto-Updates Work When You Push Changes:
1. Whenever you push code changes to git and your hosting/server restarts:
2. The registered **Service Worker (`/public/sw.js`)** detects the new asset hashes in the background.
3. The desktop window displays a gold **"Update Ready — Restart"** notification in the titlebar.
4. Clicking it (or relaunching the app) instantly swaps in the new version. **No manual downloads or re-installers needed!**

---

### 📦 Method 2: Native Electron Binary (.exe / .dmg) with GitHub Releases CI/CD

If you require a native operating system installer (`.exe` on Windows, `.dmg` on macOS) with delta binary auto-updates:

#### Repository Configuration Included:
- **`electron/main.cjs`**: Electron main process with hardware-accelerated WebGL/Canvas flags and `electron-updater` configured.
- **`electron/preload.cjs`**: Secure IPC bridge for update notifications and progress events.
- **`.github/workflows/desktop-release.yml`**: GitHub Actions CI/CD workflow that builds Windows and macOS installers and uploads them to GitHub Releases.

#### How Auto-Updates Work on Push with GitHub Releases:
1. When you finish making code changes, tag a new release version:
   ```bash
   git add .
   git commit -m "Enhance face transformation algorithm"
   git tag v2.5.0
   git push origin main --tags
   ```
2. The GitHub Actions workflow in `.github/workflows/desktop-release.yml` automatically triggers on the `v*` tag:
   - Runs pure-logic unit tests (`npx tsx --test src/utils/faceMath.test.ts`).
   - Builds the production bundle (`npm run build`).
   - Generates Windows (`.exe` NSIS) and macOS (`.dmg`) signed installers.
   - Publishes the binaries to your GitHub repository's **Releases** tab.
3. When users open their installed PersonaLive Desktop app, `electron-updater` contacts GitHub's Releases API:
   - Checks if a newer tag is available.
   - Silently downloads delta update patches in the background.
   - Prompts the user to restart, or installs automatically when closed.

---

## 🎥 Connecting to Zoom, OBS, Discord & Teams

1. Keep PersonaLive running with **VirtualCam Sink** enabled (active by default in the toolbar).
2. In **Zoom, Microsoft Teams, Discord, or Google Meet**:
   - Navigate to **Settings > Video > Camera**.
   - Select **"PersonaLive Virtual Camera"** or **"OBS Virtual Camera"**.
3. Your real-time transformed face with synchronized lip-sync and eye movement will automatically broadcast to your call.

