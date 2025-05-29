import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, beginCell, toNano } from '@ton/core';
import { NFTProxy, NFTProxyConfig, NFTProxyOpCodes, NFTProxyErrors } from '../wrappers/NFTProxy';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { calculateFeesData, calculateMaxStorageState, printTxGasStats } from './utils';
import { findTransactionRequired } from '@ton/test-utils';
import { OperationType } from '../wrappers/CrossChainLayer';

describe('NFTProxy Contract', () => {
    let code: Cell;
    let nftProxy: SandboxContract<NFTProxy>;
    let config: NFTProxyConfig;

    let adminAddress: Address;

    let admin: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let ccl: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;
    let nftItem: SandboxContract<TreasuryContract>;

    let blockchain: Blockchain;
    let initialState: BlockchainSnapshot;

    let tonProtocolFee = 0.1;
    let tacProtocolFee = 0.2;

    let tacExecutorFee = 0;
    let tonExecutorFee = 0;

    beforeAll(async () => {
        code = await compile('NFTProxy');
        blockchain = await Blockchain.create();

        admin = await blockchain.treasury('admin');
        adminAddress = admin.address;
        owner = await blockchain.treasury('owner');
        ccl = await blockchain.treasury('ccl');
        anyone = await blockchain.treasury('anyone');
        nftItem = await blockchain.treasury('nftItem');

        config = {
            adminAddress: admin.address,
            cclAddress: ccl.address,
        };

        nftProxy = blockchain.openContract(NFTProxy.createFromConfig(config, code));

        const deployResult = await nftProxy.sendDeploy(admin.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: nftProxy.address,
            deploy: true,
            success: true,
        });

        initialState = blockchain.snapshot();
    });

    async function checkFullData() {
        const data = await nftProxy.getFullData();
        expect(data.cclAddress.equals(ccl.address)).toBe(true);
        expect(data.adminAddress.equals(adminAddress)).toBe(true);
    }

    afterEach(async () => {
        await checkFullData();
        await blockchain.loadFrom(initialState);
        adminAddress = admin.address;
    });

    describe('NP-1: storage gas stats', () => {
        it('NP-1.1: collect storage stats for nft proxy', async () => {
            await calculateMaxStorageState(blockchain, 'NFT Proxy', nftProxy.address);
        });
    });

    describe('NP-2: EVM message to TVM proxy', () => {
        it('NP-2.1: should process EVM message when sent from CCL', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendEVMMsgToTVMProxy(ccl.getSender(), toNano('0.1'), {
                itemAddress: nftItem.address,
                newOwner: owner.address,
                forwardAmount: toNano('0.01'),
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: ccl.address,
                to: nftProxy.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.ccl_evmMsgToTVMProxy, 32)
                    .storeUint(0, 64)
                    .storeAddress(nftItem.address)
                    .storeAddress(owner.address)
                    .storeCoins(toNano('0.01'))
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: nftItem.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.nftItem_transfer, 32)
                    .storeUint(0, 64)
                    .storeAddress(owner.address)
                    .storeAddress(owner.address)
                    .storeBit(false)
                    .storeCoins(toNano('0.01'))
                    .storeBit(false)
                    .endCell(),
                success: true,
            });

            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });

        it('NP-2.2: should fail when sent not from CCL', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendEVMMsgToTVMProxy(anyone.getSender(), toNano('0.1'), {
                itemAddress: nftItem.address,
                newOwner: owner.address,
                forwardAmount: toNano('0.01'),
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: nftProxy.address,
                success: false,
                exitCode: NFTProxyErrors.notFromCrossChainLayer,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
            });

            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });
    });

    describe('NP-3: Error notification', () => {
        it('NP-3.1: should process error notification from CCL', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendErrorNotification(ccl.getSender(), toNano('0.1'), {
                operation: NFTProxyOpCodes.nftItem_transfer,
                itemAddress: nftItem.address,
                owner: owner.address,
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: ccl.address,
                to: nftProxy.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.ccl_errorNotification, 32)
                    .storeUint(0, 64)
                    .storeUint(NFTProxyOpCodes.nftItem_transfer, 32)
                    .storeAddress(nftItem.address)
                    .storeAddress(owner.address)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: nftItem.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.nftItem_transfer, 32)
                    .storeUint(0, 64)
                    .storeAddress(owner.address)
                    .storeAddress(owner.address)
                    .storeBit(false)
                    .storeCoins(0)
                    .storeBit(false)
                    .endCell(),
                success: true,
            });

            const errTx = findTransactionRequired(result.transactions, {
                from: ccl.address,
                to: nftProxy.address,
                success: true,
            });

            printTxGasStats('NFT proxy error notification', errTx);
            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });

        it('NP-3.2: should fail error notification when sent not from CCL', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendErrorNotification(anyone.getSender(), toNano('0.1'), {
                operation: NFTProxyOpCodes.nftItem_transfer,
                itemAddress: nftItem.address,
                owner: owner.address,
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: nftProxy.address,
                success: false,
                exitCode: NFTProxyErrors.notFromCrossChainLayer,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
            });

            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });
    });

    describe('NP-4: Ownership assigned', () => {
        it('NP-4.1: should process ownership assigned message', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const feeData = beginCell()
                .storeUint(1, 1)
                .storeCoins(toNano((tacProtocolFee + tonProtocolFee).toFixed(9)))
                .storeCoins(toNano(tacExecutorFee.toFixed(9)))
                .storeCoins(toNano(tonExecutorFee.toFixed(9)))
                .endCell();

            const evmData = beginCell().endCell();

            const result = await nftProxy.sendOwnershipAssigned(nftItem.getSender(), toNano('1'), {
                itemOwner: owner.address,
                crosschainTonAmount: toNano('0.01'),
                evmData,
                feeData,
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: nftItem.address,
                to: nftProxy.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.nftItem_ownershipAssigned, 32)
                    .storeUint(0, 64)
                    .storeAddress(owner.address)
                    .storeMaybeRef(beginCell()
                                .storeCoins(toNano('0.01'))
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: ccl.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.ccl_tvmMsgToEVM, 32)
                    .storeUint(0, 64)
                    .storeUint(OperationType.nftTransfer, 32)
                    .storeCoins(toNano('0.01'))
                    .storeMaybeRef(feeData)
                    .storeAddress(owner.address)
                    .storeAddress(nftItem.address)
                    .storeAddress(owner.address)
                    .storeRef(evmData)
                    .endCell(),
                success: true,
            });

            const transferTx = findTransactionRequired(result.transactions, {
                from: nftItem.address,
                to: nftProxy.address,
                success: true,
            });

            printTxGasStats('NFT proxy ownership assigned', transferTx);
            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });

        it('NP-4.2: should fail when message without EVM data', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendOwnershipAssigned(nftItem.getSender(), toNano('0.2'), {
                itemOwner: owner.address,
                crosschainTonAmount: toNano('0.01'),
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: nftItem.address,
                to: nftProxy.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.nftItem_ownershipAssigned, 32)
                    .storeUint(0, 64)
                    .storeAddress(owner.address)
                    .storeMaybeRef(beginCell()
                                .storeCoins(toNano('0.01'))
                                .storeMaybeRef(null)
                                .storeMaybeRef(null)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: NFTProxyErrors.invalidPayload,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: nftItem.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.nftItem_transfer, 32)
                    .storeUint(0, 64)
                    .storeAddress(owner.address)
                    .storeAddress(owner.address)
                    .storeBit(false)
                    .storeCoins(0)
                    .storeBit(false)
                    .endCell(),
                success: true,
            });

            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });

        it('NP-4.3: should fail when not enough TON is sent', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendOwnershipAssigned(nftItem.getSender(), toNano('0.1'), {
                itemOwner: owner.address,
                crosschainTonAmount: toNano('1'),
                evmData: beginCell().endCell(),
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: nftItem.address,
                to: nftProxy.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.nftItem_ownershipAssigned, 32)
                    .storeUint(0, 64)
                    .storeAddress(owner.address)
                    .storeMaybeRef(beginCell()
                                .storeCoins(toNano('1'))
                                .storeMaybeRef(null)
                                .storeMaybeRef(beginCell().endCell())
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: NFTProxyErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: nftItem.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.nftItem_transfer, 32)
                    .storeUint(0, 64)
                    .storeAddress(owner.address)
                    .storeAddress(owner.address)
                    .storeBit(false)
                    .storeCoins(0)
                    .storeBit(false)
                    .endCell(),
                success: true,
            });

            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });
    });

    describe('NP-5: Change admin', () => {
        it('NP-5.1: should change admin', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendChangeAdmin(admin.getSender(), toNano('0.1'), {
                adminAddress: owner.address.toString(),
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: nftProxy.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.admin_changeAdmin, 32)
                    .storeUint(0, 64)
                    .storeAddress(owner.address)
                    .endCell(),
                success: true,
            });

            adminAddress = owner.address;
            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });

        it('NP-5.2: should fail when not from admin', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendChangeAdmin(anyone.getSender(), toNano('0.1'), {
                adminAddress: owner.address.toString(),
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: nftProxy.address,
                success: false,
                exitCode: NFTProxyErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
            });

            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });
    });

    describe('NP-6: Update code', () => {
        it('NP-6.1: should update code', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const newCode = await compile('NFTProxyForUpdateCodeTest');

            const result = await nftProxy.sendUpdateCode(admin.getSender(), toNano('0.1'), {
                code: newCode,
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: nftProxy.address,
                body: beginCell()
                    .storeUint(NFTProxyOpCodes.admin_updateCode, 32)
                    .storeUint(0, 64)
                    .storeRef(newCode)
                    .endCell(),
                success: true,
            });

            const contract = await blockchain.getContract(nftProxy.address);
            // @ts-ignore
            expect(contract.accountState?.state.code.equals(newCode)).toBe(true);
            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });

        it('NP-6.2: should fail when not from admin', async () => {
            const initBalance = (await blockchain.getContract(nftProxy.address)).balance;
            const result = await nftProxy.sendUpdateCode(anyone.getSender(), toNano('0.1'), {
                code: beginCell().endCell(),
            });

            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: nftProxy.address,
                success: false,
                exitCode: NFTProxyErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
            });

            await calculateFeesData(blockchain, nftProxy, result, initBalance);
        });
    });

    describe('NP-7: get methods', () => {
        it('NP-7.1: get_full_data', async () => {
            const result = await nftProxy.getFullData();
            expect(result.adminAddress.equals(adminAddress)).toBe(true);
            expect(result.cclAddress.equals(ccl.address)).toBe(true);
        });
    });
});
