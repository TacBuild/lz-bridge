import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { Executor, ExecutorErrors, ExecutorOpCodes } from '../wrappers/Executor';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {calculateFeesData, calculateMaxStorageState, deployTestToken, NATIVE_TAC_ADDRESS} from "./utils";
import {generateWrongMsgDictionary, getValidExecutorsDict, getCellByMessage, generateMsgsDictionaryBatching, Message} from "../wrappers/utils/MsgUtils";
import { storageGeneric } from '../wrappers/utils/GasUtils';

describe('Executor', () => {
    let blockchain: Blockchain;
    let anyone: SandboxContract<TreasuryContract>;
    let invalidExecutor: SandboxContract<TreasuryContract>;
    let crossChainLayer: SandboxContract<TreasuryContract>;
    let executor: SandboxContract<Executor>;
    let code: Cell;
    let wTACTokenAddress: Address;

    let crossChainLayerAddress: string;
    let lastExecutorAddress: string | undefined;
    let isSpent: boolean;
    let payload: Cell;

    let initBalance: bigint;

    let initialState: BlockchainSnapshot;

    async function checkFullData() {
        const data = await executor.getFullData();
        expect(data.crossChainLayerAddress).toBe(crossChainLayerAddress);
        expect(data.lastExecutorAddress).toBe(lastExecutorAddress);
        expect(data.isSpent).toBe(isSpent);
        expect(data.payload.hash().toString()).toBe(payload.hash().toString());
    }

    async function deployExecutor() {
        executor = blockchain.openContract(
            Executor.createFromConfig(
                {
                    isSpent,
                    crossChainLayerAddress,
                    lastExecutorAddress,
                    payload: payload,
                },
                code,
            ),
        );

        const deployResult = await executor.sendDeploy(anyone.getSender(), toNano('0.01'));

        expect(deployResult.transactions).toHaveTransaction({
            from: anyone.address,
            to: executor.address,
            deploy: true,
            success: true,
        });

        initBalance = (await blockchain.getContract(executor.address)).balance;
    }

    beforeAll(async () => {
        blockchain = await Blockchain.create();

        // libs
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        const executorCodeRaw = await compile('Executor');
        const jettonWalletCodeRaw = await compile('JettonWallet');
        _libs.set(BigInt(`0x${executorCodeRaw.hash().toString('hex')}`), executorCodeRaw);
        _libs.set(BigInt(`0x${jettonWalletCodeRaw.hash().toString('hex')}`), jettonWalletCodeRaw);
        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();

        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();
        let lib_executor_prep = beginCell().storeUint(2, 8).storeBuffer(executorCodeRaw.hash()).endCell();
        code = new Cell({ exotic: true, bits: lib_executor_prep.bits, refs: lib_executor_prep.refs });

        anyone = await blockchain.treasury('anyone');
        invalidExecutor = await blockchain.treasury('invalidExecutor');

        crossChainLayer = await blockchain.treasury('crossChainLayer');
        isSpent = false;
        crossChainLayerAddress = crossChainLayer.address.toString();
        lastExecutorAddress = undefined;

        wTACTokenAddress = await deployTestToken(blockchain, crossChainLayer.address, NATIVE_TAC_ADDRESS);

        const validExecutorsDict = getValidExecutorsDict([anyone.address])
        payload = beginCell()
        .storeDict()
        .storeDict(validExecutorsDict)
        .storeAddress(wTACTokenAddress)
        .storeCoins(0)
        .endCell();

        initialState = blockchain.snapshot();
    });

    afterEach(async () => {
        await checkFullData();

        await blockchain.loadFrom(initialState);

        isSpent = false;
        lastExecutorAddress = undefined;
        const validExecutorsDict = getValidExecutorsDict([anyone.address])
        payload = beginCell()
                .storeDict()
                .storeDict(validExecutorsDict)
                .storeAddress(wTACTokenAddress)
                .storeCoins(0)
                .endCell();
    });

    describe('E-1: storage gas stats', () => {
        it('E-1.1: storage estimates', async () => {
            const messages: Message[] = [
                {
                    entries: [{
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
                    }],
                    validExecutors: [
                        anyone.address,
                    ],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.1'),    
                }
            ];

            payload = getCellByMessage(messages[0]);

            await deployExecutor();

            let timeSpan = 14 * 24 * 3600;
            const expTime = Math.floor(Date.now() / 1000) + timeSpan;
            blockchain.now = expTime - 10;

            let messagesDict = generateMsgsDictionaryBatching(messages);
            const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);
    
            console.log(anyone.getSender());
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.1'), {
                feeToAddress: anyone.address.toString(),
                merkleProof,
            });

            printTransactionFees(result.transactions);

            const storagePhase = storageGeneric(result.transactions[1]);
            const actualStorage = storagePhase?.storageFeesCollected;
            console.log('Storage estimates:', Number(actualStorage) / 10 ** 9, ' TON');

            isSpent = true;
            lastExecutorAddress = anyone.address.toString();
        });

        it('E-1.2: estimate storage usage(bits and cells)', async () => {
            await deployExecutor();
            await calculateMaxStorageState(blockchain, 'executor', executor.address);
        });
    });

    describe('E-2: proxy', () => {
        it('E-2.1: should throw error if already spent', async () => {
            isSpent = true;
            await deployExecutor();

            const merkleProof = beginCell().storeUint(12345, 32).endCell();
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.05'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, 32)
                    .storeUint(0, 64)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                exitCode: ExecutorErrors.alreadySpent,
            });

            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: anyone.address,
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, executor, result, initBalance);
        });

        it('E-2.2: should throw error if proof cell is not exotic', async () => {
            await deployExecutor();

            const merkleProof = beginCell().storeUint(12345, 32).endCell();
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.02'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, 32)
                    .storeUint(0, 64)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                exitCode: ExecutorErrors.proofIsNotExoticCell,
            });

            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: anyone.address,
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, executor, result, initBalance);
        });

        it('E-2.3: should throw error if proof cell type is not merkle proof', async () => {
            await deployExecutor();

            const messages: Message[] = [
                {
                    entries: [{
                        operationId: toNano('1'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('1'),
                        msgBody: beginCell().storeUint(12345, 32).endCell(),
                        payloadNumber: Math.round(Math.random() * 100)
                    }],
                    validExecutors: [
                        anyone.address,
                    ],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.01'),
                },
                {
                    entries: [{
                        operationId: toNano('2'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('2'),
                        msgBody: beginCell().storeUint(67890, 32).endCell(),
                        payloadNumber: Math.round(Math.random() * 100)
                    }],
                    validExecutors: [
                        anyone.address,
                    ],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.01'),
                }
            ];    

            const messagesDict = generateMsgsDictionaryBatching(messages);
            const merkleProof = messagesDict.generateMerkleUpdate(getCellByMessage(messages[0]).hash(), true);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano("0.1"), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
            });
    
            expect(result.transactions.length).toBe(3);
    
            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, 32)
                    .storeUint(0, 64)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                exitCode: ExecutorErrors.invalidProofCellType
            });
    
            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: anyone.address,
                success: true,
                exitCode: ExecutorErrors.noErrors
            });
        
            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, executor, result, initBalance);
        });

        it('E-2.4: should throw error if proof is invalid (not found payload in payload_dict)', async () => {
            await deployExecutor();

            const dict = generateWrongMsgDictionary();
            const msgIndex = 0n;
            const merkleProof = dict.generateMerkleProof([msgIndex]);
    
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano("0.02"), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
            });    

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, 32)
                    .storeUint(0, 64)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                exitCode: ExecutorErrors.invalidProof
            });
    
            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: anyone.address,
                success: true,
                exitCode: ExecutorErrors.noErrors
            });    

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, executor, result, initBalance);
        });

        it('E-2.5: should throw error unauthorized executor', async () => {
            const messages: Message[] = [
                {
                    entries: [{
                        operationId: toNano('1'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('0.01'),
                        msgBody: beginCell().storeUint(12345, 32).endCell(),
                        payloadNumber: Math.round(Math.random() * 100)
                    }],
                    validExecutors: [
                        anyone.address,
                    ],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.01'),
                }
            ];

            payload = getCellByMessage(messages[0]);

            await deployExecutor();

            let messagesDict = generateMsgsDictionaryBatching(messages);
            const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

            const result = await executor.sendProxyMsg(invalidExecutor.getSender(), toNano("0.1"), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: invalidExecutor.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, 32)
                    .storeUint(0, 64)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                exitCode: ExecutorErrors.unauthorizedExecutor
            });

            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: invalidExecutor.address,
                success: true,
                exitCode: ExecutorErrors.noErrors
            });

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, executor, result, initBalance);
        });

        it('E-2.5: should send msg to crossChainLayer', async () => {
                const messages: Message[] = [
                {
                    entries: [{
                        operationId: toNano('1'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('1'),
                        msgBody: beginCell().storeUint(12345, 32).endCell(),
                        payloadNumber: Math.round(Math.random() * 100)
                    }],
                    validExecutors: [
                        anyone.address,
                    ],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.02'),
                },
                {
                    entries: [{
                        operationId: toNano('2'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('2'),
                        msgBody: beginCell().storeUint(67890, 32).endCell(),
                        payloadNumber: Math.round(Math.random() * 100)
                    }],
                    validExecutors: [
                        anyone.address,
                    ],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.02'),
                },
                {
                    entries: [{
                        operationId: toNano('3'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('3'),
                        msgBody: beginCell().storeUint(11235, 32).endCell(),
                        payloadNumber: Math.round(Math.random() * 100)
                    }],
                    validExecutors: [
                        anyone.address,
                    ],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.02'),
                },
            ];

            payload = getCellByMessage(messages[0]);

            await deployExecutor();

            let messagesDict = generateMsgsDictionaryBatching(messages);
            const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

            const result = await executor.sendProxyMsg(anyone.getSender(), toNano("2"), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
            });

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, 32)
                    .storeUint(0, 64)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(null)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors
            });

            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(null)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors
            });

            isSpent = true;
            lastExecutorAddress = anyone.address.toString();

            printTransactionFees(result.transactions);
            await calculateFeesData(blockchain, executor, result, initBalance);
        });
    });

    describe('E-3: get methods', () => {
        it('E-3.1: get_full_data', async () => {
            await deployExecutor();
            const data = await executor.getFullData();
            console.log(data);
            expect(data.crossChainLayerAddress).toBe(crossChainLayerAddress);
            expect(data.lastExecutorAddress).toBe(lastExecutorAddress);
            expect(data.isSpent).toBe(isSpent);
            expect(data.payload.hash().toString()).toBe(payload.hash().toString());
        });

        it('E-3.2: get_check_proof', async () => {
            const messages: Message[] = [
                {
                    entries: [{
                        operationId: toNano('1'),
                        destinationAddress: anyone.address,
                        destinationMsgValue: toNano('1'),
                        msgBody: beginCell().storeUint(12345, 32).endCell(),
                        payloadNumber: Math.round(Math.random() * 100),
                    }],
                    validExecutors: [
                        anyone.address,
                    ],
                    executorFeeToken: wTACTokenAddress,
                    executorFeeValue: toNano('0.2'),
                },
            ];

            payload = getCellByMessage(messages[0]);

            await deployExecutor();

            let messagesDict = generateMsgsDictionaryBatching(messages);
            const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);

            const checkProofResult = await executor.getCheckProof(merkleProof);

            expect(checkProofResult).toBeTruthy();
        });

        it('E-3.3: get_is_valid_executor', async () => {
            await deployExecutor();
            const isValid = await executor.getIsValidExecutor(anyone.address);
            const notValid = await executor.getIsValidExecutor(invalidExecutor.address);

            expect(isValid).toBe(true);
            expect(notValid).toBe(false);
        });
    });
});
