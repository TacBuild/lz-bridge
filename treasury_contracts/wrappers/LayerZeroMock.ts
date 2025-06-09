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

export type LayerZeroMockConfig = {
    jettonMaster: Address;
    jettonWalletCode: Cell;
    minTonAmount: number;
    lzFee: number;
};

export function buildLayerZeroMockData(config: LayerZeroMockConfig): Cell {
    return beginCell()
        .storeAddress(config.jettonMaster)
        .storeRef(config.jettonWalletCode)
        .storeCoins(toNano(config.minTonAmount.toFixed(9)))
        .storeCoins(toNano(config.lzFee.toFixed(9)))
        .endCell();
}

export class LayerZeroMock implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromConfig(config: LayerZeroMockConfig, code: Cell, workchain = 0): LayerZeroMock {
        const data = buildLayerZeroMockData(config);
        const init = { code, data };
        const address = contractAddress(workchain, init);
        return new LayerZeroMock(address, init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }
}
