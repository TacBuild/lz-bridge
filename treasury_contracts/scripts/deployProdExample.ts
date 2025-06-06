import { compile, NetworkProvider, sleep } from '@ton/blueprint';

import { Address, beginCell, Cell, toNano } from '@ton/core';

import { 
    TacUsdtTreasury, 
    TacUsdtTreasuryConfig, 
} from '../wrappers/TacUsdtTreasury';

import { 
    EthUsdtTreasury, 
    EthUsdtTreasuryConfig, 
} from '../wrappers/EthUsdtTreasury';

import { Librarian } from '../external/stablecoin-contract/wrappers/Librarian';

import { JettonMinter, JettonMinterConfig, JettonMinterContent, jettonContentToCell } from '../external/stablecoin-contract/wrappers/JettonMinter';

export async function run(provider: NetworkProvider) {
    const librarianCode = await compile('UsdtLibrarian');

    console.log('deploying lib for jetton wallet');
    const jettonCodeRaw = await compile('UsdtJettonWallet');
    const jettonLibrarian = provider.open(Librarian.createFromConfig({ code: jettonCodeRaw }, librarianCode));
    if (await provider.isContractDeployed(jettonLibrarian.address)) {
        console.log('lib for jetton wallet already deployed');
    } else {
        console.log("not deployed");
        return;
    }

    const libJettonPrep = beginCell().storeUint(2, 8).storeBuffer(jettonCodeRaw.hash()).endCell();
    const usdtJettonWalletCode = new Cell({ exotic: true, bits: libJettonPrep.bits, refs: libJettonPrep.refs });

    const code = {
        usdtJettonMinter: await compile('UsdtJettonMinter'),
        tacUsdtTreasury: await compile('TacUsdtTreasury'),
        ethUsdtTreasury: await compile('EthUsdtTreasury'),
        usdtJettonWallet: usdtJettonWalletCode,
    };

    console.log('deploying ETH usdt treasury');
    const ethUsdtTreasuryConfig: EthUsdtTreasuryConfig = {
        jettonMaster: Address.parse("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"),
        jettonWalletCode: usdtJettonWalletCode,
        oAppAddress: Address.parse("EQAXByU5SqVhNvvSfQzjHYqY4PiucqTSN5td3oPiEaLV-p0-"), 
        dstEvmAddress: BigInt("0x84Cb8Be69037069E35147C9C18350Ed8895877FD"),
        ethEid: 30101,
        maxBridgeAmount: 10_000_000_000_000n,
        nativeFee: 100,
        estimatedGasCost: 100,
        jettonTransferGasCost: 1,
        treasuryFee: 0.5,
    }

    const ethUsdtTreasury = provider.open(EthUsdtTreasury.createFromConfig(ethUsdtTreasuryConfig, code.ethUsdtTreasury));
    await ethUsdtTreasury.sendDeploy(provider.sender(), toNano('0.1'));
    await provider.waitForDeploy(ethUsdtTreasury.address);
    await sleep(5 * 1000);
}
