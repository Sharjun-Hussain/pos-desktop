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

let mainWindow;
let activationWindow;
let backendProcess;
let dbSetupWindow;

function createDbSetupWindow() {
    dbSetupWindow = new BrowserWindow({
        width: 500,
        height: 700,
        resizable: false,
        frame: false,
        transparent: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    dbSetupWindow.loadFile('db-setup.html');
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

function createActivationWindow() {
    activationWindow = new BrowserWindow({
        width: 500,
        height: 650,
        resizable: false,
        frame: false,
        transparent: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
    });

    activationWindow.loadFile('activation.html');
}

function getAppPath(relativeProd, relativeDev) {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, relativeProd);
    }
    return path.join(__dirname, '..', relativeDev || relativeProd);
}

function createWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: width,
        height: height,
        title: "Inzeedo POS - Desktop Edition",
        show: false, // Start hidden and show once ready
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        icon: path.join(__dirname, 'assets/icon.png')
    });

    mainWindow.setMenuBarVisibility(false);

    // For testing/dev, use Port 3000 (Next.js). For production, use Port 5000 (Backend).
    const isDev = !app.isPackaged || process.env.ELECTRON_IS_DEV === 'true';
    const frontendUrl = isDev ? 'http://localhost:3000' : 'http://localhost:5000';
    
    console.log(`🌐 Loading Frontend from: ${frontendUrl} (Mode: ${isDev ? 'Dev' : 'Prod'})`);
    
    const loadWithRetry = () => {
        mainWindow.loadURL(frontendUrl).then(() => {
            mainWindow.maximize();
            mainWindow.show();
            mainWindow.focus();
        }).catch(() => {
            console.log('⏳ Backend not ready, retrying in 500ms...');
            setTimeout(loadWithRetry, 500);
        });
    };

    loadWithRetry();

    mainWindow.on('closed', function () {
        mainWindow = null;
    });
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

ipcMain.handle('run-setup-wizard', async (event, data) => {
    try {
        // 1. Update .env
        updateEnv({
            DB_HOST: data.db.host,
            DB_PORT: data.db.port,
            DB_NAME: data.db.name,
            DB_USER: data.db.user,
            DB_PASSWORD: data.db.pass
        });

        // 2. Run Bootstrap Script
        const bootstrapPath = getAppPath('backend/scripts/bootstrap-db.js');
        console.log('🌱 Running Bootstrap Setup:', bootstrapPath);
        
        const nodeModulesPath = app.isPackaged 
            ? path.join(process.resourcesPath, 'app.asar/node_modules')
            : path.join(__dirname, 'node_modules');

        return new Promise((resolve) => {
            // Removed '--clear' to prevent database reset as requested
            const child = fork(bootstrapPath, [], {
                cwd: getAppPath('backend'),
                env: { 
                    ...process.env, 
                    NODE_PATH: nodeModulesPath,
                    APP_PLATFORM: 'DESKTOP',
                    LOG_DIR: path.join(app.getPath('userData'), 'logs'),
                    UPLOAD_PATH: path.join(app.getPath('userData'), 'uploads')
                }
            });

            child.on('exit', (code) => {
                if (code === 0) {
                    resolve({ success: true });
                } else {
                    resolve({ success: false, message: `Setup failed with code ${code}` });
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
    
    // Store references to old windows before creating new ones
    const oldActivationWindow = activationWindow;
    const oldDbSetupWindow = dbSetupWindow;

    // Clear globals so they don't get accidentally closed if we just recreated them
    activationWindow = null;
    dbSetupWindow = null;
    
    if (!dbOk) {
        createDbSetupWindow();
    } else {
        startBackend();
        createWindow();
    }

    // Close the old windows only after the next window is initiated
    if (oldActivationWindow) {
        oldActivationWindow.close();
    }
    if (oldDbSetupWindow) {
        oldDbSetupWindow.close();
    }
});

ipcMain.on('open-external', (event, url) => {
    shell.openExternal(url);
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
            createDbSetupWindow();
        }
    } else {
        console.log('❌ License Check Failed:', check.reason);
        createActivationWindow();
    }

    app.on('activate', async function () {
        if (BrowserWindow.getAllWindows().length === 0) {
            const check = licensingService.verifyLicense();
            if (check.valid) {
                const dbOk = await checkDbConfigured();
                if (dbOk) createWindow();
                else createDbSetupWindow();
            } else {
                createActivationWindow();
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
