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
if (app.isPackaged && !fs.existsSync(dotenvPath)) {
    // Template is in extraResources
    const templatePath = path.join(process.resourcesPath, 'backend/.env.example');
    try {
        if (fs.existsSync(templatePath)) {
            fs.copyFileSync(templatePath, dotenvPath);
        } else {
            // Create a minimal .env if template is missing
            fs.writeFileSync(dotenvPath, 'PORT=5000\nNODE_ENV=production\nAPI_VERSION=v1\nAPP_PLATFORM=DESKTOP\n');
        }
    } catch (err) {
        console.error('Failed to initialize .env:', err);
    }
}
require('dotenv').config({ path: dotenvPath });

const licensingService = require('./licensing-service');

let setupWindow;
let windows = new Set();
let backendProcess;

function createSetupWindow() {
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
            preload: path.join(__dirname, 'preload.js')
        }
    });

    setupWindow.loadFile('setup-wizard.html');
    setupWindow.once('ready-to-show', () => {
        setupWindow.show();
        setupWindow.focus();
    });
}

async function checkDbConfigured() {
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
    const baseUrl = isDev ? 'http://localhost:3000' : 'http://localhost:5000';
    
    const win = new BrowserWindow({
        width: width,
        height: height,
        title: "Inzeedo POS - Desktop Edition",
        show: false,
        webPreferences: {
            partition: 'persist:inzeedo',
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets/icon.png')
    });

    win.setMenuBarVisibility(false);

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

        if (params.editFlags.canCopy) menu.append(new MenuItem({ role: 'copy' }));
        if (params.editFlags.canPaste) menu.append(new MenuItem({ role: 'paste' }));
        if (params.editFlags.canCut) menu.append(new MenuItem({ role: 'cut' }));
        if (params.editFlags.canSelectAll) menu.append(new MenuItem({ role: 'selectAll' }));

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
    const hwid = licensingService.getHWID();
    console.log('📡 IPC Request: get-hwid ->', hwid);
    return hwid;
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
                silent: true,   // ← capture stdio so we can read the real error
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
