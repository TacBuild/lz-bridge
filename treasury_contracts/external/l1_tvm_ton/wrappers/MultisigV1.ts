import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    Sender,
    SendMode,
} from '@ton/core';
import { MultisigOrder } from '@ton/ton';
import { sign } from '@ton/crypto';

export type NK = {
    n: number;
    k: number;
};

export const MultisigV1Errors = {
    noErrors: 0,
    senderPublicKeyNotFound: 31,
    invalidSenderSignature: 32,
    walletIdDoesNotMatch: 33,
    queryHasAlreadyBeenCompleted: 34,
    invalidQueryId: 35,
    notAllOwnersConfirmed: 36,
    publicKeyNotFound: 37,
    invalidSignature: 38,
    alreadySigned: 39,
};

export type MultisigV1Config = {
    publicKeys: Buffer[];
    walletId: number;
    k: number;
};

export type PendingQueries = {
    n: number;
    pendingQueries: Cell;
};

export function multisigV1ConfigToCell(config: MultisigV1Config): Cell {
    let owners = Dictionary.empty();

    for (let i = 0; i < config.publicKeys.length; i += 1) {
        owners.set(i, Buffer.concat([config.publicKeys[i], Buffer.alloc(1)]));
    }

    return beginCell()
        .storeUint(config.walletId, 32)
        .storeUint(owners.size, 8)
        .storeUint(config.k, 8)
        .storeDict(owners, Dictionary.Keys.Uint(8), Dictionary.Values.Buffer(33))
        .storeBit(0)
        .endCell();
}

export class MultisigV1 implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new MultisigV1(address);
    }

    static createFromConfig(config: MultisigV1Config, code: Cell, workchain = 0) {
        const data = multisigV1ConfigToCell(config);
        const init = { code, data };
        return new MultisigV1(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendOrder(provider: ContractProvider, order: MultisigOrder, secretKey: Buffer, ownerId: number) {
        let cell = order.toCell(ownerId);

        let signature = sign(cell.hash(), secretKey);
        cell = beginCell().storeBuffer(signature).storeSlice(cell.asSlice()).endCell();

        await provider.external(cell);
    }

    async getNK(provider: ContractProvider): Promise<NK> {
        const result = await provider.get('get_n_k', []);
        return {
            n: result.stack.readNumber(),
            k: result.stack.readNumber(),
        };
    }

    async getPublicKeys(provider: ContractProvider): Promise<Dictionary<number, Buffer>> {
        const result = await provider.get('get_public_keys', []);
        return result.stack.readCell().asSlice().loadDictDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Buffer(32));
    }

    async getPendingQueries(provider: ContractProvider): Promise<PendingQueries> {
        const result = await provider.get('get_pending_queries', []);
        return {
            n: result.stack.readNumber(),
            pendingQueries: result.stack.readCellOpt() ?? beginCell().endCell(),
        };
    }
}
