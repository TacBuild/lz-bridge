import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    Slice,
    toNano,
} from '@ton/core';

export const NFTItemOpCodes = {
    owner_transfer: 0x5fcc3d14,
    owner_burn: 0x3b390ce,
    collection_init: 0xbd6ea770,
    anyone_getStaticData: 0x2fcb26a2,
    nftItem_reportStaticData: 0x8b771735,
    nftItem_ownershipAssigned: 0x05138d91,
    nftItem_excesses: 0xd53276db,
    ccl_tvmMsgToEVM: 0x6c582059,
    ccl_errorNotification: 0xae7df95b,
};

export const NFTItemErrors = {
    notEnoughGas: 48,
    alreadyInitialized: 200,
    notInitialized: 201,
    destinationNotAllowed: 202,
    notFromCCL: 70,
    notFromOwner: 71,
    notFromCollection: 72,
};

export type NFTItemConfig = {
    init?: boolean;
    index: number;
    collectionAddress: Address;
    ownerAddress?: Address;
    content?: Cell;
    cclAddress: Address;
};

export function nftItemConfigToCell(config: NFTItemConfig): Cell {
    return beginCell()
        .storeBit(config.init ?? false)
        .storeUint(config.index, 256)
        .storeRef(
            beginCell()
                .storeAddress(config.collectionAddress)
                .storeAddress(config.cclAddress)
                .storeAddress(config.ownerAddress ?? null)
                .endCell(),
        )
        .storeMaybeRef(config.content ?? null)
        .endCell();
}

export class NFTItem implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new NFTItem(address);
    }

    static createFromConfig(config: NFTItemConfig, code: Cell, workchain = 0) {
        const data = nftItemConfigToCell(config);
        const init = { code, data };
        return new NFTItem(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    static transferMessage(
        queryId: number | bigint,
        newOwner: Address,
        responseAddress: Address,
        forwardAmount: bigint | number,
        forwardPayload?: Cell,
    ) {
        let msg = beginCell()
            .storeUint(NFTItemOpCodes.owner_transfer, 32)
            .storeUint(queryId, 64)
            .storeAddress(newOwner)
            .storeAddress(responseAddress)
            .storeBit(false) // custom payload
            .storeCoins(toNano(forwardAmount));
        if (forwardPayload) {
            msg.storeMaybeRef(forwardPayload);
        }
        return msg.endCell();
    }

    async sendTransfer(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            queryId?: number | bigint;
            newOwner: Address;
            responseAddress: Address;
            forwardAmount: bigint | number;
            forwardPayload?: Cell;
        },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTItem.transferMessage(
                params.queryId ?? 0,
                params.newOwner,
                params.responseAddress,
                params.forwardAmount,
                params.forwardPayload,
            ),
            value,
        });
    }

    static burnMessage(
        queryId: number | bigint,
        responseAddress: Address,
        crosschainTonAmount: bigint | number,
        crosschainPayload?: Cell,
        feeData?: Cell,
    ) {
        return beginCell()
            .storeUint(NFTItemOpCodes.owner_burn, 32)
            .storeUint(queryId, 64)
            .storeAddress(responseAddress)
            .storeMaybeRef(beginCell()
                        .storeCoins(toNano(crosschainTonAmount))
                        .storeMaybeRef(feeData)
                        .storeMaybeRef(crosschainPayload ?? null)
                        .endCell())
            .endCell();
    }

    async sendBurn(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            queryId?: number | bigint;
            responseAddress: Address;
            crosschainTonAmount?: number | bigint;
            crosschainPayload?: Cell;
            feeData?: Cell;
        },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTItem.burnMessage(
                params.queryId ?? 0,
                params.responseAddress,
                params.crosschainTonAmount ?? 0n,
                params.crosschainPayload,
                params.feeData,
            ),
            value,
        });
    }

    static initMessage(queryId: number | bigint, ownerAddress: Address, content: Cell) {
        return beginCell()
            .storeUint(NFTItemOpCodes.collection_init, 32)
            .storeUint(queryId, 64)
            .storeAddress(ownerAddress)
            .storeRef(content)
            .endCell();
    }

    async sendInit(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { queryId?: number | bigint; ownerAddress: Address; content: Cell },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTItem.initMessage(params.queryId ?? 0, params.ownerAddress, params.content),
            value,
        });
    }

    static getStaticDataMessage(queryId: number | bigint) {
        return beginCell().storeUint(NFTItemOpCodes.anyone_getStaticData, 32).storeUint(queryId, 64).endCell();
    }

    async sendGetStaticData(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { queryId?: number | bigint },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTItem.getStaticDataMessage(params.queryId ?? 0),
            value,
        });
    }

    static errorNotificationMessage(queryId: number | bigint) {
        return beginCell().storeUint(NFTItemOpCodes.ccl_errorNotification, 32).storeUint(queryId, 64).endCell();
    }

    async sendErrorNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { queryId?: number | bigint } = {},
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTItem.errorNotificationMessage(params.queryId ?? 0),
            value,
        });
    }

    async getNFTData(provider: ContractProvider) {
        const res = await provider.get('get_nft_data', []);
        const init = res.stack.readBoolean();
        const index = res.stack.readNumber();
        const collectionAddress = res.stack.readAddress();
        const ownerAddress = res.stack.readAddressOpt();
        const content = res.stack.readCellOpt();
        return {
            init,
            index,
            collectionAddress,
            ownerAddress,
            content,
        };
    }
}
