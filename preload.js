const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
    "api", {
        // Core functions for Activation & Setup
        getHWID: () => ipcRenderer.invoke('get-hwid'),
        activateLicense: (key) => ipcRenderer.invoke('activate-license', key),
        activationComplete: () => ipcRenderer.send('activation-complete'),
        exitApp: () => ipcRenderer.send('exit-app'),
        
        // Database Setup
        testDbConnection: (config) => ipcRenderer.invoke('test-db-connection', config),
        runSetupWizard: (data) => ipcRenderer.invoke('run-setup-wizard', data),
        
        // Printing
        getPrinters: () => ipcRenderer.invoke('get-printers'),
        printSilent: (data) => ipcRenderer.invoke('print-silent', data),
        
        openNewWindow: (url) => ipcRenderer.send('open-new-window', url),
        
        // Generic channels
        send: (channel, data) => {
            let validChannels = ["toMain", "activation-complete", "open-external", "exit-app", "open-new-window"];
            if (validChannels.includes(channel)) {
                ipcRenderer.send(channel, data);
            }
        },
        receive: (channel, func) => {
            let validChannels = ["fromMain"];
            if (validChannels.includes(channel)) {
                ipcRenderer.on(channel, (event, ...args) => func(...args));
            }
        }
    }
);
