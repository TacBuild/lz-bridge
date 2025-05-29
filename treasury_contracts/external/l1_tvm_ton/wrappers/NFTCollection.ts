import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core';

export const NFTCollectionOpCodes = {
    owner_deployNFTItem: 0xfdba5d5f,
    owner_batchDeployNFTItems: 0x909d579b,
    owner_changeOwner: 0x3ac3e0ca,
    collection_init: 0xbd6ea770,
};

export const NFTCollectionErrors = {
    notFromOwner: 71,
};

export type NFTCollectionConfig = {
    ownerAddress: Address;
    content: Cell;
    nftItemCode: Cell;
    originalAddress: string;
};

export function nftCollectionConfigToCell(config: NFTCollectionConfig): Cell {
    return beginCell()
        .storeAddress(config.ownerAddress)
        .storeRef(config.content)
        .storeRef(config.nftItemCode)
        .storeStringTail(config.originalAddress)
        .endCell();
}

export class NFTCollection implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new NFTCollection(address);
    }

    static createFromConfig(config: NFTCollectionConfig, code: Cell, workchain = 0) {
        const data = nftCollectionConfigToCell(config);
        const init = { code, data };
        return new NFTCollection(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    static deployNFTItemMessage(
        queryId: number | bigint,
        itemIndex: number,
        itemOwner: Address,
        nftContent: Cell,
        maybeNewContent?: Cell,
    ) {
        return beginCell()
            .storeUint(NFTCollectionOpCodes.owner_deployNFTItem, 32)
            .storeUint(queryId, 64)
            .storeUint(itemIndex, 256)
            .storeAddress(itemOwner)
            .storeRef(nftContent)
            .storeMaybeRef(maybeNewContent)
            .endCell();
    }

    async sendDeployNFTItem(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            queryId?: number | bigint;
            itemIndex: number;
            itemOwner: Address;
            nftContent: Cell;
            maybeNewContent?: Cell;
        },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTCollection.deployNFTItemMessage(
                params.queryId ?? 0,
                params.itemIndex,
                params.itemOwner,
                params.nftContent,
                params.maybeNewContent,
            ),
            value,
        });
    }

    static changeOwnerMessage(newOwner: Address, queryId: number | bigint) {
        return beginCell()
            .storeUint(NFTCollectionOpCodes.owner_changeOwner, 32)
            .storeUint(queryId, 64)
            .storeAddress(newOwner)
            .endCell();
    }

    async sendChangeOwner(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { queryId?: number | bigint; newOwnerAddress: Address },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: NFTCollection.changeOwnerMessage(params.newOwnerAddress, params.queryId ?? 0),
            value,
        });
    }

    async getCollectionData(provider: ContractProvider) {
        const res = await provider.get('get_collection_data', []);
        const nextIndex = res.stack.readNumber();
        const content = res.stack.readCell();
        const ownerAddress = res.stack.readAddress();
        return {
            nextIndex,
            content,
            ownerAddress,
        };
    }

    async getNFTAddressByIndex(provider: ContractProvider, index: number | bigint): Promise<Address> {
        const res = await provider.get('get_nft_address_by_index', [{ type: 'int', value: BigInt(index) }]);
        return res.stack.readAddress();
    }

    async getNFTContent(provider: ContractProvider, index: number | bigint, individualNFTContent: Cell): Promise<Cell> {
        const res = await provider.get('get_nft_content', [
            { type: 'int', value: BigInt(index) },
            { type: 'cell', cell: individualNFTContent },
        ]);
        return res.stack.readCell();
    }

    async getOriginalAddress(provider: ContractProvider): Promise<String> {
        const res = await provider.get('get_original_address', []);
        return res.stack.readString();
    }
}
