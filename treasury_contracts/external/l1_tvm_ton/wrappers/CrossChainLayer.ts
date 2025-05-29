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
    Slice,
    toNano,
} from '@ton/core';
import { Params } from './Constants';
import { StorageStats } from './utils/GasUtils';
import { arrayToCell, cellToArray, MerkleRoot } from './utils/MerkleRoots';

export type CrossChainLayerConfig = {
    adminAddress: string;
    newAdminAddress?: string;
    sequencerMultisigAddress: string;
    maxRootsSize: number;
    merkleRoots?: MerkleRoot[];
    prevEpoch?: number;
    currEpoch?: number;
    messageCollectEndTime?: number;
    epochDelay: number;
    nextVotingTime?: number;
    tonProtocolFee?: number;
    tacProtocolFee?: number;
    protocolFeeSupply?: number;
    executorCode: Cell;
};

export type EpochInfo = {
    lastMerkleRoot: bigint;
    maxRootsSize: number;
    prevEpoch: number;
    currEpoch: number;
    messageCollectEndTime: number;
    nextVotingTime: number;
    epochDelay: number;
};

export type ExecutorData = {
    address: Address;
    stateInit: Cell;
};

export enum OperationType {
    tonTransfer = 0x4ad67cd3,
    jettonTransfer = 0x2906ab02,
    nftTransfer = 0x8b092962,
    jettonBurn = 0xb0afa74d,
    nftBurn = 0xbcd19310,
}

export const CrossChainLayerOpCodes = {
    anyone_tvmMsgToEVM: 0x6c582059,
    anyone_errorNotification: 0xae7df95b,
    anyone_excesses: 0xd53276db,
    anyone_addProtocolFee: 0x48e660b5,

    executor_evmMsgToTVM: 0x0e50d313,
    executor_revertSpentParam: 0x959f183a,
    executor_errorNotification: 0xcf6a5da4,

    admin_changeAdminAddress: 0x581879bc,
    admin_cancelChangingAdminAddress: 0x60094a1b,
    admin_updateCode: 0x20faec53,
    admin_updateExecutorCode: 0x7ee5a6d0,
    admin_updateEpochDelay: 0xe97250b7,
    admin_updateTonProtocolFee: 0x063199b7,
    admin_updateTacProtocolFee: 0x3531465c,

    newAdmin_confirmChangingAdminAddress: 0x6a4fbe34,

    sequencerMultisig_changeSequencerMultisigAddress: 0x5cec6be0,
    sequencerMultisig_updateMerkleRoot: 0x23b05641,
    sequencerMultisig_collectProtocolFee: 0x1f95f86c,
    sequencerMultisig_collectProtocolFeeNotification: 0xf358b6d0,
};

export const CrossChainLayerErrors = {
    noErrors: 0,

    systemNotEnoughTon: 37,

    notFromAdmin: 70,
    notFromExecutor: 71,
    notFromSequencerMultisig: 72,
    notFromNewAdmin: 73,

    newAdminAddressIsNone: 80,

    notEnoughTon: 100,
    insufficientBalance: 101,

    zeroFeeSupply: 200,
    invalidProof: 201,
    votingNotActive: 202,
    messageCollectEndTimeLow: 203,
    notEnoughProtocolFee: 204,
};

export function crossChainLayerConfigToCell(config: CrossChainLayerConfig): Cell {
    return beginCell()
        .storeAddress(Address.parse(config.adminAddress))
        .storeAddress(config.newAdminAddress ? Address.parse(config.newAdminAddress) : null)
        .storeAddress(Address.parse(config.sequencerMultisigAddress))
        .storeRef(
            beginCell()
                .storeCoins(config.tacProtocolFee ? toNano(config.tacProtocolFee.toFixed(9)) : 0)
                .storeCoins(config.tonProtocolFee ? toNano(config.tonProtocolFee.toFixed(9)) : 0)
                .storeCoins(config.protocolFeeSupply ? toNano(config.protocolFeeSupply.toFixed(9)) : 0)
                .endCell(),
        )
        .storeRef(config.executorCode)
        .storeRef(
            beginCell()
                .storeUint(config.epochDelay, Params.bitsize.time)
                .storeUint(config.prevEpoch ? config.prevEpoch : 0, Params.bitsize.time)
                .storeUint(config.currEpoch ? config.currEpoch : 0, Params.bitsize.time)
                .storeUint(config.messageCollectEndTime ? config.messageCollectEndTime : 0, Params.bitsize.time)
                .storeUint(config.nextVotingTime ? config.nextVotingTime : 0, Params.bitsize.time)
                .storeUint(config.maxRootsSize, 4)
                .storeDict(arrayToCell(config.merkleRoots ?? []))
                .endCell(),
        )
        .endCell();
}

export class CrossChainLayer implements Contract {
    static minStorageDuration = 365 * 24 * 3600; //1 year
    static storageStats = new StorageStats(34254n, 85n);

    static addFeeGasConsumption = 6036n;

    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new CrossChainLayer(address);
    }

    static createFromConfig(config: CrossChainLayerConfig, code: Cell, workchain = 0) {
        const data = crossChainLayerConfigToCell(config);
        const init = { code, data };
        return new CrossChainLayer(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendTVMMsgToEVM(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            operationType: OperationType;
            crossChainTonAmount: number;
            feeData?: Cell;
            payload: Slice;
            responseAddress?: string;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeUint(opts.operationType, Params.bitsize.op)
                .storeCoins(toNano(opts.crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(opts.feeData)
                .storeAddress(opts.responseAddress ? Address.parse(opts.responseAddress) : null)
                .storeSlice(opts.payload)
                .endCell(),
        });
    }

    async sendEVMMsgToTVM(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            feeToAddress: string;
            merkleProof: Cell;
            payload: Cell;
            responseAddress?: string;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeAddress(opts.feeToAddress ? Address.parse(opts.feeToAddress) : null)
                .storeRef(opts.merkleProof)
                .storeRef(opts.payload)
                .storeAddress(opts.responseAddress ? Address.parse(opts.responseAddress) : null)
                .endCell(),
        });
    }

    async sendErrorNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            payload: Cell;
            responseAddress: Address;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.executor_errorNotification, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeRef(opts.payload)
                .storeAddress(opts.responseAddress)
                .endCell(),
        });
    }

    async sendUpdateMerkleRoot(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            merkleRoot: bigint;
            messageCollectEndTime: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeUint(opts.merkleRoot, Params.bitsize.hash)
                .storeUint(opts.messageCollectEndTime, Params.bitsize.time)
                .endCell(),
        });
    }

    async sendAddProtocolFee(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts?: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_addProtocolFee, Params.bitsize.op)
                .storeUint(opts?.queryId ?? 0, Params.bitsize.queryId)
                .endCell(),
        });
    }

    async sendCollectProtocolFee(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.sequencerMultisig_collectProtocolFee, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .endCell(),
        });
    }

    async sendChangeAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts?: {
            queryId?: number;
            adminAddress?: string;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.admin_changeAdminAddress, Params.bitsize.op)
                .storeUint(opts?.queryId || 0, Params.bitsize.queryId)
                .storeAddress(opts?.adminAddress ? Address.parse(opts.adminAddress) : null)
                .endCell(),
        });
    }

    async sendCancelChangingAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts?: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.admin_cancelChangingAdminAddress, Params.bitsize.op)
                .storeUint(opts?.queryId || 0, Params.bitsize.queryId)
                .endCell(),
        });
    }

    async sendConfirmNewAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts?: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.newAdmin_confirmChangingAdminAddress, Params.bitsize.op)
                .storeUint(opts?.queryId || 0, Params.bitsize.queryId)
                .endCell(),
        });
    }

    async sendChangeSequencerMultisig(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            sequencerMultisigAddress: string;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.sequencerMultisig_changeSequencerMultisigAddress, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeAddress(Address.parse(opts.sequencerMultisigAddress))
                .endCell(),
        });
    }

    async sendUpdateTonProtocolFeeAmount(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            tonProtocolFee: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.admin_updateTonProtocolFee, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeCoins(toNano(opts.tonProtocolFee.toFixed(9)))
                .endCell(),
        });
    }

    async sendUpdateTacProtocolFeeAmount(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            tacProtocolFee: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.admin_updateTacProtocolFee, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeCoins(toNano(opts.tacProtocolFee.toFixed(9)))
                .endCell(),
        });
    }

    async sendUpdateEpochDelay(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            epochDelay: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.admin_updateEpochDelay, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeUint(opts.epochDelay || 0, Params.bitsize.time)
                .endCell(),
        });
    }

    async sendUpdateCode(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            code: Cell;
            data: Cell;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.admin_updateCode, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeRef(opts.code)
                .storeRef(opts.data)
                .endCell(),
        });
    }

    async sendUpdateExecutorCode(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            code: Cell;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.admin_updateExecutorCode, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeRef(opts.code)
                .endCell(),
        });
    }

    async getFullData(provider: ContractProvider): Promise<CrossChainLayerConfig> {
        const result = await provider.get('get_full_data', []);

        const adminAddress = result.stack.readAddress().toString();
        const newAdminAddress = result.stack.readAddressOpt()?.toString();
        const sequencerMultisigAddress = result.stack.readAddress().toString();
        const maxRootsSize = result.stack.readNumber();
        const merkleRoots = result.stack.readCellOpt();
        const prevEpoch = result.stack.readNumber();
        const currEpoch = result.stack.readNumber();
        const messageCollectEndTime = result.stack.readNumber();
        const epochDelay = result.stack.readNumber();
        const nextVotingTime = result.stack.readNumber();
        const tacProtocolFee = Number(fromNano(result.stack.readNumber()));
        const tonProtocolFee = Number(fromNano(result.stack.readNumber()));
        const protocolFeeSupply = Number(fromNano(result.stack.readNumber()));
        const executorCode = result.stack.readCell();

        return {
            adminAddress,
            newAdminAddress,
            sequencerMultisigAddress,
            maxRootsSize,
            merkleRoots: cellToArray(merkleRoots),
            prevEpoch,
            currEpoch,
            epochDelay,
            messageCollectEndTime,
            nextVotingTime,
            tacProtocolFee,
            tonProtocolFee,
            protocolFeeSupply,
            executorCode,
        };
    }

    async getCurrentEpochInfo(provider: ContractProvider): Promise<EpochInfo> {
        const result = await provider.get('get_current_epoch_info', []);

        const lastMerkleRoot = result.stack.readBigNumber();
        const prevEpoch = result.stack.readNumber();
        const currEpoch = result.stack.readNumber();
        const messageCollectEndTime = result.stack.readNumber();
        const nextVotingTime = result.stack.readNumber();
        const epochDelay = result.stack.readNumber();
        const maxRootsSize = result.stack.readNumber();

        return {
            lastMerkleRoot,
            prevEpoch,
            currEpoch,
            messageCollectEndTime,
            nextVotingTime,
            epochDelay,
            maxRootsSize,
        };
    }

    async getExecutorAddress(provider: ContractProvider, payload: Cell): Promise<Address> {
        const result = await provider.get('get_executor_address', [{ type: 'cell', cell: payload }]);
        return result.stack.readAddress();
    }

    async getExecutorData(provider: ContractProvider, payload: Cell): Promise<ExecutorData> {
        const result = await provider.get('get_executor_data', [{ type: 'cell', cell: payload }]);
        const address = result.stack.readAddress();
        const stateInit = result.stack.readCell();

        return {
            address,
            stateInit,
        };
    }
}
