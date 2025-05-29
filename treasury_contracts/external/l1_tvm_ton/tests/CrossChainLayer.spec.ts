import { Blockchain, printTransactionFees, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, fromNano, storeStateInit, toNano } from '@ton/core';
import {
    CrossChainLayer,
    CrossChainLayerConfig,
    crossChainLayerConfigToCell,
    CrossChainLayerErrors,
    CrossChainLayerOpCodes,
    OperationType,
} from '../wrappers/CrossChainLayer';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    calculateFeesData,
    calculateMaxStorageState,
    printTxGasStats,
    deployTestToken,
    NATIVE_TAC_ADDRESS,
    sumTxFees,
} from './utils';
import { Message, generateMsgsDictionaryBatching, getCellByMessage } from '../wrappers/utils/MsgUtils';
import { Executor, ExecutorOpCodes } from '../wrappers/Executor';
import {
    calcStorageFee,
    computeGasFee,
    getGasPrices,
    getStoragePrices,
    storageGeneric,
} from '../wrappers/utils/GasUtils';
import { Params } from '../wrappers/Constants';
import { JettonMinter, JettonMinterOpCodes } from '../wrappers/JettonMinter';
import { findTransactionRequired } from '@ton/test-utils';
import { JettonWalletErrors } from '../wrappers/JettonWallet';
import { arrayToCell, MerkleRoot } from '../wrappers/utils/MerkleRoots';

describe('CrossChainLayer', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;
    let sequencerMultisig: SandboxContract<TreasuryContract>;
    let crossChainLayer: SandboxContract<CrossChainLayer>;

    let tacExecutorFee = 0.01;
    let tonExecutorFee = 0.02;
    let wTACTokenAddress: Address;

    let initialTonLock = 0;

    let config: CrossChainLayerConfig;

    let adminAddress: string;
    let newAdminAddress: string | undefined;
    let sequencerMultisigAddress: string;
    let merkleRoots: MerkleRoot[];
    let prevEpoch: number;
    let currEpoch: number;
    let epochDelay: number;
    let maxRootsSize: number;
    let nextVotingTime: number;
    let messageCollectEndTime: number;
    let tonProtocolFee: number;
    let tacProtocolFee: number;
    let protocolFeeSupply: number;
    let executorCode: Cell;
    let jettonWalletCode: Cell;

    async function checkFullData() {
        const data = await crossChainLayer.getFullData();
        expect(data.adminAddress).toBe(adminAddress);
        expect(data.newAdminAddress).toBe(newAdminAddress);
        expect(data.sequencerMultisigAddress).toBe(sequencerMultisigAddress);
        expect(data.maxRootsSize).toBe(maxRootsSize);
        expect(data.merkleRoots).toStrictEqual(merkleRoots);
        expect(data.prevEpoch).toBe(prevEpoch);
        expect(data.currEpoch).toBe(currEpoch);
        expect(data.epochDelay).toBe(epochDelay);
        expect(data.messageCollectEndTime).toBe(messageCollectEndTime);
        expect(data.nextVotingTime).toBe(nextVotingTime);
        expect(data.tacProtocolFee).toBe(tacProtocolFee);
        expect(data.tonProtocolFee).toBe(tonProtocolFee);
        expect(data.protocolFeeSupply).toBe(protocolFeeSupply);
        expect(data.executorCode.hash().toString()).toBe(executorCode.hash().toString());
    }

    async function deployCrossChainLayer() {
        config = {
            adminAddress,
            newAdminAddress,
            executorCode,
            tacProtocolFee,
            tonProtocolFee,
            protocolFeeSupply,
            maxRootsSize,
            merkleRoots,
            prevEpoch,
            currEpoch,
            epochDelay,
            messageCollectEndTime,
            nextVotingTime,
            sequencerMultisigAddress,
        };

        crossChainLayer = blockchain.openContract(CrossChainLayer.createFromConfig(config, code));

        const deployResult = await crossChainLayer.sendDeploy(
            admin.getSender(),
            toNano('1') + toNano(initialTonLock) + toNano(protocolFeeSupply.toFixed(9)),
        );

        expect(deployResult.transactions.length).toBe(2);

        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: crossChainLayer.address,
            body: beginCell().endCell(),
            initData: beginCell()
                .storeAddress(Address.parse(adminAddress))
                .storeAddress(newAdminAddress ? Address.parse(newAdminAddress) : null)
                .storeAddress(Address.parse(sequencerMultisigAddress))
                .storeRef(
                    beginCell()
                        .storeCoins(toNano(tacProtocolFee.toFixed(9)))
                        .storeCoins(toNano(tonProtocolFee.toFixed(9)))
                        .storeCoins(toNano(protocolFeeSupply.toFixed(9)))
                        .endCell(),
                )
                .storeRef(executorCode)
                .storeRef(
                    beginCell()
                        .storeUint(epochDelay, Params.bitsize.time)
                        .storeUint(prevEpoch, Params.bitsize.time)
                        .storeUint(currEpoch, Params.bitsize.time)
                        .storeUint(messageCollectEndTime, Params.bitsize.time)
                        .storeUint(nextVotingTime, Params.bitsize.time)
                        .storeUint(maxRootsSize, 4)
                        .storeDict(arrayToCell(merkleRoots))
                        .endCell(),
                )
                .endCell(),
            deploy: true,
            success: true,
            exitCode: CrossChainLayerErrors.noErrors,
        });

        await checkFullData();

        wTACTokenAddress = await deployTestToken(blockchain, crossChainLayer.address, NATIVE_TAC_ADDRESS);
    }

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        code = await compile('CrossChainLayer');
        executorCode = await compile('Executor');
        jettonWalletCode = await compile('JettonWallet');
        admin = await blockchain.treasury('admin');
        anyone = await blockchain.treasury('anyone');
        sequencerMultisig = await blockchain.treasury('sequencerMultisig');

        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${executorCode.hash().toString('hex')}`), executorCode);
        _libs.set(BigInt(`0x${jettonWalletCode.hash().toString('hex')}`), jettonWalletCode);
        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();

        adminAddress = admin.address.toString();
        newAdminAddress = undefined;
        sequencerMultisigAddress = sequencerMultisig.address.toString();
        merkleRoots = [];
        maxRootsSize = 3;
        prevEpoch = 0;
        currEpoch = 1;
        epochDelay = 0;
        messageCollectEndTime = 0;
        nextVotingTime = 0;
        tacProtocolFee = 0.01;
        tonProtocolFee = 0.02;
        protocolFeeSupply = 0;
        initialTonLock = 0;
    });

    afterEach(async () => {
        await checkFullData();

        adminAddress = admin.address.toString();
        sequencerMultisigAddress = sequencerMultisig.address.toString();
        merkleRoots = [];
        prevEpoch = 0;
        currEpoch = 1;
        epochDelay = 0;
        messageCollectEndTime = 0;
        nextVotingTime = 0;
        tacProtocolFee = 0.01;
        tonProtocolFee = 0.02;
        protocolFeeSupply = 0;
        initialTonLock = 0;
    });

    describe('CCL-1: storage gas stats', () => {
        beforeEach(async () => {
            blockchain.now = Math.floor(Date.now() / 1000);
            epochDelay = 10;

            merkleRoots = [
                { root: 0n, validTimestamp: blockchain.now - 2 * epochDelay },
                { root: 1n, validTimestamp: blockchain.now - epochDelay },
                { root: 2n, validTimestamp: blockchain.now },
                { root: 3n, validTimestamp: blockchain.now + epochDelay },
                { root: 4n, validTimestamp: blockchain.now + 2 * epochDelay },
                { root: 5n, validTimestamp: blockchain.now + 3 * epochDelay },
                { root: 6n, validTimestamp: blockchain.now + 4 * epochDelay },
                { root: 7n, validTimestamp: blockchain.now + 5 * epochDelay },
                { root: 8n, validTimestamp: blockchain.now + 6 * epochDelay },
                { root: 9n, validTimestamp: blockchain.now + 7 * epochDelay },
                { root: 10n, validTimestamp: blockchain.now + 8 * epochDelay },
            ];
        });

        it('CCL-1.1: storage estimates', async () => {
            await deployCrossChainLayer();

            let timeSpan = 365 * 24 * 3600;
            const expTime = Math.floor(Date.now() / 1000) + timeSpan;
            blockchain.now = expTime - 10;

            const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
            const crossChainTonAmount = 0;
            const operationType = OperationType.tonTransfer;
            let msgValue = toNano('0.018');
            const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), msgValue, {
                operationType,
                crossChainTonAmount,
                payload,
            });

            const storagePhase = storageGeneric(result.transactions[1]);
            const actualStorage = storagePhase?.storageFeesCollected;
            console.log('Storage estimates:', Number(actualStorage) / 10 ** 9, ' TON');
        });

        it('CCL-1.2: estimate storage usage(bits and cells)', async () => {
            await deployCrossChainLayer();
            await calculateMaxStorageState(blockchain, 'Cross Chain Layer', crossChainLayer.address);
        });
    });

    describe('CCL-2: EVM msg to TVM', () => {
        it('CCL-2.1: should return error msg if there is insufficient msg value', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
            const operationType = OperationType.jettonTransfer;
            const feeData = beginCell()
                .storeUint(1, 1)
                .storeCoins(toNano((tacProtocolFee + tonProtocolFee).toFixed(9)))
                .storeCoins(toNano(tacExecutorFee.toFixed(9)))
                .storeCoins(toNano(tonExecutorFee.toFixed(9)))
                .endCell();

            const crossChainTonAmount = 0;
            const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), toNano('0.01'), {
                operationType,
                crossChainTonAmount,
                feeData,
                payload,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                    .storeUint(0, 64)
                    .storeUint(operationType, 32)
                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                    .storeMaybeRef(feeData)
                    .storeAddress(null)
                    .storeSlice(payload)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, 32)
                    .storeUint(0, 64)
                    .storeUint(operationType, 32)
                    .storeSlice(payload)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-2.2: should return error msg if there is insufficient msg value (big crosschain ton amount)', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
            const operationType = OperationType.jettonTransfer;
            const crossChainTonAmount = 1000;
            const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), toNano('10'), {
                operationType,
                crossChainTonAmount,
                payload,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                    .storeUint(0, 64)
                    .storeUint(operationType, 32)
                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                    .storeMaybeRef(null)
                    .storeAddress(null)
                    .storeSlice(payload)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, 32)
                    .storeUint(0, 64)
                    .storeUint(operationType, 32)
                    .storeSlice(payload)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-2.3: should emit log with feeData', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
            const feeData = beginCell()
                .storeUint(1, 1)
                .storeCoins(toNano(tacProtocolFee.toFixed(9)) + toNano(tonProtocolFee.toFixed(9)))
                .storeCoins(toNano(tacExecutorFee.toFixed(9)))
                .storeCoins(toNano(tonExecutorFee.toFixed(9)))
                .endCell();

            const operationType = OperationType.tonTransfer;
            const crossChainTonAmount = 0;
            let msgValue =
                toNano('0.018') +
                toNano(tacProtocolFee.toFixed(9)) +
                toNano(tonProtocolFee.toFixed(9)) +
                toNano(tacExecutorFee.toFixed(9)) +
                toNano(tonExecutorFee.toFixed(9));
            const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), msgValue, {
                operationType,
                crossChainTonAmount,
                feeData,
                payload,
            });

            expect(result.transactions.length).toBe(2);

            const tvmMsgToEVMbody = beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                .storeUint(0, 64)
                .storeUint(operationType, 32)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(feeData)
                .storeAddress(null)
                .storeSlice(payload)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: tvmMsgToEVMbody,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 1,
            });

            const logPayload = beginCell()
                .storeUint(operationType, 32)
                .storeUint(0, 64)
                .storeAddress(anyone.address)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(
                    beginCell()
                        .storeMaybeRef(feeData)
                        .storeCoins(toNano(tacProtocolFee.toFixed(9)))
                        .storeCoins(toNano(tonProtocolFee.toFixed(9)))
                        .endCell(),
                )
                .storeSlice(payload)
                .endCell();

            expect(result.transactions[1].outMessagesCount).toBe(1);
            expect(result.transactions[1].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[1].outMessages.get(0)?.body.hash().toString()).toBe(
                logPayload.hash().toString(),
            );

            protocolFeeSupply += tacProtocolFee + tonProtocolFee;

            const tx = findTransactionRequired(result.transactions, {
                from: anyone.address,
                to: crossChainLayer.address,
                success: true,
                body: tvmMsgToEVMbody,
                exitCode: JettonWalletErrors.noErrors,
            });

            const newBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            expect(newBalance - initBalance).toBeGreaterThan(
                toNano(tacProtocolFee.toFixed(9)) + toNano(tonProtocolFee.toFixed(9)),
            );

            printTxGasStats('TVM msg to EVM', tx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-2.3: should emit log with feeData there is no roundTrip', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
            const feeData = beginCell()
                .storeUint(0, 1)
                .storeCoins(toNano(tacProtocolFee.toFixed(9)))
                .storeCoins(toNano(tacExecutorFee.toFixed(9)))
                .endCell();

            const operationType = OperationType.tonTransfer;
            const crossChainTonAmount = 0;
            let msgValue = toNano('0.018') + toNano(tacProtocolFee.toFixed(9)) + toNano(tacExecutorFee.toFixed(9));
            const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), msgValue, {
                operationType,
                crossChainTonAmount,
                feeData,
                payload,
            });

            expect(result.transactions.length).toBe(2);

            const tvmMsgToEVMbody = beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                .storeUint(0, 64)
                .storeUint(operationType, 32)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(feeData)
                .storeAddress(null)
                .storeSlice(payload)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: tvmMsgToEVMbody,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 1,
            });

            const logPayload = beginCell()
                .storeUint(operationType, 32)
                .storeUint(0, 64)
                .storeAddress(anyone.address)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(
                    beginCell()
                        .storeMaybeRef(feeData)
                        .storeCoins(toNano(tacProtocolFee.toFixed(9)))
                        .storeCoins(toNano(tonProtocolFee.toFixed(9)))
                        .endCell(),
                )
                .storeSlice(payload)
                .endCell();

            expect(result.transactions[1].outMessagesCount).toBe(1);
            expect(result.transactions[1].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[1].outMessages.get(0)?.body.hash().toString()).toBe(
                logPayload.hash().toString(),
            );

            protocolFeeSupply += tacProtocolFee;

            const tx = findTransactionRequired(result.transactions, {
                from: anyone.address,
                to: crossChainLayer.address,
                success: true,
                body: tvmMsgToEVMbody,
                exitCode: JettonWalletErrors.noErrors,
            });

            const newBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            expect(newBalance - initBalance).toBeGreaterThan(
                toNano(tacProtocolFee.toFixed(9)) + toNano(tonProtocolFee.toFixed(9)),
            );

            printTxGasStats('TVM msg to EVM', tx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it("CCL-2.4: should emit log and don't return excesses if msgValue is insufficient", async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
            const operationType = OperationType.tonTransfer;
            const crossChainTonAmount = 0;
            let msgValue = toNano('0.018');
            const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), msgValue, {
                operationType,
                crossChainTonAmount,
                responseAddress: anyone.address.toString(),
                payload,
            });

            expect(result.transactions.length).toBe(3);

            const tvmMsgToEVMbody = beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                .storeUint(0, 64)
                .storeUint(operationType, 32)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(null)
                .storeAddress(anyone.address)
                .storeSlice(payload)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: tvmMsgToEVMbody,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 2,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell().storeUint(CrossChainLayerOpCodes.anyone_excesses, 32).storeUint(0, 64).endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            const logPayload = beginCell()
                .storeUint(operationType, 32)
                .storeUint(0, 64)
                .storeAddress(anyone.address)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(null)
                .storeSlice(payload)
                .endCell();

            expect(result.transactions[1].outMessagesCount).toBe(2);
            expect(result.transactions[1].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[1].outMessages.get(0)?.body.hash().toString()).toBe(
                logPayload.hash().toString(),
            );

            const tx = findTransactionRequired(result.transactions, {
                from: anyone.address,
                to: crossChainLayer.address,
                success: true,
                body: tvmMsgToEVMbody,
                exitCode: JettonWalletErrors.noErrors,
            });
            printTxGasStats('TVM msg to EVM', tx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-2.5: should emit log and return excesses', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
            const crossChainTonAmount = 0;
            const operationType = OperationType.tonTransfer;
            let msgValue = toNano('0.05');
            const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), msgValue, {
                operationType,
                crossChainTonAmount,
                responseAddress: anyone.address.toString(),
                payload,
            });

            expect(result.transactions.length).toBe(3);

            const tvmMsgToEVMbody = beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                .storeUint(0, 64)
                .storeUint(operationType, 32)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(null)
                .storeAddress(anyone.address)
                .storeSlice(payload)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: tvmMsgToEVMbody,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 2,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell().storeUint(CrossChainLayerOpCodes.anyone_excesses, 32).storeUint(0, 64).endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            const logPayload = beginCell()
                .storeUint(operationType, 32)
                .storeUint(0, 64)
                .storeAddress(anyone.address)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(null)
                .storeSlice(payload)
                .endCell();

            expect(result.transactions[1].outMessagesCount).toBe(2);
            expect(result.transactions[1].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[1].outMessages.get(0)?.body.hash().toString()).toBe(
                logPayload.hash().toString(),
            );

            const tx = findTransactionRequired(result.transactions, {
                from: anyone.address,
                to: crossChainLayer.address,
                success: true,
                body: tvmMsgToEVMbody,
                exitCode: JettonWalletErrors.noErrors,
            });
            printTxGasStats('TVM msg to EVM', tx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-2.6: should emit log and return excesses (big crosschain ton amount)', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
            const crossChainTonAmount = 1000;
            const operationType = OperationType.tonTransfer;
            let msgValue = toNano(crossChainTonAmount.toFixed(9)) + toNano('0.05');
            const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), msgValue, {
                operationType,
                crossChainTonAmount,
                responseAddress: anyone.address.toString(),
                payload,
            });

            expect(result.transactions.length).toBe(3);

            const tvmMsgToEVMbody = beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                .storeUint(0, 64)
                .storeUint(operationType, 32)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(null)
                .storeAddress(anyone.address)
                .storeSlice(payload)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: tvmMsgToEVMbody,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 2,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell().storeUint(CrossChainLayerOpCodes.anyone_excesses, 32).storeUint(0, 64).endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            const logPayload = beginCell()
                .storeUint(operationType, 32)
                .storeUint(0, 64)
                .storeAddress(anyone.address)
                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                .storeMaybeRef(null)
                .storeSlice(payload)
                .endCell();

            expect(result.transactions[1].outMessagesCount).toBe(2);
            expect(result.transactions[1].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[1].outMessages.get(0)?.body.hash().toString()).toBe(
                logPayload.hash().toString(),
            );

            const tx = findTransactionRequired(result.transactions, {
                from: anyone.address,
                to: crossChainLayer.address,
                success: true,
                body: tvmMsgToEVMbody,
                exitCode: JettonWalletErrors.noErrors,
            });
            printTxGasStats('TVM msg to EVM', tx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-3: EVM msg to TVM', () => {
        describe('CCL-3.1: fee in WTAC and no need to unlock', () => {
            let messages: Message[];
            let executorFeeValue: bigint;
            let messagesDict: Dictionary<Buffer, boolean>;
            let merkleRoot: MerkleRoot;

            beforeEach(async () => {
                await deployCrossChainLayer();

                executorFeeValue = toNano('0.01');
                messages = [
                    {
                        entries: [
                            {
                                operationId: toNano('1'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('1'),
                                msgBody: beginCell().storeUint(12345, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                        ],
                        validExecutors: [anyone.address],
                        executorFeeToken: wTACTokenAddress,
                        executorFeeValue: executorFeeValue,
                    },
                    {
                        entries: [
                            {
                                operationId: toNano('2'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('2'),
                                msgBody: beginCell().storeUint(67890, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                        ],
                        validExecutors: [anyone.address],
                        executorFeeToken: wTACTokenAddress,
                        executorFeeValue: executorFeeValue,
                    },
                    {
                        entries: [
                            {
                                operationId: toNano('3'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('3'),
                                msgBody: beginCell().storeUint(11235, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                        ],
                        validExecutors: [anyone.address],
                        executorFeeToken: wTACTokenAddress,
                        executorFeeValue: executorFeeValue,
                    },
                ];

                messagesDict = generateMsgsDictionaryBatching(messages);
                const dictCell = beginCell().storeDictDirect(messagesDict).endCell();

                blockchain.now = Math.floor(Date.now() / 1000);

                merkleRoot = {
                    root: BigInt('0x' + dictCell.hash().toString('hex')),
                    validTimestamp: blockchain.now,
                };

                const setRootResult = await crossChainLayer.sendUpdateMerkleRoot(
                    sequencerMultisig.getSender(),
                    toNano('0.05'),
                    {
                        merkleRoot: merkleRoot.root,
                        messageCollectEndTime: nextVotingTime,
                    },
                );

                expect(setRootResult.transactions.length).toBe(3);
                prevEpoch = 1;
                currEpoch = blockchain.now;
                messageCollectEndTime = nextVotingTime;
                nextVotingTime = currEpoch + epochDelay;
                merkleRoots = [merkleRoot];
            });

            it('CCL-3.1.1: should throw error if sender is not executor contract', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const msgIndex = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([msgIndex.hash()]);
                const destinationMsgValue = toNano('0.05');
                const payload = beginCell()
                    .storeUint(toNano('1'), Params.bitsize.hash)
                    .storeAddress(anyone.address)
                    .storeCoins(destinationMsgValue)
                    .storeRef(beginCell().storeUint(12345, 32).endCell())
                    .endCell();

                const result = await crossChainLayer.sendEVMMsgToTVM(anyone.getSender(), toNano('0.02'), {
                    feeToAddress: anyone.address.toString(),
                    merkleProof,
                    payload,
                });

                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: false,
                    exitCode: CrossChainLayerErrors.notFromExecutor,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });

            it('CCL-3.1.2: should send msg to destination', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);
                const destinationAddress = messages[0].entries[0].destinationAddress;
                const destinationMsgValue = messages[0].entries[0].destinationMsgValue;
                const destinationMsgBody = messages[0].entries[0].msgBody;

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(
                    blockchain.sender(executor.address),
                    destinationMsgValue + toNano((0.05).toFixed(9)),
                    {
                        feeToAddress: anyone.address.toString(),
                        merkleProof,
                        payload: payload,
                    },
                );

                expect(result.transactions.length).toBe(5);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 3,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: destinationAddress,
                    success: true,
                    body: destinationMsgBody,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                expect(result.transactions[0].outMessages.get(2)?.info.src!.toString()).toEqual(
                    crossChainLayer.address.toString(),
                );
                expect(result.transactions[0].outMessages.get(2)?.body.hash().toString()).toBe(
                    payload.hash().toString(),
                );

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });

            it('CCL-3.1.3: should revert spend param in executor contract (invalid merkle root)', async () => {
                // change merkle root
                messages.push({
                    entries: [
                        {
                            operationId: toNano('4'),
                            destinationAddress: anyone.address,
                            destinationMsgValue: toNano('4'),
                            msgBody: beginCell().storeUint(12312, 32).endCell(),
                            payloadNumber: Math.round(Math.random() * 100),
                        },
                    ],
                    validExecutors: [anyone.address],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.01'),
                });

                messagesDict = generateMsgsDictionaryBatching(messages);

                const payload = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(blockchain.sender(executor.address), toNano('2'), {
                    feeToAddress: anyone.address.toString(),
                    merkleProof,
                    payload,
                });

                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: false,
                    exitCode: CrossChainLayerErrors.invalidProof,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: executor.address,
                    success: true,
                    inMessageBounced: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_errorNotification, 32)
                        .storeUint(0, 64)
                        .storeRef(payload)
                        .storeAddress(undefined)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 1,
                });

                expect(result.transactions[2].outMessages.get(0)?.info.src!.toString()).toEqual(
                    crossChainLayer.address.toString(),
                );
                expect(result.transactions[2].outMessages.get(0)?.body.hash().toString()).toBe(
                    payload.hash().toString(),
                );

                const newExecutorData = await executor.getFullData();
                expect(newExecutorData.isSpent).toBeFalsy();
                expect(newExecutorData.lastExecutorAddress).toBeUndefined();

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });

            it('CCL-3.1.4: should revert spend param in executor contract (not enough ton)', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(
                    blockchain.sender(executor.address),
                    toNano('0.02'),
                    {
                        feeToAddress: anyone.address.toString(),
                        merkleProof,
                        payload: payload,
                    },
                );

                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: false,
                    exitCode: CrossChainLayerErrors.notEnoughTon,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: executor.address,
                    inMessageBounced: true,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                const newExecutorData = await executor.getFullData();
                expect(newExecutorData.isSpent).toBeFalsy();
                expect(newExecutorData.lastExecutorAddress).toBeUndefined();

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });

            it('CCL-3.1.5: should send msg to destination', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);
                const destinationAddress = messages[0].entries[0].destinationAddress;
                const destinationMsgValue = messages[0].entries[0].destinationMsgValue;
                const destinationMsgBody = messages[0].entries[0].msgBody;

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(
                    blockchain.sender(executor.address),
                    destinationMsgValue + toNano((0.05).toFixed(9)),
                    {
                        feeToAddress: anyone.address.toString(),
                        merkleProof,
                        payload: payload,
                    },
                );

                expect(result.transactions.length).toBe(5);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 3,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: destinationAddress,
                    success: true,
                    body: destinationMsgBody,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                expect(result.transactions[0].outMessages.get(2)?.info.src!.toString()).toEqual(
                    crossChainLayer.address.toString(),
                );
                expect(result.transactions[0].outMessages.get(2)?.body.hash().toString()).toBe(
                    payload.hash().toString(),
                );

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });

            it('CCL-3.1.6: should send msg to destination with response address def', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);
                const destinationAddress = messages[0].entries[0].destinationAddress;
                const destinationMsgValue = messages[0].entries[0].destinationMsgValue;
                const destinationMsgBody = messages[0].entries[0].msgBody;

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(
                    blockchain.sender(executor.address),
                    destinationMsgValue + toNano((0.05).toFixed(9)),
                    {
                        feeToAddress: anyone.address.toString(),
                        merkleProof,
                        payload: payload,
                        responseAddress: anyone.address.toString(),
                    },
                );

                expect(result.transactions.length).toBe(6);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(anyone.address)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 4,
                });
                expect(result.transactions[0].outMessages.get(2)?.info.src!.toString()).toEqual(
                    crossChainLayer.address.toString(),
                );

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: destinationAddress,
                    success: true,
                    body: destinationMsgBody,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    body: beginCell().storeUint(CrossChainLayerOpCodes.anyone_excesses, 32).storeUint(0, 64).endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });
        });

        describe('CCL-3.2: need to unlock fee in TON', () => {
            let messages: Message[];
            let messagesDict: Dictionary<Buffer, boolean>;
            let merkleRoot: MerkleRoot;

            beforeEach(async () => {
                initialTonLock = 100;
                await deployCrossChainLayer();

                messages = [
                    {
                        entries: [
                            {
                                needToUnlockTON: true,
                                operationId: toNano('1'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('1'),
                                msgBody: beginCell().storeUint(12345, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                        ],
                        validExecutors: [anyone.address],
                        executorFeeToken: null,
                        executorFeeValue: toNano('1'),
                    },
                    {
                        entries: [
                            {
                                needToUnlockTON: true,
                                operationId: toNano('2'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano(initialTonLock),
                                msgBody: beginCell().storeUint(67890, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                        ],
                        validExecutors: [anyone.address],
                        executorFeeToken: null,
                        executorFeeValue: toNano(initialTonLock),
                    },
                    {
                        entries: [
                            {
                                needToUnlockTON: true,
                                operationId: toNano('3'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano(initialTonLock),
                                msgBody: beginCell().storeUint(11235, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                        ],
                        validExecutors: [anyone.address],
                        executorFeeToken: null,
                        executorFeeValue: toNano(initialTonLock),
                    },
                ];

                messagesDict = generateMsgsDictionaryBatching(messages);
                const dictCell = beginCell().storeDictDirect(messagesDict).endCell();
                blockchain.now = Math.floor(Date.now() / 1000);
                merkleRoot = {
                    root: BigInt('0x' + dictCell.hash().toString('hex')),
                    validTimestamp: blockchain.now,
                };
                merkleRoots = [merkleRoot];
                const setRootResult = await crossChainLayer.sendUpdateMerkleRoot(
                    sequencerMultisig.getSender(),
                    toNano('0.01'),
                    {
                        merkleRoot: merkleRoot.root,
                        messageCollectEndTime: nextVotingTime,
                    },
                );
                expect(setRootResult.transactions.length).toBe(3);
                prevEpoch = 1;
                currEpoch = blockchain.now;
                messageCollectEndTime = nextVotingTime;
                nextVotingTime = currEpoch + epochDelay;
            });

            it('CCL-3.2.1: should send msg and unlock TON from ccl', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);
                const destinationAddress = messages[0].entries[0].destinationAddress;
                const destinationMsgValue = messages[0].entries[0].destinationMsgValue;
                const destinationMsgBody = messages[0].entries[0].msgBody;

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(
                    blockchain.sender(executor.address),
                    toNano((0.05).toFixed(9)),
                    {
                        feeToAddress: anyone.address.toString(),
                        merkleProof,
                        payload: payload,
                    },
                );

                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 3,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: destinationAddress,
                    success: true,
                    body: destinationMsgBody,
                    value: destinationMsgValue,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    success: true,

                    body: beginCell().endCell(),
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                expect(result.transactions[0].outMessages.get(2)?.info.src!.toString()).toEqual(
                    crossChainLayer.address.toString(),
                );
                expect(result.transactions[0].outMessages.get(2)?.body.hash().toString()).toBe(
                    payload.hash().toString(),
                );

                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });

            it('CCL-3.2.2: should revert spend param in executor contract (insufficient balance)', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[1]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(
                    blockchain.sender(executor.address),
                    toNano('0.04'),
                    {
                        feeToAddress: anyone.address.toString(),
                        merkleProof,
                        payload: payload,
                    },
                );

                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: false,
                    exitCode: CrossChainLayerErrors.insufficientBalance,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: executor.address,
                    inMessageBounced: true,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                const newExecutorData = await executor.getFullData();
                expect(newExecutorData.isSpent).toBeFalsy();
                expect(newExecutorData.lastExecutorAddress).toBeUndefined();

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });
        });

        it('CCL-3.3: should execute message with state init', async () => {
            await deployCrossChainLayer();

            const someContract = JettonMinter.createFromConfig(
                {
                    adminAddress: admin.address,
                    content: beginCell().endCell(),
                    jettonWalletCode: await compile('JettonWallet'),
                    evmTokenAddress: '0x1234',
                    totalSupply: 0,
                },
                await compile('JettonMinter'),
            );
            const state = someContract.init!;
            const stateCell = beginCell().store(storeStateInit(state)).endCell();

            const executorFeeValue = toNano('0.01');
            const messages: Message[] = [
                {
                    entries: [
                        {
                            operationId: toNano('1'),
                            destinationAddress: someContract.address,
                            destinationMsgValue: toNano('1'),
                            msgBody: beginCell().endCell(),
                            payloadNumber: Math.round(Math.random() * 100),
                            maybeStateInit: stateCell,
                        },
                    ],
                    validExecutors: [anyone.address],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: executorFeeValue,
                },
            ];

            const messagesDict = generateMsgsDictionaryBatching(messages);
            const dictCell = beginCell().storeDictDirect(messagesDict).endCell();
            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots = [merkleRoot];
            const setRootResult = await crossChainLayer.sendUpdateMerkleRoot(
                sequencerMultisig.getSender(),
                toNano('0.01'),
                {
                    merkleRoot: merkleRoot.root,
                    messageCollectEndTime: nextVotingTime,
                },
            );
            expect(setRootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = getCellByMessage(messages[0]);
            const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

            const executor = blockchain.openContract(
                Executor.createFromConfig(
                    {
                        isSpent: false,
                        crossChainLayerAddress: crossChainLayer.address.toString(),
                        payload: payload,
                    },
                    executorCode,
                ),
            );

            await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

            const result = await crossChainLayer.sendEVMMsgToTVM(
                blockchain.sender(executor.address),
                toNano(10) + toNano((0.05).toFixed(9)) + executorFeeValue,
                {
                    feeToAddress: anyone.address.toString(),
                    merkleProof,
                    payload: payload,
                },
            );

            expect(result.transactions.length).toBe(2 + 2 + 1);

            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(null)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 3,
            });
            expect(result.transactions[0].outMessages.get(2)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[0].outMessages.get(2)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: someContract.address,
                initCode: someContract.init?.code,
                initData: someContract.init?.data,
                body: beginCell().endCell(),
                success: true,
                oldStatus: 'uninitialized',
                endStatus: 'active',
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: wTACTokenAddress,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeCoins(executorFeeValue)
                    .storeAddress(anyone.address)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-3.4: should not use own balance to cover fees when handling EVM->TVM messages', async () => {
            await deployCrossChainLayer();

            const executorFeeValue = 0.01;
            const entryCount = 30;
            const messages: Message[] = [
                {
                    entries: [...Array(entryCount).keys()].map((k) => ({
                        operationId: toNano(k),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('0.01'),
                        msgBody: beginCell().storeUint(k, 32).endCell(),
                        payloadNumber: Math.round(Math.random() * 100),
                    })),
                    validExecutors: [anyone.address],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano(executorFeeValue),
                },
            ];

            const messagesDict = generateMsgsDictionaryBatching(messages);
            const dictCell = beginCell().storeDictDirect(messagesDict).endCell();
            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots = [merkleRoot];

            const setRootResult = await crossChainLayer.sendUpdateMerkleRoot(
                sequencerMultisig.getSender(),
                toNano('0.01'),
                {
                    merkleRoot: merkleRoot.root,
                    messageCollectEndTime: nextVotingTime,
                },
            );
            expect(setRootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const payload = getCellByMessage(messages[0]);
            const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

            const executor = blockchain.openContract(
                Executor.createFromConfig(
                    {
                        isSpent: false,
                        crossChainLayerAddress: crossChainLayer.address.toString(),
                        payload: payload,
                    },
                    executorCode,
                ),
            );

            await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

            const result = await crossChainLayer.sendEVMMsgToTVM(
                blockchain.sender(executor.address),
                toNano(0.01 * entryCount + 1),
                {
                    feeToAddress: anyone.address.toString(),
                    merkleProof,
                    payload: payload,
                },
            );

            expect(result.transactions.length).toBe(1 + entryCount + 3); // executor->ccl, ccl->entries, fee: ccl->jetton_minter->jetton_wallet

            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: crossChainLayer.address,
                success: true,
                outMessagesCount: entryCount + 1 + 1,
            });

            expect(result.transactions[0].outMessages.get(entryCount + 1)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(
                result.transactions[0].outMessages
                    .get(entryCount + 1)
                    ?.body.hash()
                    .toString(),
            ).toBe(payload.hash().toString());

            for (let i = 0; i < messages[0].entries.length; i++) {
                const entry = messages[0].entries[i];
                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: entry.destinationAddress,
                    body: entry.msgBody,
                    success: true,
                });
            }

            const tx = findTransactionRequired(result.transactions, {
                from: crossChainLayer.address,
                to: wTACTokenAddress,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(executorFeeValue))
                    .storeAddress(anyone.address)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
            });

            printTxGasStats('wTAC mint', tx);

            const finalBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            expect(finalBalance).toBeGreaterThanOrEqual(initBalance + toNano(protocolFeeSupply));

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        describe('CCL-3.5 batching', () => {
            let messages: Message[];
            let executorFeeValue: bigint;
            let messagesDict: Dictionary<Buffer, boolean>;
            let merkleRoot: MerkleRoot;

            beforeEach(async () => {
                await deployCrossChainLayer();

                executorFeeValue = toNano('0.01');
                messages = [
                    {
                        entries: [
                            {
                                operationId: toNano('1'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('1'),
                                msgBody: beginCell().storeUint(12345, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                            {
                                operationId: toNano('2'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('2'),
                                msgBody: beginCell().storeUint(67890, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                            {
                                operationId: toNano('3'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('3'),
                                msgBody: beginCell().storeUint(11235, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                        ],
                        validExecutors: [anyone.address],
                        executorFeeToken: wTACTokenAddress,
                        executorFeeValue: executorFeeValue,
                    },
                    {
                        entries: [
                            {
                                needToUnlockTON: true,
                                operationId: toNano('1'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('1'),
                                msgBody: beginCell().storeUint(12345, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                            {
                                needToUnlockTON: true,
                                operationId: toNano('2'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('2'),
                                msgBody: beginCell().storeUint(67890, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                            {
                                needToUnlockTON: true,
                                operationId: toNano('3'),
                                destinationAddress: anyone.address,
                                destinationMsgValue: toNano('3'),
                                msgBody: beginCell().storeUint(11235, 32).endCell(),
                                payloadNumber: Math.round(Math.random() * 100),
                            },
                        ],
                        validExecutors: [anyone.address],
                        executorFeeToken: wTACTokenAddress,
                        executorFeeValue: executorFeeValue,
                    },
                ];

                messagesDict = generateMsgsDictionaryBatching(messages);
                const dictCell = beginCell().storeDictDirect(messagesDict).endCell();

                blockchain.now = Math.floor(Date.now() / 1000);

                merkleRoot = {
                    root: BigInt('0x' + dictCell.hash().toString('hex')),
                    validTimestamp: blockchain.now,
                };

                const setRootResult = await crossChainLayer.sendUpdateMerkleRoot(
                    sequencerMultisig.getSender(),
                    toNano('0.05'),
                    {
                        merkleRoot: merkleRoot.root,
                        messageCollectEndTime: nextVotingTime,
                    },
                );

                expect(setRootResult.transactions.length).toBe(3);
                prevEpoch = 1;
                currEpoch = blockchain.now;
                messageCollectEndTime = nextVotingTime;
                nextVotingTime = currEpoch + epochDelay;
                merkleRoots = [merkleRoot];
            });

            it('CCL-3.5.1: should revert spend param in executor contract (not enough ton)', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(
                    blockchain.sender(executor.address),
                    toNano(1 + 2 + 3),
                    {
                        feeToAddress: anyone.address.toString(),
                        merkleProof,
                        payload: payload,
                    },
                );

                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: false,
                    exitCode: CrossChainLayerErrors.notEnoughTon,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: executor.address,
                    inMessageBounced: true,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 1,
                });

                expect(result.transactions[2].outMessages.get(0)?.info.src!.toString()).toEqual(
                    crossChainLayer.address.toString(),
                );
                expect(result.transactions[2].outMessages.get(0)?.body.hash().toString()).toBe(
                    payload.hash().toString(),
                );

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });

            it('CCL-3.5.2: should revert spend param in executor contract (insufficient balance)', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[1]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(blockchain.sender(executor.address), toNano(1), {
                    feeToAddress: anyone.address.toString(),
                    merkleProof,
                    payload: payload,
                });

                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: false,
                    exitCode: CrossChainLayerErrors.insufficientBalance,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: executor.address,
                    inMessageBounced: true,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 1,
                });

                expect(result.transactions[2].outMessages.get(0)?.info.src!.toString()).toEqual(
                    crossChainLayer.address.toString(),
                );
                expect(result.transactions[2].outMessages.get(0)?.body.hash().toString()).toBe(
                    payload.hash().toString(),
                );

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });

            it('CCL-3.5.3: should execute all messages', async () => {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

                const payload = getCellByMessage(messages[0]);
                const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

                const executor = blockchain.openContract(
                    Executor.createFromConfig(
                        {
                            isSpent: false,
                            crossChainLayerAddress: crossChainLayer.address.toString(),
                            payload: payload,
                        },
                        executorCode,
                    ),
                );

                await executor.sendDeploy(anyone.getSender(), toNano('0.05'));

                const result = await crossChainLayer.sendEVMMsgToTVM(
                    blockchain.sender(executor.address),
                    toNano(1 + 2 + 3) + toNano(messages.length * 0.01 + 0.05),
                    {
                        feeToAddress: anyone.address.toString(),
                        merkleProof,
                        payload: payload,
                    },
                );

                expect(result.transactions.length).toBe(1 + 3 + 2 + 1);

                expect(result.transactions).toHaveTransaction({
                    from: executor.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeRef(merkleProof)
                        .storeRef(payload)
                        .storeAddress(null)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 5,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: wTACTokenAddress,
                    body: beginCell()
                        .storeUint(JettonMinterOpCodes.mint, 32)
                        .storeUint(0, 64)
                        .storeAddress(anyone.address)
                        .storeCoins(executorFeeValue)
                        .storeAddress(anyone.address)
                        .storeCoins(0)
                        .storeUint(0, 1)
                        .storeUint(0, 1)
                        .endCell(),
                    success: true,
                });

                expect(result.transactions[0].outMessages.get(4)?.info.src!.toString()).toEqual(
                    crossChainLayer.address.toString(),
                );
                expect(result.transactions[0].outMessages.get(4)?.body.hash().toString()).toBe(
                    payload.hash().toString(),
                );

                printTransactionFees(result.transactions);
                await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
            });
        });
    });

    describe('CCL-4: update merkle root', () => {
        it('CCL-4.1: should throw error if sender is not sequencer multisig', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newMerkleRoot = 1n;

            const result = await crossChainLayer.sendUpdateMerkleRoot(anyone.getSender(), toNano('0.02'), {
                merkleRoot: newMerkleRoot,
                messageCollectEndTime: nextVotingTime,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(BigInt(nextVotingTime), Params.bitsize.time)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromSequencerMultisig,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-4.2: should throw error if messageCollectEndTime is low', async () => {
            epochDelay = 123;
            blockchain.now = Math.floor(Date.now() / 1000);
            const initMessageCollectEndTime = blockchain.now;
            nextVotingTime = blockchain.now + epochDelay;

            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            blockchain.now = nextVotingTime + 1;
            const newMerkleRoot = 1n;
            const result = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('0.01'), {
                merkleRoot: newMerkleRoot,
                messageCollectEndTime: initMessageCollectEndTime,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: sequencerMultisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(initMessageCollectEndTime, Params.bitsize.time)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.messageCollectEndTimeLow,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: sequencerMultisig.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-4.3: should throw error if there are not enough TONs', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newMerkleRoot = 1n;
            //TODO: calc fee
            const result = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('0.006'), {
                merkleRoot: newMerkleRoot,
                messageCollectEndTime: nextVotingTime,
            });
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: sequencerMultisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(BigInt(nextVotingTime), Params.bitsize.time)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.noErrors,
                actionResultCode: CrossChainLayerErrors.systemNotEnoughTon,
            });

            // expect(result.transactions).toHaveTransaction({
            //     from: crossChainLayer.address,
            //     to: sequencerMultisig.address,
            // });

            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-4.4: should save new merkle root and emit event', async () => {
            epochDelay = 123;

            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newMerkleRoot = 1n;
            const result = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('0.01'), {
                merkleRoot: newMerkleRoot,
                messageCollectEndTime: nextVotingTime,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: sequencerMultisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(BigInt(nextVotingTime), Params.bitsize.time)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 2,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: sequencerMultisig.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            const savedNextVotingTime = nextVotingTime;
            prevEpoch = 1;
            currEpoch = result.transactions[0].now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            const merkleRoot: MerkleRoot = {
                root: newMerkleRoot,
                validTimestamp: nextVotingTime,
            };
            merkleRoots = [merkleRoot];

            const logPayload = beginCell()
                .storeUint(newMerkleRoot, Params.bitsize.hash)
                .storeUint(BigInt(0), Params.bitsize.time)
                .storeUint(BigInt(savedNextVotingTime), Params.bitsize.time)
                .storeUint(prevEpoch, Params.bitsize.time)
                .storeUint(currEpoch, Params.bitsize.time)
                .storeUint(nextVotingTime, Params.bitsize.time)
                .endCell();

            expect(result.transactions[1].outMessagesCount).toBe(2);
            expect(result.transactions[1].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[1].outMessages.get(0)?.body.hash().toString()).toBe(
                logPayload.hash().toString(),
            );

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-4.5: should cleanup old roots, save new merkle root and emit event', async () => {
            epochDelay = 10;

            blockchain.now = Math.floor(Date.now() / 1000);

            for (let i = -2; i <= maxRootsSize - 2; i++) {
                merkleRoots.push({
                    root: BigInt(i + 2),
                    validTimestamp: blockchain.now - 2 * epochDelay,
                });
            }

            nextVotingTime = blockchain.now + 10 * epochDelay;
            blockchain.now += 11 * epochDelay;
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newMerkleRoot = 13n;
            const result = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('0.1'), {
                merkleRoot: newMerkleRoot,
                messageCollectEndTime: nextVotingTime,
            });

            expect(result.transactions.length).toBe(3);

            const updateRootTx = {
                from: sequencerMultisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(BigInt(nextVotingTime), Params.bitsize.time)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 2,
            };

            expect(result.transactions).toHaveTransaction(updateRootTx);

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: sequencerMultisig.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            const savedNextVotingTime = nextVotingTime;
            prevEpoch = 1;
            currEpoch = result.transactions[0].now;
            const prevMessageCollectEndTime = messageCollectEndTime;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            const merkleRoot: MerkleRoot = {
                root: newMerkleRoot,
                validTimestamp: nextVotingTime,
            };

            merkleRoots.push(merkleRoot);

            merkleRoots = merkleRoots.filter((root) => root.validTimestamp > currEpoch - maxRootsSize * epochDelay);

            const logPayload = beginCell()
                .storeUint(newMerkleRoot, Params.bitsize.hash)
                .storeUint(BigInt(prevMessageCollectEndTime), Params.bitsize.time)
                .storeUint(BigInt(savedNextVotingTime), Params.bitsize.time)
                .storeUint(prevEpoch, Params.bitsize.time)
                .storeUint(currEpoch, Params.bitsize.time)
                .storeUint(nextVotingTime, Params.bitsize.time)
                .endCell();

            expect(result.transactions[1].outMessagesCount).toBe(2);
            expect(result.transactions[1].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[1].outMessages.get(0)?.body.hash().toString()).toBe(
                logPayload.hash().toString(),
            );

            const tx = findTransactionRequired(result.transactions, updateRootTx);
            printTxGasStats('Update root', tx);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-4.6: size of merkle roots should always be less than or equal to max_roots_size', async () => {
            epochDelay = 10;
            await deployCrossChainLayer();

            let maxInitBalance = 0n;
            let maxResult: SendMessageResult & { result: void } = {
                result: undefined,
                transactions: [],
                events: [],
                externals: [],
            };

            let maxFees = 0n;

            blockchain.now = Math.floor(Date.now() / 1000);

            for (let i = 0; i < 100; i++) {
                const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                nextVotingTime = blockchain.now;
                const result = await crossChainLayer.sendUpdateMerkleRoot(
                    sequencerMultisig.getSender(),
                    toNano('0.02'),
                    {
                        merkleRoot: BigInt(i),
                        messageCollectEndTime: nextVotingTime,
                    },
                );
                const totalFees = result.transactions.reduce(sumTxFees, 0n);
                if (totalFees > maxFees) {
                    maxResult = result;
                    maxInitBalance = initBalance;
                }

                prevEpoch = currEpoch;
                currEpoch = result.transactions[0].now;
                messageCollectEndTime = nextVotingTime;
                nextVotingTime = currEpoch + epochDelay;

                const merkleRoot: MerkleRoot = {
                    root: BigInt(i),
                    validTimestamp: nextVotingTime,
                };

                merkleRoots.push(merkleRoot);

                merkleRoots = merkleRoots.filter(
                    (root) => root.validTimestamp > result.transactions[0].now - maxRootsSize * epochDelay,
                );

                expect(merkleRoots.length).toBeLessThanOrEqual(maxRootsSize + 1);

                blockchain.now += epochDelay;
            }

            await calculateFeesData(blockchain, crossChainLayer, maxResult, maxInitBalance);
        });
    });

    describe('CCL-5: add protocol fee', () => {
        it('CCL-5.1: should throw error if there is insufficient msg value', async () => {
            await deployCrossChainLayer();
            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const gasPrices = getGasPrices(blockchain.config, 0);
            const addFeeGasFee = computeGasFee(gasPrices, CrossChainLayer.addFeeGasConsumption);
            const result = await crossChainLayer.sendAddProtocolFee(anyone.getSender(), addFeeGasFee);

            expect(result.transactions.length).toBe(3);

            const addFeeBody = beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_addProtocolFee, Params.bitsize.op)
                .storeUint(0, Params.bitsize.queryId)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: addFeeBody,
                success: false,
                exitCode: CrossChainLayerErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            const currentBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            expect(Number(currentBalance) / 1e9).toBeCloseTo(Number(initBalance) / 1e9, 1e-9);

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-5.2: should add msg_value to protocol fee supply', async () => {
            await deployCrossChainLayer();
            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const addProtocolFeeAmount = 10;
            const result = await crossChainLayer.sendAddProtocolFee(
                anyone.getSender(),
                toNano(addProtocolFeeAmount.toFixed(9)),
            );

            expect(result.transactions.length).toBe(2);

            const addFeeBody = beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_addProtocolFee, Params.bitsize.op)
                .storeUint(0, Params.bitsize.queryId)
                .endCell();

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: addFeeBody,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            const storagePrices = getStoragePrices(blockchain.config);
            const minTonForStorage = calcStorageFee(
                storagePrices,
                CrossChainLayer.storageStats,
                BigInt(CrossChainLayer.minStorageDuration),
            );
            const storageFee =
                Number(fromNano(minTonForStorage)) -
                Math.min(Number(fromNano(initBalance)), Number(fromNano(minTonForStorage)));

            const gasPrices = getGasPrices(blockchain.config, 0);
            const addFeeGasFee = computeGasFee(gasPrices, CrossChainLayer.addFeeGasConsumption);

            const newFeeAmount = addProtocolFeeAmount - storageFee - Number(fromNano(addFeeGasFee));

            protocolFeeSupply += newFeeAmount;

            const tx = findTransactionRequired(result.transactions, {
                from: anyone.address,
                to: crossChainLayer.address,
                success: true,
                body: addFeeBody,
                exitCode: JettonWalletErrors.noErrors,
            });
            printTxGasStats('Add Fee', tx);

            const currentBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            expect(Number(currentBalance) / 1e9).toBeCloseTo(
                Number(initBalance + toNano(newFeeAmount.toFixed(9))) / 1e9,
                1e-9,
            );

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-6: collect protocol fee', () => {
        it('CCL-6.1: should throw error if sender is not sequencer multisig', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendCollectProtocolFee(anyone.getSender(), toNano('0.01'), {});

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_collectProtocolFee, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromSequencerMultisig,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-6.2: should throw error if there is zero supply', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendCollectProtocolFee(
                sequencerMultisig.getSender(),
                toNano('0.01'),
                {},
            );

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: sequencerMultisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_collectProtocolFee, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.zeroFeeSupply,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: sequencerMultisig.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-6.3: should send fee supply', async () => {
            protocolFeeSupply = 0.5;
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendCollectProtocolFee(
                sequencerMultisig.getSender(),
                toNano('0.01'),
                {},
            );

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: sequencerMultisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_collectProtocolFee, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: sequencerMultisig.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_collectProtocolFeeNotification, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(protocolFeeSupply.toFixed(9)))
                    .endCell(),
                success: true,
                value: (x) => {
                    return (
                        x! <= toNano(protocolFeeSupply.toFixed(9)) &&
                        x! >= toNano((protocolFeeSupply - 0.01).toFixed(9))
                    );
                },
                exitCode: CrossChainLayerErrors.noErrors,
            });

            protocolFeeSupply = 0;

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-7: change sequencer multisig', () => {
        it('CCL-7.1: should throw error if sender is not sequencer multisig', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendChangeSequencerMultisig(anyone.getSender(), toNano('0.01'), {
                sequencerMultisigAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_changeSequencerMultisigAddress, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-7.2: should save new sequencer multisig address', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendChangeSequencerMultisig(admin.getSender(), toNano('0.01'), {
                sequencerMultisigAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_changeSequencerMultisigAddress, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            sequencerMultisigAddress = anyone.address.toString();

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-8: change admin', () => {
        it('CCL-8.1: should throw error if sender is not admin', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendChangeAdmin(anyone.getSender(), toNano('0.01'), {
                adminAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_changeAdminAddress, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-8.2: should throw error if new_admin_address is none', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendChangeAdmin(admin.getSender(), toNano('0.01'), {
                adminAddress: undefined,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_changeAdminAddress, 32)
                    .storeUint(0, 64)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.newAdminAddressIsNone,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: admin.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-8.3: should save new admin address', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendChangeAdmin(admin.getSender(), toNano('0.01'), {
                adminAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_changeAdminAddress, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            newAdminAddress = anyone.address.toString();

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-9: cancel changing admin address', () => {
        it('CCL-9.1: should throw error if sender is not admin', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendCancelChangingAdmin(anyone.getSender(), toNano('0.01'));

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_cancelChangingAdminAddress, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-9.2: should set new_admin_address to undefined', async () => {
            newAdminAddress = anyone.address.toString();
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendCancelChangingAdmin(admin.getSender(), toNano('0.01'));

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_cancelChangingAdminAddress, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            newAdminAddress = undefined;
            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-10: confirm changing admin address', () => {
        it('CCL-10.1: should throw error if sender is not new_admin', async () => {
            newAdminAddress = anyone.address.toString();
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendConfirmNewAdmin(admin.getSender(), toNano('0.01'));

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.newAdmin_confirmChangingAdminAddress, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromNewAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: admin.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-10.2: should set admin and set new_admin to undefined', async () => {
            newAdminAddress = anyone.address.toString();
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const result = await crossChainLayer.sendConfirmNewAdmin(anyone.getSender(), toNano('0.01'));

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.newAdmin_confirmChangingAdminAddress, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            adminAddress = newAdminAddress;
            newAdminAddress = undefined;

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-11: change fee amount', () => {
        it('CCL-11.1: should throw error if sender is not admin', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newFeeAmount = 1;
            const result = await crossChainLayer.sendUpdateTacProtocolFeeAmount(anyone.getSender(), toNano('0.01'), {
                tacProtocolFee: newFeeAmount,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateTacProtocolFee, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(newFeeAmount.toFixed(9)))
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-11.2: should save new tac protocol fee amount', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newFeeAmount = 1;
            const result = await crossChainLayer.sendUpdateTacProtocolFeeAmount(admin.getSender(), toNano('0.01'), {
                tacProtocolFee: newFeeAmount,
            });

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateTacProtocolFee, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(newFeeAmount.toFixed(9)))
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            tacProtocolFee = newFeeAmount;

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-11.2: should save new tpn protocol fee amount', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newFeeAmount = 1;
            const result = await crossChainLayer.sendUpdateTonProtocolFeeAmount(admin.getSender(), toNano('0.01'), {
                tonProtocolFee: newFeeAmount,
            });

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateTonProtocolFee, 32)
                    .storeUint(0, 64)
                    .storeCoins(toNano(newFeeAmount.toFixed(9)))
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            tonProtocolFee = newFeeAmount;

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-12: update code', () => {
        it('CCL-12.1: should throw error if sender is not admin', async () => {
            await deployCrossChainLayer();

            let info = await blockchain.getContract(crossChainLayer.address);
            expect(info.accountState!.type).toBe('active');
            let crossChainLayerCode = info.accountState!.type === 'active' ? info.accountState!.state!.code! : null;
            expect(crossChainLayerCode!.hash().toString()).toBe(code.hash().toString());

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newCode = await compile('CrossChainLayerForUpdateCodeTest');
            const newData = crossChainLayerConfigToCell(config);
            const result = await crossChainLayer.sendUpdateCode(anyone.getSender(), toNano('0.01'), {
                code: newCode,
                data: newData,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateCode, 32)
                    .storeUint(0, 64)
                    .storeRef(newCode)
                    .storeRef(newData)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            info = await blockchain.getContract(crossChainLayer.address);
            expect(info.accountState!.type).toBe('active');
            crossChainLayerCode = info.accountState!.type === 'active' ? info.accountState!.state!.code! : null;
            expect(crossChainLayerCode!.hash().toString()).toBe(code.hash().toString());

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-12.2: should set new', async () => {
            await deployCrossChainLayer();

            let info = await blockchain.getContract(crossChainLayer.address);
            expect(info.accountState!.type).toBe('active');
            let crossChainLayerCode = info.accountState!.type === 'active' ? info.accountState!.state!.code! : null;
            expect(crossChainLayerCode!.hash().toString()).toBe(code.hash().toString());

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newCode = await compile('CrossChainLayerForUpdateCodeTest');

            epochDelay = 12345;
            config.epochDelay = epochDelay;
            const newData = crossChainLayerConfigToCell(config);
            const result = await crossChainLayer.sendUpdateCode(admin.getSender(), toNano('0.01'), {
                code: newCode,
                data: newData,
            });

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateCode, 32)
                    .storeUint(0, 64)
                    .storeRef(newCode)
                    .storeRef(newData)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            info = await blockchain.getContract(crossChainLayer.address);
            expect(info.accountState!.type).toBe('active');
            crossChainLayerCode = info.accountState!.type === 'active' ? info.accountState!.state!.code! : null;
            expect(crossChainLayerCode!.hash().toString()).toBe(newCode.hash().toString());

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-13: change epoch delay', () => {
        it('CCL-13.1: should throw error if sender is not admin', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newEpochDelay = 125;
            const result = await crossChainLayer.sendUpdateEpochDelay(anyone.getSender(), toNano('0.01'), {
                epochDelay: newEpochDelay,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateEpochDelay, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(newEpochDelay, Params.bitsize.time)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-13.2: should save new epoch delay', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newEpochDelay = 123;
            const result = await crossChainLayer.sendUpdateEpochDelay(admin.getSender(), toNano('0.01'), {
                epochDelay: newEpochDelay,
            });

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateEpochDelay, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(newEpochDelay, Params.bitsize.time)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            epochDelay = newEpochDelay;

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-14: update executor code', () => {
        it('CCL-14.1: should throw error if sender is not admin', async () => {
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newCode = await compile('ExecutorForUpdateCodeTest');
            const result = await crossChainLayer.sendUpdateExecutorCode(anyone.getSender(), toNano('0.01'), {
                code: newCode,
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateExecutorCode, 32)
                    .storeUint(0, 64)
                    .storeRef(newCode)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });

        it('CCL-14.2: should set new executor code and emit event', async () => {
            merkleRoots = [
                { root: 0n, validTimestamp: 1 },
                { root: 1n, validTimestamp: 2 },
                { root: 2n, validTimestamp: 3 },
            ];
            await deployCrossChainLayer();

            const initBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const newExecutorCode = await compile('ExecutorForUpdateCodeTest');
            const result = await crossChainLayer.sendUpdateExecutorCode(admin.getSender(), toNano('0.01'), {
                code: newExecutorCode,
            });

            expect(result.transactions.length).toBe(2);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.admin_updateExecutorCode, 32)
                    .storeUint(0, 64)
                    .storeRef(newExecutorCode)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 1,
            });

            const logPayload = beginCell().endCell();

            expect(result.transactions[1].outMessagesCount).toBe(1);
            expect(result.transactions[1].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(result.transactions[1].outMessages.get(0)?.body.hash().toString()).toBe(
                logPayload.hash().toString(),
            );

            executorCode = newExecutorCode;
            merkleRoots = [];

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, crossChainLayer, result, initBalance);
        });
    });

    describe('CCL-15: error notifications', () => {
        /*
         * Executor sends message to CCL with insufficient funds
         * in order to CCL fail and return bounced message back
         */

        let executor: SandboxContract<Executor>;
        let merkleProof: Cell;
        let payload: Cell;

        beforeEach(async () => {
            prevEpoch = 0;
            currEpoch = 1;
            epochDelay = 0;
            nextVotingTime = 0;

            await deployCrossChainLayer();

            const executorFeeValue = toNano('0.01');
            const messages: Message[] = [
                {
                    entries: [
                        {
                            operationId: toNano('1'),
                            destinationAddress: anyone.address,
                            destinationMsgValue: toNano('10'),
                            msgBody: beginCell().storeUint(12345, Params.bitsize.op).endCell(),
                            payloadNumber: Math.round(Math.random() * 100),
                        },
                    ],
                    validExecutors: [anyone.address],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: executorFeeValue,
                },
            ];
            const messagesDict = generateMsgsDictionaryBatching(messages);
            const dictCell = beginCell().storeDictDirect(messagesDict).endCell();
            payload = getCellByMessage(messages[0]);
            merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots = [merkleRoot];

            const setRootResult = await crossChainLayer.sendUpdateMerkleRoot(
                sequencerMultisig.getSender(),
                toNano('0.01'),
                {
                    merkleRoot: merkleRoot.root,
                    messageCollectEndTime: nextVotingTime,
                },
            );
            expect(setRootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            executor = blockchain.openContract(
                Executor.createFromConfig(
                    {
                        isSpent: false,
                        crossChainLayerAddress: crossChainLayer.address.toString(),
                        payload: payload,
                    },
                    executorCode,
                ),
            );

            await executor.sendDeploy(anyone.getSender(), toNano('0.1'));
        });

        it('CCL-15.1: should emit log and send notification to response address', async () => {
            // Sending 1 TON while crosschain amount is 10 TON will lead to fail on CCL
            const res = await executor.sendProxyMsg(anyone.getSender(), toNano('1'), {
                feeToAddress: anyone.address.toString(),
                merkleProof,
                responseAddress: anyone.address.toString(),
            });
            printTransactionFees(res.transactions);

            // wallet -> executor -> ccl -> executor -> ccl -> 1.log, 2.response
            expect(res.transactions.length).toBe(6);

            expect(res.transactions).toHaveTransaction({
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.executor_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notEnoughTon,
            });

            expect(res.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: executor.address,
                inMessageBounced: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.executor_errorNotification, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                op: ExecutorOpCodes.executor_errorNotification,
                success: true,
            });

            const logPayload = payload;

            expect(res.transactions[4].outMessagesCount).toBe(2);
            expect(res.transactions[4].outMessages.get(0)?.info.src!.toString()).toEqual(
                crossChainLayer.address.toString(),
            );
            expect(res.transactions[4].outMessages.get(0)?.body.hash().toString()).toBe(logPayload.hash().toString());
        });

        it('CCL-15.2: should throw error if sender is not executor contract', async () => {
            const res = await crossChainLayer.sendErrorNotification(anyone.getSender(), toNano('1'), {
                payload: payload,
                responseAddress: anyone.address,
            });

            // wallet -> ccl -> wallet
            expect(res.transactions.length).toBe(3);

            expect(res.transactions).toHaveTransaction({
                from: anyone.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.executor_errorNotification, 32)
                    .storeUint(0, 64)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notFromExecutor,
            });

            expect(res.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                success: true,
                inMessageBounced: true,
            });
        });
    });

    describe('CCL-16: get methods', () => {
        beforeEach(async () => {
            prevEpoch = 0;
            currEpoch = 1;
            epochDelay = 0;
            nextVotingTime = 0;

            merkleRoots = [{ root: 123123n, validTimestamp: 1 }];
            epochDelay = 10;
            await deployCrossChainLayer();
        });

        it('CCL-16.1: get_full_data', async () => {
            const data = await crossChainLayer.getFullData();
            console.log(data);
            expect(data.adminAddress).toBe(adminAddress);
            expect(data.newAdminAddress).toBe(newAdminAddress);
            expect(data.sequencerMultisigAddress).toBe(sequencerMultisigAddress);
            expect(data.merkleRoots).toStrictEqual(merkleRoots);
            expect(data.maxRootsSize).toBe(maxRootsSize);
            expect(data.prevEpoch).toBe(prevEpoch);
            expect(data.currEpoch).toBe(currEpoch);
            expect(data.epochDelay).toBe(epochDelay);
            expect(data.nextVotingTime).toBe(nextVotingTime);
            expect(data.messageCollectEndTime).toBe(messageCollectEndTime);
            expect(data.protocolFeeSupply).toBe(protocolFeeSupply);
            expect(data.tacProtocolFee).toBe(tacProtocolFee);
            expect(data.tonProtocolFee).toBe(tonProtocolFee);
            expect(data.executorCode.hash().toString()).toBe(executorCode.hash().toString());
        });

        it('CCL-16.2: get_current_epoch_info', async () => {
            const result = await crossChainLayer.getCurrentEpochInfo();
            console.log(result);
            expect(result.lastMerkleRoot).toBe(123123n);
            expect(result.prevEpoch).toBe(prevEpoch);
            expect(result.currEpoch).toBe(currEpoch);
            expect(result.nextVotingTime).toBe(nextVotingTime);
            expect(result.messageCollectEndTime).toBe(messageCollectEndTime);
            expect(result.epochDelay).toBe(epochDelay);
            expect(result.maxRootsSize).toBe(maxRootsSize);
        });

        it('CCL-16.3: get_executor_address', async () => {
            const executorFeeValue = toNano('0.02');
            const message: Message = {
                entries: [
                    {
                        operationId: toNano('1'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('10'),
                        msgBody: beginCell().storeUint(12345, Params.bitsize.op).endCell(),
                        payloadNumber: Math.round(Math.random() * 100),
                    },
                ],
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: executorFeeValue,
            };

            const entryCell = getCellByMessage(message);
            const address = await crossChainLayer.getExecutorAddress(entryCell);
            console.log(address);
            expect(address).toBeDefined();
            expect(address).toBeInstanceOf(Address);
        });

        it('CCL-16.4: get_executor_data', async () => {
            const executorFeeValue = toNano('0.02');
            const message: Message = {
                entries: [
                    {
                        operationId: toNano('1'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('10'),
                        msgBody: beginCell().storeUint(12345, Params.bitsize.op).endCell(),
                        payloadNumber: Math.round(Math.random() * 100),
                    },
                ],
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: executorFeeValue,
            };

            const entryCell = getCellByMessage(message);
            const result = await crossChainLayer.getExecutorData(entryCell);
            console.log(result);
            expect(result.address).toBeDefined();
            expect(result.address).toBeInstanceOf(Address);
            expect(result.stateInit).toBeDefined;
            expect(result.stateInit).toBeInstanceOf(Cell);
        });
    });
});
