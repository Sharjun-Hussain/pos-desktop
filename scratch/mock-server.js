const express = require('express');
const bodyParser = require('body-parser');
const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const PORT = 5050;

// Load Private Key
const privateKeyPem = fs.readFileSync(path.join(__dirname, '../keys/private_key.pem'), 'utf8');
const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);

// Mock Database of valid keys
const VALID_KEYS = [
    'PRO-1234-5678',
    'ENT-9999-0000',
    'TEST-KEYS-001'
];

// Map to track used keys: Key -> HWID
const USED_KEYS = new Map();

app.post('/activate', (req, res) => {
    const { licenseKey, hwid } = req.body;

    console.log(`\n--- Activation Request ---`);
    console.log(`Key: ${licenseKey}`);
    console.log(`HWID: ${hwid}`);

    // 1. Check if key is valid
    if (!VALID_KEYS.includes(licenseKey)) {
        return res.status(400).json({ success: false, message: 'Invalid license key.' });
    }

    // 2. Check if key is already tied to another HWID
    if (USED_KEYS.has(licenseKey) && USED_KEYS.get(licenseKey) !== hwid) {
        return res.status(400).json({ success: false, message: 'License already in use on another device.' });
    }

    // 3. Link key to HWID
    USED_KEYS.set(licenseKey, hwid);

    // 4. Create Payload
    const payload = JSON.stringify({
        licenseKey,
        hwid,
        expiry: '2027-12-31T23:59:59Z', // 1 year+ expiry
        issuedAt: new Date().toISOString()
    });

    // 5. Sign Payload
    const md = forge.md.sha256.create();
    md.update(payload, 'utf8');
    const signature = forge.util.encode64(privateKey.sign(md));

    console.log('✅ Activation successful. Returning signed certificate.');

    res.json({
        success: true,
        certificate: {
            payload,
            signature
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Mock License Server running at http://localhost:${PORT}`);
    console.log(`Valid Keys for testing: ${VALID_KEYS.join(', ')}`);
});
