import {
    Address,
    Cell,
    beginCell,
    contractAddress,
    Contract,
    ContractProvider,
    Sender,
    toNano,
    SendMode,
    fromNano,
} from '@ton/core';

export type EthUsdtTreasuryConfig = {
    jettonMaster: Address;
    jettonWalletCode: Cell;
    oAppAddress: Address;
    dstEvmAddress: bigint;
    ethEid: number;
    maxBridgeAmount: bigint;
    nativeFee: number;
    estimatedGasCost: number;
    jettonTransferGasCost: number;
    treasuryFee: number;
};

export const EthUsdtTreasuryOpCodes = {
    bridge_usdt_to_eth: 0x6e6c1865,
};

export const EthUsdtTreasuryErrors = {
    noErrors: 0,
    notEnoughMsgValue: 100,
    notEnoughMsgValueAddFee: 101,
    bridgeAmountTooBig: 102,
};

export function buildEthUsdtTreasuryData(config: EthUsdtTreasuryConfig): Cell {
    return beginCell()
        .storeAddress(config.jettonMaster)
        .storeRef(config.jettonWalletCode)
        .storeAddress(config.oAppAddress)
        .storeUint(config.ethEid, 32)
        .storeUint(config.dstEvmAddress, 256)
        .storeRef(beginCell()
                .storeCoins(config.maxBridgeAmount)
                .storeCoins(toNano(config.nativeFee.toFixed(9)))
                .storeCoins(toNano(config.estimatedGasCost.toFixed(9)))
                .storeCoins(toNano(config.jettonTransferGasCost.toFixed(9)))
                .storeCoins(toNano(config.treasuryFee.toFixed(9)))
                .endCell())
        .endCell();
}

export class EthUsdtTreasury implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static open(address: Address): EthUsdtTreasury {
        return new EthUsdtTreasury(address);
    }

    static createFromConfig(config: EthUsdtTreasuryConfig, code: Cell, workchain = 0): EthUsdtTreasury {
        const data = buildEthUsdtTreasuryData(config);
        const init = { code, data };
        const address = contractAddress(workchain, init);
        return new EthUsdtTreasury(address, init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendBridgeUsdt(
        provider: ContractProvider,
        sender: Sender,
        value: bigint,
        params: {
            queryId?: number;
            usdtAmount: bigint;
            addFee?: {
                addNativeFee: number,
                addJettonTransferGasCost: number,
                addEstimatedGasCost: number,
            }
        }
    ) {
        const addFeeCell = params.addFee
        ? beginCell()
            .storeCoins(toNano(params.addFee.addNativeFee.toFixed(9)))
            .storeCoins(toNano(params.addFee.addEstimatedGasCost.toFixed(9)))
            .storeCoins(toNano(params.addFee.addJettonTransferGasCost.toFixed(9)))
            .endCell()
        : null;

        await provider.internal(sender, {
            value: value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(EthUsdtTreasuryOpCodes.bridge_usdt_to_eth, 32)
                .storeUint(params.queryId ?? 0, 64)
                .storeCoins(params.usdtAmount)
                .storeMaybeRef(addFeeCell)
                .endCell(),
        });
    }

    async getFullData(provider: ContractProvider) {
        const result = await provider.get('get_full_data', []);
        return {
            jettonMaster: result.stack.readAddress(),
            jettonWalletCode: result.stack.readCell(),
            oAppAddress: result.stack.readAddress(),
            dstEvmAddress: result.stack.readBigNumber(),
            ethEid: result.stack.readNumber(),
            maxBridgeAmount: result.stack.readBigNumber(),
            nativeFee: Number(fromNano(result.stack.readNumber())),
            estimatedGasCost: Number(fromNano(result.stack.readNumber())),
            treasuryFee: Number(fromNano(result.stack.readNumber()))
        };
    }
}
