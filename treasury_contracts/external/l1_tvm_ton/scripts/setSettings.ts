import { address, Dictionary, toNano, beginCell, Cell } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { Settings } from '../wrappers/Settings';
import { sha256 } from '@ton/crypto';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sha256toBigInt(ContractName: string): Promise<bigint> {
    const hash = await sha256(ContractName);

    return BigInt('0x' + hash.toString('hex'));
}

export async function run(provider: NetworkProvider) {
    const settings = provider.open(
        Settings.createFromAddress(address('EQA4c4YONqc9nfoadZ5L5uRfnCM8KW5FRVKOYTXXFjxihnms')),
    );

    const jettonCodeRaw = await compile('JettonWallet');
    const libJettonPrep = beginCell().storeUint(2, 8).storeBuffer(jettonCodeRaw.hash()).endCell();
    const jettonWalletCode = new Cell({ exotic: true, bits: libJettonPrep.bits, refs: libJettonPrep.refs });

    await settings.sendSetValue(provider.sender(), toNano(0.05), {
        key: await sha256toBigInt('JETTON_WALLET_CODE'),
        value: jettonWalletCode,
    });

    // await sleep(5000);

    // await settings.sendSetValue(provider.sender(), toNano(0.05), {
    //     key: await sha256toBigInt('JETTON_MINTER_CODE'),
    //     value: await compile('JettonMinter')
    // });

    // await sleep(5000);

    // await settings.sendSetValue(provider.sender(), toNano(0.05), {
    //     key: await sha256toBigInt('MerkleTreeDuration'),
    //     value: beginCell().storeUint(604800, 64).endCell() // 1 week = 24 * 7 * 60 * 60
    // });

    // await sleep(5000);

    // await settings.sendSetValue(provider.sender(), toNano(0.05), {
    //     key: await sha256toBigInt('EpochDuration'),
    //     value: beginCell().storeUint(30, 64).endCell() // 30 sec
    // });

    // await sleep(5000);

    // await settings.sendSetValue(provider.sender(), toNano(0.05), {
    //     key: await sha256toBigInt('JettonProxyAddress'),
    //     value: beginCell().storeAddress(address("EQB0i5KNvB3TPaa2xHYaL6PTl8geI4w8BjZhz9cOibF73R33")).endCell()
    // });

    // await sleep(5000);

    // await settings.sendSetValue(provider.sender(), toNano(0.05), {
    //     key: await sha256toBigInt('CrossChainLayerAddress'),
    //     value: beginCell().storeAddress(address("EQAdiCkHjVgEDH27PRhfMv4lxo30pHwgxyElHTtSj72fme0s")).endCell()
    // });
}
