import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, storeStateInit, toNano } from '@ton/core';
import {
    NFTCollection,
    NFTCollectionConfig,
    NFTCollectionErrors,
    NFTCollectionOpCodes,
} from '../wrappers/NFTCollection';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { calculateFeesData, calculateMaxStorageState } from './utils';
import { collectCellStats } from '../wrappers/utils/GasUtils';

describe('NFTCollection Contract', () => {
    let code: Cell;
    let nftCollection: SandboxContract<NFTCollection>;
    let config: NFTCollectionConfig;

    let owner: SandboxContract<TreasuryContract>;
    let newOwner: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;

    let ownerAddress: Address;

    let blockchain: Blockchain;
    let initialState: BlockchainSnapshot;

    beforeAll(async () => {
        code = await compile('NFTCollection');
        blockchain = await Blockchain.create();

        owner = await blockchain.treasury('owner');
        newOwner = await blockchain.treasury('newOwner');
        anyone = await blockchain.treasury('anyone');

        ownerAddress = owner.address;

        const nftItemCodeRaw = await compile('NFTItem');
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${nftItemCodeRaw.hash().toString('hex')}`), nftItemCodeRaw);
        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();
        let lib_nft_prep = beginCell().storeUint(2, 8).storeBuffer(nftItemCodeRaw.hash()).endCell();
        const nftItemCode = new Cell({ exotic: true, bits: lib_nft_prep.bits, refs: lib_nft_prep.refs });

        config = {
            ownerAddress,
            content: beginCell().endCell(),
            nftItemCode,
            originalAddress: '0x12345',
        };

        nftCollection = blockchain.openContract(NFTCollection.createFromConfig(config, code));

        const deployResult = await nftCollection.sendDeploy(owner.getSender(), toNano('0.05'));
        printTransactionFees(deployResult.transactions);
        expect(deployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: nftCollection.address,
            deploy: true,
            success: true,
            body: beginCell().endCell(),
        });

        initialState = blockchain.snapshot();
    });

    beforeEach(() => {
        ownerAddress = owner.address;
    });

    async function checkFullData() {
        const data = await nftCollection.getCollectionData();
        expect(data.ownerAddress.equals(ownerAddress)).toBe(true);
        expect(data.content.hash().equals(config.content.hash())).toBe(true);
        expect(data.nextIndex).toBe(-1);
    }

    afterEach(async () => {
        await checkFullData();
        await blockchain.loadFrom(initialState);

        nftCollection = blockchain.openContract(NFTCollection.createFromConfig(config, code));
    });

    describe('NC-1: gas consumption', () => {
        it('NC-1.1: collect stats for nft collection and item', async () => {
            const result = await nftCollection.sendDeployNFTItem(owner.getSender(), toNano(0.1), {
                itemIndex: 0,
                itemOwner: anyone.address,
                nftContent: beginCell().endCell(),
            });

            const itemAddress = await nftCollection.getNFTAddressByIndex(0);

            expect(result.transactions).toHaveTransaction({
                from: nftCollection.address,
                to: itemAddress,
                success: true,
                deploy: true,
                body: beginCell()
                    .storeUint(NFTCollectionOpCodes.collection_init, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeRef(beginCell().endCell())
                    .endCell(),
            });

            const nftItemContract = await blockchain.getContract(itemAddress);

            await calculateMaxStorageState(blockchain, 'NFT Collection', nftCollection.address);

            await calculateMaxStorageState(blockchain, 'NFT Item', nftItemContract.address);

            // @ts-ignore // non-null checks performed in calculateMaxStorageState
            const itemState = nftItemContract.accountState!.state;

            const itemStateCell = beginCell().store(storeStateInit(itemState)).endCell();
            console.log('NFT Item State init stats:', collectCellStats(itemStateCell, []));
        });
    });

    describe('NC-2: NFT item deployment', () => {
        it('NC-2.1: should deploy NFT item', async () => {
            const initBalance = (await blockchain.getContract(nftCollection.address)).balance;
            const result = await nftCollection.sendDeployNFTItem(owner.getSender(), toNano(0.1), {
                itemIndex: 0,
                itemOwner: anyone.address,
                nftContent: beginCell().endCell(),
            });

            printTransactionFees(result.transactions);

            const itemAddress = await nftCollection.getNFTAddressByIndex(0);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: nftCollection.address,
                success: true,
                body: beginCell()
                    .storeUint(NFTCollectionOpCodes.owner_deployNFTItem, 32)
                    .storeUint(0, 64)
                    .storeUint(0, 256)
                    .storeAddress(anyone.address)
                    .storeRef(beginCell().endCell())
                    .storeMaybeRef(null)
                    .endCell(),
            });

            expect(result.transactions).toHaveTransaction({
                from: nftCollection.address,
                to: itemAddress,
                body: beginCell()
                    .storeUint(NFTCollectionOpCodes.collection_init, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeRef(beginCell().endCell())
                    .endCell(),
                success: true,
                deploy: true,
            });

            await calculateFeesData(blockchain, nftCollection, result, initBalance);
        });

        it('NC-2.2: should fail when non-owner tries to deploy NFT item', async () => {
            const initBalance = (await blockchain.getContract(nftCollection.address)).balance;
            const result = await nftCollection.sendDeployNFTItem(anyone.getSender(), toNano(0.05), {
                itemIndex: 1,
                itemOwner: newOwner.address,
                nftContent: beginCell().endCell(),
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: nftCollection.address,
                exitCode: NFTCollectionErrors.notFromOwner,
                success: false,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftCollection.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
            });

            await calculateFeesData(blockchain, nftCollection, result, initBalance);
        });
    });

    describe('NC-3: Owner management', () => {
        it('NC-3.1: should change owner when called by current owner', async () => {
            const initBalance = (await blockchain.getContract(nftCollection.address)).balance;
            const result = await nftCollection.sendChangeOwner(owner.getSender(), toNano('0.05'), {
                newOwnerAddress: newOwner.address,
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: nftCollection.address,
                success: true,
                body: beginCell()
                    .storeUint(NFTCollectionOpCodes.owner_changeOwner, 32)
                    .storeUint(0, 64)
                    .storeAddress(newOwner.address)
                    .endCell(),
            });

            ownerAddress = newOwner.address;
            await calculateFeesData(blockchain, nftCollection, result, initBalance);
        });

        it('NC-3.2: should fail when non-owner tries to change owner', async () => {
            const initBalance = (await blockchain.getContract(nftCollection.address)).balance;
            const result = await nftCollection.sendChangeOwner(anyone.getSender(), toNano('0.05'), {
                newOwnerAddress: anyone.address,
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: nftCollection.address,
                exitCode: NFTCollectionErrors.notFromOwner,
                success: false,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftCollection.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
            });

            await calculateFeesData(blockchain, nftCollection, result, initBalance);
        });
    });

    describe('NC-4: get methods', () => {
        it('NC-4.1: get_collection_data', async () => {
            const data = await nftCollection.getCollectionData();
            expect(data.ownerAddress.equals(ownerAddress)).toBe(true);
            expect(data.content.hash().equals(config.content.hash())).toBe(true);
            expect(data.nextIndex).toBe(-1);
        });

        it('NC-4.2: get_nft_address_by_index', async () => {
            const itemAddress = await nftCollection.getNFTAddressByIndex(0);
            expect(itemAddress).toBeDefined();
        });

        it('NC-4.3: get_nft_content', async () => {
            const itemContent = await nftCollection.getNFTContent(0, beginCell().endCell());
            expect(itemContent).toBeDefined();
        });

        it('NC-4.4: get_original_address', async () => {
            const originalAddress = await nftCollection.getOriginalAddress();
            expect(originalAddress).toBe('0x12345');
        });
    });
});
