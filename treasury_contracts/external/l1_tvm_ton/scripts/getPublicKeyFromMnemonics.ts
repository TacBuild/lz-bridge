import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';

async function getPublicKey() {
    const mnemonic = await mnemonicNew();
    console.log(mnemonic.join(' '));
    const keys = await mnemonicToPrivateKey(mnemonic);
    return keys.publicKey.toString('hex');
}

getPublicKey().then((publicKey) => {
    console.log(publicKey);
});
