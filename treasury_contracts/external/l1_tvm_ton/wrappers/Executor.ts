import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    fromNano,
    Sender,
    SendMode,
} from '@ton/core';
import { Params } from './Constants';

export type ExecutorConfig = {
    crossChainLayerAddress: string;
    lastExecutorAddress?: string;
    isSpent: boolean;
    payload: Cell;
};

export const ExecutorOpCodes = {
    crossChainLayer_evmMsgToTVM: 0x0e50d313,
    crossChainLayer_revertSpentParam: 0x959f183a,

    executor_errorNotification: 0xcf6a5da4,

    anyone_proxyMsg: 0x3b6616c6,
    anyone_errorNotification: 0xd3a4fb32,
};

export const ExecutorErrors = {
    noErrors: 0,

    notFromCrossChainLayer: 70,

    notEnoughTon: 100,

    alreadySpent: 200,
    proofIsNotExoticCell: 201,
    invalidProofCellType: 202,
    invalidProof: 203,
    unauthorizedExecutor: 204,
    insufficientExecutorFee: 205,
};

export function executorConfigToCell(config: ExecutorConfig): Cell {
    return beginCell()
        .storeAddress(Address.parse(config.crossChainLayerAddress))
        .storeAddress(config.lastExecutorAddress ? Address.parse(config.lastExecutorAddress) : null)
        .storeInt(config.isSpent ? -1n : 0n, 1)
        .storeRef(config.payload)
        .endCell();
}

export class Executor implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Executor(address);
    }

    static createFromConfig(config: ExecutorConfig, code: Cell, workchain = 0) {
        const data = executorConfigToCell(config);
        const init = { code, data };
        return new Executor(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendProxyMsg(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            merkleProof: Cell;
            feeToAddress: string;
            responseAddress?: string;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(ExecutorOpCodes.anyone_proxyMsg, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeRef(opts.merkleProof)
                .storeAddress(Address.parse(opts.feeToAddress))
                .storeAddress(opts.responseAddress ? Address.parse(opts.responseAddress) : null)
                .endCell(),
        });
    }

    async getFullData(provider: ContractProvider): Promise<ExecutorConfig> {
        const result = await provider.get('get_full_data', []);

        const crossChainLayer = result.stack.readAddress().toString();
        const lastExecutorAddress = result.stack.readAddressOpt()?.toString();
        const isSpent = result.stack.readNumber() == -1;
        const payload = result.stack.readCell();

        return {
            crossChainLayerAddress: crossChainLayer,
            lastExecutorAddress,
            isSpent,
            payload,
        };
    }

    async getCheckProof(provider: ContractProvider, merkleProof: Cell): Promise<boolean> {
        const result = await provider.get('get_check_proof', [{ type: 'cell', cell: merkleProof }]);
        return result.stack.readBoolean();
    }

    async getIsValidExecutor(provider: ContractProvider, executorAddress: Address): Promise<boolean> {
        const result = await provider.get('get_is_valid_executor', [{ type: 'slice', cell: beginCell().storeAddress(executorAddress).endCell() }]);
        return result.stack.readBoolean();
    }
}
