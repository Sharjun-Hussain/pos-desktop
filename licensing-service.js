const { machineIdSync } = require('node-machine-id');
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// --- CONFIGURATION ---
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApQq6N20h8BYtYWT7l0DV
cHRFYdeCNT9e4YCh6CzjJSeTHjb7NVioCz583i/cHCxZ0Ws4YhRjm/5WjSzrimgV
dpty5CbpUHiY30k9v8ZnUs7KRuRNNa6quslAh0P/ezoTJsXSXY0JeUgpKshQ/Y4J
2wlzX0zWHWAmGmoESGGb1gdXc8F6yADJiI7IEHGGZzfDOWi4RUa03McUGOrC4n3y
k6OG11qCBvfT1/B7HoL3cb41Ywp3/cQo/L4U2mpmACsnDhrSKhgm8YsLG3gD95zg
jp9bG3F5f29zv5WYwfqVd+EZH7a2P0/4FgrvEAyoNYdC4q+oG/8itTN0BOGQbFIx
UQIDAQAB
-----END PUBLIC KEY-----`;

class LicensingService {
    constructor() {
        this.userDataPath = app.getPath('userData');
        this.licensePath = path.join(this.userDataPath, 'license.dat');

        // Use the hardcoded public key to verify against the production license server
        this.publicKeyPem = PUBLIC_KEY_PEM.trim();
    }

    /**
     * Returns the unique Hardware ID of the machine.
     * We use { original: true } to get the raw /etc/machine-id value, NOT a hashed
     * derivative. The hashed version can differ between Electron sandbox contexts
     * (dev vs .deb vs AppImage), causing false "another device" errors on the same machine.
     */
    getHWID() {
        try {
            const id = machineIdSync({ original: true });
            console.log('📋 Generated HWID (raw):', id);
            return id;
        } catch (error) {
            console.error('❌ Failed to get HWID:', error);
            return 'UNKNOWN-DEVICE';
        }
    }

    /**
     * Verifies the local license file.
     * Returns { valid: boolean, data: object|null, reason: string|null }
     */
    verifyLicense() {
        if (!fs.existsSync(this.licensePath)) {
            return { valid: false, reason: 'LICENSE_MISSING' };
        }

        try {
            const licenseContent = fs.readFileSync(this.licensePath, 'utf8');
            const { payload, signature } = JSON.parse(licenseContent);

            // Verify Signature
            const publicKey = forge.pki.publicKeyFromPem(this.publicKeyPem.trim());
            const md = forge.md.sha256.create();
            md.update(payload, 'utf8');

            const signatureBytes = forge.util.decode64(signature);
            const verified = publicKey.verify(md.digest().bytes(), signatureBytes);

            if (!verified) {
                return { valid: false, reason: 'INVALID_SIGNATURE' };
            }

            const data = JSON.parse(payload);
            const currentHWID = this.getHWID();

            // Check HWID Match
            if (data.hwid !== currentHWID) {
                return { valid: false, reason: 'HARDWARE_MISMATCH' };
            }

            // Check Expiry
            if (data.expiry && new Date(data.expiry) < new Date()) {
                return { valid: false, reason: 'LICENSE_EXPIRED' };
            }

            return { valid: true, data };
        } catch (error) {
            console.error('License verification error:', error);
            return { valid: false, reason: 'VERIFICATION_ERROR' };
        }
    }

    /**
     * Checks if the license needs an online sync (every 30 days).
     * Returns { needsSync: boolean, daysSinceSync: number }
     *
     * 🧪 TEST MODE: Set TEST_FORCE_SYNC = true to always trigger the sync check.
     *    Remember to set it back to false before building for release!
     */
    getSyncStatus() {
        const TEST_FORCE_SYNC = process.env.TEST_LICENSE_ALERT === 'GRACE_PERIOD';

        const check = this.verifyLicense();
        if (!check.valid && !TEST_FORCE_SYNC) return { needsSync: true, daysSinceSync: 999 };

        if (TEST_FORCE_SYNC) {
            console.log('🧪 Simulating Day 30 Offline Grace Period Alert...');
            return { needsSync: true, isExpired: false, daysSinceSync: 30 };
        }

        const issuedAt = new Date(check.data.issuedAt);
        const now = new Date();
        const diffTime = Math.abs(now - issuedAt);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        return {
            needsSync: diffDays >= 30,
            isExpired: diffDays >= 32, // 2-day grace period before hard block
            daysSinceSync: diffDays
        };
    }

    /**
     * Saves a new license certificate.
     */
    saveLicense(signedPayload) {
        try {
            fs.writeFileSync(this.licensePath, JSON.stringify(signedPayload, null, 2));
            return true;
        } catch (error) {
            console.error('Failed to save license:', error);
            return false;
        }
    }
    /**
     * Periodically syncs with the server to check for subscription renewals.
     * Returns true if the server responded and the certificate was refreshed.
     */
    async syncWithServer() {
        if (!fs.existsSync(this.licensePath)) return false;

        try {
            const licenseContent = fs.readFileSync(this.licensePath, 'utf8');
            const { payload } = JSON.parse(licenseContent);
            const data = JSON.parse(payload);

            const { net, session } = require('electron');

            return new Promise((resolve) => {
                const directSession = session.fromPartition('persist:direct', { cache: false });
                directSession.setProxy({ proxyRules: 'direct://' });

                const request = net.request({
                    method: 'POST',
                    url: 'https://license.inzeedo.lk/sync',
                    session: directSession
                });

                request.setHeader('Content-Type', 'application/json');
                request.setHeader('User-Agent', 'Inzeedo-POS-Desktop/1.0');
                request.setHeader('X-Inzeedo-Token', 'INZEEDO_SECURE_2026_PROD');

                request.on('response', (response) => {
                    let responseData = '';
                    response.on('data', (chunk) => { responseData += chunk; });
                    response.on('end', () => {
                        try {
                            const result = JSON.parse(responseData);
                            if (result.success) {
                                this.saveLicense(result.certificate);
                                console.log('🔄 License synced successfully via Native Net.');
                                resolve(true);  // ← success
                            } else {
                                console.warn('⚠️ License sync: server rejected the request -', result.message);
                                resolve(false); // ← server said no
                            }
                        } catch (e) {
                            console.error('⚠️ License sync: bad JSON from server');
                            resolve(false);
                        }
                    });
                });

                request.on('error', (err) => {
                    console.error('⚠️ License sync failed (Network Error):', err.message);
                    resolve(false); // ← network error
                });

                request.write(JSON.stringify({
                    licenseKey: data.licenseKey,
                    hwid: data.hwid
                }));
                request.end();
            });
        } catch (error) {
            console.error('⚠️ License sync failed (Local Error):', error.message);
            return false;
        }
    }
}

module.exports = new LicensingService();
