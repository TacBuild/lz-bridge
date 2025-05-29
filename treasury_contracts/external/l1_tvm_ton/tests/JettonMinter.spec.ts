import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, storeStateInit, toNano } from '@ton/core';
import '@ton/test-utils';
import { JettonMinter, JettonMinterConfig, JettonMinterErrors, JettonMinterOpCodes } from '../wrappers/JettonMinter';
import { JettonWallet, JettonWalletOpCodes } from '../wrappers/JettonWallet';
import { collectCellStats } from '../wrappers/utils/GasUtils';
import { findTransactionRequired } from '@ton/test-utils';
import { calculateFeesData, calculateMaxStorageState, printTxGasStats } from './utils';
import { CrossChainLayerOpCodes, OperationType } from '../wrappers/CrossChainLayer';
import { Params } from '../wrappers/Constants';
import { compile } from '@ton/blueprint';
import { JettonProxyErrors } from '../wrappers/JettonProxy';

describe('JettonMinter', () => {
    let jettonWalletCode: Cell;
    let jettonMinterCode: Cell;
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;
    let jettonMinter: SandboxContract<JettonMinter>;

    let jettonMinterConfig: JettonMinterConfig;
    let initialState: BlockchainSnapshot;

    let totalSupply: number;
    let adminAddress: Address;
    let newAdminAddress: Address | undefined;
    let content: Cell;
    let evmTokenAddress: string;

    const curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);

    async function checkFullData() {
        if ((await blockchain.getContract(jettonMinter.address)).accountState?.type === 'frozen') return;
        const data = await jettonMinter.getFullData();
        expect(data.totalSupply).toBe(totalSupply);
        expect(data.adminAddress.toString()).toBe(adminAddress.toString());
        expect(data.newAdminAddress?.toString()).toBe(newAdminAddress?.toString());
        expect(data.content.hash().toString()).toBe(content.hash().toString());
        expect(data.walletCode.hash().toString()).toBe(jettonWalletCode.hash().toString());
        expect(data.evmTokenAddress).toBe(evmTokenAddress);
    }

    function restoreConfig() {
        totalSupply = jettonMinterConfig.totalSupply;
        adminAddress = deployer.address;
        newAdminAddress = undefined;
        content = jettonMinterConfig.content;
        evmTokenAddress = jettonMinterConfig.evmTokenAddress;
    }

    beforeAll(async () => {
        jettonMinterCode = await compile('JettonMinter');

        blockchain = await Blockchain.create();
        blockchain.now = curTime();

        const jettonWalletCodeRaw = await compile('JettonWallet');
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${jettonWalletCodeRaw.hash().toString('hex')}`), jettonWalletCodeRaw);
        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();
        let lib_jetton_prep = beginCell().storeUint(2, 8).storeBuffer(jettonWalletCodeRaw.hash()).endCell();
        jettonWalletCode = new Cell({ exotic: true, bits: lib_jetton_prep.bits, refs: lib_jetton_prep.refs });

        deployer = await blockchain.treasury('deployer');
        anyone = await blockchain.treasury('anyone');

        jettonMinterConfig = {
            adminAddress: deployer.address,
            newAdminAddress: undefined,
            content: beginCell().endCell(),
            jettonWalletCode,
            evmTokenAddress: '0x1234',
            totalSupply: 0,
        };

        jettonMinter = blockchain.openContract(JettonMinter.createFromConfig(jettonMinterConfig, jettonMinterCode));

        const deployResult = await jettonMinter.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonMinter.address,
            deploy: true,
            success: true,
        });

        totalSupply = jettonMinterConfig.totalSupply;
        adminAddress = deployer.address;
        newAdminAddress = undefined;
        content = jettonMinterConfig.content;
        evmTokenAddress = jettonMinterConfig.evmTokenAddress;

        await checkFullData();

        initialState = blockchain.snapshot();
    });

    afterEach(async () => {
        await checkFullData();
        await blockchain.loadFrom(initialState);
        jettonMinter = blockchain.openContract(JettonMinter.createFromConfig(jettonMinterConfig, jettonMinterCode));
        restoreConfig();
    });

    describe('JM-1: storage gas stats', () => {
        it('JM-1.1: should collect stats for jetton minter', async () => {
            await calculateMaxStorageState(blockchain, 'Minter', jettonMinter.address);
        });

        it('JM-1.2: should collect stats for jetton wallet', async () => {
            const deployerWallet = blockchain.openContract(
                JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(deployer.address)),
            );
            const mintAmount = 1000;
            const res = await jettonMinter.sendMint(deployer.getSender(), toNano('1'), {
                to: deployer.address,
                jettonAmount: mintAmount,
                forwardTonAmount: 0.5,
                forwardPayload: beginCell().storeUint(0, 32).storeUint(1, 64).endCell(),
                newContent: null,
                queryId: 12345,
            });
            totalSupply += mintAmount;
            expect(res.transactions).toHaveTransaction({
                to: deployerWallet.address,
                op: JettonWalletOpCodes.InternalTransfer,
                success: true,
            });

            const smc = await blockchain.getContract(deployerWallet.address);
            if (smc.accountState === undefined) throw new Error("Can't access wallet account state");
            if (smc.accountState.type !== 'active') throw new Error('Wallet account is not active');
            if (smc.account.account === undefined || smc.account.account === null)
                throw new Error("Can't access wallet account!");
            console.log('Jetton wallet max storage stats:', smc.account.account.storageStats.used);
            const state = smc.accountState.state;
            const stateCell = beginCell().store(storeStateInit(state)).endCell();
            console.log('State init stats:', collectCellStats(stateCell, []));
        });
    });

    describe('JM-2: mint tokens', () => {
        it('JM-2.1: should reject request when sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendMint(anyone.getSender(), toNano('1'), {
                to: anyone.address,
                jettonAmount: 1000,
                responseAddress: anyone.address,
                forwardTonAmount: 0,
                forwardPayload: null,
                newContent: null,
            });

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonMinter.address,
                success: false,
                exitCode: JettonMinterErrors.notFromAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-2.2: should mint tokens without content change', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const deployerWallet = blockchain.openContract(
                JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(deployer.address)),
            );
            const mintAmount = 1000;
            const res = await jettonMinter.sendMint(deployer.getSender(), toNano('1'), {
                to: deployer.address,
                jettonAmount: mintAmount,
                responseAddress: deployer.address,
                forwardTonAmount: 0,
            });

            totalSupply += mintAmount;

            expect(res.transactions.length).toBe(4);
            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                success: true,
                body: JettonMinter.mintMessage(deployer.address, mintAmount, deployer.address, 0),
            });

            expect(await deployerWallet.getJettonBalance()).toBe(mintAmount);

            const mintTx = findTransactionRequired(res.transactions, {
                from: jettonMinter.address,
                to: deployerWallet.address,
                success: true,
            });
            printTxGasStats('Mint fee', mintTx);

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-2.3: should mint tokens with content change', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const deployerWallet = blockchain.openContract(
                JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(deployer.address)),
            );

            //TODO: store real content
            content = beginCell().storeUint(1234, 32).endCell();
            const mintAmount = 1000;
            const res = await jettonMinter.sendMint(deployer.getSender(), toNano('1'), {
                to: deployer.address,
                jettonAmount: mintAmount,
                responseAddress: deployer.address,
                forwardTonAmount: 0,
                forwardPayload: null,
                newContent: content,
            });
            totalSupply += mintAmount;

            expect(res.transactions.length).toBe(4);
            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                success: true,
                body: JettonMinter.mintMessage(deployer.address, mintAmount, deployer.address, 0, null, content, 0),
            });

            expect(await deployerWallet.getJettonBalance()).toBe(mintAmount);

            const mintTx = findTransactionRequired(res.transactions, {
                from: jettonMinter.address,
                to: deployerWallet.address,
                success: true,
            });
            printTxGasStats('Mint fee', mintTx);

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });
    });

    describe('JM-3: burn notification', () => {
        it('JM-3.1: should reject request when sender is not jetton wallet', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendBurnNotification(anyone.getSender(), toNano('1'), {
                from: anyone.address,
                jettonAmount: 100,
                responseAddress: anyone.address,
            });

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonMinter.address,
                success: false,
                exitCode: JettonMinterErrors.notFromJettonWallet,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-3.2: should handle burn notification and send excesses', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const deployerWallet = blockchain.openContract(
                JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(deployer.address)),
            );
            const mintAmount = 1000;
            await jettonMinter.sendMint(deployer.getSender(), toNano('1'), {
                to: deployer.address,
                jettonAmount: mintAmount,
                forwardTonAmount: 0,
                forwardPayload: null,
                newContent: null,
            });
            totalSupply += mintAmount;
            expect(await deployerWallet.getJettonBalance()).toBe(mintAmount);

            const burnJettonAmount = 100;
            const crossChainTonAmount = 1;
            const crossChainPayload = beginCell()
                .storeUint(2, 32)
                .storeUint(0, 64)
                .storeRef(beginCell().storeUint(2, 32).storeUint(0, 64).storeUint(0, 64).storeUint(0, 64).endCell())
                .endCell();

            const burnTonAmount = toNano('1') + toNano(crossChainTonAmount.toFixed(9));
            const result = await deployerWallet.sendBurn(deployer.getSender(), burnTonAmount, {
                jettonAmount: burnJettonAmount,
                receiverAddress: anyone.address.toString(),
                crossChainTonAmount,
                crossChainPayload,
            });
            totalSupply -= burnJettonAmount;
            expect(result.transactions.length).toBe(4);

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: deployerWallet.address,
                value: burnTonAmount,
                success: true,
            });

            const burnNotificationBody = beginCell()
                .storeUint(JettonWalletOpCodes.BurnNotification, 32)
                .storeUint(0, 64)
                .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                .storeAddress(deployer.address)
                .storeAddress(anyone.address)
                .storeMaybeRef(beginCell()
                            .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                            .storeMaybeRef(null)
                            .storeMaybeRef(crossChainPayload)
                            .endCell())
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: deployerWallet.address,
                to: jettonMinter.address,
                value: (x) => {
                    return x! <= burnTonAmount;
                },
                success: true,
                body: burnNotificationBody,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.excesses, 32)
                    .storeUint(0, 64)
                    .storeMaybeRef(crossChainPayload)
                    .endCell(),
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonMinter, result, initBalance);
        });

        it('JM-3.3: should handle burn notification and send forward payload to admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const deployerWallet = blockchain.openContract(
                JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(deployer.address)),
            );
            const mintAmount = 1000;
            await jettonMinter.sendMint(deployer.getSender(), toNano('1'), {
                to: deployer.address,
                jettonAmount: mintAmount,
                forwardTonAmount: 0,
                forwardPayload: null,
                newContent: null,
            });
            totalSupply += mintAmount;
            expect(await deployerWallet.getJettonBalance()).toBe(mintAmount);
            const crossChainTonAmount = 1;
            const crossChainPayload = beginCell()
                .storeUint(2, 32)
                .storeUint(0, 64)
                .storeRef(beginCell().storeUint(2, 32).storeUint(0, 64).storeUint(0, 64).storeUint(0, 64).endCell())
                .endCell();

            const burnTonAmount = toNano('1') + toNano(crossChainTonAmount.toFixed(9));
            const burnJettonAmount = 100;
            const result = await deployerWallet.sendBurn(deployer.getSender(), burnTonAmount, {
                jettonAmount: burnJettonAmount,
                receiverAddress: deployer.address.toString(),
                crossChainTonAmount,
                crossChainPayload,
            });
            totalSupply -= burnJettonAmount;
            expect(result.transactions.length).toBe(4);

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: deployerWallet.address,
                value: burnTonAmount,
                success: true,
            });

            const burnNotificationBody = beginCell()
                .storeUint(JettonWalletOpCodes.BurnNotification, 32)
                .storeUint(0, 64)
                .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                .storeAddress(deployer.address)
                .storeAddress(deployer.address)
                .storeMaybeRef(beginCell()
                            .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                            .storeMaybeRef(null)
                            .storeMaybeRef(crossChainPayload)
                            .endCell())
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: deployerWallet.address,
                to: jettonMinter.address,
                value: (x) => {
                    return x! <= burnTonAmount;
                },
                success: true,
                body: burnNotificationBody,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: deployer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                    .storeUint(0, 64)
                    .storeUint(OperationType.jettonBurn, 32)
                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                    .storeMaybeRef(null)
                    .storeAddress(deployer.address)
                    .storeAddress(deployer.address)
                    .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                    .storeMaybeRef(crossChainPayload)
                    .endCell(),
            });

            const burnNotificationTx = findTransactionRequired(result.transactions, {
                from: deployerWallet.address,
                to: jettonMinter.address,
                success: true,
                body: burnNotificationBody,
            });

            printTxGasStats('Burn Notification with forward payload', burnNotificationTx);

            await calculateFeesData(blockchain, jettonMinter, result, initBalance);
        });

        it('JM-3.4: should return tokens to user in case of minter fail', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const deployerWallet = blockchain.openContract(
                JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(deployer.address)),
            );
            const mintAmount = 1000;
            await jettonMinter.sendMint(deployer.getSender(), toNano(0.1), {
                to: deployer.address,
                jettonAmount: mintAmount,
                forwardTonAmount: 0,
                forwardPayload: null,
                newContent: null,
            });

            expect(await deployerWallet.getJettonBalance()).toBe(mintAmount);
            totalSupply += mintAmount;

            await jettonMinter.sendWithdrawExtraTon(deployer.getSender(), toNano(1));

            blockchain.now = curTime() + 20 * 365 * 24 * 3600; // 20 years passed

            const burnJettonAmount = 100;

            const result = await deployerWallet.sendBurn(deployer.getSender(), toNano(0.1), {
                jettonAmount: burnJettonAmount,
            });

            expect(result.transactions).toHaveTransaction({
                from: deployerWallet.address,
                to: jettonMinter.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.BurnNotification, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                    .storeAddress(deployer.address)
                    .storeAddress(deployer.address)
                    .storeMaybeRef(beginCell()
                                .storeCoins(0n)
                                .storeMaybeRef(null)
                                .storeMaybeRef(null)
                                .endCell())
                    .endCell(),
                success: false,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: deployerWallet.address,
                inMessageBounced: true,
                success: true,
            });

            expect(await deployerWallet.getJettonBalance()).toBe(mintAmount);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonMinter, result, initBalance);
        });
    });

    describe('JM-4: change admin', () => {
        it('JM-4.1: should reject request when sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendChangeAdmin(anyone.getSender(), toNano('1'), {
                newAdmin: anyone.address,
            });

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonMinter.address,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.changeAdmin, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                exitCode: JettonMinterErrors.notFromAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-4.1: should throw error if new_admin_address is none', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendChangeAdmin(deployer.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.changeAdmin, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                exitCode: JettonMinterErrors.newAdminAddressIsNone,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: deployer.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-4.2: should change admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendChangeAdmin(deployer.getSender(), toNano('1'), {
                newAdmin: anyone.address,
            });
            newAdminAddress = anyone.address;

            expect(res.transactions.length).toBe(2);

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.changeAdmin, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });
    });

    describe('JM-5: cancel changing admin', () => {
        beforeEach(async () => {
            await jettonMinter.sendChangeAdmin(deployer.getSender(), toNano('1'), {
                newAdmin: anyone.address,
            });
            newAdminAddress = anyone.address;
        });

        it('JM-5.1: should reject request when sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendCancelChangingAdmin(anyone.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonMinter.address,
                success: false,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.cancelChangingAdminAddress, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                exitCode: JettonMinterErrors.notFromAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-5.2: should cancel changing admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendCancelChangingAdmin(deployer.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(2);

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.cancelChangingAdminAddress, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
            });

            newAdminAddress = undefined;
            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });
    });

    describe('JM-6: confirm changing admin', () => {
        beforeEach(async () => {
            await jettonMinter.sendChangeAdmin(deployer.getSender(), toNano('1'), {
                newAdmin: anyone.address,
            });
            newAdminAddress = anyone.address;
        });

        it('JM-6.1: should reject request when sender is not new_admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendConfirmNewAdmin(deployer.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                success: false,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.confirmChangingAdminAddress, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                exitCode: JettonMinterErrors.notFromNewAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: deployer.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-6.2: should confirm changing admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendConfirmNewAdmin(anyone.getSender(), toNano('1'));

            expect(res.transactions.length).toBe(2);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonMinter.address,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.confirmChangingAdminAddress, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
            });

            adminAddress = newAdminAddress!;
            newAdminAddress = undefined;
            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });
    });

    describe('JM-7: change content', () => {
        it('JM-7.1: should reject request when sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendChangeContent(anyone.getSender(), toNano('1'), {
                content: beginCell().endCell(),
            });

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonMinter.address,
                success: false,
                exitCode: JettonMinterErrors.notFromAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-7.2: should change content', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            content = beginCell().storeUint(1234, 32).endCell();
            const res = await jettonMinter.sendChangeContent(deployer.getSender(), toNano('1'), {
                content,
            });

            expect(res.transactions.length).toBe(2);

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                success: true,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });
    });

    describe('JM-8: error notification', () => {
        it('JM-8.1: should reject notification when sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendErrorNotification(anyone.getSender(), toNano(0.1), {
                jettonAmount: 100,
                jettonOwnerAddress: anyone.address,
            });

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonMinter.address,
                success: false,
                exitCode: JettonMinterErrors.notFromAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-8.2: should mint tokens to user', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const jettonAmount = 100;
            const res = await jettonMinter.sendErrorNotification(deployer.getSender(), toNano(1), {
                jettonAmount,
                jettonOwnerAddress: anyone.address,
            });
            totalSupply += jettonAmount;
            expect(res.transactions.length).toBe(4);

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                success: true,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, 32)
                    .storeUint(0, 64)
                    .storeUint(OperationType.jettonBurn, 32)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .endCell(),
            });

            const anyoneWallet = blockchain.openContract(
                JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(anyone.address)),
            );

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyoneWallet.address,
                success: true,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.InternalTransfer, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(jettonMinter.address)
                    .storeAddress(anyone.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
            });

            expect(await anyoneWallet.getJettonBalance()).toBe(jettonAmount);

            expect(res.transactions).toHaveTransaction({
                from: anyoneWallet.address,
                to: anyone.address,
                success: true,
                value: (x) => x! > toNano(0.9),
            });

            const mintTx = findTransactionRequired(res.transactions, {
                from: deployer.address,
                to: jettonMinter.address,
            });
            printTxGasStats('Mint after error notification', mintTx);

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });
    });

    describe('JM-9: withdraw extra ton', () => {
        it('JM-9.1: should reject request when sender is not admin', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendWithdrawExtraTon(anyone.getSender(), toNano(0.1));

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonMinter.address,
                success: false,
                exitCode: JettonMinterErrors.notFromAdmin,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });

        it('JM-9.2: should withdraw extra TON on contract', async () => {
            const initBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const res = await jettonMinter.sendWithdrawExtraTon(deployer.getSender(), toNano(100));

            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: deployer.address,
                to: jettonMinter.address,
                body: beginCell().storeUint(JettonMinterOpCodes.withdrawExtraTon, 32).storeUint(0, 64).endCell(),
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: deployer.address,
                success: true,
                value: (x) => x! > toNano(99),
            });

            printTransactionFees(res.transactions);
            await calculateFeesData(blockchain, jettonMinter, res, initBalance);
        });
    });

    describe('JM-10: get methods', () => {});
});
