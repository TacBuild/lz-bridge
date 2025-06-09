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

function buildEvmDataCell(evmTargetAdress: string, gasLimit: number, evmValidExecutors: string[], tvmValidExecutors: string[]): Cell {    
    const json = JSON.stringify({
        evmCall: {
            target: evmTargetAdress,
            methodName: "",
            arguments: "",
            gasLimit: gasLimit,
        },
        shardsKey: "1",
        shardCount: 1,
        evmValidExecutors: evmValidExecutors,
        tvmValidExecutors: tvmValidExecutors,
    });

    return beginCell().storeStringTail(json).endCell();
}

export async function run(provider: NetworkProvider) {
    const adminAddress = 'EQDoF2OkxsI3gc5jAuxlqozN9H_SgEOUCopMa1yU4djLaXuL';
    const cclJettonProxy = 'EQBwSHP1u0aMoPrGW0g4L_vS3yZuPoFGRKWzHZxCdHl6t8ac';

    const evmTargetAdress = "0x440E079445AA9586bf99971d5f57BF09E2B9A403";
    const gasLimit = 1000000;
    const evmValidExecutors = [
        '0x440E079445AA9586bf99971d5f57BF09E2B9A403'
    ]
    const tvmValidExecutors = [
        'EQBshzK3qgIwHozYzVAvEaOKF3YXdY1veim4XLSoNDz1oZba'
    ]
    const evmData = buildEvmDataCell(evmTargetAdress, gasLimit, evmValidExecutors, tvmValidExecutors);

    const protocolFee = 0.5;
    const tacExecutorsFee = 0.5;
    const tonExecutorsFee = 0.5;
    const jettonTransferTonAmount = 1;
    const treasuryFee = 0.5;

    const librarianCode = await compile('UsdtLibrarian');

    console.log('deploying lib for jetton wallet');
    const jettonCodeRaw = await compile('UsdtJettonWallet');
    const jettonLibrarian = provider.open(Librarian.createFromConfig({ code: jettonCodeRaw }, librarianCode));
    if (await provider.isContractDeployed(jettonLibrarian.address)) {
        console.log('lib for jetton wallet already deployed');
    } else {
        await jettonLibrarian.sendDeploy(provider.sender(), toNano('20'));
        await provider.waitForDeploy(jettonLibrarian.address);
        await sleep(5 * 1000);
    }
    const libJettonPrep = beginCell().storeUint(2, 8).storeBuffer(jettonCodeRaw.hash()).endCell();
    const usdtJettonWalletCode = new Cell({ exotic: true, bits: libJettonPrep.bits, refs: libJettonPrep.refs });

    const code = {
        usdtJettonMinter: await compile('UsdtJettonMinter'),
        tacUsdtTreasury: await compile('TacUsdtTreasury'),
        ethUsdtTreasury: await compile('EthUsdtTreasury'),
        usdtJettonWallet: usdtJettonWalletCode,
    };

    console.log('deploying usdt minter');
    const usdtDefaultContent: JettonMinterContent = {
        uri: 'https://tether.to/usdt-ton.json'
    };

    const usdtJettonMinterConfig: JettonMinterConfig = {
        admin: Address.parse(adminAddress),
        wallet_code: usdtJettonWalletCode,
        jetton_content: jettonContentToCell(usdtDefaultContent)
    };

    const usdtJettonMinter = provider.open(JettonMinter.createFromConfig(usdtJettonMinterConfig, code.usdtJettonMinter))
    await usdtJettonMinter.sendDeploy(provider.sender(), toNano('1'));
    await provider.waitForDeploy(usdtJettonMinter.address);
    await sleep(5 * 1000);

    console.log('deploying ETH usdt treasury');
    const ethUsdtTreasuryConfig: EthUsdtTreasuryConfig = {
        jettonMaster: usdtJettonMinter.address,
        jettonWalletCode: usdtJettonWalletCode,
        oAppAddress: Address.parse(adminAddress), 
        dstEvmAddress: BigInt("0x440E079445AA9586bf99971d5f57BF09E2B9A403"),
        ethEid: 30101,
        maxBridgeAmount: 1_000_000_000n,
        nativeFee: 0.5,
        estimatedGasCost: 0.5,
        jettonTransferGasCost: 0.5,
        treasuryFee: 0.5,
    }

    const ethUsdtTreasury = provider.open(EthUsdtTreasury.createFromConfig(ethUsdtTreasuryConfig, code.ethUsdtTreasury));
    await ethUsdtTreasury.sendDeploy(provider.sender(), toNano('0.1'));
    await provider.waitForDeploy(ethUsdtTreasury.address);
    await sleep(5 * 1000);

    // send mint to treasury
    await usdtJettonMinter.sendMint(provider.sender(), ethUsdtTreasury.address, 1_000_000_000_000n, null, null, null, 0n, toNano('2'));
    await sleep(5 * 1000);
    const ethTtreasuryWallet = await usdtJettonMinter.getWalletAddress(ethUsdtTreasury.address);
    await sleep(5 * 1000);
    console.log('ETH usdt treasury wallet:', ethTtreasuryWallet.toString());

    console.log('deploying TAC usdt treasury');
    const tacUsdtTreasuryConfig: TacUsdtTreasuryConfig = {
        evmData: evmData,
        cclJettonProxy: Address.parse(cclJettonProxy),
        jettonMaster: usdtJettonMinter.address,
        jettonWalletCode: usdtJettonWalletCode,
        protocolFee,
        tacExecutorsFee,
        tonExecutorsFee,
        jettonTransferTonAmount,
        treasuryFee,
    }
    const tacUsdtTreasury = provider.open(TacUsdtTreasury.createFromConfig(tacUsdtTreasuryConfig, code.tacUsdtTreasury));
    await tacUsdtTreasury.sendDeploy(provider.sender(), toNano('0.1'));
    await provider.waitForDeploy(tacUsdtTreasury.address);
    await sleep(5 * 1000);

    // send mint to treasury
    await usdtJettonMinter.sendMint(provider.sender(), tacUsdtTreasury.address, 1_000_000_000_000n, null, null, null, 0n, toNano('2'));
    await sleep(5 * 1000);
    const usdtTtreasuryWallet = await usdtJettonMinter.getWalletAddress(tacUsdtTreasury.address);
    console.log('TAC usdt treasury wallet:', usdtTtreasuryWallet.toString());

}
