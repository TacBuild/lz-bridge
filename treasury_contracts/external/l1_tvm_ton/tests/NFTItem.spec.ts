import { Address, beginCell, Cell, toNano } from '@ton/core';
import { NFTItem, NFTItemConfig, NFTItemErrors, NFTItemOpCodes } from '../wrappers/NFTItem';
import { OperationType } from '../wrappers/CrossChainLayer';
import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { compile } from '@ton/blueprint';

import '@ton/test-utils';
import { calculateFeesData, calculateMaxStorageState, printTxGasStats } from './utils';
import { findTransactionRequired } from '@ton/test-utils';

describe('NFTItem Contract', () => {
    let code: Cell;
    let nftItem: SandboxContract<NFTItem>;
    let config: NFTItemConfig;

    let owner: SandboxContract<TreasuryContract>;
    let collection: SandboxContract<TreasuryContract>;
    let ccl: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;

    let ownerAddress: Address | undefined;
    let content: Cell | undefined;
    let isInit: boolean;

    let blockchain: Blockchain;
    let initialState: BlockchainSnapshot;

    let tonProtocolFee = 0.1;
    let tacProtocolFee = 0.2;

    let tacExecutorFee = 0;
    let tonExecutorFee = 0;

    async function checkFullData() {
        const data = await nftItem.getNFTData();
        expect(data.collectionAddress.toString()).toBe(collection.address.toString());
        expect(data.index).toBe(config.index);

        expect(data.content?.hash().toString()).toBe(content?.hash().toString());
        expect(data.init).toBe(isInit);
        expect(data.ownerAddress?.toString()).toBe(ownerAddress?.toString());
    }

    beforeAll(async () => {
        code = await compile('NFTItem');
        blockchain = await Blockchain.create();

        owner = await blockchain.treasury('owner');
        collection = await blockchain.treasury('collection');
        ccl = await blockchain.treasury('ccl');
        anyone = await blockchain.treasury('anyone');

        config = {
            cclAddress: ccl.address,
            index: 0,
            collectionAddress: collection.address,
        };
        nftItem = blockchain.openContract(NFTItem.createFromConfig(config, code));

        const deployResult = await nftItem.sendDeploy(collection.getSender(), toNano(0.05));
        expect(deployResult.transactions).toHaveTransaction({
            from: collection.address,
            to: nftItem.address,
            deploy: true,
            body: beginCell().endCell(),
        });

        initialState = blockchain.snapshot();
    });

    beforeEach(() => {
        ownerAddress = undefined;
        isInit = false;
        content = undefined;
        nftItem = blockchain.openContract(NFTItem.createFromConfig(config, code));
    });

    afterEach(async () => {
        await checkFullData();
        await blockchain.loadFrom(initialState);
    });

    describe('NI-1: storage gas stats', () => {
        it('NI-1.1: should collect storage stats for nft item', async () => {
            await calculateMaxStorageState(blockchain, 'NFT Item', nftItem.address);
        });
    });

    describe('NI: opcodes', () => {
        // initializes NFT item to use in subsequent tests
        beforeEach(async () => {
            ownerAddress = owner.address;
            content = beginCell().storeUint(1, 32).endCell();
            isInit = true;

            const initResult = await nftItem.sendInit(collection.getSender(), toNano(0.05), {
                ownerAddress,
                content,
            });

            printTransactionFees(initResult.transactions);

            expect(initResult.transactions).toHaveTransaction({
                from: collection.address,
                to: nftItem.address,
                success: true,
                body: beginCell()
                    .storeUint(NFTItemOpCodes.collection_init, 32)
                    .storeUint(0, 64)
                    .storeAddress(ownerAddress!)
                    .storeRef(content!)
                    .endCell(),
            });
        });

        describe('NI-2: initialization', () => {
            it('NI-2.1: should initialize the NFT item', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                const initResult = await nftItem.sendInit(collection.getSender(), toNano(0.05), {
                    ownerAddress: ownerAddress!,
                    content: content!,
                });
                await calculateFeesData(blockchain, nftItem, initResult, initBalance);
            });

            it('NI-2.2: should fail to initialize the NFT item twice', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                const initResult = await nftItem.sendInit(collection.getSender(), toNano(0.05), {
                    ownerAddress: ownerAddress!,
                    content: content!,
                });

                printTransactionFees(initResult.transactions);

                expect(initResult.transactions.length).toBe(3);

                expect(initResult.transactions).toHaveTransaction({
                    from: collection.address,
                    to: nftItem.address,
                    success: false,
                    exitCode: NFTItemErrors.alreadyInitialized,
                });

                expect(initResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: collection.address,
                    success: true,
                    inMessageBounced: true,
                });

                await calculateFeesData(blockchain, nftItem, initResult, initBalance);
            });

            it('NI-2.3: should fail to initialize the NFT from not collection address', async () => {
                const nftItem2 = blockchain.openContract(NFTItem.createFromConfig({ ...config, index: 1 }, code));
                const initBalance = (await blockchain.getContract(nftItem2.address)).balance;
                const initResult = await nftItem2.sendInit(owner.getSender(), toNano(0.05), {
                    ownerAddress: ownerAddress!,
                    content: content!,
                });

                printTransactionFees(initResult.transactions);

                expect(initResult.transactions.length).toBe(3);

                expect(initResult.transactions).toHaveTransaction({
                    from: owner.address,
                    to: nftItem2.address,
                    success: false,
                    exitCode: NFTItemErrors.notFromCollection,
                });

                expect(initResult.transactions).toHaveTransaction({
                    from: nftItem2.address,
                    to: owner.address,
                    inMessageBounced: true,
                });

                await calculateFeesData(blockchain, nftItem2, initResult, initBalance);
            });
        });

        describe('NI-3: burn', () => {
            it('NI-3.1: should burn the NFT item and send msg to CCL', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                const feeData = beginCell()
                    .storeUint(1, 1)
                    .storeCoins(toNano((tacProtocolFee + tonProtocolFee).toFixed(9)))
                    .storeCoins(toNano(tacExecutorFee.toFixed(9)))
                    .storeCoins(toNano(tonExecutorFee.toFixed(9)))
                    .endCell();

                const burnResult = await nftItem.sendBurn(owner.getSender(), toNano(0.5), {
                    responseAddress: ccl.address,
                    crosschainTonAmount: 0.05,
                    feeData,
                });

                printTransactionFees(burnResult.transactions);

                expect(burnResult.transactions.length).toBe(3);

                expect(burnResult.transactions).toHaveTransaction({
                    from: owner.address,
                    to: nftItem.address,
                    success: true,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_burn, 32)
                        .storeUint(0, 64)
                        .storeAddress(ccl.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(0.05))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(null)
                                    .endCell())
                        .endCell(),
                });

                expect(burnResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: ccl.address,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.ccl_tvmMsgToEVM, 32)
                        .storeUint(0, 64)
                        .storeUint(OperationType.nftBurn, 32)
                        .storeCoins(toNano(0.05))
                        .storeMaybeRef(feeData)
                        .storeAddress(owner.address)
                        .storeAddress(owner.address)
                        .storeMaybeRef(null)
                        .endCell(),
                    success: true,
                });

                isInit = false;
                ownerAddress = undefined;
                content = undefined;

                const burnTx = findTransactionRequired(burnResult.transactions, {
                    from: owner.address,
                    to: nftItem.address,
                    success: true,
                });

                printTxGasStats('NFT Burn', burnTx);
                await calculateFeesData(blockchain, nftItem, burnResult, initBalance);
            });

            it('NI-3.2: should burn the NFT item and send msg to response destination (not CCL)', async () => {
                const responseAddress = await blockchain.treasury('responseAddress');
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                const burnResult = await nftItem.sendBurn(owner.getSender(), toNano(0.2), {
                    responseAddress: responseAddress.address,
                });

                printTransactionFees(burnResult.transactions);

                expect(burnResult.transactions.length).toBe(3);

                expect(burnResult.transactions).toHaveTransaction({
                    from: owner.address,
                    to: nftItem.address,
                    success: true,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_burn, 32)
                        .storeUint(0, 64)
                        .storeAddress(responseAddress.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(0)
                                    .storeMaybeRef(null)
                                    .storeMaybeRef(null)
                                    .endCell())
                        .endCell(),
                });

                expect(burnResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: responseAddress.address,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.nftItem_excesses, 32)
                        .storeUint(0, 64)
                        .storeMaybeRef(null)
                        .endCell(),
                    success: true,
                });

                isInit = false;
                ownerAddress = undefined;
                content = undefined;
                await calculateFeesData(blockchain, nftItem, burnResult, initBalance);
            });

            it('NI-3.3: should reject if nft is not initialized', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                await nftItem.sendBurn(owner.getSender(), toNano(0.2), {
                    responseAddress: ccl.address,
                    crosschainTonAmount: 0.05,
                });
                isInit = false;
                ownerAddress = undefined;
                content = undefined;

                const burnResult = await nftItem.sendBurn(owner.getSender(), toNano(0.2), {
                    responseAddress: ccl.address,
                    crosschainTonAmount: 0.05,
                });

                printTransactionFees(burnResult.transactions);

                expect(burnResult.transactions.length).toBe(3);

                expect(burnResult.transactions).toHaveTransaction({
                    from: owner.address,
                    to: nftItem.address,
                    success: false,
                    exitCode: NFTItemErrors.notInitialized,
                });

                expect(burnResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: owner.address,
                    success: true,
                    inMessageBounced: true,
                });

                await calculateFeesData(blockchain, nftItem, burnResult, initBalance);
            });

            it('NI-3.4: should reject if sender is not owner', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                const burnResult = await nftItem.sendBurn(anyone.getSender(), toNano(0.2), {
                    responseAddress: ccl.address,
                    crosschainTonAmount: 0.05,
                });

                printTransactionFees(burnResult.transactions);

                expect(burnResult.transactions.length).toBe(3);

                expect(burnResult.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: nftItem.address,
                    success: false,
                    exitCode: NFTItemErrors.notFromOwner,
                });

                expect(burnResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: anyone.address,
                    success: true,
                    inMessageBounced: true,
                });

                await calculateFeesData(blockchain, nftItem, burnResult, initBalance);
            });

            it('NI-3.5: should restore init flag when burn message bounces back', async () => {
                const uninitializedCclAddress = Address.parse('EQD4FPq-PRDieyQKkizFTRtSDyucUIqrj0v_zXJmqaDp6_0t'); // some random uninitialized address
                const nftItemWithUninitializedCcl = blockchain.openContract(
                    NFTItem.createFromConfig(
                        {
                            ...config,
                            cclAddress: uninitializedCclAddress,
                        },
                        code,
                    ),
                );

                await nftItemWithUninitializedCcl.sendDeploy(collection.getSender(), toNano(0.05));
                const initBalance = (await blockchain.getContract(nftItemWithUninitializedCcl.address)).balance;
                await nftItemWithUninitializedCcl.sendInit(collection.getSender(), toNano(0.05), {
                    ownerAddress: owner.address,
                    content: beginCell().storeUint(1, 32).endCell(),
                });

                const burnResult = await nftItemWithUninitializedCcl.sendBurn(owner.getSender(), toNano(0.2), {
                    responseAddress: uninitializedCclAddress,
                    crosschainTonAmount: 0.05,
                });

                printTransactionFees(burnResult.transactions);

                expect(burnResult.transactions.length).toBe(4);

                expect(burnResult.transactions).toHaveTransaction({
                    from: owner.address,
                    to: nftItemWithUninitializedCcl.address,
                    success: true,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_burn, 32)
                        .storeUint(0, 64)
                        .storeAddress(uninitializedCclAddress)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(0.05))
                                    .storeMaybeRef(null)
                                    .storeMaybeRef(null)
                                    .endCell())
                        .endCell(),
                });

                expect(burnResult.transactions).toHaveTransaction({
                    from: nftItemWithUninitializedCcl.address,
                    to: uninitializedCclAddress,
                    success: false,
                });

                expect(burnResult.transactions).toHaveTransaction({
                    from: uninitializedCclAddress,
                    to: nftItemWithUninitializedCcl.address,
                    success: true,
                    inMessageBounced: true,
                });

                // Since CCL is uninitialized, the message will bounce back and init flag should be restored
                const data = await nftItemWithUninitializedCcl.getNFTData();
                expect(data.init).toBe(true);

                await calculateFeesData(blockchain, nftItemWithUninitializedCcl, burnResult, initBalance);
            });
        });

        describe('NI-4: transfer ownership', () => {
            it('NI-4.1: should transfer ownership', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                const transferResult = await nftItem.sendTransfer(owner.getSender(), toNano(0.1), {
                    newOwner: anyone.address,
                    responseAddress: owner.address,
                    forwardAmount: 0.05,
                });

                printTransactionFees(transferResult.transactions);

                expect(transferResult.transactions.length).toBe(4);

                expect(transferResult.transactions).toHaveTransaction({
                    from: owner.address,
                    to: nftItem.address,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_transfer, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeAddress(owner.address)
                        .storeBit(false)
                        .storeCoins(toNano(0.05))
                        .endCell(),
                    success: true,
                });

                // forward message
                expect(transferResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: owner.address,
                    body: beginCell().storeUint(NFTItemOpCodes.nftItem_excesses, 32).storeUint(0, 64).endCell(),
                    success: true,
                });

                // response message
                expect(transferResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.nftItem_ownershipAssigned, 32)
                        .storeUint(0, 64)
                        .storeAddress(owner.address)
                        .endCell(),
                    success: true,
                });

                ownerAddress = anyone.address;

                const transferTx = findTransactionRequired(transferResult.transactions, {
                    from: owner.address,
                    to: nftItem.address,
                    success: true,
                });

                printTxGasStats('NFT transfer', transferTx);
                await calculateFeesData(blockchain, nftItem, transferResult, initBalance);
            });

            it('NI-4.2: should reject if nft is not initialized', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                await nftItem.sendBurn(owner.getSender(), toNano(0.2), {
                    responseAddress: ccl.address,
                    crosschainTonAmount: 0.05,
                });
                isInit = false;
                ownerAddress = undefined;
                content = undefined;

                const transferResult = await nftItem.sendTransfer(owner.getSender(), toNano(0.1), {
                    newOwner: anyone.address,
                    responseAddress: owner.address,
                    forwardAmount: toNano(0.05),
                });

                printTransactionFees(transferResult.transactions);

                expect(transferResult.transactions.length).toBe(3);

                expect(transferResult.transactions).toHaveTransaction({
                    from: owner.address,
                    to: nftItem.address,
                    success: false,
                    exitCode: NFTItemErrors.notInitialized,
                });

                expect(transferResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: owner.address,
                    success: true,
                    inMessageBounced: true,
                });

                await calculateFeesData(blockchain, nftItem, transferResult, initBalance);
            });

            it('NI-4.3: should reject if sender is not owner', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                const transferResult = await nftItem.sendTransfer(anyone.getSender(), toNano(0.1), {
                    newOwner: anyone.address,
                    responseAddress: owner.address,
                    forwardAmount: toNano(0.05),
                });

                printTransactionFees(transferResult.transactions);

                expect(transferResult.transactions.length).toBe(3);

                expect(transferResult.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: nftItem.address,
                    success: false,
                    exitCode: NFTItemErrors.notFromOwner,
                });

                expect(transferResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: anyone.address,
                    success: true,
                    inMessageBounced: true,
                });

                await calculateFeesData(blockchain, nftItem, transferResult, initBalance);
            });

            it('NI-4.4: should reject if insufficient balance', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                const transferResult = await nftItem.sendTransfer(owner.getSender(), toNano(0.5), {
                    newOwner: anyone.address,
                    responseAddress: owner.address,
                    forwardAmount: toNano(1),
                });

                printTransactionFees(transferResult.transactions);

                expect(transferResult.transactions.length).toBe(3);

                expect(transferResult.transactions).toHaveTransaction({
                    from: owner.address,
                    to: nftItem.address,
                    success: false,
                    exitCode: NFTItemErrors.notEnoughGas,
                });

                expect(transferResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: owner.address,
                    success: true,
                    inMessageBounced: true,
                });

                await calculateFeesData(blockchain, nftItem, transferResult, initBalance);
            });
        });

        it('NI-5: should return static data', async () => {
            const initBalance = (await blockchain.getContract(nftItem.address)).balance;
            const staticDataResult = await nftItem.sendGetStaticData(owner.getSender(), toNano(0.1), {});

            printTransactionFees(staticDataResult.transactions);

            expect(staticDataResult.transactions.length).toBe(3);

            expect(staticDataResult.transactions).toHaveTransaction({
                from: owner.address,
                to: nftItem.address,
                body: beginCell().storeUint(NFTItemOpCodes.anyone_getStaticData, 32).storeUint(0, 64).endCell(),
                success: true,
            });

            expect(staticDataResult.transactions).toHaveTransaction({
                from: nftItem.address,
                to: owner.address,
                body: beginCell()
                    .storeUint(NFTItemOpCodes.nftItem_reportStaticData, 32)
                    .storeUint(0, 64)
                    .storeUint(0, 256)
                    .storeAddress(collection.address)
                    .endCell(),
                success: true,
            });

            await calculateFeesData(blockchain, nftItem, staticDataResult, initBalance);
        });

        describe('NI-6: error notification', () => {
            it('NI-6.1: should handle error notification', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                await nftItem.sendBurn(owner.getSender(), toNano(0.2), {
                    responseAddress: ccl.address,
                    crosschainTonAmount: 0.05,
                });

                const errorNotificationResult = await nftItem.sendErrorNotification(ccl.getSender(), toNano(0.1));

                printTransactionFees(errorNotificationResult.transactions);

                expect(errorNotificationResult.transactions.length).toBe(2);

                expect(errorNotificationResult.transactions).toHaveTransaction({
                    from: ccl.address,
                    to: nftItem.address,
                    body: beginCell().storeUint(NFTItemOpCodes.ccl_errorNotification, 32).storeUint(0, 64).endCell(),
                    success: true,
                });

                isInit = true;

                const errTx = findTransactionRequired(errorNotificationResult.transactions, {
                    from: ccl.address,
                    to: nftItem.address,
                    success: true,
                });

                printTxGasStats('NFT error notification', errTx);
                await calculateFeesData(blockchain, nftItem, errorNotificationResult, initBalance);
            });

            it('NI-6.2: should reject error notification from non CCL address', async () => {
                const initBalance = (await blockchain.getContract(nftItem.address)).balance;
                await nftItem.sendBurn(owner.getSender(), toNano(0.2), {
                    responseAddress: ccl.address,
                    crosschainTonAmount: 0.05,
                });

                const errorNotificationResult = await nftItem.sendErrorNotification(anyone.getSender(), toNano(0.1));

                printTransactionFees(errorNotificationResult.transactions);

                expect(errorNotificationResult.transactions.length).toBe(3);

                expect(errorNotificationResult.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: nftItem.address,
                    success: false,
                    exitCode: NFTItemErrors.notFromCCL,
                });

                expect(errorNotificationResult.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: anyone.address,
                    success: true,
                    inMessageBounced: true,
                });

                isInit = false;
                ownerAddress = undefined;
                content = undefined;
                await calculateFeesData(blockchain, nftItem, errorNotificationResult, initBalance);
            });
        });
    });

    describe('NI-7: get methods', () => {
        it('NI-7.1: get_nft_data', async () => {
            let nftDataResult = await nftItem.getNFTData();
            expect(nftDataResult.collectionAddress.equals(collection.address)).toBe(true);
            expect(nftDataResult.index).toBe(0);
            expect(nftDataResult.init).toBe(false);
            expect(nftDataResult.content?.hash().toString()).toBe(content?.hash().toString());
            expect(nftDataResult.ownerAddress).toBeNull();

            isInit = true;
            ownerAddress = owner.address;
            content = beginCell().endCell();
            await nftItem.sendInit(collection.getSender(), toNano(0.05), {
                ownerAddress,
                content,
            });
            nftDataResult = await nftItem.getNFTData();
            expect(nftDataResult.collectionAddress.equals(collection.address)).toBe(true);
            expect(nftDataResult.index).toBe(0);
            expect(nftDataResult.init).toBe(true);
            expect(nftDataResult.content?.hash().toString()).toBe(content?.hash().toString());
            expect(nftDataResult.ownerAddress?.equals(ownerAddress)).toBe(true);
        });
    });
});
