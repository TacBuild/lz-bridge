import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export type MultisigV1SimplifiedConfig = {};

export function multisigV1SimplifiedConfigToCell(config: MultisigV1SimplifiedConfig): Cell {
    return beginCell().endCell();
}

export class MultisigV1Simplified implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new MultisigV1Simplified(address);
    }

    static createFromConfig(config: MultisigV1SimplifiedConfig, code: Cell, workchain = 0) {
        const data = multisigV1SimplifiedConfigToCell(config);
        const init = { code, data };
        return new MultisigV1Simplified(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }
}
