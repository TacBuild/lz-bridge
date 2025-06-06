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

export type TacUsdtTreasuryConfig = {
    evmData: Cell;
    cclJettonProxy: Address;
    jettonMaster: Address;
    jettonWalletCode: Cell;
    protocolFee: number;
    tacExecutorsFee: number;
    tonExecutorsFee: number;
    jettonTransferTonAmount: number;
    treasuryFee: number;
};

export const TacUsdtTreasuryOpCodes = {
    bridge_usdt_to_tac: 0x1d350b50,
};

export const TacUsdtTreasuryErrors = {
    noErrors: 0,
    notEnoughMsgValue: 100,
};

export function buildUsdtTreasuryData(config: TacUsdtTreasuryConfig): Cell {
    return beginCell()
        .storeRef(config.evmData)
        .storeAddress(config.cclJettonProxy)
        .storeAddress(config.jettonMaster)
        .storeRef(config.jettonWalletCode)
        .storeRef(beginCell()
                .storeCoins(toNano(config.protocolFee.toFixed(9)))
                .storeCoins(toNano(config.tacExecutorsFee.toFixed(9)))
                .storeCoins(toNano(config.tonExecutorsFee.toFixed(9)))
                .storeCoins(toNano(config.jettonTransferTonAmount.toFixed(9)))
                .storeCoins(toNano(config.treasuryFee.toFixed(9)))
                .endCell())
        .endCell();
}

export class TacUsdtTreasury implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromConfig(config: TacUsdtTreasuryConfig, code: Cell, workchain = 0): TacUsdtTreasury {
        const data = buildUsdtTreasuryData(config);
        const init = { code, data };
        const address = contractAddress(workchain, init);
        return new TacUsdtTreasury(address, init);
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
            usdtAmount: number;
            addFee?: {
                addProtocolFee: number,
                addJettonTransferTonAmount: number,
            }
        }
    ) {
        const addFeeCell = params.addFee
        ? beginCell()
            .storeCoins(toNano(params.addFee.addProtocolFee.toFixed(9)))
            .storeCoins(toNano(params.addFee.addJettonTransferTonAmount.toFixed(9)))
            .endCell()
        : null;

        await provider.internal(sender, {
            value: value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(TacUsdtTreasuryOpCodes.bridge_usdt_to_tac, 32)
                .storeUint(params.queryId ?? 0, 64)
                .storeCoins(toNano(params.usdtAmount.toFixed(9)))
                .storeMaybeRef(addFeeCell)
                .endCell(),
        });
    }

    async getFullData(provider: ContractProvider) {
        const result = await provider.get('get_full_data', []);
        return {
            evmData: result.stack.readCell(),
            cclJettonProxy: result.stack.readAddress(),
            jettonMaster: result.stack.readAddress(),
            jettonWalletCode: result.stack.readCell(),
            protocolFee: Number(fromNano(result.stack.readNumber())),
            tacExecutorsFee: Number(fromNano(result.stack.readNumber())),
            tonExecutorsFee: Number(fromNano(result.stack.readNumber())),
            jettonTransferTonAmount: Number(fromNano(result.stack.readNumber())),
            treasuryFee:  Number(fromNano(result.stack.readNumber())),
        };
    }
}
