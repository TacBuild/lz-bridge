import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';
import { Params } from './Constants';

export const NFTItemTransferOperation = 0x8b092962;

export const NFTProxyOpCodes = {
    admin_changeAdmin: 0x581879bc,
    admin_updateCode: 0x20faec53,
    ccl_evmMsgToTVMProxy: 0x7817b330,
    ccl_errorNotification: 0xae7df95b,
    ccl_tvmMsgToEVM: 0x6c582059,
    nftItem_ownershipAssigned: 0x05138d91,
    nftItem_burn: 0x6656d267,
    nftItem_transfer: 0x5fcc3d14,
};

export const NFTProxyErrors = {
    notFromCrossChainLayer: 70,
    notFromAdmin: 71,
    notEnoughTon: 100,
    invalidPayload: 200,
};

export type NFTProxyConfig = {
    cclAddress: Address;
    adminAddress: Address;
};

export function nftProxyConfigToCell(config: NFTProxyConfig): Cell {
    return beginCell().storeAddress(config.cclAddress).storeAddress(config.adminAddress).endCell();
}

export class NFTProxy implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new NFTProxy(address);
    }

    static createFromConfig(config: NFTProxyConfig, code: Cell, workchain = 0) {
        const data = nftProxyConfigToCell(config);
        const init = { code, data };
        return new NFTProxy(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    static errorNotificationMessage(
        queryId: number | bigint,
        operation: number | bigint,
        itemAddress: Address,
        owner: Address,
    ) {
        return beginCell()
            .storeUint(NFTProxyOpCodes.ccl_errorNotification, Params.bitsize.op)
            .storeUint(queryId, Params.bitsize.queryId)
            .storeUint(operation, 32)
            .storeAddress(itemAddress)
            .storeAddress(owner)
            .endCell();
    }

    async sendErrorNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { queryId?: number | bigint; operation: number | bigint; itemAddress: Address; owner: Address },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTProxy.errorNotificationMessage(
                params.queryId ?? 0,
                params.operation,
                params.itemAddress,
                params.owner,
            ),
            value,
        });
    }

    static evmMsgToTVMProxyMessage(
        queryId: number | bigint,
        itemAddress: Address,
        newOwner: Address,
        forwardAmount: bigint,
    ) {
        return beginCell()
            .storeUint(NFTProxyOpCodes.ccl_evmMsgToTVMProxy, Params.bitsize.op)
            .storeUint(queryId, Params.bitsize.queryId)
            .storeAddress(itemAddress)
            .storeAddress(newOwner)
            .storeCoins(forwardAmount)
            .endCell();
    }

    async sendEVMMsgToTVMProxy(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { queryId?: number | bigint; itemAddress: Address; newOwner: Address; forwardAmount: bigint },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTProxy.evmMsgToTVMProxyMessage(
                params.queryId ?? 0,
                params.itemAddress,
                params.newOwner,
                params.forwardAmount,
            ),
            value,
        });
    }

    static ownershipAssignedMessage(
        queryId: number | bigint,
        itemOwner: Address,
        crosschainTonAmount: bigint,
        evmData?: Cell,
        feeData?: Cell,
    ) {
        return beginCell()
            .storeUint(NFTProxyOpCodes.nftItem_ownershipAssigned, Params.bitsize.op)
            .storeUint(queryId, Params.bitsize.queryId)
            .storeAddress(itemOwner)
            .storeMaybeRef(beginCell()
                        .storeCoins(crosschainTonAmount)
                        .storeMaybeRef(feeData)
                        .storeMaybeRef(evmData)
                        .endCell())
            .endCell();
    }

    async sendOwnershipAssigned(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            queryId?: number | bigint;
            itemOwner: Address;
            crosschainTonAmount: bigint;
            evmData?: Cell;
            feeData?: Cell;
        },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTProxy.ownershipAssignedMessage(
                params.queryId ?? 0,
                params.itemOwner,
                params.crosschainTonAmount,
                params.evmData,
                params.feeData,
            ),
            value,
        });
    }

    async sendUpdateCode(
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
                .storeUint(NFTProxyOpCodes.admin_updateCode, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeRef(opts.code)
                .endCell(),
        });
    }

    async sendChangeAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            adminAddress: string;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(0x581879bc, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeAddress(Address.parse(opts.adminAddress))
                .endCell(),
        });
    }

    async getFullData(provider: ContractProvider) {
        const res = await provider.get('get_full_data', []);
        const cclAddress = res.stack.readAddress();
        const adminAddress = res.stack.readAddress();
        return {
            cclAddress,
            adminAddress,
        };
    }
}
