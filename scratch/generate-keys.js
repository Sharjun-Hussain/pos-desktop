const forge = require('node-forge');
const fs = require('fs');
const path = require('path');

console.log('Generating RSA 2048-bit key pair...');

forge.pki.rsa.generateKeyPair({bits: 2048, workers: 2}, function(err, keypair) {
    if (err) {
        console.error(err);
        return;
    }

    const publicKeyPem = forge.pki.publicKeyToPem(keypair.publicKey);
    const privateKeyPem = forge.pki.privateKeyToPem(keypair.privateKey);

    const keysDir = path.join(__dirname, 'keys');
    if (!fs.existsSync(keysDir)) {
        fs.mkdirSync(keysDir);
    }

    fs.writeFileSync(path.join(keysDir, 'public_key.pem'), publicKeyPem);
    fs.writeFileSync(path.join(keysDir, 'private_key.pem'), privateKeyPem);

    console.log('Keys generated successfully in the "keys" directory.');
    console.log('\n--- PUBLIC KEY (Put this in Electron App) ---');
    console.log(publicKeyPem);
    console.log('\n--- PRIVATE KEY (Keep this on License Server) ---');
    console.log(privateKeyPem);
});
