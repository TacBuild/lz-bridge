import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, storeStateInit, toNano } from '@ton/core';
import { JettonWallet, JettonWalletConfig, JettonWalletErrors, JettonWalletOpCodes } from '../wrappers/JettonWallet';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { findTransactionRequired } from '@ton/test-utils';
import { calcStorageFee, collectCellStats, getStoragePrices } from '../wrappers/utils/GasUtils';
import { calculateFeesData, printTxGasStats } from './utils';

describe('JettonWallet - Not Library', () => {
    let code: Cell;
    let jettonMaster: SandboxContract<TreasuryContract>;
    let jettonWallet: SandboxContract<JettonWallet>;
    let owner: SandboxContract<TreasuryContract>;
    let blockchain: Blockchain;
    let initialState: BlockchainSnapshot;

    let balance: number;
    let newJettonAmount: number;
    let jettonWalletConfig: JettonWalletConfig;

    async function checkFullData() {
        if ((await blockchain.getContract(jettonWallet.address)).accountState?.type === 'frozen') return;
        const data = await jettonWallet.getWalletData();
        expect(data.balance).toBe(balance);
        expect(data.ownerAddress.toString()).toBe(owner.address.toString());
        expect(data.jettonMasterAddress.toString()).toBe(jettonMaster.address.toString());
        expect(data.jettonWalletCode.hash().toString()).toBe(code.hash().toString());
    }

    beforeAll(async () => {
        code = await compile('JettonWallet');
        blockchain = await Blockchain.create();

        balance = 0;
        jettonMaster = await blockchain.treasury('jettonMaster');
        owner = await blockchain.treasury('owner');

        jettonWalletConfig = {
            balance: 0,
            jettonMasterAddress: jettonMaster.address.toString(),
            ownerAddress: owner.address.toString(),
        };

        jettonWallet = blockchain.openContract(JettonWallet.createFromConfig(jettonWalletConfig, code));

        const deployer = await blockchain.treasury('deployer');

        const deployResult = await jettonWallet.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: jettonWallet.address,
            deploy: true,
        });

        await checkFullData();

        newJettonAmount = 100;
        await jettonWallet.sendReceive(jettonMaster.getSender(), toNano('0.01'), { jettonAmount: newJettonAmount });
        balance += newJettonAmount;
        await checkFullData();

        initialState = blockchain.snapshot();
    });

    afterEach(async () => {
        await checkFullData();
        await blockchain.loadFrom(initialState);
        jettonWallet = blockchain.openContract(JettonWallet.createFromConfig(jettonWalletConfig, code));
        balance = newJettonAmount;
    });

    describe('JW-1: storage gas stats', () => {
        it('JW-1.1: should collect stats for jetton wallet', async () => {
            const smc = await blockchain.getContract(jettonWallet.address);
            if (smc.accountState === undefined) throw new Error("Can't access wallet account state");
            if (smc.accountState.type !== 'active') throw new Error('Wallet account is not active');
            if (smc.account.account === undefined || smc.account.account === null)
                throw new Error("Can't access wallet account!");
            console.log('Jetton wallet max storage stats (not library):', smc.account.account.storageStats.used);
            const state = smc.accountState.state;
            const stateCell = beginCell().store(storeStateInit(state)).endCell();
            console.log('jettonWallet State init stats (not library):', collectCellStats(stateCell, []));
        });
    });

    describe('JW-2: return ton', () => {
        it('JW-2.1: should return ton', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const anyone = await blockchain.treasury('anyone');
            const tonAmount = toNano('0.05');
            const result = await jettonWallet.sendReturnTon(anyone.getSender(), tonAmount);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonWallet.address,
                value: (x) => {
                    return x! <= tonAmount;
                },
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonWallet.address,
                to: owner.address,
                success: true,
            });
            const storagePrices = getStoragePrices(blockchain.config);
            const storageDuration = 5 * 365 * 24 * 3600;
            const minTonsForJettonWalletStorage = calcStorageFee(
                storagePrices,
                JettonWallet.storageStats,
                BigInt(storageDuration),
            );

            expect((await blockchain.getContract(jettonWallet.address)).balance).toBe(minTonsForJettonWalletStorage);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });
    });

    describe('JW-3: burn', () => {
        it('JW-3.1: should throw error when not enough ton', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const tonAmount = toNano('0.005');
            const result = await jettonWallet.sendBurn(owner.getSender(), tonAmount, { jettonAmount: 100 });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: false,
                exitCode: JettonWalletErrors.notEnoughGas,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonWallet.address,
                to: owner.address,
                value: (x) => {
                    return x! <= tonAmount;
                },
                success: true,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });

        it('JW-3.2: should throw error when not enough ton (big crosschain ton amount)', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const tonAmount = toNano('10');
            const result = await jettonWallet.sendBurn(owner.getSender(), tonAmount, {
                jettonAmount: balance,
                crossChainTonAmount: 100,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: false,
                exitCode: JettonWalletErrors.notEnoughGas,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonWallet.address,
                to: owner.address,
                value: (x) => {
                    return x! <= tonAmount;
                },
                success: true,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });

        it('JW-3.3: should throw error when not enough jettons', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const tonAmount = toNano('1');
            const burnJettonAmount = balance + 100;
            const result = await jettonWallet.sendBurn(owner.getSender(), tonAmount, {
                jettonAmount: burnJettonAmount,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: false,
                exitCode: JettonWalletErrors.insufficientJettonBalance,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonWallet.address,
                to: owner.address,
                value: (x) => {
                    return x! <= tonAmount;
                },
                success: true,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });

        it('JW-3.4: should throw error when sender is not owner', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const anyone = await blockchain.treasury('anyone');
            const tonAmount = toNano('1');
            const result = await jettonWallet.sendBurn(anyone.getSender(), tonAmount, { jettonAmount: balance });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: false,
                exitCode: JettonWalletErrors.notFromOwner,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonWallet.address,
                to: anyone.address,
                value: (x) => {
                    return x! <= tonAmount;
                },
                success: true,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });

        it('JW-3.5: should decrease balance', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const assertBurn = async (
                receiverAddress?: Address,
                crossChainTonAmount?: number,
                crossChainPayload?: Cell,
            ) => {
                const tonAmount = toNano('0.3') + toNano(crossChainTonAmount?.toFixed(9) ?? 0);
                    const result = await jettonWallet.sendBurn(owner.getSender(), tonAmount, {
                    jettonAmount: balance,
                    receiverAddress: receiverAddress?.toString(),
                    crossChainTonAmount,
                    crossChainPayload,
                });

                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: owner.address,
                    to: jettonWallet.address,
                    value: tonAmount,
                    success: true,
                });

                const burnNotificationBody = beginCell()
                    .storeUint(JettonWalletOpCodes.BurnNotification, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(balance.toFixed(9)))
                    .storeAddress(owner.address)
                    .storeAddress(receiverAddress ?? owner.address)
                    .storeMaybeRef(beginCell()
                                .storeCoins(toNano(crossChainTonAmount?.toFixed(9) ?? 0))
                                .storeMaybeRef(null)
                                .storeMaybeRef(crossChainPayload)
                                .endCell())
                    .endCell();

                expect(result.transactions).toHaveTransaction({
                    from: jettonWallet.address,
                    to: jettonMaster.address,
                    value: (x) => {
                        return x! <= tonAmount;
                    },
                    success: true,
                    body: burnNotificationBody,
                });

                balance = 0;

                await checkFullData();
                await blockchain.loadFrom(initialState);
                balance = newJettonAmount;

                return result;
            };

            await assertBurn();

            const anyone = await blockchain.treasury('anyone');
            await assertBurn(anyone.address);

            let crossChainTonAmount = 10;
            await assertBurn(anyone.address, crossChainTonAmount);

            const crossChainPayload = beginCell()
                .storeUint(2, 32)
                .storeUint(0, 64)
                .storeRef(beginCell().storeUint(2, 32).storeUint(0, 64).storeUint(0, 64).storeUint(0, 64).endCell())
                .endCell();

            await assertBurn(anyone.address, undefined, crossChainPayload);

            const result = await assertBurn(anyone.address, crossChainTonAmount, crossChainPayload);

            const burnTx = findTransactionRequired(result.transactions, {
                from: owner.address,
                to: jettonWallet.address,
                success: true,
            });
            printTxGasStats('Burn', burnTx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });
    });

    describe('JW-4: transfer', () => {
        it('JW-4.1: should throw an error because there is not enough ton', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const tonAmount = toNano('0.008');
            const destination = await blockchain.treasury('destination');
            const result = await jettonWallet.sendTransfer(owner.getSender(), tonAmount, {
                jettonAmount: balance,
                toOwnerAddress: destination.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: false,
                exitCode: JettonWalletErrors.notEnoughGas,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });

        it('JW-4.2: should throw an error because there is not enough jetton', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const tonAmount = toNano('0.008');
            const destination = await blockchain.treasury('destination');
            const result = await jettonWallet.sendTransfer(owner.getSender(), tonAmount, {
                jettonAmount: balance + 100,
                toOwnerAddress: destination.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: false,
                exitCode: JettonWalletErrors.insufficientJettonBalance,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });

        it('JW-4.3: should throw an error when sender is not a owner', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const tonAmount = toNano('0.008');
            const destination = await blockchain.treasury('destination');
            const anyone = await blockchain.treasury('anyone');
            const result = await jettonWallet.sendTransfer(anyone.getSender(), tonAmount, {
                jettonAmount: balance,
                toOwnerAddress: destination.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: false,
                exitCode: JettonWalletErrors.notFromOwner,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });

        it('JW-4.4: should send tokens', async () => {
            const initBalance = (await blockchain.getContract(jettonWallet.address)).balance;

            const destination = await blockchain.treasury('destination');
            const destinationJettonWallet = blockchain.openContract(
                JettonWallet.createFromConfig(
                    {
                        balance: 0,
                        jettonMasterAddress: jettonMaster.address.toString(),
                        ownerAddress: destination.address.toString(),
                    },
                    code,
                ),
            );

            const deployer = await blockchain.treasury('deployer');

            const deployResult = await destinationJettonWallet.sendDeploy(deployer.getSender(), toNano('0.05'));

            expect(deployResult.transactions).toHaveTransaction({
                from: deployer.address,
                to: destinationJettonWallet.address,
                deploy: true,
            });

            const initialDestinationJettonWalletData = await destinationJettonWallet.getWalletData();
            expect(initialDestinationJettonWalletData.balance).toBe(0);

            const forwardTonAmount = 0.1;
            const forwardPayload = beginCell()
                .storeUint(2, 32)
                .storeUint(0, 64)
                .storeRef(beginCell().storeUint(2, 32).storeUint(0, 64).storeUint(0, 64).storeUint(0, 64).endCell())
                .endCell();
            const customPayload = beginCell()
                .storeUint(5, 32)
                .storeUint(5, 64)
                .storeRef(beginCell().storeUint(5, 32).storeUint(5, 64).endCell())
                .endCell();

            const tonAmount = toNano('0.2') + toNano(forwardTonAmount.toFixed(9));
            const result = await jettonWallet.sendTransfer(owner.getSender(), tonAmount, {
                jettonAmount: balance,
                toOwnerAddress: destination.address.toString(),
                responseAddress: owner.address.toString(),
                customPayload: customPayload,
                forwardTonAmount,
                forwardPayload,
            });

            expect(result.transactions.length).toBe(5);

            const transferBody = beginCell()
                .storeUint(JettonWalletOpCodes.Transfer, 32)
                .storeUint(0, 64)
                .storeCoins(toNano(balance.toFixed(9)))
                .storeAddress(destination.address)
                .storeAddress(owner.address)
                .storeMaybeRef(customPayload)
                .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                .storeMaybeRef(forwardPayload)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: true,
                body: transferBody,
                exitCode: JettonWalletErrors.noErrors,
            });

            const receiveBody = beginCell()
                .storeUint(JettonWalletOpCodes.InternalTransfer, 32)
                .storeUint(0, 64)
                .storeCoins(toNano(balance.toFixed(9)))
                .storeAddress(owner.address)
                .storeAddress(owner.address)
                .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                .storeMaybeRef(forwardPayload)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: jettonWallet.address,
                to: destinationJettonWallet.address,
                success: true,
                body: receiveBody,
                exitCode: JettonWalletErrors.noErrors,
            });

            const transferNotificationBody = beginCell()
                .storeUint(JettonWalletOpCodes.TransferNotification, 32)
                .storeUint(0, 64)
                .storeCoins(toNano(balance.toFixed(9)))
                .storeAddress(owner.address)
                .storeMaybeRef(forwardPayload)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: destinationJettonWallet.address,
                to: destination.address,
                success: true,
                body: transferNotificationBody,
                exitCode: JettonWalletErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: destinationJettonWallet.address,
                to: owner.address,
                success: true,
                body: beginCell().storeUint(JettonWalletOpCodes.Excesses, 32).storeUint(0, 64).endCell(),
                exitCode: JettonWalletErrors.noErrors,
            });

            const destinationJettonWalletData = await destinationJettonWallet.getWalletData();
            expect(destinationJettonWalletData.balance).toBe(initialDestinationJettonWalletData.balance + balance);

            balance = 0;

            const transferTx = findTransactionRequired(result.transactions, {
                from: owner.address,
                to: jettonWallet.address,
                value: tonAmount,
                success: true,
                body: transferBody,
                exitCode: JettonWalletErrors.noErrors,
            });
            printTxGasStats('Transfer', transferTx);

            const receiveTx = findTransactionRequired(result.transactions, {
                from: jettonWallet.address,
                to: destinationJettonWallet.address,
                success: true,
                body: receiveBody,
                exitCode: JettonWalletErrors.noErrors,
            });
            printTxGasStats('Receive', receiveTx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, jettonWallet, result, initBalance);
        });
    });

    describe('JW-5: get methods', () => {
        it('JW-5.1: should return wallet data', async () => {
            const result = await jettonWallet.getWalletData();

            expect(result.ownerAddress).toBe(owner.address.toString());
            expect(result.jettonMasterAddress).toBe(jettonMaster.address.toString());
            expect(result.balance).toBe(balance);
            expect(result.jettonWalletCode.hash().toString()).toBe(code.hash().toString());
        });
    });
});
