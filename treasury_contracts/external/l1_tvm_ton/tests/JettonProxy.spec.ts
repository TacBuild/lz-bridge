import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { JettonProxy, jettonProxyConfigToCell, JettonProxyErrors, JettonProxyOpCodes } from '../wrappers/JettonProxy';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { OperationType } from '../wrappers/CrossChainLayer';
import { calculateFeesData, calculateMaxStorageState, printTxGasStats } from './utils';
import { storageGeneric } from '../wrappers/utils/GasUtils';
import { findTransactionRequired } from '@ton/test-utils';
import { JettonWalletErrors } from '../wrappers/JettonWallet';
import { Params } from '../wrappers/Constants';

describe('JettonProxy', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let anyone: SandboxContract<TreasuryContract>;
    let crossChainLayer: SandboxContract<TreasuryContract>;
    let admin: SandboxContract<TreasuryContract>;
    let jettonProxy: SandboxContract<JettonProxy>;

    let tonProtocolFee = 0.1;
    let tacProtocolFee = 0.2;

    let tacExecutorFee = 0;
    let tonExecutorFee = 0;

    let adminAddress: string;
    let crossChainLayerAddress: string;
    let newAdminAddress: string | undefined;

    let initState: BlockchainSnapshot;

    async function checkFullData() {
        if ((await blockchain.getContract(jettonProxy.address)).accountState?.type === 'frozen') return;
        const data = await jettonProxy.getFullData();
        expect(data.crossChainLayerAddress).toBe(crossChainLayerAddress);
        expect(data.adminAddress.toString()).toBe(adminAddress);
        expect(data.newAdminAddress).toBe(newAdminAddress);
    }

    beforeAll(async () => {
        code = await compile('JettonProxy');

        blockchain = await Blockchain.create();

        crossChainLayer = await blockchain.treasury('crossChainLayer');
        admin = await blockchain.treasury('admin');

        adminAddress = admin.address.toString();
        crossChainLayerAddress = crossChainLayer.address.toString();
        newAdminAddress = undefined;

        jettonProxy = blockchain.openContract(
            JettonProxy.createFromConfig(
                {
                    crossChainLayerAddress: crossChainLayer.address.toString(),
                    adminAddress: admin.address.toString(),
                },
                code,
            ),
        );

        anyone = await blockchain.treasury('anyone');

        const deployResult = await jettonProxy.sendDeploy(anyone.getSender(), toNano('0.005'));

        await checkFullData();

        expect(deployResult.transactions).toHaveTransaction({
            from: anyone.address,
            to: jettonProxy.address,
            deploy: true,
            success: true,
        });

        initState = blockchain.snapshot();
    });

    afterEach(async () => {
        await checkFullData();

        await blockchain.loadFrom(initState);

        adminAddress = admin.address.toString();
        crossChainLayerAddress = crossChainLayer.address.toString();
        newAdminAddress = undefined;
    });

    describe('JP-1: storage gas stats', () => {
        it('JP-1.1: should collect stats for jetton proxy', async () => {
            await calculateMaxStorageState(blockchain, 'JettonProxy', jettonProxy.address);
        });

        it('JP-1.2: storage estimates', async () => {
            let timeSpan = 365 * 24 * 3600;
            const expTime = Math.floor(Date.now() / 1000) + timeSpan;
            blockchain.now = expTime - 10;

            const tonAmount = 0.01;
            const receivedJettonAmount = 0;
            const depositorAddress = anyone.address.toString();
            const evmData = beginCell().storeUint(12345, 32).endCell();
            const result = await jettonProxy.sendTransferNotification(
                anyone.getSender(),
                toNano(tonAmount.toFixed(9)),
                {
                    receivedJettonAmount,
                    depositorAddress,
                    evmData,
                },
            );

            const storagePhase = storageGeneric(result.transactions[1]);
            const actualStorage = storagePhase?.storageFeesCollected;
            console.log('Storage estimates:', Number(actualStorage) / 10 ** 9, ' TON');
        });
    });

    describe('JP-2: transfer notification', () => {
        it('JP-2.1: should do nothing if zero jetton is received', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const tonAmount = 0.01;
            const receivedJettonAmount = 0;
            const depositorAddress = anyone.address.toString();
            const evmData = beginCell().storeUint(12345, 32).endCell();
            const result = await jettonProxy.sendTransferNotification(
                anyone.getSender(),
                toNano(tonAmount.toFixed(9)),
                {
                    receivedJettonAmount,
                    depositorAddress,
                    evmData,
                },
            );

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0n)
                                .storeMaybeRef(null)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-2.2: should revert jetton if there is not payload', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const tonAmount = 0.2; //TODO: calc
            const receivedJettonAmount = 100;
            const depositorAddress = anyone.address.toString();
            const result = await jettonProxy.sendTransferNotification(
                anyone.getSender(),
                toNano(tonAmount.toFixed(9)),
                {
                    receivedJettonAmount,
                    depositorAddress,
                },
            );

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0n)
                                .storeMaybeRef(null)
                                .storeMaybeRef(null)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.invalidPayload,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transfer, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeUint(0, 1)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-2.3: should revert jetton if there is not enough ton (big crosschain_ton_amount)', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const tonAmount = 10;
            const receivedJettonAmount = 100;
            const crossChainTonAmount = 100;
            const depositorAddress = anyone.address.toString();
            const result = await jettonProxy.sendTransferNotification(
                anyone.getSender(),
                toNano(tonAmount.toFixed(9)),
                {
                    receivedJettonAmount,
                    depositorAddress,
                    crossChainTonAmount,
                },
            );

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeMaybeRef(beginCell()
                                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                .storeMaybeRef(null)
                                .storeMaybeRef(null)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transfer, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeUint(0, 1)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-2.4: should revert jetton if there is not enough ton (big fee_data amount)', async () => {
            tacProtocolFee = 0.3;
            tonProtocolFee = 0.3;
            tacExecutorFee = 0.2;
            tonExecutorFee = 0.2;
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const tonAmount = 10;
            const receivedJettonAmount = 100;
            const crossChainTonAmount = 9;
            const feeData = beginCell()
                            .storeUint(1, 1)
                            .storeCoins(toNano((tacProtocolFee + tonProtocolFee).toFixed(9)))
                            .storeCoins(toNano(tacExecutorFee.toFixed(9)))
                            .storeCoins(toNano(tonExecutorFee.toFixed(9)))
                            .endCell();

            const depositorAddress = anyone.address.toString();
            const result = await jettonProxy.sendTransferNotification(
                anyone.getSender(),
                toNano(tonAmount.toFixed(9)),
                {
                    receivedJettonAmount,
                    depositorAddress,
                    crossChainTonAmount,
                    feeData,
                },
            );

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeMaybeRef(beginCell()
                                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(null)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transfer, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeAddress(Address.parse(depositorAddress))
                    .storeUint(0, 1)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-2.5: should send msg to crossChainLayer with fee data', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const receivedJettonAmount = 100;
            const depositorAddress = anyone.address.toString();
            const crossChainTonAmount = 100;
            const feeData = beginCell()
                            .storeUint(1, 1)
                            .storeCoins(toNano((tacProtocolFee + tonProtocolFee).toFixed(9)))
                            .storeCoins(toNano(tacExecutorFee.toFixed(9)))
                            .storeCoins(toNano(tonExecutorFee.toFixed(9)))
                            .endCell();

            const evmData = beginCell().storeUint(12345, 32).endCell();

            const tonAmount = 0.2 + crossChainTonAmount + tacProtocolFee + tacProtocolFee + tacExecutorFee + tonExecutorFee;
            const result = await jettonProxy.sendTransferNotification(
                anyone.getSender(),
                toNano(tonAmount.toFixed(9)),
                {
                    receivedJettonAmount,
                    depositorAddress,
                    crossChainTonAmount,
                    feeData,
                    evmData,
                },
            );

            expect(result.transactions.length).toBe(3);

            const transferNotificationBody = beginCell()
                .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, 32)
                .storeUint(0, 64)
                .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                .storeAddress(Address.parse(depositorAddress))
                .storeMaybeRef(beginCell()
                            .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                            .storeMaybeRef(feeData)
                            .storeMaybeRef(evmData)
                            .endCell())
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: transferNotificationBody,
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.anyone_tvmMsgToEVM, 32)
                    .storeUint(0, 64)
                    .storeUint(OperationType.jettonTransfer, 32)
                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                    .storeMaybeRef(feeData)
                    .storeAddress(Address.parse(depositorAddress))
                    .storeAddress(anyone.address)
                    .storeAddress(Address.parse(depositorAddress))
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeRef(evmData)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            const transferNotificationTx = findTransactionRequired(result.transactions, {
                from: anyone.address,
                to: jettonProxy.address,
                success: true,
                body: transferNotificationBody,
                exitCode: JettonWalletErrors.noErrors,
            });
            printTxGasStats('Transfer Notification', transferNotificationTx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });
    });

    describe('JP-3: error notification', () => {
        it('JP-3.1: should throw error if sender is not crossChainLayer', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const receivedJettonAmount = 10;
            const jettonWalletAddress = anyone.address.toString();
            const ownerAddress = anyone.address.toString();
            const result = await jettonProxy.sendErrorNotification(anyone.getSender(), toNano('0.1'), {
                jettonWalletAddress,
                ownerAddress,
                receivedJettonAmount,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.crossChainLayerAddress_errorNotification, 32)
                    .storeUint(0, 64)
                    .storeUint(OperationType.jettonTransfer, 32)
                    .storeAddress(Address.parse(jettonWalletAddress))
                    .storeAddress(Address.parse(ownerAddress))
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .endCell(),
                success: false,
                exitCode: JettonProxyErrors.notFromCrossChainLayer,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: anyone.address,
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-3.2: should send jetton', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const receivedJettonAmount = 10;
            const jettonWalletAddress = anyone.address.toString();
            const ownerAddress = anyone.address.toString();
            const result = await jettonProxy.sendErrorNotification(crossChainLayer.getSender(), toNano('0.1'), {
                jettonWalletAddress,
                ownerAddress,
                receivedJettonAmount,
            });

            expect(result.transactions.length).toBe(3);

            const errorNotificationBody = beginCell()
                .storeUint(JettonProxyOpCodes.crossChainLayerAddress_errorNotification, 32)
                .storeUint(0, 64)
                .storeUint(OperationType.jettonTransfer, 32)
                .storeAddress(Address.parse(jettonWalletAddress))
                .storeAddress(Address.parse(ownerAddress))
                .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonProxy.address,
                body: errorNotificationBody,
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: Address.parse(jettonWalletAddress),
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transfer, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(receivedJettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(ownerAddress))
                    .storeAddress(Address.parse(ownerAddress))
                    .storeUint(0, 1)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            const errorNotificationTx = findTransactionRequired(result.transactions, {
                from: crossChainLayer.address,
                to: jettonProxy.address,
                success: true,
                body: errorNotificationBody,
                exitCode: JettonWalletErrors.noErrors,
            });
            printTxGasStats('Error Notification', errorNotificationTx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });
    });

    describe('JP-4: proxy', () => {
        it('JP-4.1: should throw error if sender is not crossChainLayer', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const jettonWalletAddress = anyone.address.toString();
            const toOwnerAddress = anyone.address.toString();
            const jettonAmount = 10;
            const responseAddress = anyone.address.toString();
            const result = await jettonProxy.sendProxy(anyone.getSender(), toNano('0.1'), {
                jettonWalletAddress,
                toOwnerAddress,
                jettonAmount,
                responseAddress,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.crossChainLayerAddress_evmMsgToTVMproxy, 32)
                    .storeUint(0, 64)
                    .storeAddress(Address.parse(jettonWalletAddress))
                    .storeAddress(Address.parse(toOwnerAddress))
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(responseAddress))
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                success: false,
                exitCode: JettonProxyErrors.notFromCrossChainLayer,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: anyone.address,
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-4.2: should send jetton', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const jettonWalletAddress = anyone.address.toString();
            const toOwnerAddress = anyone.address.toString();
            const jettonAmount = 10;
            const responseAddress = anyone.address.toString();
            const result = await jettonProxy.sendProxy(crossChainLayer.getSender(), toNano('0.1'), {
                jettonWalletAddress,
                toOwnerAddress,
                jettonAmount,
                responseAddress,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.crossChainLayerAddress_evmMsgToTVMproxy, 32)
                    .storeUint(0, 64)
                    .storeAddress(Address.parse(jettonWalletAddress))
                    .storeAddress(Address.parse(toOwnerAddress))
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(responseAddress))
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: Address.parse(jettonWalletAddress),
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transfer, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(toOwnerAddress))
                    .storeAddress(Address.parse(responseAddress))
                    .storeUint(0, 1)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-4.3: should send jetton with non-empty payload', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const jettonWalletAddress = anyone.address.toString();
            const toOwnerAddress = anyone.address.toString();
            const jettonAmount = 10;
            const responseAddress = anyone.address.toString();
            const forwardTonAmount = 0.1;
            const forwardPayload = beginCell().storeUint(12345, 32).endCell();
            const result = await jettonProxy.sendProxy(crossChainLayer.getSender(), toNano('0.1'), {
                jettonWalletAddress,
                toOwnerAddress,
                jettonAmount,
                responseAddress,
                forwardTonAmount,
                forwardPayload,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.crossChainLayerAddress_evmMsgToTVMproxy, 32)
                    .storeUint(0, 64)
                    .storeAddress(Address.parse(jettonWalletAddress))
                    .storeAddress(Address.parse(toOwnerAddress))
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(responseAddress))
                    .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                    .storeMaybeRef(forwardPayload)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: Address.parse(jettonWalletAddress),
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.jettonWallet_transfer, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(Address.parse(toOwnerAddress))
                    .storeAddress(Address.parse(responseAddress))
                    .storeUint(0, 1)
                    .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                    .storeMaybeRef(forwardPayload)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });
    });

    describe('JP-5: change admin', () => {
        it('JP-5.1: should throw error if sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const result = await jettonProxy.sendChangeAdmin(anyone.getSender(), toNano('0.1'), {
                adminAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.admin_changeAdminAddress, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                inMessageBounceable: true,
                exitCode: JettonProxyErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-5.1: should throw error if new_admin_address is none', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const result = await jettonProxy.sendChangeAdmin(admin.getSender(), toNano('0.1'));

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.admin_changeAdminAddress, 32)
                    .storeUint(0, 64)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                inMessageBounceable: true,
                exitCode: JettonProxyErrors.newAdminAddressIsNone,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: admin.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-5.3: should save new_admin address', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const result = await jettonProxy.sendChangeAdmin(admin.getSender(), toNano('0.1'), {
                adminAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.admin_changeAdminAddress, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            newAdminAddress = anyone.address.toString();

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });
    });

    describe('JP-6: cancel changing admin', () => {
        beforeEach(async () => {
            await jettonProxy.sendChangeAdmin(admin.getSender(), toNano('1'), {
                adminAddress: anyone.address.toString(),
            });
            newAdminAddress = anyone.address.toString();
        });

        it('JP-6.1: should reject request when sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const res = await jettonProxy.sendCancelChangingAdmin(anyone.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                success: false,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.admin_cancelChangingAdminAddress, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                exitCode: JettonProxyErrors.notFromAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonProxy, res, initBalance);
        });

        it('JP-6.2: should cancel changing admin', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const res = await jettonProxy.sendCancelChangingAdmin(admin.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(2);

            expect(res.transactions).toHaveTransaction({
                from: admin.address,
                to: jettonProxy.address,
                success: true,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.admin_cancelChangingAdminAddress, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                exitCode: JettonProxyErrors.noErrors,
            });

            newAdminAddress = undefined;

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonProxy, res, initBalance);
        });
    });

    describe('JP-7: confirm changing admin', () => {
        beforeEach(async () => {
            await jettonProxy.sendChangeAdmin(admin.getSender(), toNano('1'), {
                adminAddress: anyone.address.toString(),
            });
            newAdminAddress = anyone.address.toString();
        });

        it('JP-7.1: should reject request when sender is not new_admin', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const res = await jettonProxy.sendConfirmNewAdmin(admin.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: admin.address,
                to: jettonProxy.address,
                success: false,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.newAdmin_confirmChangingAdminAddress, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                exitCode: JettonProxyErrors.notFromNewAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: admin.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonProxy, res, initBalance);
        });

        it('JP-7.2: should confirm changing admin', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            const res = await jettonProxy.sendConfirmNewAdmin(anyone.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(2);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.newAdmin_confirmChangingAdminAddress, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            adminAddress = newAdminAddress!;
            newAdminAddress = undefined;

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonProxy, res, initBalance);
        });
    });

    describe('JP-8: update code', () => {
        it('JP-8.1: should throw error if sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            let info = await blockchain.getContract(jettonProxy.address);
            expect(info.accountState!.type).toBe('active');
            let jettonProxyCode = info.accountState!.type === 'active' ? info.accountState!.state!.code! : null;
            expect(jettonProxyCode!.hash().toString()).toBe(code.hash().toString());

            const newCode = await compile('JettonProxyForUpdateCodeTest');
            const newData = jettonProxyConfigToCell({
                adminAddress,
                newAdminAddress,
                crossChainLayerAddress,
            });
            const result = await jettonProxy.sendUpdateCode(anyone.getSender(), toNano('0.1'), {
                code: newCode,
                data: newData,
            });

            info = await blockchain.getContract(jettonProxy.address);
            expect(info.accountState!.type).toBe('active');
            jettonProxyCode = info.accountState!.type === 'active' ? info.accountState!.state!.code! : null;
            expect(jettonProxyCode!.hash().toString()).toBe(code.hash().toString());

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.admin_updateCode, 32)
                    .storeUint(0, 64)
                    .storeRef(newCode)
                    .storeRef(newData)
                    .endCell(),
                success: false,
                inMessageBounceable: true,
                exitCode: JettonProxyErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });

        it('JP-8.2: should set new code', async () => {
            const initBalance = (await blockchain.getContract(jettonProxy.address)).balance;

            let info = await blockchain.getContract(jettonProxy.address);
            expect(info.accountState!.type).toBe('active');
            let jettonProxyCode = info.accountState!.type === 'active' ? info.accountState!.state!.code! : null;
            expect(jettonProxyCode!.hash().toString()).toBe(code.hash().toString());

            const newCode = await compile('JettonProxyForUpdateCodeTest');
            const newData = jettonProxyConfigToCell({
                adminAddress,
                newAdminAddress,
                crossChainLayerAddress,
            });
            const result = await jettonProxy.sendUpdateCode(admin.getSender(), toNano('0.1'), {
                code: newCode,
                data: newData,
            });

            info = await blockchain.getContract(jettonProxy.address);
            expect(info.accountState!.type).toBe('active');
            jettonProxyCode = info.accountState!.type === 'active' ? info.accountState!.state!.code! : null;
            expect(jettonProxyCode!.hash().toString()).toBe(newCode.hash().toString());

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(JettonProxyOpCodes.admin_updateCode, 32)
                    .storeUint(0, 64)
                    .storeRef(newCode)
                    .storeRef(newData)
                    .endCell(),
                success: true,
                inMessageBounceable: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonProxy, result, initBalance);
        });
    });

    describe('JP-9: get methods', () => {
        it('JP-9.1: : get_full_data', async () => {
            const data = await jettonProxy.getFullData();
            console.log(data);
            expect(data.crossChainLayerAddress).toBe(crossChainLayerAddress);
            expect(data.adminAddress).toBe(adminAddress);
            expect(data.newAdminAddress).toBe(newAdminAddress);
        });
    });
});
