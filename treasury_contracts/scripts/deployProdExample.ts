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
    const evmTargetAdress = "0x699e04F98dE2Fc395a7dcBf36B48EC837A976490";
    const gasLimit = 1000000;
    const evmValidExecutors = [
        '0x455d18882b5227F153D2802fE401D6C00Aa5a5B8'
    ]
    const tvmValidExecutors = [
        'EQB9Yo7kY7hlsVB6aei8ZkSpiI2OPC_kkbh5KAoUrKW04ZxW'
    ]
    const evmData = buildEvmDataCell(evmTargetAdress, gasLimit, evmValidExecutors, tvmValidExecutors);

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

    console.log("usdt jetton wallet code:", usdtJettonWalletCode.toBoc().toString('hex'));

    console.log("usdt jetton wallet code:", usdtJettonWalletCode.toBoc().toString('base64'));

    // const code = {
    //     usdtJettonMinter: await compile('UsdtJettonMinter'),
    //     tacUsdtTreasury: await compile('TacUsdtTreasury'),
    //     ethUsdtTreasury: await compile('EthUsdtTreasury'),
    //     usdtJettonWallet: usdtJettonWalletCode,
    // };

    // console.log('deploying ETH usdt treasury');
    // const nativeFee = 25;
    // const estimatedGasCost = 0.5;
    // const jettonTransferGasCost = 0.1;
    // const treasuryFee = 0.1;

    // const ethUsdtTreasuryConfig: EthUsdtTreasuryConfig = {
    //     jettonMaster: Address.parse("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"),
    //     jettonWalletCode: usdtJettonWalletCode,
    //     oAppAddress: Address.parse("EQAd31gAUhdO0d0NZsNb_cGl_Maa9PSuNhVLE9z8bBSjX6Gq"), 
    //     dstEvmAddress: BigInt(evmTargetAdress),
    //     ethEid: 30101,
    //     maxBridgeAmount: 10_000_000_000_000n,
    //     minBridgeAmount: 1_000_000n,
    //     nativeFee,
    //     estimatedGasCost,
    //     jettonTransferGasCost,
    //     treasuryFee,
    // }

    // const ethUsdtTreasury = provider.open(EthUsdtTreasury.createFromConfig(ethUsdtTreasuryConfig, code.ethUsdtTreasury));
    // await ethUsdtTreasury.sendDeploy(provider.sender(), toNano(nativeFee + estimatedGasCost));
    // await provider.waitForDeploy(ethUsdtTreasury.address);
    // await sleep(5 * 1000);

    // console.log('deploying TAC usdt treasury');

    // const cclJettonProxy = 'EQAChAswsPNsU2k3A5ZDO_cfhWknCGS6WMG2Jz15USMwxMdw';
    // const protocolFee = 0.5;
    // const tacExecutorsFee = 3;
    // const tonExecutorsFee = 1;
    // const jettonTransferTonAmount = 0.5;

    // const tacUsdtTreasuryConfig: TacUsdtTreasuryConfig = {
    //     evmData: evmData,
    //     cclJettonProxy: Address.parse(cclJettonProxy),
    //     jettonMaster: Address.parse("EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"),
    //     jettonWalletCode: usdtJettonWalletCode,
    //     protocolFee,
    //     tacExecutorsFee,
    //     tonExecutorsFee,
    //     jettonTransferTonAmount,
    //     treasuryFee,
    // }
    // const tacUsdtTreasury = provider.open(TacUsdtTreasury.createFromConfig(tacUsdtTreasuryConfig, code.tacUsdtTreasury));
    // await tacUsdtTreasury.sendDeploy(provider.sender(), toNano('0.1'));
    // await provider.waitForDeploy(tacUsdtTreasury.address);
    // await sleep(5 * 1000);
}
