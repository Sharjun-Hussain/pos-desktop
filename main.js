const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');
const axios = require('axios');
const mysql = require('mysql2/promise');
const userDataPath = app.getPath('userData');
const dotenvPath = app.isPackaged 
    ? path.join(userDataPath, '.env')
    : path.join(__dirname, '../backend/.env');

// Ensure .env exists in userData for production
if (app.isPackaged) {
    const templatePath = path.join(process.resourcesPath, 'backend/.env.example');
    
    if (!fs.existsSync(dotenvPath)) {
        try {
            if (fs.existsSync(templatePath)) {
                fs.copyFileSync(templatePath, dotenvPath);
            } else {
                fs.writeFileSync(dotenvPath, 'PORT=5000\nNODE_ENV=production\nAPI_VERSION=v1\nAPP_PLATFORM=DESKTOP\n');
            }
        } catch (err) {
            console.error('Failed to initialize .env:', err);
        }
    } else {
        // Migration: If .env exists but is missing QZ_PRIVATE_KEY, append it from template
        try {
            const currentEnv = fs.readFileSync(dotenvPath, 'utf8');
            if (!currentEnv.includes('QZ_PRIVATE_KEY') && fs.existsSync(templatePath)) {
                const templateEnv = fs.readFileSync(templatePath, 'utf8');
                const qzMatch = templateEnv.match(/QZ_PRIVATE_KEY=["']?(.+?)["']?(?:\r?\n|$)/s) || templateEnv.match(/QZ_PRIVATE_KEY=.*$/sm);
                if (qzMatch) {
                    fs.appendFileSync(dotenvPath, `\n\n${qzMatch[0]}\n`);
                    console.log('Appended missing QZ_PRIVATE_KEY to existing .env');
                }
            }
        } catch (err) {
            console.error('Failed to migrate .env:', err);
        }
    }
}
require('dotenv').config({ path: dotenvPath, override: true });

const licensingService = require('./licensing-service');

let setupWindow;
let windows = new Set();
let backendProcess;

function createSetupWindow(mode = null) {
    setupWindow = new BrowserWindow({
        width: 900,
        height: 600,
        resizable: false,
        frame: false,
        transparent: true,
        center: true,
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            devTools: !app.isPackaged || process.env.ELECTRON_IS_DEV === 'true',
            preload: path.join(__dirname, 'preload.js')
        }
    });

    // Use loadFile (safe for both dev & packaged builds).
    // Pass an optional query param to activate a specific mode in the UI.
    const loadOptions = mode ? { query: { mode } } : {};
    setupWindow.loadFile('setup-wizard.html', loadOptions);
    setupWindow.once('ready-to-show', () => {
        setupWindow.show();
        setupWindow.focus();
    });
}

async function checkDbConfigured() {
    // Client mode: no local DB needed — just need a server URL
    if (process.env.APP_MODE === 'client') {
        return !!process.env.SERVER_URL;
    }
    if (!process.env.DB_NAME) return false;
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || '127.0.0.1',
            port: process.env.DB_PORT || 3306,
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME
        });
        await connection.end();
        return true;
    } catch (err) {
        return false;
    }
}

function updateEnv(updates) {
    try {
        let content = fs.readFileSync(dotenvPath, 'utf8');
        for (const [key, value] of Object.entries(updates)) {
            const regex = new RegExp(`^${key}=.*`, 'm');
            if (content.match(regex)) {
                content = content.replace(regex, `${key}=${value}`);
            } else {
                content += `\n${key}=${value}`;
            }
            // Manually update process.env because dotenv won't overwrite existing variables
            process.env[key] = value;
        }
        fs.writeFileSync(dotenvPath, content);
        // Reload just in case
        require('dotenv').config({ path: dotenvPath });
        return true;
    } catch (err) {
        console.error('Failed to update .env:', err);
        return false;
    }
}

function getAppPath(relativeProd, relativeDev) {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, relativeProd);
    }
    return path.join(__dirname, '..', relativeDev || relativeProd);
}

function createWindow(url = null) {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const isDev = !app.isPackaged || process.env.ELECTRON_IS_DEV === 'true';
    // Client mode: load from the remote server URL instead of localhost
    const baseUrl = process.env.APP_MODE === 'client' && process.env.SERVER_URL
        ? process.env.SERVER_URL
        : (isDev ? 'http://localhost:3000' : 'http://localhost:5000');
    
    const win = new BrowserWindow({
        width: width,
        height: height,
        title: "Inzeedo POS - Desktop Edition",
        show: false,
        webPreferences: {
            partition: 'persist:inzeedo',
            nodeIntegration: false,
            contextIsolation: true,
            devTools: isDev,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets/icon.png')
    });

    win.setMenuBarVisibility(false);
// ← TEMP DEBUG: remove after fixing white screen

    const loadWithRetry = () => {
        // If a specific URL is provided, we still load the BASE URL first to ensure
        // that all static assets (JS/CSS) load correctly from the root path.
        // We pass the target route as a query parameter.
        let finalUrl = baseUrl;
        if (url && url !== baseUrl) {
            try {
                const urlObj = new URL(url);
                const route = urlObj.pathname + urlObj.search + urlObj.hash;
                const baseObj = new URL(baseUrl);
                baseObj.searchParams.set('initRoute', route);
                finalUrl = baseObj.toString();
            } catch (e) {
                console.error("Failed to parse initRoute:", e);
                finalUrl = url; // Fallback to raw URL
            }
        }

        win.loadURL(finalUrl).catch(() => {
            console.log('⏳ Backend not ready, retrying in 500ms...');
            setTimeout(loadWithRetry, 500);
        });
    };

    win.once('ready-to-show', () => {
        if (!url) win.maximize();
        win.show();
        win.focus();
        if (isDev) {
            // ← TEMP DEBUG: open DevTools so we can see network errors on Client PCs (Dev only)
            win.webContents.openDevTools();
        }
    });

    loadWithRetry();

    // Context Menu Implementation
    win.webContents.on('context-menu', (event, params) => {
        const { Menu, MenuItem } = require('electron');
        const menu = new Menu();

        if (params.linkURL) {
            menu.append(new MenuItem({
                label: 'Open in New Window',
                click: () => {
                    const isDev = !app.isPackaged || process.env.ELECTRON_IS_DEV === 'true';
                    const baseUrl = isDev ? 'http://localhost:3000' : 'http://localhost:5000';
                    
                    if (params.linkURL.startsWith(baseUrl) || params.linkURL.startsWith('http://localhost') || params.linkURL.startsWith('http://127.0.0.1')) {
                        createWindow(params.linkURL);
                    } else {
                        shell.openExternal(params.linkURL);
                    }
                }
            }));
            menu.append(new MenuItem({ type: 'separator' }));
        }

        if (params.isEditable || params.selectionText.trim().length > 0) {
            if (params.editFlags.canCopy) menu.append(new MenuItem({ role: 'copy' }));
            if (params.editFlags.canPaste) menu.append(new MenuItem({ role: 'paste' }));
            if (params.editFlags.canCut) menu.append(new MenuItem({ role: 'cut' }));
            if (params.editFlags.canSelectAll) menu.append(new MenuItem({ role: 'selectAll' }));
        }

        if (menu.items.length > 0) {
            menu.popup({ window: win });
        }
    });

    win.on('closed', function () {
        windows.delete(win);
    });

    windows.add(win);
    return win;
}

function startBackend() {
    // Client mode: the backend runs on the remote server — don't start a local one
    if (process.env.APP_MODE === 'client') {
        console.log('ℹ️  Client mode: skipping local backend start.');
        return;
    }

    console.log("🚀 Starting Inzeedo POS Backend...");
    const backendPath = getAppPath('backend/server.js');

    const nodeModulesPath = app.isPackaged 
        ? path.join(process.resourcesPath, 'app.asar/node_modules')
        : path.join(__dirname, 'node_modules');

    backendProcess = fork(backendPath, [], {
        cwd: getAppPath('backend'),
        env: {
            ...process.env,
            NODE_PATH: nodeModulesPath,
            NODE_ENV: 'production',
            ELECTRON_RUNNING: 'true',
            APP_PLATFORM: 'DESKTOP',
            LOG_DIR: path.join(app.getPath('userData'), 'logs'),
            UPLOAD_PATH: path.join(app.getPath('userData'), 'uploads')
        },
        silent: false
    });

    backendProcess.on('exit', (code) => {
        console.log(`Backend process exited with code ${code}`);
    });
}

// --- IPC HANDLERS ---
ipcMain.handle('get-hwid', () => {
    return licensingService.getHWID();
});

ipcMain.handle('get-license-info', () => {
    const check = licensingService.verifyLicense();
    return check.valid ? check.data : null;
});

let pendingLicenseAlerts = [];
ipcMain.handle('get-license-alerts', () => {
    return pendingLicenseAlerts;
});
ipcMain.handle('clear-license-alerts', () => {
    pendingLicenseAlerts = [];
});

// --- ACTIVATION FLOW ---
ipcMain.on('get-server-url', (event) => {
    event.returnValue = process.env.APP_MODE === 'client' && process.env.SERVER_URL 
        ? process.env.SERVER_URL 
        : (process.env.ELECTRON_IS_DEV === 'true' || !app.isPackaged ? 'http://localhost:3000' : 'http://localhost:5000');
});

ipcMain.handle('activate-license', async (event, licenseKey) => {
    const hwid = licensingService.getHWID();
    const { net, session } = require('electron');

    return new Promise((resolve) => {
        console.log('📡 Sending Native Secure Request to: https://license.inzeedo.lk/activate');
        
        // Force direct connection for this request to bypass proxies
        const directSession = session.fromPartition('persist:direct', { cache: false });
        directSession.setProxy({ proxyRules: 'direct://' });

        const request = net.request({
            method: 'POST',
            url: 'https://license.inzeedo.lk/activate',
            session: directSession
        });

        request.setHeader('Content-Type', 'application/json');
        request.setHeader('User-Agent', 'Inzeedo-POS-Desktop/1.0');
        request.setHeader('X-Inzeedo-Token', 'INZEEDO_SECURE_2026_PROD');

        request.on('response', (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.success) {
                        licensingService.saveLicense(result.certificate);
                        resolve({ success: true });
                    } else {
                        resolve({ success: false, message: result.message });
                    }
                } catch (e) {
                    resolve({ success: false, message: 'Invalid server response.' });
                }
            });
        });

        request.on('error', (error) => {
            console.error('--- NATIVE NETWORK ERROR ---', error);
            resolve({ success: false, message: `Connection failed: ${error.message}` });
        });

        request.write(JSON.stringify({ licenseKey, hwid }));
        request.end();
    });
});

ipcMain.handle('sync-license', async () => {
    console.log('🔄 IPC Request: sync-license');
    // Use the boolean return value directly — avoids TEST_FORCE_SYNC interference
    const synced = await licensingService.syncWithServer();
    console.log('🔄 Sync result:', synced ? 'SUCCESS' : 'FAILED');
    return { success: synced };
});

ipcMain.handle('test-db-connection', async (event, config) => {
    try {
        const connection = await mysql.createConnection({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password
        });
        await connection.end();
        return { success: true };
    } catch (err) {
        return { success: false, message: err.message };
    }
});

ipcMain.handle('get-printers', async (event) => {
    return await event.sender.getPrintersAsync();
});

ipcMain.handle('print-silent', async (event, { html, printerName, options = {} }) => {
    const workerWindow = new BrowserWindow({
        show: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    workerWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    return new Promise((resolve) => {
        workerWindow.webContents.on('did-finish-load', () => {
            workerWindow.webContents.print({
                silent: true,
                deviceName: printerName || '',
                printBackground: true,
                margins: { marginType: 'none' },
                ...options
            }, (success, failureReason) => {
                workerWindow.close();
                if (success) resolve({ success: true });
                else resolve({ success: false, message: failureReason });
            });
        });
    });
});

ipcMain.handle('run-setup-wizard', async (event, data) => {
    try {
        // ── CLIENT MODE: just save the remote server URL ────────────────────
        if (data.mode === 'client') {
            updateEnv({ APP_MODE: 'client', SERVER_URL: data.serverUrl });
            console.log(`✅ Client mode configured. Server URL: ${data.serverUrl}`);
            return { success: true };
        }

        // ── SERVER MODE (default): full DB + bootstrap setup ─────────────────
        updateEnv({ APP_MODE: 'server' });

        // 1. Update .env with the new DB credentials
        updateEnv({
            DB_HOST: data.db.host,
            DB_PORT: data.db.port,
            DB_NAME: data.db.name,
            DB_USER: data.db.user,
            DB_PASSWORD: data.db.pass
        });

        // 2. Pre-check: Try to connect and create the database if it doesn't exist
        try {
            const preConn = await mysql.createConnection({
                host: data.db.host,
                port: data.db.port,
                user: data.db.user,
                password: data.db.pass
            });
            await preConn.query(`CREATE DATABASE IF NOT EXISTS \`${data.db.name}\``);
            await preConn.end();
            console.log(`✅ Database "${data.db.name}" verified/created on ${data.db.host}`);
        } catch (preErr) {
            console.error('❌ Pre-connection failed:', preErr.message);
            return { success: false, message: `Cannot connect to MySQL: ${preErr.message}` };
        }

        // 3. Run Bootstrap Script — capture stdout/stderr to surface real errors
        const bootstrapPath = getAppPath('backend/scripts/bootstrap-db.js');
        console.log('🌱 Running Bootstrap Setup:', bootstrapPath);

        const nodeModulesPath = app.isPackaged
            ? path.join(process.resourcesPath, 'app.asar/node_modules')
            : path.join(__dirname, 'node_modules');

        return new Promise((resolve) => {
            let errorOutput = '';

            const child = fork(bootstrapPath, [], {
                cwd: getAppPath('backend'),
                silent: true,
                env: {
                    ...process.env,
                    NODE_PATH: nodeModulesPath,
                    APP_PLATFORM: 'DESKTOP',
                    LOG_DIR: path.join(app.getPath('userData'), 'logs'),
                    UPLOAD_PATH: path.join(app.getPath('userData'), 'uploads')
                }
            });

            // Pipe child stdout to parent console so we still see logs
            child.stdout.on('data', (data) => {
                const msg = data.toString();
                process.stdout.write(msg);
            });

            // Capture stderr to show real errors in the UI
            child.stderr.on('data', (data) => {
                const msg = data.toString();
                process.stderr.write(msg);
                errorOutput += msg;
            });

            child.on('exit', (code) => {
                if (code === 0) {
                    resolve({ success: true });
                } else {
                    // Extract the most useful part of the error for display
                    const shortError = errorOutput
                        .split('\n')
                        .find(l => l.includes('Error') || l.includes('error') || l.includes('denied') || l.includes('ECONNREFUSED'))
                        || errorOutput.slice(0, 300)
                        || `Bootstrap failed (exit code ${code})`;

                    console.error('❌ Bootstrap error output:', errorOutput);
                    resolve({ success: false, message: shortError.trim() });
                }
            });
        });
    } catch (err) {
        return { success: false, message: err.message };
    }
});

ipcMain.handle('test-server-connection', async (event, url) => {
    try {
        // Normalize: strip trailing slash, append a lightweight health endpoint
        const base = url.replace(/\/+$/, '');
        const testUrl = `${base}/api/health`;
        console.log(`🔍 Testing server connection: ${testUrl}`);
        const response = await axios.get(testUrl, { timeout: 5000 });
        if (response.status >= 200 && response.status < 400) {
            return { success: true };
        }
        return { success: false, message: `Server returned status ${response.status}` };
    } catch (err) {
        // If /api/health doesn't exist the server still responded — treat 404 as reachable
        if (err.response) {
            return { success: true };
        }
        return { success: false, message: `Could not reach server: ${err.message}` };
    }
});

ipcMain.on('activation-complete', async () => {
    // Check DB first to avoid a moment with no windows open
    const dbOk = await checkDbConfigured();
    
    // Store references to old window
    const oldSetupWindow = setupWindow;

    // Clear global so it doesn't get accidentally closed if we just recreated it
    setupWindow = null;
    
    if (!dbOk) {
        createSetupWindow();
    } else {
        startBackend();
        createWindow();
    }

    // Close the old window only after the next window is initiated
    if (oldSetupWindow) {
        oldSetupWindow.close();
    }
});

ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
});

ipcMain.on('open-new-window', (event, url) => {
    createWindow(url);
});

ipcMain.on('exit-app', () => {
    app.quit();
});

// --- APP LIFECYCLE ---
app.whenReady().then(async () => {
    const check = licensingService.verifyLicense();

    if (check.valid) {
        console.log('✅ License Verified for HWID:', check.data.hwid);
        
        // 30-Day Mandatory Sync Check
        const syncStatus = licensingService.getSyncStatus();
        if (syncStatus.needsSync) {
            console.log(`⚠️ License sync required (${syncStatus.daysSinceSync} days since last check)`);
            
            // Try to sync silently first
            await licensingService.syncWithServer();
            const afterSyncStatus = licensingService.getSyncStatus();
            
            if (afterSyncStatus.isExpired) {
                console.log('❌ Silent sync failed and grace period over. Mandatory online check required.');
                createSetupWindow('sync');
                return;
            } else if (afterSyncStatus.needsSync) {
                const daysLeft = 32 - afterSyncStatus.daysSinceSync;
                console.log(`⚠️ Background sync failed. Offline grace period active (${daysLeft} days remaining).`);
                pendingLicenseAlerts.push({
                    type: 'warning',
                    title: 'Internet Connection Required Soon',
                    message: `Your system has been offline for ${afterSyncStatus.daysSinceSync} days. You must connect to the internet within ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} to verify your license, otherwise the system will be locked.`
                });
            } else {
                console.log('✅ Background sync successful.');
            }
        }

        // Native Expiry Alert (Warn 7 days before cloud subscription expiration)
        if (check.data && check.data.expiry) {
            const expiryDate = new Date(check.data.expiry);
            const daysToExpiry = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
            
            if (daysToExpiry > 0 && daysToExpiry <= 7) {
                pendingLicenseAlerts.push({
                    type: 'info',
                    title: 'Subscription Expiring Soon',
                    message: `Your software subscription will expire in ${daysToExpiry} ${daysToExpiry === 1 ? 'day' : 'days'}. Please ensure your payment is up to date on the cloud dashboard.`
                });
            }
        }

        const dbOk = await checkDbConfigured();
        if (dbOk) {
            startBackend();
            createWindow();
        } else {
            console.log('⚠️  Database not configured. Launching Setup Wizard...');
            createSetupWindow();
        }
    } else {
        console.log('❌ License Check Failed:', check.reason);
        
        // --- EMERGENCY SEAMLESS RENEWAL ---
        // If the local license simply hit its timestamp expiry, the customer might have renewed on the cloud.
        // Attempt a seamless background sync using the old key before kicking them out to the wizard.
        if (check.reason === 'LICENSE_EXPIRED') {
            console.log('⚠️ Local license expired. Attempting emergency cloud sync...');
            const synced = await licensingService.syncWithServer();
            if (synced) {
                const recheck = licensingService.verifyLicense();
                if (recheck.valid) {
                    console.log('✅ Emergency sync successful. License renewed!');
                    const dbOk = await checkDbConfigured();
                    if (dbOk) {
                        startBackend();
                        createWindow();
                    } else {
                        createSetupWindow();
                    }
                    return;
                }
            }
            console.log('❌ Emergency sync failed or license is still expired on the cloud.');
        }

        createSetupWindow();
    }

    app.on('activate', async function () {
        if (windows.size === 0) {
            const check = licensingService.verifyLicense();
            if (check.valid) {
                const dbOk = await checkDbConfigured();
                if (dbOk) createWindow();
                else createSetupWindow();
            } else {
                createSetupWindow();
            }
        }
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
        if (backendProcess) backendProcess.kill();
        app.quit();
    }
});

process.on('exit', () => {
    if (backendProcess) backendProcess.kill();
});
