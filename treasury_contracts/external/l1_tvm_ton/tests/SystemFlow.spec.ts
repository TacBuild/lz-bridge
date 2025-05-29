import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, ExternalAddress, toNano } from '@ton/core';
import { findTransactionRequired } from '@ton/test-utils';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import {
    CrossChainLayer,
    CrossChainLayerErrors,
    CrossChainLayerOpCodes,
    OperationType,
} from '../wrappers/CrossChainLayer';
import { Executor, ExecutorErrors, ExecutorOpCodes } from '../wrappers/Executor';
import { JettonProxy, JettonProxyErrors, JettonProxyOpCodes } from '../wrappers/JettonProxy';
import { Message, MsgEntry, generateMsgsDictionaryBatching, getCellByMessage } from '../wrappers/utils/MsgUtils';
import { Params } from '../wrappers/Constants';
import { deployTestToken, NATIVE_TAC_ADDRESS, sumTxFees, sumTxForwardFees, sumTxUsedGas } from './utils';
import { JettonWallet, JettonWalletErrors, JettonWalletOpCodes } from '../wrappers/JettonWallet';
import { JettonMinter, JettonMinterErrors, JettonMinterOpCodes } from '../wrappers/JettonMinter';
import { arrayToCell, MerkleRoot } from '../wrappers/utils/MerkleRoots';
import { NFTCollection } from '../wrappers/NFTCollection';
import { NFTItem, NFTItemOpCodes } from '../wrappers/NFTItem';
import { NFTProxy } from '../wrappers/NFTProxy';

describe('SystemFlow', () => {
    let initialState: BlockchainSnapshot;

    let curTime: () => number;

    // CrossChainLayer
    let crossChainLayerCode: Cell;
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;
    let response: SandboxContract<TreasuryContract>;
    let sequencerMultisig: SandboxContract<TreasuryContract>;
    let crossChainLayer: SandboxContract<CrossChainLayer>;
    let msgEntries: MsgEntry[];
    let msgDict: Dictionary<Buffer, boolean>;

    let adminAddress: string;
    let sequencerMultisigAddress: string;
    let merkleRoots: MerkleRoot[];
    let prevEpoch: number;
    let currEpoch: number;
    let epochDelay: number;
    let nextVotingTime: number;
    let messageCollectEndTime: number;
    let tacProtocolFee: number;
    let tonProtocolFee: number;
    let protocolFeeSupply: number;
    let tacExecutorFee: number;
    let tonExecutorFee: number;
    let initialTonLock = 0;
    let maxRootsSize = 3;

    // Executor
    let executor: SandboxContract<Executor>;
    let executorCode: Cell;

    let isSpent: boolean;
    let payload: Cell;

    // JettonProxy
    let jettonProxy: SandboxContract<JettonProxy>;
    let jettonProxyCode: Cell;

    // Jetton Wallet
    let jettonMinterSandBox: SandboxContract<TreasuryContract>;
    let jettonWalletCode: Cell;
    let jettonMinter: SandboxContract<JettonMinter>;
    let jettonMinterCode: Cell;

    let wTACTokenAddress: Address;
    // NFT
    let nftCollectionFake: SandboxContract<TreasuryContract>;
    let nftCollection: SandboxContract<NFTCollection>;
    let nftItem: SandboxContract<NFTItem>;
    let nftItemCode: Cell;
    let nftProxy: SandboxContract<NFTProxy>;

    async function checkCrossChainLayerFullData() {
        const data = await crossChainLayer.getFullData();
        expect(data.adminAddress).toBe(adminAddress);
        expect(data.newAdminAddress).toBe(undefined);
        expect(data.sequencerMultisigAddress).toBe(sequencerMultisigAddress);
        expect(data.merkleRoots?.length).toBe(merkleRoots.length);
        const expectedRoots = merkleRoots.sort((a, b) => a.validTimestamp - b.validTimestamp);
        const receivedRoots = data.merkleRoots?.sort((a, b) => a.validTimestamp - b.validTimestamp);
        expect(receivedRoots).toStrictEqual(expectedRoots);
        expect(data.prevEpoch).toBe(prevEpoch);
        expect(data.currEpoch).toBe(currEpoch);
        expect(data.epochDelay).toBe(epochDelay);
        expect(data.maxRootsSize).toBe(maxRootsSize);
        expect(data.messageCollectEndTime).toBe(messageCollectEndTime);
        expect(data.nextVotingTime).toBe(nextVotingTime);
        expect(data.currEpoch).toBeGreaterThan(prevEpoch);
        expect(data.tacProtocolFee).toBe(tacProtocolFee);
        expect(data.tonProtocolFee).toBe(tonProtocolFee);
        expect(data.protocolFeeSupply).toBe(protocolFeeSupply);
        expect(data.executorCode.hash().toString()).toBe(executorCode.hash().toString());
    }

    async function deployNFTCollection() {
        nftCollection = blockchain.openContract(
            NFTCollection.createFromConfig(
                {
                    ownerAddress: crossChainLayer.address,
                    content: beginCell().endCell(),
                    nftItemCode: nftItemCode,
                    originalAddress: '0x1234',
                },
                await compile('NFTCollection'),
            ),
        );

        const deployResult = await nftCollection.sendDeploy(admin.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: nftCollection.address,
            deploy: true,
            success: true,
        });
    }

    async function deploySingleNFTItem(to?: Address) {
        to = to ?? anyone.address;
        nftCollectionFake = await blockchain.treasury('nftCollectionFake');
        nftItem = blockchain.openContract(
            NFTItem.createFromConfig(
                {
                    init: true,
                    index: 0,
                    collectionAddress: nftCollectionFake.address,
                    ownerAddress: to,
                    content: beginCell().endCell(),
                    cclAddress: crossChainLayer.address,
                },
                nftItemCode,
            ),
        );
        await nftItem.sendDeploy(admin.getSender(), toNano('0.05'));
    }

    async function deployNFTProxy() {
        nftProxy = blockchain.openContract(
            NFTProxy.createFromConfig(
                {
                    cclAddress: crossChainLayer.address,
                    adminAddress: admin.address,
                },
                await compile('NFTProxy'),
            ),
        );
        const deployResult = await nftProxy.sendDeploy(admin.getSender(), toNano('0.05'));
        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: nftProxy.address,
            deploy: true,
            success: true,
        });
    }

    async function deployCrossChainLayer() {
        crossChainLayer = blockchain.openContract(
            CrossChainLayer.createFromConfig(
                {
                    adminAddress,
                    executorCode,
                    messageCollectEndTime,
                    merkleRoots,
                    prevEpoch,
                    currEpoch,
                    epochDelay,
                    maxRootsSize,
                    nextVotingTime,
                    tacProtocolFee,
                    tonProtocolFee,
                    protocolFeeSupply,
                    sequencerMultisigAddress,
                },
                crossChainLayerCode,
            ),
        );

        const deployResult = await crossChainLayer.sendDeploy(admin.getSender(), toNano(0.5 + initialTonLock));

        expect(deployResult.transactions.length).toBe(2);

        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: crossChainLayer.address,
            body: beginCell().endCell(),
            initData: beginCell()
                .storeAddress(Address.parse(adminAddress))
                .storeAddress(null)
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

        await checkCrossChainLayerFullData();

        wTACTokenAddress = await deployTestToken(blockchain, crossChainLayer.address, NATIVE_TAC_ADDRESS);

        await setMessages();
    }

    function generateFeeData() {
        return beginCell()
            .storeUint(1, 1)
            .storeCoins(toNano((tacProtocolFee + tonProtocolFee).toFixed(9)))
            .storeCoins(toNano(tacExecutorFee.toFixed(9)))
            .storeCoins(toNano(tonExecutorFee.toFixed(9)))
            .endCell();
    }

    async function setMessages() {
        const destination = await blockchain.treasury('destination');

        msgEntries = [
            {
                operationId: toNano('1'),
                destinationAddress: destination.address,
                destinationMsgValue: toNano('1'),
                msgBody: beginCell().storeUint(12345, 32).endCell(),
                payloadNumber: 54321,
            },
            {
                operationId: toNano('2'),
                destinationAddress: destination.address,
                destinationMsgValue: toNano('2'),
                msgBody: beginCell().storeUint(67890, 32).endCell(),
                payloadNumber: 12345,
            },
        ];

        for (let i = 0; i < 100; i++) {
            const msgBody = Math.round(Math.random() * 100);
            const payloadNumber = Math.round(Math.random() * 100);
            msgEntries.push({
                operationId: toNano(i),
                destinationAddress: destination.address,
                destinationMsgValue: toNano('1'),
                msgBody: beginCell().storeUint(msgBody, 32).endCell(),
                payloadNumber: payloadNumber,
            });
        }
    }

    async function checkExecutorFullData() {
        const data = await executor.getFullData();
        expect(data.crossChainLayerAddress).toBe(crossChainLayer.address.toString());
        expect(data.isSpent).toBe(isSpent);
        expect(data.payload.hash().toString()).toBe(payload.hash().toString());
    }

    async function deployExecutor() {
        executor = blockchain.openContract(
            Executor.createFromConfig(
                {
                    isSpent,
                    crossChainLayerAddress: crossChainLayer.address.toString(),
                    payload,
                },
                executorCode,
            ),
        );

        const deployResult = await executor.sendDeploy(anyone.getSender(), toNano('0.02'));

        expect(deployResult.transactions).toHaveTransaction({
            from: anyone.address,
            to: executor.address,
            deploy: true,
            success: true,
        });

        const totalGas = deployResult.transactions.reduce(sumTxUsedGas, 0n);
        const totalFees =
            deployResult.transactions.reduce(sumTxFees, 0n) + deployResult.transactions.reduce(sumTxForwardFees, 0n);

        return {
            totalGas: totalGas,
            totalFees: totalFees,
        };
    }

    async function deployJettonWalletWithBalance(ownerAddress: string, jettonBalance: number) {
        const jettonWallet = blockchain.openContract(
            JettonWallet.createFromConfig(
                {
                    balance: 0,
                    ownerAddress,
                    jettonMasterAddress: jettonMinterSandBox.address.toString(),
                },
                await compile('JettonWallet'),
            ),
        );

        const deployResult = await jettonWallet.sendDeploy(jettonMinterSandBox.getSender(), toNano('0.01'));

        expect(deployResult.transactions).toHaveTransaction({
            from: jettonMinterSandBox.address,
            to: jettonWallet.address,
            deploy: true,
            success: true,
        });

        if (jettonBalance > 0) {
            await jettonWallet.sendReceive(jettonMinterSandBox.getSender(), toNano('0.1'), {
                jettonAmount: jettonBalance,
            });
        }

        expect((await jettonWallet.getWalletData()).balance).toBe(jettonBalance);
        return jettonWallet;
    }

    async function deployJettonProxy() {
        jettonProxy = blockchain.openContract(
            JettonProxy.createFromConfig(
                {
                    crossChainLayerAddress: crossChainLayer.address.toString(),
                    adminAddress: admin.address.toString(),
                },
                jettonProxyCode,
            ),
        );

        const deployResult = await jettonProxy.sendDeploy(admin.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: jettonProxy.address,
            deploy: true,
            success: true,
        });
    }

    async function deployJettonMinter() {
        const jettonMinterConfig = {
            adminAddress: admin.address,
            content: beginCell().endCell(),
            jettonWalletCode,
            evmTokenAddress: '0x1234',
            totalSupply: 0,
        };

        jettonMinter = blockchain.openContract(JettonMinter.createFromConfig(jettonMinterConfig, jettonMinterCode));

        const deployResult = await jettonMinter.sendDeploy(admin.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: jettonMinter.address,
            deploy: true,
            success: true,
        });
    }

    async function getJettonWallet(owner: Address) {
        return blockchain.openContract(JettonWallet.createFromAddress(await jettonMinter.getWalletAddress(owner)));
    }

    async function mintTokens(to: Address, mintAmount: number, responseAddress?: Address) {
        const res = await jettonMinter.sendMint(admin.getSender(), toNano('1'), {
            to,
            jettonAmount: mintAmount,
            responseAddress,
            forwardTonAmount: 0,
            forwardPayload: null,
            newContent: null,
        });
        expect(res.transactions).toHaveTransaction({
            from: admin.address,
            to: jettonMinter.address,
            body: JettonMinter.mintMessage(to, mintAmount, responseAddress),
            success: true,
        });

        expect(res.transactions).toHaveTransaction({
            from: jettonMinter.address,
            to: await jettonMinter.getWalletAddress(to),
            body: beginCell()
                .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                .storeUint(0, Params.bitsize.queryId)
                .storeCoins(toNano(mintAmount.toFixed(9)))
                .storeAddress(jettonMinter.address)
                .storeAddress(responseAddress ?? null)
                .storeCoins(0)
                .storeMaybeRef(null)
                .endCell(),
            success: true,
        });
    }

    async function giveMinterAdminToCrossChainLayer() {
        await jettonMinter.sendChangeAdmin(admin.getSender(), toNano(0.1), {
            newAdmin: crossChainLayer.address,
        });

        await jettonMinter.sendConfirmNewAdmin(blockchain.sender(crossChainLayer.address), toNano(0.1));
    }

    beforeAll(async () => {
        crossChainLayerCode = await compile('CrossChainLayer');
        jettonProxyCode = await compile('JettonProxy');
        jettonMinterCode = await compile('JettonMinter');

        blockchain = await Blockchain.create();

        const executorCodeRaw = await compile('Executor');
        const jettonWalletCodeRaw = await compile('JettonWallet');
        const nftItemCodeRaw = await compile('NFTItem');
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${executorCodeRaw.hash().toString('hex')}`), executorCodeRaw);
        _libs.set(BigInt(`0x${jettonWalletCodeRaw.hash().toString('hex')}`), jettonWalletCodeRaw);
        _libs.set(BigInt(`0x${nftItemCodeRaw.hash().toString('hex')}`), nftItemCodeRaw);
        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();

        let lib_executor_prep = beginCell().storeUint(2, 8).storeBuffer(executorCodeRaw.hash()).endCell();
        executorCode = new Cell({ exotic: true, bits: lib_executor_prep.bits, refs: lib_executor_prep.refs });

        let lib_jetton_prep = beginCell().storeUint(2, 8).storeBuffer(jettonWalletCodeRaw.hash()).endCell();
        jettonWalletCode = new Cell({ exotic: true, bits: lib_jetton_prep.bits, refs: lib_jetton_prep.refs });

        let lib_nft_prep = beginCell().storeUint(2, 8).storeBuffer(nftItemCodeRaw.hash()).endCell();
        nftItemCode = new Cell({ exotic: true, bits: lib_nft_prep.bits, refs: lib_nft_prep.refs });

        admin = await blockchain.treasury('admin');
        anyone = await blockchain.treasury('anyone');
        response = await blockchain.treasury('response');
        await response.send({
            value: toNano('1'),
            to: admin.address,
        });
        await anyone.send({
            value: toNano('1'),
            to: admin.address,
        });

        sequencerMultisig = await blockchain.treasury('sequencerMultisig');
        jettonMinterSandBox = await blockchain.treasury('jettonMaster');

        merkleRoots = [];
        prevEpoch = 0;
        currEpoch = 1;
        epochDelay = 0;
        messageCollectEndTime = 0;
        nextVotingTime = 1;

        adminAddress = admin.address.toString();
        sequencerMultisigAddress = sequencerMultisig.address.toString();

        tacProtocolFee = 0.01;
        tonProtocolFee = 0.02;
        protocolFeeSupply = 0;
        tacExecutorFee = 0.03;
        tonExecutorFee = 0.04;
        initialTonLock = 0;

        curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);

        initialState = blockchain.snapshot();
    });

    // Each case state is independent
    afterEach(async () => {
        await blockchain.loadFrom(initialState);

        blockchain.now = Math.floor(Date.now() / 1000);
        merkleRoots = [];
        prevEpoch = 0;
        currEpoch = 1;
        epochDelay = 0;
        messageCollectEndTime = 0;
        nextVotingTime = 1;
        adminAddress = admin.address.toString();
        sequencerMultisigAddress = sequencerMultisig.address.toString();
        tacProtocolFee = 0.01;
        tonProtocolFee = 0.02;
        protocolFeeSupply = 0;
        tacExecutorFee = 0.03;
        tonExecutorFee = 0.04;
        initialTonLock = 0;
    });

    describe('SF-1: tvm msg to evm', () => {
        describe('SF-1.1: transfer ton', () => {
            it('SF-1.1.1: successful', async () => {
                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
                const operationType = OperationType.tonTransfer;
                const crossChainTonAmount = 1;

                const feeData = generateFeeData();

                const tonAmount =
                    toNano(crossChainTonAmount.toFixed(9)) +
                    toNano('0.1') +
                    toNano(tacProtocolFee.toFixed(9)) +
                    toNano(tonProtocolFee.toFixed(9)) +
                    toNano(tacExecutorFee.toFixed(9)) +
                    toNano(tonExecutorFee.toFixed(9));
                const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), tonAmount, {
                    operationType,
                    responseAddress: anyone.address.toString(),
                    crossChainTonAmount,
                    feeData,
                    payload,
                });
                printTransactionFees(result.transactions);
                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(operationType, 32)
                        .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeSlice(payload)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 2,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                const logPayload = beginCell()
                    .storeUint(OperationType.tonTransfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
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

                expect(result.transactions[result.transactions.length - 2].outMessagesCount).toBe(2);
                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.info.src!.toString(),
                ).toEqual(crossChainLayer.address.toString());
                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.body.hash().toString(),
                ).toBe(logPayload.hash().toString());

                protocolFeeSupply += tacProtocolFee + tonProtocolFee;
                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

                const cost = totalFees + differenceCrossChainLayer;
                console.log(`
                    [TVM to EVM]: 
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    CrossChainLayer balance difference without protocol and executor fee: ${Number(differenceCrossChainLayer - toNano(tacProtocolFee + tonProtocolFee + tacExecutorFee + tonExecutorFee + crossChainTonAmount)) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                    - CCL protocol fee: ${protocolFeeSupply} TON
                    - CrossChain amount: ${crossChainTonAmount} TON
                    - ExecutorFee: ${Number(tacExecutorFee + tonExecutorFee) / 10 ** 9} TON
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    USER COSTS WITHOUT CCL FEE: ${Number(cost - toNano(protocolFeeSupply.toFixed(9))) / 10 ** 9} TON
                    USER COSTS WITHOUT CCL AND EXECUTOR FEE AND CROSSCHAIN TON AMOUNT: ${Number(cost - toNano(tacExecutorFee + tonExecutorFee + protocolFeeSupply) - toNano(crossChainTonAmount.toFixed(9))) / 10 ** 9} TON
                    ---------------------------------------------
                `);
            });

            it('SF-1.1.2: unsuccessful and need to return ton to user (not enough ton)', async () => {
                protocolFeeSupply = 100;

                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const payload = beginCell().storeUint(12345, 32).endCell().beginParse();
                const crossChainTonAmount = 1;
                const operationType = OperationType.tonTransfer;

                const result = await crossChainLayer.sendTVMMsgToEVM(anyone.getSender(), toNano('0.5'), {
                    operationType,
                    responseAddress: anyone.address.toString(),
                    payload,
                    crossChainTonAmount,
                });
                printTransactionFees(result.transactions);
                expect(result.transactions.length).toBe(3);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(operationType, 32)
                        .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                        .storeMaybeRef(null)
                        .storeAddress(anyone.address)
                        .storeSlice(payload)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.notEnoughTon,
                    outMessagesCount: 1,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(operationType, 32)
                        .storeSlice(payload)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

                const cost = totalFees + differenceCrossChainLayer;
                console.log(`
                    [TVM to EVM]: 
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON  
                    
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    ---------------------------------------------
                `);
            });
        });

        describe('SF-1.2: transfer tokens', () => {
            it('SF-1.2.1: successful', async () => {
                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();
                await deployJettonProxy();
                const initAnyoneJettonWalletJettonBalance = 1000;
                const anyoneJettonWallet = await deployJettonWalletWithBalance(
                    anyone.address.toString(),
                    initAnyoneJettonWalletJettonBalance,
                );
                const jettonProxyJettonWallet = await deployJettonWalletWithBalance(jettonProxy.address.toString(), 0);

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initJettonProxyBalance = (await blockchain.getContract(jettonProxy.address)).balance;
                const initAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const initJettonProxyJettonWalletBalance = (
                    await blockchain.getContract(jettonProxyJettonWallet.address)
                ).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const sendJettonAmount = 100;
                const crossChainTonAmount = 10;
                const feeData = generateFeeData();
                const crossChainPayload = beginCell().storeUint(12345, 32).endCell();

                const forwardTonAmount =
                    1 + crossChainTonAmount + tacProtocolFee + tonProtocolFee + tacExecutorFee + tonExecutorFee;
                const tonAmount = toNano('0.5') + toNano(forwardTonAmount.toFixed(9));
                const result = await anyoneJettonWallet.sendCrossChainTransfer(anyone.getSender(), tonAmount, {
                    jettonAmount: sendJettonAmount,
                    toOwnerAddress: jettonProxy.address.toString(),
                    responseAddress: anyone.address.toString(),
                    forwardTonAmount,
                    feeData,
                    crossChainPayload,
                    crossChainTonAmount,
                });
                printTransactionFees(result.transactions);
                expect((await anyoneJettonWallet.getWalletData()).balance).toBe(
                    initAnyoneJettonWalletJettonBalance - sendJettonAmount,
                );
                expect((await jettonProxyJettonWallet.getWalletData()).balance).toBe(sendJettonAmount);

                expect(result.transactions.length).toBe(7);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: anyoneJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Transfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(jettonProxy.address)
                        .storeAddress(anyone.address)
                        .storeBit(0) // custom payload
                        .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyoneJettonWallet.address,
                    to: jettonProxyJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxyJettonWallet.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxyJettonWallet.address,
                    to: jettonProxy.address,
                    body: beginCell()
                        .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonProxyErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxy.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(JettonProxyOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.jettonTransfer, 32)
                        .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeAddress(jettonProxyJettonWallet.address)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeRef(crossChainPayload)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    outMessagesCount: 2,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                });

                const logPayload = beginCell()
                    .storeUint(OperationType.jettonTransfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(jettonProxy.address)
                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                    .storeMaybeRef(
                        beginCell()
                            .storeMaybeRef(feeData)
                            .storeCoins(toNano(tacProtocolFee.toFixed(9)))
                            .storeCoins(toNano(tonProtocolFee.toFixed(9)))
                            .endCell(),
                    )
                    .storeAddress(jettonProxyJettonWallet.address)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                    .storeRef(crossChainPayload)
                    .endCell();

                expect(result.transactions[result.transactions.length - 2].outMessagesCount).toBe(2);
                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.info.src!.toString(),
                ).toEqual(crossChainLayer.address.toString());
                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.body.hash().toString(),
                ).toBe(logPayload.hash().toString());

                protocolFeeSupply += tacProtocolFee + tonProtocolFee;
                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentJettonProxyBalance = (await blockchain.getContract(jettonProxy.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const currentJettonProxyJettonWalletBalance = (
                    await blockchain.getContract(jettonProxyJettonWallet.address)
                ).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const differenceJettonProxy = currentJettonProxyBalance - initJettonProxyBalance;
                const differenceAnyoneJettonWallet = currentAnyoneJettonWalletBalance - initAnyoneJettonWalletBalance;
                const differenceJettonProxyJettonWallet =
                    currentJettonProxyJettonWalletBalance - initJettonProxyJettonWalletBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

                const cost =
                    totalFees +
                    differenceAnyoneJettonWallet +
                    differenceJettonProxy +
                    differenceJettonProxyJettonWallet +
                    differenceCrossChainLayer;

                console.log(`
                    [TVM to EVM]: {
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                    - User JW balance difference (contract kept balance): ${Number(differenceAnyoneJettonWallet) / 10 ** 9} TON, 
                    - JettonProxy JW balance difference (contract kept balance): ${Number(differenceJettonProxyJettonWallet) / 10 ** 9} TON,
                    - JettonProxy balance difference (contract kept balance): ${Number(differenceJettonProxy) / 10 ** 9} TON,
                    - CrossChainLayer balance difference (evm protocol fee): ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    - CrossChainLayer balance difference without protocol and executor fee: ${Number(differenceCrossChainLayer - toNano(protocolFeeSupply + tacExecutorFee + tonExecutorFee + crossChainTonAmount)) / 10 ** 9} TON
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    ---------------------------------------------
                    }`);
            });

            it('SF-1.2.2: unsuccessful and need to return jettons to user (not enough ton)', async () => {
                tacProtocolFee = 10;
                tonProtocolFee = 10;

                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();
                await deployJettonProxy();
                const initAnyoneJettonWalletJettonBalance = 1000;
                const anyoneJettonWallet = await deployJettonWalletWithBalance(
                    anyone.address.toString(),
                    initAnyoneJettonWalletJettonBalance,
                );
                const jettonProxyJettonWallet = await deployJettonWalletWithBalance(jettonProxy.address.toString(), 0);

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initJettonProxyBalance = (await blockchain.getContract(jettonProxy.address)).balance;
                const initAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const initJettonProxyJettonWalletBalance = (
                    await blockchain.getContract(jettonProxyJettonWallet.address)
                ).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const sendJettonAmount = 100;
                const crossChainTonAmount = 10;
                const crossChainPayload = beginCell().storeUint(12345, 32).endCell();

                const forwardTonAmount = 1 + crossChainTonAmount + tacExecutorFee + tonExecutorFee;
                const tonAmount = toNano('0.5') + toNano(forwardTonAmount.toFixed(9));

                const feeData = generateFeeData();

                const result = await anyoneJettonWallet.sendCrossChainTransfer(anyone.getSender(), tonAmount, {
                    jettonAmount: sendJettonAmount,
                    toOwnerAddress: jettonProxy.address.toString(),
                    responseAddress: anyone.address.toString(),
                    forwardTonAmount,
                    crossChainTonAmount,
                    feeData,
                    crossChainPayload,
                });
                printTransactionFees(result.transactions);
                expect((await anyoneJettonWallet.getWalletData()).balance).toBe(initAnyoneJettonWalletJettonBalance);
                expect((await jettonProxyJettonWallet.getWalletData()).balance).toBe(0);

                expect(result.transactions.length).toBe(8);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: anyoneJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Transfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(jettonProxy.address)
                        .storeAddress(anyone.address)
                        .storeBit(0) // custom payload
                        .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyoneJettonWallet.address,
                    to: jettonProxyJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxyJettonWallet.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxyJettonWallet.address,
                    to: jettonProxy.address,
                    body: beginCell()
                        .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonProxyErrors.notEnoughTon,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxy.address,
                    to: jettonProxyJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Transfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeBit(0)
                        .storeCoins(0)
                        .storeMaybeSlice(null)
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxyJettonWallet.address,
                    to: anyoneJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(jettonProxy.address)
                        .storeAddress(anyone.address)
                        .storeCoins(0)
                        .storeMaybeSlice(null)
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyoneJettonWallet.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentJettonProxyBalance = (await blockchain.getContract(jettonProxy.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const currentJettonProxyJettonWalletBalance = (
                    await blockchain.getContract(jettonProxyJettonWallet.address)
                ).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const differenceJettonProxy = currentJettonProxyBalance - initJettonProxyBalance;
                const differenceAnyoneJettonWallet = currentAnyoneJettonWalletBalance - initAnyoneJettonWalletBalance;
                const differenceJettonProxyJettonWallet =
                    currentJettonProxyJettonWalletBalance - initJettonProxyJettonWalletBalance;
                const differenceAnyone = initAnyoneBalance - currentAnyoneBalance;

                const cost =
                    totalFees +
                    differenceAnyoneJettonWallet +
                    differenceJettonProxy +
                    differenceJettonProxyJettonWallet +
                    differenceCrossChainLayer;
                console.log(`
                    [TVM to EVM]: {
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                    - User JW balance difference (contract kept balance): ${Number(differenceAnyoneJettonWallet) / 10 ** 9} TON, 
                    - JettonProxy JW balance difference (contract kept balance): ${Number(differenceJettonProxyJettonWallet) / 10 ** 9} TON,
                    - JettonProxy balance difference (contract kept balance): ${Number(differenceJettonProxy) / 10 ** 9} TON,
                    - CrossChainLayer balance difference (there is no protocol fee): ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    ---------------------------------------------
                    }`);
            });

            it('SF-1.2.2: not enough protocol fee on ccl and need to return jettons to user', async () => {
                tacProtocolFee = 10;
                tonProtocolFee = 10;

                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();
                await deployJettonProxy();
                const initAnyoneJettonWalletJettonBalance = 1000;
                const anyoneJettonWallet = await deployJettonWalletWithBalance(
                    anyone.address.toString(),
                    initAnyoneJettonWalletJettonBalance,
                );
                const jettonProxyJettonWallet = await deployJettonWalletWithBalance(jettonProxy.address.toString(), 0);

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initJettonProxyBalance = (await blockchain.getContract(jettonProxy.address)).balance;
                const initAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const initJettonProxyJettonWalletBalance = (
                    await blockchain.getContract(jettonProxyJettonWallet.address)
                ).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const sendJettonAmount = 100;
                const crossChainTonAmount = 10;
                const crossChainPayload = beginCell().storeUint(12345, 32).endCell();

                const forwardTonAmount =
                    1 + crossChainTonAmount + tacExecutorFee + tonExecutorFee + tacProtocolFee + tonProtocolFee - 1;
                const tonAmount = toNano('0.5') + toNano(forwardTonAmount.toFixed(9));

                const feeData = beginCell()
                    .storeUint(1, 1)
                    .storeCoins(toNano((tacProtocolFee + tonProtocolFee - 1).toFixed(9)))
                    .storeCoins(toNano(tacExecutorFee.toFixed(9)))
                    .storeCoins(toNano(tonExecutorFee.toFixed(9)))
                    .endCell();

                const result = await anyoneJettonWallet.sendCrossChainTransfer(anyone.getSender(), tonAmount, {
                    jettonAmount: sendJettonAmount,
                    toOwnerAddress: jettonProxy.address.toString(),
                    responseAddress: anyone.address.toString(),
                    forwardTonAmount,
                    crossChainTonAmount,
                    feeData,
                    crossChainPayload,
                });
                printTransactionFees(result.transactions);
                expect((await anyoneJettonWallet.getWalletData()).balance).toBe(initAnyoneJettonWalletJettonBalance);
                expect((await jettonProxyJettonWallet.getWalletData()).balance).toBe(0);

                expect(result.transactions.length).toBe(10);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: anyoneJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Transfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(jettonProxy.address)
                        .storeAddress(anyone.address)
                        .storeBit(0) // custom payload
                        .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyoneJettonWallet.address,
                    to: jettonProxyJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(forwardTonAmount.toFixed(9)))
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxyJettonWallet.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxyJettonWallet.address,
                    to: jettonProxy.address,
                    body: beginCell()
                        .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    success: true,
                    exitCode: JettonProxyErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonProxy.address,
                    to: crossChainLayer.address,
                    body: beginCell()
                        .storeUint(JettonProxyOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.jettonTransfer, 32)
                        .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeAddress(jettonProxyJettonWallet.address)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeRef(crossChainPayload)
                        .endCell(),
                    success: true,
                    exitCode: CrossChainLayerErrors.notEnoughProtocolFee,
                    outMessagesCount: 1,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: jettonProxy.address,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.jettonTransfer, 32)
                        .storeAddress(jettonProxyJettonWallet.address)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(sendJettonAmount.toFixed(9)))
                        .storeRef(crossChainPayload)
                        .endCell(),
                    success: true,
                    exitCode: JettonProxyErrors.noErrors,
                });

                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentJettonProxyBalance = (await blockchain.getContract(jettonProxy.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const currentJettonProxyJettonWalletBalance = (
                    await blockchain.getContract(jettonProxyJettonWallet.address)
                ).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const differenceJettonProxy = currentJettonProxyBalance - initJettonProxyBalance;
                const differenceAnyoneJettonWallet = currentAnyoneJettonWalletBalance - initAnyoneJettonWalletBalance;
                const differenceJettonProxyJettonWallet =
                    currentJettonProxyJettonWalletBalance - initJettonProxyJettonWalletBalance;
                const differenceAnyone = initAnyoneBalance - currentAnyoneBalance;

                const cost =
                    totalFees +
                    differenceAnyoneJettonWallet +
                    differenceJettonProxy +
                    differenceJettonProxyJettonWallet +
                    differenceCrossChainLayer;
                console.log(`
                        [TVM to EVM]: {
                        User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                        ---------------------------------------------
                        
                        COSTS:
                        - totalGas: ${totalGas}, 
                        - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                        - User JW balance difference (contract kept balance): ${Number(differenceAnyoneJettonWallet) / 10 ** 9} TON, 
                        - JettonProxy JW balance difference (contract kept balance): ${Number(differenceJettonProxyJettonWallet) / 10 ** 9} TON,
                        - JettonProxy balance difference (contract kept balance): ${Number(differenceJettonProxy) / 10 ** 9} TON,
                        - CrossChainLayer balance difference (there is no protocol fee): ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                        ---------------------------------------------
                        ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                        ---------------------------------------------
                        }`);
            });
        });

        describe('SF-1.3: burn tokens', () => {
            it('SF-1.3.1: successful', async () => {
                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();

                await deployJettonMinter();
                const anyoneJettonWallet = await getJettonWallet(anyone.address);

                const initAnyoneJettonWalletJettonBalance = 1000;
                await mintTokens(anyone.address, initAnyoneJettonWalletJettonBalance);

                await giveMinterAdminToCrossChainLayer();

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const initMinterBalance = (await blockchain.getContract(jettonMinter.address)).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const burnJettonAmount = 100;
                const crossChainPayload = beginCell().storeUint(12345, 32).endCell();
                const crossChainTonAmount = 10;
                const feeData = generateFeeData();
                const tonAmount =
                    toNano('0.5') +
                    toNano(crossChainTonAmount.toFixed(9)) +
                    toNano(tacProtocolFee.toFixed(9)) +
                    toNano(tonProtocolFee.toFixed(9)) +
                    toNano(tacExecutorFee.toFixed(9)) +
                    toNano(tonExecutorFee.toFixed(9));
                const result = await anyoneJettonWallet.sendBurn(anyone.getSender(), tonAmount, {
                    jettonAmount: burnJettonAmount,
                    receiverAddress: crossChainLayer.address.toString(),
                    crossChainPayload,
                    feeData,
                    crossChainTonAmount,
                });
                printTransactionFees(result.transactions);
                expect((await anyoneJettonWallet.getWalletData()).balance).toBe(
                    initAnyoneJettonWalletJettonBalance - burnJettonAmount,
                );

                expect(result.transactions.length).toBe(5);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: anyoneJettonWallet.address,
                    success: true,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Burn, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                        .storeAddress(crossChainLayer.address)
                        .storeMaybeRef(
                            beginCell()
                                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(crossChainPayload)
                                .endCell(),
                        )
                        .endCell(),
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyoneJettonWallet.address,
                    to: jettonMinter.address,
                    success: true,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.BurnNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeAddress(crossChainLayer.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonMinter.address,
                    to: crossChainLayer.address,
                    success: true,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.jettonBurn, 32)
                        .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                        .storeMaybeRef(crossChainPayload)
                        .endCell(),
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    success: true,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                    exitCode: 0,
                });

                const logPayload = beginCell()
                    .storeUint(OperationType.jettonBurn, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(jettonMinter.address)
                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                    .storeMaybeRef(
                        beginCell()
                            .storeMaybeRef(feeData)
                            .storeCoins(toNano(tacProtocolFee.toFixed(9)))
                            .storeCoins(toNano(tonProtocolFee.toFixed(9)))
                            .endCell(),
                    )
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                    .storeMaybeRef(crossChainPayload)
                    .endCell();

                expect(result.transactions[result.transactions.length - 2].outMessagesCount).toBe(2);

                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.info.src!.toString(),
                ).toEqual(crossChainLayer.address.toString());

                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.body.hash().toString(),
                ).toBe(logPayload.hash().toString());

                protocolFeeSupply += tacProtocolFee + tonProtocolFee;

                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const currentMinterBalance = (await blockchain.getContract(jettonMinter.address)).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const differenceAnyoneJettonWallet = currentAnyoneJettonWalletBalance - initAnyoneJettonWalletBalance;
                const differenceMinter = currentMinterBalance - initMinterBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

                const cost = totalFees + differenceAnyoneJettonWallet + differenceMinter + differenceCrossChainLayer;
                console.log(`
                    [TVM to EVM]: 
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    CrossChainLayer balance difference without protocol and executor fee: ${Number(differenceCrossChainLayer - toNano(tacProtocolFee + tonProtocolFee + tacExecutorFee + tonExecutorFee + crossChainTonAmount)) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                    - User JW kept balance: ${Number(differenceAnyoneJettonWallet) / 10 ** 9} TON, 
                    - Minter kept balance: ${Number(differenceMinter) / 10 ** 9} TON,
                    - CCL protocol fee: ${protocolFeeSupply} TON
                    - CrossChain amount: ${crossChainTonAmount} TON
                    - ExecutorFee: ${Number(tacExecutorFee + tonExecutorFee) / 10 ** 9} TON
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    USER COSTS WITHOUT CCL FEE: ${Number(cost - toNano(protocolFeeSupply.toFixed(9))) / 10 ** 9} TON
                    USER COSTS WITHOUT CCL FEE AND CROSSCHAIN TON AMOUNT: ${Number(cost - toNano(protocolFeeSupply.toFixed(9)) - toNano(crossChainTonAmount.toFixed(9))) / 10 ** 9} TON
                    ---------------------------------------------
                `);
            });

            it('SF-1.3.2: unsuccessful and return tokens to the user (not enough ton)', async () => {
                tacProtocolFee = 100;
                tonProtocolFee = 100;

                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();
                await deployJettonProxy();
                await deployJettonMinter();
                const anyoneJettonWallet = await getJettonWallet(anyone.address);

                const initAnyoneJettonWalletJettonBalance = 1000;
                await mintTokens(anyone.address, initAnyoneJettonWalletJettonBalance);

                await giveMinterAdminToCrossChainLayer();

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const initMinterBalance = (await blockchain.getContract(jettonMinter.address)).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const burnJettonAmount = 100;
                const crossChainPayload = beginCell().storeUint(12345, 32).endCell();
                const crossChainTonAmount = 10;
                const feeData = generateFeeData();
                const tonAmount = toNano('0.5') + toNano(crossChainTonAmount.toFixed(9));

                const result = await anyoneJettonWallet.sendBurn(anyone.getSender(), tonAmount, {
                    jettonAmount: burnJettonAmount,
                    receiverAddress: crossChainLayer.address.toString(),
                    crossChainTonAmount,
                    feeData,
                    crossChainPayload,
                });
                printTransactionFees(result.transactions);
                expect(result.transactions.length).toBe(7);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: anyoneJettonWallet.address,
                    success: true,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Burn, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                        .storeAddress(crossChainLayer.address)
                        .storeMaybeRef(
                            beginCell()
                                .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(crossChainPayload)
                                .endCell(),
                        )
                        .endCell(),
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyoneJettonWallet.address,
                    to: jettonMinter.address,
                    exitCode: JettonMinterErrors.noErrors,
                    success: true,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.BurnNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                        .storeAddress(anyone.address)
                        .storeAddress(crossChainLayer.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crossChainPayload)
                                    .endCell())
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonMinter.address,
                    to: crossChainLayer.address,
                    exitCode: CrossChainLayerErrors.notEnoughTon,
                    success: true,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.jettonBurn, 32)
                        .storeCoins(toNano(crossChainTonAmount.toFixed(9)))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                        .storeMaybeRef(crossChainPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: jettonMinter.address,
                    exitCode: JettonMinterErrors.noErrors,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.jettonBurn, 32)
                        .storeAddress(anyone.address)
                        .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                        .storeMaybeRef(crossChainPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: jettonMinter.address,
                    to: anyoneJettonWallet.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeCoins(toNano(burnJettonAmount.toFixed(9)))
                        .storeAddress(jettonMinter.address)
                        .storeAddress(anyone.address)
                        .storeCoins(0)
                        .storeMaybeRef(null)
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyoneJettonWallet.address,
                    to: anyone.address,
                    body: beginCell()
                        .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                    success: true,
                    exitCode: JettonWalletErrors.noErrors,
                });

                expect((await anyoneJettonWallet.getWalletData()).balance).toBe(initAnyoneJettonWalletJettonBalance);

                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address))
                    .balance;
                const currentMinterBalance = (await blockchain.getContract(jettonMinter.address)).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const differenceAnyoneJettonWallet = currentAnyoneJettonWalletBalance - initAnyoneJettonWalletBalance;
                const differenceMinter = currentMinterBalance - initMinterBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

                const cost = totalFees + differenceAnyoneJettonWallet + differenceMinter + differenceCrossChainLayer;
                console.log(`
                    [TVM to EVM]:
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    ---------------------------------------------

                    COSTS:
                    - totalGas: ${totalGas},
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,
                    - User JW kept balance: ${Number(differenceAnyoneJettonWallet) / 10 ** 9} TON,
                    - Minter kept balance: ${Number(differenceMinter) / 10 ** 9} TON,

                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    ---------------------------------------------
                `);
            });
        });

        describe('SF-1.4: nft burn', () => {
            it('SF-1.4.1: successful', async () => {
                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();

                //deploy nft
                await deploySingleNFTItem();

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initNFTItemBalance = (await blockchain.getContract(nftItem.address)).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const crosschainPayload = beginCell().storeUint(12345, 32).endCell();
                const crosschainTonAmount = 10;
                const feeData = generateFeeData();
                const tonAmount = toNano('0.5') + toNano(crosschainTonAmount);

                // burn nft item
                const result = await nftItem.sendBurn(anyone.getSender(), tonAmount, {
                    responseAddress: crossChainLayer.address,
                    crosschainTonAmount: crosschainTonAmount,
                    crosschainPayload,
                    feeData,
                });

                expect(result.transactions.length).toBe(4);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: nftItem.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_burn, 32)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeAddress(crossChainLayer.address)
                       .storeMaybeRef(beginCell()
                                     .storeCoins(toNano(crosschainTonAmount))
                                     .storeMaybeRef(feeData)
                                     .storeMaybeRef(crosschainPayload)
                                    .endCell())
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: crossChainLayer.address,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.nftBurn, 32)
                        .storeCoins(toNano(crosschainTonAmount))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeMaybeRef(crosschainPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                });

                const logPayload = beginCell()
                    .storeUint(OperationType.nftBurn, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(nftItem.address)
                    .storeCoins(toNano(crosschainTonAmount))
                    .storeMaybeRef(
                        beginCell()
                            .storeMaybeRef(feeData)
                            .storeCoins(toNano(tacProtocolFee.toFixed(9)))
                            .storeCoins(toNano(tonProtocolFee.toFixed(9)))
                            .endCell(),
                    )
                    .storeAddress(anyone.address)
                    .storeMaybeRef(crosschainPayload)
                    .endCell();

                expect(result.transactions[result.transactions.length - 2].outMessagesCount).toBe(2);
                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.info.src!.toString(),
                ).toEqual(crossChainLayer.address.toString());
                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.body.hash().toString(),
                ).toBe(logPayload.hash().toString());

                protocolFeeSupply += tacProtocolFee + tonProtocolFee;
                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentNFTItemBalance = (await blockchain.getContract(nftItem.address)).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const diffrerenceNFTItem = currentNFTItemBalance - initNFTItemBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

                const cost = totalFees + diffrerenceNFTItem + differenceCrossChainLayer;
                console.log(`
                    [TVM to EVM]: 
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                    - NFT item kept balance: ${Number(diffrerenceNFTItem) / 10 ** 9} TON, 
                    - CrossChainLayer balance difference (evm protocol fee): ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    - CrossChainLayer balance difference without protocol and executor fee: ${Number(differenceCrossChainLayer - toNano(protocolFeeSupply + tacExecutorFee + tonExecutorFee + crosschainTonAmount)) / 10 ** 9} TON
                    
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    ---------------------------------------------
                `);
            });

            it('SF-1.4.2: not enough protocol fee on ccl and return nft to the user', async () => {
                tacProtocolFee = 100;
                tonProtocolFee = 100;

                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();

                //deploy nft
                await deploySingleNFTItem();

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initNFTItemBalance = (await blockchain.getContract(nftItem.address)).balance;
                const initAnyoneBalance = await anyone.getBalance();

                const crosschainPayload = beginCell().storeUint(12345, 32).endCell();
                const crosschainTonAmount = 10;
                // temporary set lower fees to generate fee data
                tacProtocolFee = 10;
                tonProtocolFee = 10;
                const feeData = generateFeeData();
                tacProtocolFee = 100;
                tonProtocolFee = 100;
                const tonAmount = toNano(0.5 + crosschainTonAmount + tacProtocolFee + tonProtocolFee);
                // burn nft item
                const result = await nftItem.sendBurn(anyone.getSender(), tonAmount, {
                    responseAddress: crossChainLayer.address,
                    crosschainTonAmount,
                    crosschainPayload,
                    feeData,
                });

                expect(result.transactions.length).toBe(4);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: nftItem.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_burn, 32)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeAddress(crossChainLayer.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crosschainTonAmount))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crosschainPayload)
                                    .endCell())
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: crossChainLayer.address,
                    exitCode: CrossChainLayerErrors.notEnoughProtocolFee,
                    success: true,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.nftBurn, 32)
                        .storeCoins(toNano(crosschainTonAmount))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeMaybeRef(crosschainPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: nftItem.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.nftBurn, 32)
                        .storeAddress(anyone.address)
                        .storeMaybeRef(crosschainPayload)
                        .endCell(),
                });

                await checkCrossChainLayerFullData();

                const nftData = await nftItem.getNFTData();
                expect(nftData.init).toBe(true);
                expect(nftData.ownerAddress?.equals(anyone.address)).toBe(true);

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentNFTItemBalance = (await blockchain.getContract(nftItem.address)).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const diffrerenceNFTItem = currentNFTItemBalance - initNFTItemBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

                const cost = totalFees + diffrerenceNFTItem + differenceCrossChainLayer;
                console.log(`
                    [TVM to EVM]: 
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                    - NFT item kept balance: ${Number(diffrerenceNFTItem) / 10 ** 9} TON, 
                    - CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    ---------------------------------------------
                `);
            });
        });

        describe('SF-1.5: nft transfer', () => {
            it('SF-1.5.1: successful', async () => {
                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();

                //deploy nft
                await deploySingleNFTItem();
                await deployNFTProxy();

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initNFTItemBalance = (await blockchain.getContract(nftItem.address)).balance;
                const initAnyoneBalance = await anyone.getBalance();
                const initNFTProxyBalance = (await blockchain.getContract(nftProxy.address)).balance;

                const crosschainPayload = beginCell().storeUint(12345, 32).endCell();
                const crosschainTonAmount = 10;
                const feeData = generateFeeData();
                const forwardAmount = Number(crosschainTonAmount) + 0.5;
                const tonAmount = toNano(forwardAmount) + toNano(1);

                const forwardPayload = beginCell()
                    .storeCoins(toNano(crosschainTonAmount))
                    .storeMaybeRef(feeData)
                    .storeMaybeRef(crosschainPayload)
                    .endCell()

                const result = await nftItem.sendTransfer(anyone.getSender(), tonAmount, {
                    newOwner: nftProxy.address,
                    responseAddress: anyone.address,
                    forwardAmount,
                    forwardPayload,
                });

                expect(result.transactions.length).toBe(6);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: nftItem.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_transfer, 32)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeAddress(nftProxy.address)
                        .storeAddress(anyone.address)
                        .storeBit(false)
                        .storeCoins(toNano(forwardAmount))
                        .storeMaybeRef(forwardPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.nftItem_excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: nftProxy.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.nftItem_ownershipAssigned, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeAddress(anyone.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crosschainTonAmount))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crosschainPayload)
                                    .endCell())
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftProxy.address,
                    to: crossChainLayer.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.nftTransfer, 32)
                        .storeCoins(toNano(crosschainTonAmount))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeAddress(nftItem.address)
                        .storeAddress(anyone.address)
                        .storeRef(crosschainPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: anyone.address,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                });

                const logPayload = beginCell()
                    .storeUint(OperationType.nftTransfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(nftProxy.address)
                    .storeCoins(toNano(crosschainTonAmount))
                    .storeMaybeRef(
                        beginCell()
                            .storeMaybeRef(feeData)
                            .storeCoins(toNano(tacProtocolFee.toFixed(9)))
                            .storeCoins(toNano(tonProtocolFee.toFixed(9)))
                            .endCell(),
                    )
                    .storeAddress(nftItem.address)
                    .storeAddress(anyone.address)
                    .storeRef(crosschainPayload)
                    .endCell();

                expect(result.transactions[result.transactions.length - 2].outMessagesCount).toBe(2);
                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.info.src!.toString(),
                ).toEqual(crossChainLayer.address.toString());
                expect(
                    result.transactions[result.transactions.length - 2].outMessages.get(0)?.body.hash().toString(),
                ).toBe(logPayload.hash().toString());

                protocolFeeSupply += tacProtocolFee + tonProtocolFee;
                await checkCrossChainLayerFullData();

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentNFTItemBalance = (await blockchain.getContract(nftItem.address)).balance;
                const currentNFTProxyBalance = (await blockchain.getContract(nftProxy.address)).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const diffrerenceNFTItem = currentNFTItemBalance - initNFTItemBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;
                const differenceNFTProxy = currentNFTProxyBalance - initNFTProxyBalance;

                const cost = totalFees + diffrerenceNFTItem + differenceCrossChainLayer + differenceNFTProxy;
                console.log(`
                    [TVM to EVM]: 
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                    - NFT item kept balance: ${Number(diffrerenceNFTItem) / 10 ** 9} TON, 
                    - NFT proxy kept balance: ${Number(differenceNFTProxy) / 10 ** 9} TON,
                    - CrossChainLayer balance difference (evm protocol fee): ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    - CrossChainLayer balance difference without protocol and executor fee: ${Number(differenceCrossChainLayer - toNano(protocolFeeSupply + tacExecutorFee + tonExecutorFee + crosschainTonAmount)) / 10 ** 9} TON
                    
                    
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    ---------------------------------------------
                `);
            });

            it('SF-1.5.2: not enough protocol fee on ccl and return nft to the user', async () => {
                tacProtocolFee = 100;
                tonProtocolFee = 100;

                await deployCrossChainLayer();
                await checkCrossChainLayerFullData();

                //deploy nft
                await deploySingleNFTItem();
                await deployNFTProxy();

                const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const initNFTItemBalance = (await blockchain.getContract(nftItem.address)).balance;
                const initAnyoneBalance = await anyone.getBalance();
                const initNFTProxyBalance = (await blockchain.getContract(nftProxy.address)).balance;

                const crosschainPayload = beginCell().storeUint(12345, 32).endCell();
                const crosschainTonAmount = 10;
                tacProtocolFee = 10;
                tonProtocolFee = 10;
                const feeData = generateFeeData();
                tacProtocolFee = 100;
                tonProtocolFee = 100;
                const forwardAmount = 0.5 + crosschainTonAmount + tacProtocolFee + tonProtocolFee;
                const tonAmount = toNano(forwardAmount) + toNano(1);

                const forwardPayload = beginCell()
                    .storeCoins(toNano(crosschainTonAmount))
                    .storeMaybeRef(feeData)
                    .storeMaybeRef(crosschainPayload)
                    .endCell()

                const result = await nftItem.sendTransfer(anyone.getSender(), tonAmount, {
                    newOwner: nftProxy.address,
                    responseAddress: anyone.address,
                    forwardAmount,
                    forwardPayload,
                });

                expect(result.transactions.length).toBe(8);

                expect(result.transactions).toHaveTransaction({
                    from: undefined,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                });

                expect(result.transactions).toHaveTransaction({
                    from: anyone.address,
                    to: nftItem.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_transfer, 32)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeAddress(nftProxy.address)
                        .storeAddress(anyone.address)
                        .storeBit(false)
                        .storeCoins(toNano(forwardAmount))
                        .storeMaybeRef(forwardPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.nftItem_excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: nftProxy.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.nftItem_ownershipAssigned, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeAddress(anyone.address)
                        .storeMaybeRef(beginCell()
                                    .storeCoins(toNano(crosschainTonAmount))
                                    .storeMaybeRef(feeData)
                                    .storeMaybeRef(crosschainPayload)
                                    .endCell())
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftProxy.address,
                    to: crossChainLayer.address,
                    success: true,
                    exitCode: CrossChainLayerErrors.notEnoughProtocolFee,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.nftTransfer, 32)
                        .storeCoins(toNano(crosschainTonAmount))
                        .storeMaybeRef(feeData)
                        .storeAddress(anyone.address)
                        .storeAddress(nftItem.address)
                        .storeAddress(anyone.address)
                        .storeRef(crosschainPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: crossChainLayer.address,
                    to: nftProxy.address,
                    success: true,
                    exitCode: CrossChainLayerErrors.noErrors,
                    body: beginCell()
                        .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeUint(OperationType.nftTransfer, 32)
                        .storeAddress(nftItem.address)
                        .storeAddress(anyone.address)
                        .storeRef(crosschainPayload)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftProxy.address,
                    to: nftItem.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.owner_transfer, 32)
                        .storeUint(0, Params.bitsize.queryId)
                        .storeAddress(anyone.address)
                        .storeAddress(anyone.address)
                        .storeBit(false)
                        .storeCoins(0)
                        .storeBit(false)
                        .endCell(),
                });

                expect(result.transactions).toHaveTransaction({
                    from: nftItem.address,
                    to: anyone.address,
                    success: true,
                    exitCode: 0,
                    body: beginCell()
                        .storeUint(NFTItemOpCodes.nftItem_excesses, Params.bitsize.op)
                        .storeUint(0, Params.bitsize.queryId)
                        .endCell(),
                });

                await checkCrossChainLayerFullData();

                const nftData = await nftItem.getNFTData();
                expect(nftData.init).toBe(true);
                expect(nftData.ownerAddress?.equals(anyone.address)).toBe(true);

                const totalFees =
                    result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
                const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
                const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
                const currentAnyoneBalance = await anyone.getBalance();
                const currentNFTItemBalance = (await blockchain.getContract(nftItem.address)).balance;
                const currentNFTProxyBalance = (await blockchain.getContract(nftProxy.address)).balance;

                const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
                const diffrerenceNFTItem = currentNFTItemBalance - initNFTItemBalance;
                const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;
                const differenceNFTProxy = currentNFTProxyBalance - initNFTProxyBalance;

                const cost = totalFees + diffrerenceNFTItem + differenceCrossChainLayer + differenceNFTProxy;
                console.log(`
                    [TVM to EVM]: 
                    User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                    ---------------------------------------------
                    
                    COSTS:
                    - totalGas: ${totalGas}, 
                    - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                    - NFT item kept balance: ${Number(diffrerenceNFTItem) / 10 ** 9} TON, 
                    - NFT proxy kept balance: ${Number(differenceNFTProxy) / 10 ** 9} TON,
                    - CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                    
                    ---------------------------------------------
                    ALL USER COSTS: ${Number(cost) / 10 ** 9} TON
                    ---------------------------------------------
                `);
            });
        });
    });

    describe('SF-2: evm msg to tvm', () => {
        it('SF-2.1: successful ton transfer', async () => {
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const initAnyoneBalance = await anyone.getBalance();

            isSpent = false;
            const msgEntry = msgEntries[0];
            const msg: Message = {
                entries: [msgEntries[0]],
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            };
            payload = getCellByMessage(msg);

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            msgDict = generateMsgsDictionaryBatching([msg]);
            const dictCell = beginCell().storeDictDirect(msgDict).endCell();

            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots = [merkleRoot];

            const rootResult = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('1'), {
                merkleRoot: merkleRoot.root,
                messageCollectEndTime: nextVotingTime,
            });

            expect(rootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            await checkCrossChainLayerFullData();

            const merkleProof = msgDict.generateMerkleProof([payload.hash()]);

            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('2'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: anyone.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect(result.transactions.length).toBe(8);

            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
                exitCode: 0,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 4,
            });
            expect((tx.outMessages.get(2)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_evmMsgToTVM),
            );
            expect(tx.outMessages.get(2)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(2)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: msgEntry.destinationAddress,
                body: msgEntry.msgBody,
                value: msgEntry.destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: wTACTokenAddress,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano('0.01'))
                    .storeAddress(anyone.address)
                    .storeCoins(0)
                    .storeBit(0)
                    .storeBit(0)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            isSpent = true;

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            result.transactions.pop();
            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const currentExecutorBalance = (await blockchain.getContract(executor.address)).balance;
            const currentAnyoneBalance = await anyone.getBalance();

            const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

            const userCosts =
                totalFees +
                deployExecutorInfo.totalFees +
                currentExecutorBalance +
                msgEntry.destinationMsgValue +
                toNano(protocolFeeSupply.toFixed(9));

            console.log(`
                [EVM to TVM]:
                User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                ${Number(msgEntry.destinationMsgValue) / 10 ** 9} TON will be given to destination address
                ---------------------------------------------
                
                USER COSTS:
                - totalGas: ${totalGas}, 
                - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                - Executor storage fee (prevent double spending): ${Number(currentExecutorBalance) / 10 ** 9} TON,  
                - Send to destination: ${Number(msgEntry.destinationMsgValue) / 10 ** 9} TON,   
                
                ---------------------------------------------
                ALL USER COSTS: ${Number(userCosts) / 10 ** 9} TON
                ---------------------------------------------
            `);
        });

        it('SF-2.2: successful jetton transfer', async () => {
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();
            await deployJettonProxy();

            const initJettonProxyJettonBalance = 1000;
            const anyoneJettonWallet = await deployJettonWalletWithBalance(anyone.address.toString(), 0);
            const jettonProxyJettonWallet = await deployJettonWalletWithBalance(
                jettonProxy.address.toString(),
                initJettonProxyJettonBalance,
            );

            const jettonAmount = 100;
            const payloadNumber = Math.round(Math.random() * 100);
            const msgEntry: MsgEntry = {
                needToUnlockTON: false,
                operationId: toNano('1'),
                destinationAddress: jettonProxy.address,
                destinationMsgValue: toNano('0.2'),
                msgBody: beginCell()
                    .storeUint(JettonProxyOpCodes.crossChainLayerAddress_evmMsgToTVMproxy, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(jettonProxyJettonWallet.address)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                payloadNumber: payloadNumber,
            };
            msgEntries.push(msgEntry);

            const messages: Message[] = msgEntries.map((e) => ({
                entries: [e],
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            }));
            msgDict = generateMsgsDictionaryBatching(messages);

            const dictCell = beginCell().storeDictDirect(msgDict).endCell();

            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots = [merkleRoot];

            const rootResult = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('1'), {
                merkleRoot: merkleRoot.root,
                messageCollectEndTime: nextVotingTime,
            });

            expect(rootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            await checkCrossChainLayerFullData();

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const initJettonProxyBalance = (await blockchain.getContract(jettonProxy.address)).balance;
            const initAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address)).balance;
            const initJettonProxyJettonWalletBalance = (await blockchain.getContract(jettonProxyJettonWallet.address))
                .balance;
            const initAnyoneBalance = await anyone.getBalance();
            const initResponseBalance = await response.getBalance();

            isSpent = false;
            payload = getCellByMessage(messages[messages.length - 1]);

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            const merkleProof = msgDict.generateMerkleProof([payload.hash()]);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.6'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: response.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect((await anyoneJettonWallet.getWalletData()).balance).toBe(jettonAmount);
            expect((await jettonProxyJettonWallet.getWalletData()).balance).toBe(
                initJettonProxyJettonBalance - jettonAmount,
            );

            expect(result.transactions.length).toBe(11);

            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
                exitCode: 0,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(response.address)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(response.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 4,
            });
            expect((tx.outMessages.get(2)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_evmMsgToTVM),
            );
            expect(tx.outMessages.get(2)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(2)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: response.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonProxy.address,
                body: msgEntry.msgBody,
                value: msgEntry.destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: jettonProxyJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Transfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(anyone.address)
                    .storeAddress(response.address)
                    .storeBit(0)
                    .storeCoins(0)
                    .storeMaybeSlice(null)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxyJettonWallet.address,
                to: anyoneJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(jettonProxy.address)
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeSlice(null)
                    .endCell(),
                success: true,
                exitCode: JettonWalletErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyoneJettonWallet.address,
                to: response.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: JettonWalletErrors.noErrors,
            });

            // fee
            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: wTACTokenAddress,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano('0.01'))
                    .storeAddress(anyone.address)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            isSpent = true;

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const currentExecutorBalance = (await blockchain.getContract(executor.address)).balance;
            const currentJettonProxyBalance = (await blockchain.getContract(jettonProxy.address)).balance;
            const currentAnyoneBalance = await anyone.getBalance();
            const currentResponseBalance = await response.getBalance();
            const currentAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address)).balance;
            const currentJettonProxyJettonWalletBalance = (
                await blockchain.getContract(jettonProxyJettonWallet.address)
            ).balance;

            const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const differenceJettonProxy = currentJettonProxyBalance - initJettonProxyBalance;
            const differenceAnyoneJettonWallet = currentAnyoneJettonWalletBalance - initAnyoneJettonWalletBalance;
            const differenceJettonProxyJettonWallet =
                currentJettonProxyJettonWalletBalance - initJettonProxyJettonWalletBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;
            const differenceResponse = currentResponseBalance - initResponseBalance;

            const userCosts =
                totalFees +
                differenceAnyoneJettonWallet +
                differenceJettonProxy +
                differenceJettonProxyJettonWallet +
                deployExecutorInfo.totalFees +
                currentExecutorBalance;

            console.log(`
                [EVM to TVM]:
                User balance difference: ${Number(differenceAnyone + differenceResponse) / 10 ** 9} TON
                Response amount: ${Number(differenceResponse) / 10 ** 9} TON
                CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                ---------------------------------------------
                
                USER COSTS:
                - totalGas: ${totalGas}, 
                - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                - User JW kept balance: ${Number(differenceAnyoneJettonWallet) / 10 ** 9} TON, 
                - JettonProxy JW kept balance: ${Number(differenceJettonProxyJettonWallet) / 10 ** 9} TON,
                - JettonProxy kept balance: ${Number(differenceJettonProxy) / 10 ** 9} TON,
                - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                - Executor storage fee (prevent double spending): ${Number(currentExecutorBalance) / 10 ** 9} TON,  
                
                ---------------------------------------------
                ALL USER COSTS: ${Number(userCosts) / 10 ** 9} TON
                ---------------------------------------------
            `);
        });

        it('SF-2.3: successful mint tokens', async () => {
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await deployJettonMinter();
            await giveMinterAdminToCrossChainLayer();

            const anyoneJettonWallet = await getJettonWallet(anyone.address);

            const jettonAmount = 100;
            const msgEntry: MsgEntry = {
                operationId: toNano('1'),
                destinationAddress: jettonMinter.address,
                destinationMsgValue: toNano('0.2'),
                msgBody: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .storeMaybeRef(null)
                    .endCell(),
                payloadNumber: Math.round(Math.random() * 100),
            };
            msgEntries.push(msgEntry);
            const messages: Message[] = msgEntries.map((e) => ({
                entries: [e],
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            }));
            msgDict = generateMsgsDictionaryBatching(messages);
            const dictCell = beginCell().storeDictDirect(msgDict).endCell();

            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots = [merkleRoot];

            const rootResult = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('1'), {
                merkleRoot: merkleRoot.root,
                messageCollectEndTime: nextVotingTime,
            });

            expect(rootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            await checkCrossChainLayerFullData();

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const initAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address)).balance;
            const initMinterBalance = (await blockchain.getContract(jettonMinter.address)).balance;
            const initAnyoneBalance = await anyone.getBalance();
            const initResponseBalance = await response.getBalance();

            isSpent = false;
            payload = getCellByMessage(messages[messages.length - 1]);

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            const merkleProof = msgDict.generateMerkleProof([payload.hash()]);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('2'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: response.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect(result.transactions.length).toBe(10);

            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(response.address)
                    .endCell(),
                success: true,
            });

            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(response.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 4,
            });
            expect((tx.outMessages.get(2)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_evmMsgToTVM),
            );
            expect(tx.outMessages.get(2)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(2)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: response.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonMinter.address,
                body: msgEntry.msgBody,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyoneJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(jettonMinter.address)
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyoneJettonWallet.address,
                to: response.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            // fee
            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: wTACTokenAddress,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano('0.01'))
                    .storeAddress(anyone.address)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect((await anyoneJettonWallet.getWalletData()).balance).toBe(jettonAmount);

            isSpent = true;

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const currentExecutorBalance = (await blockchain.getContract(executor.address)).balance;
            const currentAnyoneBalance = await anyone.getBalance();
            const currentResponseBalance = await response.getBalance();
            const currentAnyoneJettonWalletBalance = (await blockchain.getContract(anyoneJettonWallet.address)).balance;
            const currentMinterBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const differenceAnyoneJettonWallet = currentAnyoneJettonWalletBalance - initAnyoneJettonWalletBalance;
            const differenceMinterWallet = currentMinterBalance - initMinterBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;
            const differenceResponse = currentResponseBalance - initResponseBalance;

            const userCosts =
                totalFees +
                differenceAnyoneJettonWallet +
                differenceMinterWallet +
                deployExecutorInfo.totalFees +
                currentExecutorBalance +
                toNano(protocolFeeSupply.toFixed(9));

            console.log(`
                [EVM to TVM]:
                User balance difference: ${Number(differenceAnyone + differenceResponse) / 10 ** 9} TON
                Response amount: ${Number(differenceResponse) / 10 ** 9} TON
                CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                ---------------------------------------------
                
                USER COSTS:
                - totalGas: ${totalGas}, 
                - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                - User JW kept balance: ${Number(differenceAnyoneJettonWallet) / 10 ** 9} TON, 
                - Jetton Minter kept balance: ${Number(differenceMinterWallet) / 10 ** 9} TON,
                - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                - Executor storage fee (prevent double spending): ${Number(currentExecutorBalance) / 10 ** 9} TON,  
                - CCL protocol fee: ${protocolFeeSupply} TON
                - ExecutorFee: ${Number(tacExecutorFee + tonExecutorFee) / 10 ** 9} TON

                ---------------------------------------------
                ALL USER COSTS: ${Number(userCosts) / 10 ** 9} TON
                COSTS WITHOUT CCL FEE: ${Number(userCosts - toNano(protocolFeeSupply.toFixed(9))) / 10 ** 9} TON 
                ---------------------------------------------
            `);
        });

        it('SF-2.4: successful multiple actions with unlock', async () => {
            initialTonLock = 10;

            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await deployJettonProxy();
            await deployJettonMinter();
            await giveMinterAdminToCrossChainLayer();

            const initJettonProxyJettonBalance = 1000;
            const anyoneTransferJettonWallet = await deployJettonWalletWithBalance(anyone.address.toString(), 0);
            const jettonProxyJettonWallet = await deployJettonWalletWithBalance(
                jettonProxy.address.toString(),
                initJettonProxyJettonBalance,
            );
            const anyoneMintJettonWallet = await getJettonWallet(anyone.address);

            const jettonAmount = 100;
            const payloadNumber = Math.round(Math.random() * 100);

            let testMsgEntries = [msgEntries[0], msgEntries[1]];

            let destinationMsgValue = 0n;
            let unlockTonValue = 0n;
            testMsgEntries.forEach((msgEntry) => {
                if (msgEntry.needToUnlockTON) {
                    unlockTonValue += msgEntry.destinationMsgValue;
                } else {
                    destinationMsgValue += msgEntry.destinationMsgValue;
                }
            });

            const jettonTransferMsgEntry: MsgEntry = {
                needToUnlockTON: true,
                operationId: toNano('1'),
                destinationAddress: jettonProxy.address,
                destinationMsgValue: toNano(initialTonLock / 2),
                msgBody: beginCell()
                    .storeUint(JettonProxyOpCodes.crossChainLayerAddress_evmMsgToTVMproxy, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(jettonProxyJettonWallet.address)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                payloadNumber: payloadNumber,
            };
            testMsgEntries.push(jettonTransferMsgEntry);

            const mintJettonMsgEntry: MsgEntry = {
                needToUnlockTON: true,
                operationId: toNano('1'),
                destinationAddress: jettonMinter.address,
                destinationMsgValue: toNano(initialTonLock / 2),
                msgBody: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .storeMaybeRef(null)
                    .endCell(),
                payloadNumber: Math.round(Math.random() * 100),
            };
            testMsgEntries.push(mintJettonMsgEntry);

            const testMsg: Message = {
                entries: testMsgEntries,
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            };
            msgDict = generateMsgsDictionaryBatching([testMsg]);
            const dictCell = beginCell().storeDictDirect(msgDict).endCell();
            payload = getCellByMessage(testMsg);

            isSpent = false;
            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots.push(merkleRoot);

            const rootResult = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('1'), {
                merkleRoot: merkleRoot.root,
                messageCollectEndTime: nextVotingTime,
            });

            expect(rootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;
            await checkCrossChainLayerFullData();

            const initAnyoneBalance = await anyone.getBalance();

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const initAnyoneTransferJettonWalletContractBalance = (
                await blockchain.getContract(anyoneTransferJettonWallet.address)
            ).balance;
            const initJettonProxyJettonWalletContractBalance = (
                await blockchain.getContract(jettonProxyJettonWallet.address)
            ).balance;
            const initJettonProxyContractBalance = (await blockchain.getContract(jettonProxy.address)).balance;
            const initMinterWalletContractBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const initResponseBalance = await response.getBalance();

            const merkleProof = msgDict.generateMerkleProof([payload.hash()]);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.5') + destinationMsgValue, {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: anyone.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect(result.transactions.length).toBe(16);

            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
            });

            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 7,
            });
            expect((tx.outMessages.get(5)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_evmMsgToTVM),
            );
            expect(tx.outMessages.get(5)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(5)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonMinter.address,
                body: mintJettonMsgEntry.msgBody,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyoneMintJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(jettonMinter.address)
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyoneMintJettonWallet.address,
                to: response.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonProxy.address,
                body: jettonTransferMsgEntry.msgBody,
                value: jettonTransferMsgEntry.destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: jettonProxyJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Transfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(anyone.address)
                    .storeAddress(response.address)
                    .storeBit(0)
                    .storeCoins(0)
                    .storeMaybeSlice(null)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxyJettonWallet.address,
                to: anyoneTransferJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(jettonProxy.address)
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeSlice(null)
                    .endCell(),
                success: true,
                exitCode: JettonWalletErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyoneTransferJettonWallet.address,
                to: response.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: JettonWalletErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: msgEntries[0].destinationAddress,
                body: msgEntries[0].msgBody,
                value: msgEntries[0].destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: msgEntries[1].destinationAddress,
                body: msgEntries[1].msgBody,
                value: msgEntries[1].destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            // fee
            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: wTACTokenAddress,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano('0.01'))
                    .storeAddress(anyone.address)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect((await anyoneTransferJettonWallet.getWalletData()).balance).toBe(jettonAmount);
            expect((await anyoneMintJettonWallet.getWalletData()).balance).toBe(jettonAmount);

            isSpent = true;

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerContractBalance = (await blockchain.getContract(crossChainLayer.address))
                .balance;
            const currentExecutorContractBalance = (await blockchain.getContract(executor.address)).balance;
            const currentAnyoneTransferJettonWalletContractBalance = (
                await blockchain.getContract(anyoneTransferJettonWallet.address)
            ).balance;
            const currentJettonProxyJettonWalletContractBalance = (
                await blockchain.getContract(jettonProxyJettonWallet.address)
            ).balance;
            const currentJettonProxyContractBalance = (await blockchain.getContract(jettonProxy.address)).balance;
            const currentMinterWalletContractBalance = (await blockchain.getContract(jettonMinter.address)).balance;
            const currentAnyoneMintJettonWalletContractBalance = (
                await blockchain.getContract(anyoneMintJettonWallet.address)
            ).balance;
            const currentAnyoneBalance = await anyone.getBalance();
            const currentResponseBalance = await response.getBalance();

            const differenceCrossChainLayer = currentCrossChainLayerContractBalance - initCrossChainLayerBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;
            const differenceResponse = currentResponseBalance - initResponseBalance;
            const differenceAnyoneTransferJettonWallet =
                currentAnyoneTransferJettonWalletContractBalance - initAnyoneTransferJettonWalletContractBalance;
            const differenceJettonProxyJettonWallet =
                currentJettonProxyJettonWalletContractBalance - initJettonProxyJettonWalletContractBalance;
            const differenceJettonProxy = currentJettonProxyContractBalance - initJettonProxyContractBalance;
            const differenceMinterWallet = currentMinterWalletContractBalance - initMinterWalletContractBalance;

            const userCosts =
                totalFees +
                destinationMsgValue +
                differenceJettonProxy +
                differenceJettonProxyJettonWallet +
                differenceAnyoneTransferJettonWallet +
                differenceMinterWallet +
                currentAnyoneMintJettonWalletContractBalance +
                deployExecutorInfo.totalFees +
                currentExecutorContractBalance +
                differenceCrossChainLayer;

            const difference = differenceAnyone + differenceResponse + userCosts;

            console.log(`
                        [EVM to TVM]:
                        User balance difference: ${Number(differenceAnyone + differenceResponse) / 10 ** 9} TON
                        difference: ${Number(difference) / 10 ** 9} TON
                        Response amount: ${Number(differenceResponse) / 10 ** 9} TON
                        CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                        ${Number(destinationMsgValue + unlockTonValue) / 10 ** 9} TON will be given to destination address
                        ---------------------------------------------
                        
                        CCL COSTS:
                        Transfer TON:
                        - Send to destination: ${Number(unlockTonValue) / 10 ** 9} TON,
                        
                        ---------------------------------------------
                        USER COSTS:
                        - totalGas: ${totalGas}, 
                        - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                        
                        Transfer TON:
                        - Send to destination: ${Number(destinationMsgValue) / 10 ** 9} TON,
                        
                        Transfer Jetton:
                        - User JW kept balance: ${Number(differenceAnyoneTransferJettonWallet) / 10 ** 9} TON, 
                        - JettonProxy JW kept balance: ${Number(differenceJettonProxyJettonWallet) / 10 ** 9} TON,
                        - JettonProxy kept balance: ${Number(differenceJettonProxy) / 10 ** 9} TON,
                        
                        Mint:
                        - User JW kept balance: ${Number(currentAnyoneMintJettonWalletContractBalance) / 10 ** 9} TON, 
                        - Jetton Minter kept balance: ${Number(differenceMinterWallet) / 10 ** 9} TON,
                        
                        General:
                        - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                        - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                        - Executor storage fee (prevent double spending): ${Number(currentExecutorContractBalance) / 10 ** 9} TON,     
                        
                        ---------------------------------------------
                        ALL USER COSTS: ${Number(userCosts - difference) / 10 ** 9} TON
                        COSTS WITHOUT DESTINATION AMOUNT: ${Number(userCosts - difference - destinationMsgValue) / 10 ** 9} TON 
                        ---------------------------------------------
            `);
        });

        it('SF-2.5: successful multiple actions after root changing', async () => {
            epochDelay = 10;
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await deployJettonProxy();
            await deployJettonMinter();
            await giveMinterAdminToCrossChainLayer();

            const initJettonProxyJettonBalance = 1000;
            const anyoneTransferJettonWallet = await deployJettonWalletWithBalance(anyone.address.toString(), 0);
            const jettonProxyJettonWallet = await deployJettonWalletWithBalance(
                jettonProxy.address.toString(),
                initJettonProxyJettonBalance,
            );
            const anyoneMintJettonWallet = await getJettonWallet(anyone.address);

            const jettonAmount = 100;
            const payloadNumber = Math.round(Math.random() * 100);

            let testMsgEntries = [msgEntries[0], msgEntries[1]];

            let destinationMsgValue = 0n;
            let unlockTonValue = 0n;
            testMsgEntries.forEach((msgEntry) => {
                if (!msgEntry.needToUnlockTON) {
                    destinationMsgValue += msgEntry.destinationMsgValue;
                } else {
                    unlockTonValue += msgEntry.destinationMsgValue;
                }
            });

            const jettonTransferMsgEntry: MsgEntry = {
                operationId: toNano('1'),
                destinationAddress: jettonProxy.address,
                destinationMsgValue: toNano('0.1'),
                msgBody: beginCell()
                    .storeUint(JettonProxyOpCodes.crossChainLayerAddress_evmMsgToTVMproxy, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(jettonProxyJettonWallet.address)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                payloadNumber: payloadNumber,
            };
            testMsgEntries.push(jettonTransferMsgEntry);

            const mintJettonMsgEntry: MsgEntry = {
                operationId: toNano('1'),
                destinationAddress: jettonMinter.address,
                destinationMsgValue: toNano('0.1'),
                msgBody: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .storeMaybeRef(null)
                    .endCell(),
                payloadNumber: Math.round(Math.random() * 100),
            };
            testMsgEntries.push(mintJettonMsgEntry);

            let msgValue = 0n;
            testMsgEntries.forEach((msgEntry) => {
                msgValue += msgEntry.destinationMsgValue;
            });

            const testMsg: Message = {
                entries: testMsgEntries,
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            };

            payload = getCellByMessage(testMsg);
            const messagesDict = generateMsgsDictionaryBatching([testMsg]);
            const dictCell = beginCell().storeDictDirect(messagesDict).endCell();
            blockchain.now = Math.floor(Date.now() / 1000);

            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now + epochDelay,
            };
            merkleRoots.push(merkleRoot);
            console.log(merkleRoot.root);

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
            currEpoch = setRootResult.transactions[0].now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;
            await checkCrossChainLayerFullData();

            //Changing root in process
            const newMsgEntries = [...msgEntries];
            const newTestMsg: Message = {
                entries: newMsgEntries,
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            };

            const newMessagesDict = generateMsgsDictionaryBatching([newTestMsg]);
            const newDictCell = beginCell().storeDictDirect(newMessagesDict).endCell();
            blockchain.now = nextVotingTime + 2;

            const newMerkleRoot: MerkleRoot = {
                root: BigInt('0x' + newDictCell.hash().toString('hex')),
                validTimestamp: blockchain.now + epochDelay,
            };
            merkleRoots.push(newMerkleRoot);

            const newSetRootResult = await crossChainLayer.sendUpdateMerkleRoot(
                sequencerMultisig.getSender(),
                toNano('0.05'),
                {
                    merkleRoot: newMerkleRoot.root,
                    messageCollectEndTime: nextVotingTime,
                },
            );
            expect(newSetRootResult.transactions.length).toBe(3);
            prevEpoch = currEpoch;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;
            await checkCrossChainLayerFullData();

            isSpent = false;

            const initAnyoneBalance = await anyone.getBalance();

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const initAnyoneTransferJettonWalletContractBalance = (
                await blockchain.getContract(anyoneTransferJettonWallet.address)
            ).balance;
            const initJettonProxyJettonWalletContractBalance = (
                await blockchain.getContract(jettonProxyJettonWallet.address)
            ).balance;
            const initJettonProxyContractBalance = (await blockchain.getContract(jettonProxy.address)).balance;
            const initMinterWalletContractBalance = (await blockchain.getContract(jettonMinter.address)).balance;

            const initResponseBalance = await response.getBalance();

            const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.5') + destinationMsgValue, {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: anyone.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect(result.transactions.length).toBe(16);

            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
            });

            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 7,
            });
            expect((tx.outMessages.get(5)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_evmMsgToTVM),
            );
            expect(tx.outMessages.get(5)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(5)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonMinter.address,
                body: mintJettonMsgEntry.msgBody,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonMinter.address,
                to: anyoneMintJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(jettonMinter.address)
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyoneMintJettonWallet.address,
                to: response.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonProxy.address,
                body: jettonTransferMsgEntry.msgBody,
                value: jettonTransferMsgEntry.destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxy.address,
                to: jettonProxyJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Transfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(anyone.address)
                    .storeAddress(response.address)
                    .storeBit(0)
                    .storeCoins(0)
                    .storeMaybeSlice(null)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: jettonProxyJettonWallet.address,
                to: anyoneTransferJettonWallet.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.InternalTransfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(jettonProxy.address)
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeSlice(null)
                    .endCell(),
                success: true,
                exitCode: JettonWalletErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyoneTransferJettonWallet.address,
                to: response.address,
                body: beginCell()
                    .storeUint(JettonWalletOpCodes.Excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: JettonWalletErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: msgEntries[0].destinationAddress,
                body: msgEntries[0].msgBody,
                value: msgEntries[0].destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: msgEntries[1].destinationAddress,
                body: msgEntries[1].msgBody,
                value: msgEntries[1].destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: wTACTokenAddress,
                body: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano('0.01'))
                    .storeAddress(anyone.address)
                    .storeCoins(0)
                    .storeUint(0, 1)
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect((await anyoneTransferJettonWallet.getWalletData()).balance).toBe(jettonAmount);
            expect((await anyoneMintJettonWallet.getWalletData()).balance).toBe(jettonAmount);

            isSpent = true;

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerContractBalance = (await blockchain.getContract(crossChainLayer.address))
                .balance;
            const currentExecutorContractBalance = (await blockchain.getContract(executor.address)).balance;
            const currentAnyoneTransferJettonWalletContractBalance = (
                await blockchain.getContract(anyoneTransferJettonWallet.address)
            ).balance;
            const currentJettonProxyJettonWalletContractBalance = (
                await blockchain.getContract(jettonProxyJettonWallet.address)
            ).balance;
            const currentJettonProxyContractBalance = (await blockchain.getContract(jettonProxy.address)).balance;
            const currentMinterWalletContractBalance = (await blockchain.getContract(jettonMinter.address)).balance;
            const currentAnyoneMintJettonWalletContractBalance = (
                await blockchain.getContract(anyoneMintJettonWallet.address)
            ).balance;
            const currentAnyoneBalance = await anyone.getBalance();
            const currentResponseBalance = await response.getBalance();

            const differenceCrossChainLayer = currentCrossChainLayerContractBalance - initCrossChainLayerBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;
            const differenceResponse = currentResponseBalance - initResponseBalance;
            const differenceAnyoneTransferJettonWallet =
                currentAnyoneTransferJettonWalletContractBalance - initAnyoneTransferJettonWalletContractBalance;
            const differenceJettonProxyJettonWallet =
                currentJettonProxyJettonWalletContractBalance - initJettonProxyJettonWalletContractBalance;
            const differenceJettonProxy = currentJettonProxyContractBalance - initJettonProxyContractBalance;
            const differenceMinterWallet = currentMinterWalletContractBalance - initMinterWalletContractBalance;

            const userCosts =
                totalFees +
                destinationMsgValue +
                differenceJettonProxy +
                differenceJettonProxyJettonWallet +
                differenceAnyoneTransferJettonWallet +
                differenceMinterWallet +
                currentAnyoneMintJettonWalletContractBalance +
                deployExecutorInfo.totalFees +
                currentExecutorContractBalance +
                differenceCrossChainLayer;

            const difference = differenceAnyone + differenceResponse + userCosts;

            console.log(`
                [EVM to TVM]:
                User balance difference: ${Number(differenceAnyone + differenceResponse) / 10 ** 9} TON
                difference: ${Number(difference) / 10 ** 9} TON
                Response amount: ${Number(differenceResponse) / 10 ** 9} TON
                CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                ${Number(destinationMsgValue + unlockTonValue) / 10 ** 9} TON will be given to destination address
                ---------------------------------------------
                
                CCL COSTS:
                Transfer TON:
                - Send to destination: ${Number(unlockTonValue) / 10 ** 9} TON,
                
                ---------------------------------------------
                
                USER COSTS:
                - totalGas: ${totalGas}, 
                - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                
                Transfer TON:
                - Send to destination: ${Number(destinationMsgValue) / 10 ** 9} TON,
                
                Transfer Jetton:
                - User JW kept balance: ${Number(differenceAnyoneTransferJettonWallet) / 10 ** 9} TON, 
                - JettonProxy JW kept balance: ${Number(differenceJettonProxyJettonWallet) / 10 ** 9} TON,
                - JettonProxy kept balance: ${Number(differenceJettonProxy) / 10 ** 9} TON,
                
                Mint:
                - User JW kept balance: ${Number(currentAnyoneMintJettonWalletContractBalance) / 10 ** 9} TON, 
                - Jetton Minter kept balance: ${Number(differenceMinterWallet) / 10 ** 9} TON,
                
                General:
                - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                - Executor storage fee (prevent double spending): ${Number(currentExecutorContractBalance) / 10 ** 9} TON,     
                
                ---------------------------------------------
                ALL USER COSTS: ${Number(userCosts - difference) / 10 ** 9} TON
                COSTS WITHOUT DESTINATION AMOUNT: ${Number(userCosts - difference - destinationMsgValue) / 10 ** 9} TON 
                ---------------------------------------------
            `);
        });

        it('SF-2.6: unsuccessful ton transfer (not enough ton)', async () => {
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            const messages: Message[] = msgEntries.map((e) => ({
                entries: [e],
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            }));
            msgDict = generateMsgsDictionaryBatching(messages);
            const dictCell = beginCell().storeDictDirect(msgDict).endCell();

            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot = BigInt('0x' + dictCell.hash().toString('hex'));
            const rootResult = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('1'), {
                merkleRoot,
                messageCollectEndTime: nextVotingTime,
            });

            prevEpoch = currEpoch;
            currEpoch = rootResult.transactions[0].now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;
            merkleRoots.push({
                root: merkleRoot,
                validTimestamp: nextVotingTime,
            });
            await checkCrossChainLayerFullData();

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const initAnyoneBalance = await anyone.getBalance();

            isSpent = false;

            payload = getCellByMessage(messages[1]);

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            const merkleProof = msgDict.generateMerkleProof([payload.hash()]);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.5'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: anyone.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect(result.transactions.length).toBe(6);

            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
                exitCode: 0,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                exitCode: CrossChainLayerErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: executor.address,
                inMessageBounced: true,
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.executor_errorNotification, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors,
                outMessagesCount: 2,
            });
            expect((tx.outMessages.get(0)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_errorNotification),
            );
            expect(tx.outMessages.get(0)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(0)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const currentExecutorBalance = (await blockchain.getContract(executor.address)).balance;
            const currentAnyoneBalance = await anyone.getBalance();

            const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

            const userCosts = totalFees + deployExecutorInfo.totalFees + currentExecutorBalance;

            console.log(`
                [EVM to TVM]:
                User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                ---------------------------------------------
                
                USER COSTS:
                - totalGas: ${totalGas}, 
                - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                - Executor storage fee (prevent double spending): ${Number(currentExecutorBalance) / 10 ** 9} TON,    
                
                ---------------------------------------------
                ALL USER COSTS: ${Number(userCosts) / 10 ** 9} TON
                ---------------------------------------------
            `);
        });

        it('SF-2.7: unsuccessful multiple transfer (not enough ton)', async () => {
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await deployJettonProxy();
            await deployJettonMinter();
            await giveMinterAdminToCrossChainLayer();

            const initJettonProxyJettonBalance = 1000;
            const anyoneTransferJettonWallet = await deployJettonWalletWithBalance(anyone.address.toString(), 0);
            const jettonProxyJettonWallet = await deployJettonWalletWithBalance(
                jettonProxy.address.toString(),
                initJettonProxyJettonBalance,
            );

            const jettonAmount = 100;
            const payloadNumber = Math.round(Math.random() * 100);

            let testMsgEntries = [msgEntries[0], msgEntries[1]];

            let destinationMsgValue = 0n;
            testMsgEntries.forEach((msgEntry) => {
                destinationMsgValue += msgEntry.destinationMsgValue;
            });

            const jettonTransferMsgEntry: MsgEntry = {
                operationId: toNano('1'),
                destinationAddress: jettonProxy.address,
                destinationMsgValue: toNano('0.1'),
                msgBody: beginCell()
                    .storeUint(JettonProxyOpCodes.crossChainLayerAddress_evmMsgToTVMproxy, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(jettonProxyJettonWallet.address)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .endCell(),
                payloadNumber: payloadNumber,
            };
            testMsgEntries.push(jettonTransferMsgEntry);

            const mintJettonMsgEntry: MsgEntry = {
                operationId: toNano('1'),
                destinationAddress: jettonMinter.address,
                destinationMsgValue: toNano('0.1'),
                msgBody: beginCell()
                    .storeUint(JettonMinterOpCodes.mint, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeCoins(toNano(jettonAmount.toFixed(9)))
                    .storeAddress(response.address)
                    .storeCoins(0)
                    .storeMaybeRef(null)
                    .storeMaybeRef(null)
                    .endCell(),
                payloadNumber: Math.round(Math.random() * 100),
            };
            testMsgEntries.push(mintJettonMsgEntry);

            let msgValue = 0n;
            testMsgEntries.forEach((msgEntry) => {
                msgValue += msgEntry.destinationMsgValue;
            });

            const testMsg: Message = {
                entries: testMsgEntries,
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            };

            payload = getCellByMessage(testMsg);
            const messagesDict = generateMsgsDictionaryBatching([testMsg]);
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
            await checkCrossChainLayerFullData();

            isSpent = false;

            const initAnyoneBalance = await anyone.getBalance();

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const merkleProof = messagesDict.generateMerkleProof([payload.hash()]);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.5'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: anyone.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect(result.transactions.length).toBe(6);

            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
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

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: executor.address,
                inMessageBounced: true,
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.executor_errorNotification, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(payload)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors,
                outMessagesCount: 2,
            });
            expect((tx.outMessages.get(0)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_errorNotification),
            );
            expect(tx.outMessages.get(0)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(0)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });

            expect((await anyoneTransferJettonWallet.getWalletData()).balance).toBe(0);

            isSpent = false;

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerContractBalance = (await blockchain.getContract(crossChainLayer.address))
                .balance;
            const currentExecutorContractBalance = (await blockchain.getContract(executor.address)).balance;
            const currentAnyoneBalance = await anyone.getBalance();

            const differenceCrossChainLayer = currentCrossChainLayerContractBalance - initCrossChainLayerBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;

            const userCosts =
                totalFees + deployExecutorInfo.totalFees + currentExecutorContractBalance + differenceCrossChainLayer;

            console.log(`
                [EVM to TVM]:
                User balance difference: ${Number(differenceAnyone) / 10 ** 9} TON
                CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                ---------------------------------------------
                
                USER COSTS:
                - totalGas: ${totalGas}, 
                - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                - Executor storage fee (prevent double spending): ${Number(currentExecutorContractBalance) / 10 ** 9} TON,     

                ---------------------------------------------
                ALL USER COSTS: ${Number(userCosts) / 10 ** 9} TON
                ---------------------------------------------
            `);
        });

        it('SF-2.8: successful nft mint', async () => {
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await deployNFTCollection();

            const itemIndex = 123;

            const msgEntry: MsgEntry = {
                operationId: toNano('1'),
                destinationAddress: nftCollection.address,
                destinationMsgValue: toNano('0.2'),
                msgBody: NFTCollection.deployNFTItemMessage(0, itemIndex, anyone.address, beginCell().endCell()),
                payloadNumber: Math.round(Math.random() * 100),
            };
            msgEntries.push(msgEntry);
            const messages: Message[] = msgEntries.map((e) => ({
                entries: [e],
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            }));
            msgDict = generateMsgsDictionaryBatching(messages);
            const dictCell = beginCell().storeDictDirect(msgDict).endCell();

            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots = [merkleRoot];

            const rootResult = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('1'), {
                merkleRoot: merkleRoot.root,
                messageCollectEndTime: nextVotingTime,
            });

            expect(rootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            await checkCrossChainLayerFullData();

            const nftItemAddress = await nftCollection.getNFTAddressByIndex(itemIndex);

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const initAnyoneBalance = await anyone.getBalance();
            const initCollectionBalance = (await blockchain.getContract(nftCollection.address)).balance;
            const initItemBalance = (await blockchain.getContract(nftItemAddress)).balance;
            const initResponseBalance = (await blockchain.getContract(response.address)).balance;

            isSpent = false;
            payload = getCellByMessage(messages[messages.length - 1]);

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            const merkleProof = msgDict.generateMerkleProof([payload.hash()]);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('2'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: response.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect(result.transactions.length).toBe(9);

            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(response.address)
                    .endCell(),
                success: true,
            });

            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(response.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 4,
            });
            expect((tx.outMessages.get(2)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_evmMsgToTVM),
            );
            expect(tx.outMessages.get(2)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(2)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: response.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: nftCollection.address,
                body: msgEntry.msgBody,
                success: true,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftCollection.address,
                to: nftItemAddress,
                body: NFTItem.initMessage(0, anyone.address, beginCell().endCell()),
                success: true,
                deploy: true,
            });

            isSpent = true;

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const currentExecutorBalance = (await blockchain.getContract(executor.address)).balance;
            const currentAnyoneBalance = await anyone.getBalance();
            const currentResponseBalance = await response.getBalance();
            const currentCollectionBalance = (await blockchain.getContract(nftCollection.address)).balance;
            const currentItemBalance = (await blockchain.getContract(nftItemAddress)).balance;

            const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;
            const differenceResponse = currentResponseBalance - initResponseBalance;
            const differenceCollection = currentCollectionBalance - initCollectionBalance;
            const differenceItem = currentItemBalance - initItemBalance;

            const userCosts =
                totalFees +
                differenceCollection +
                differenceItem +
                deployExecutorInfo.totalFees +
                currentExecutorBalance +
                toNano(protocolFeeSupply.toFixed(9));

            console.log(`
                [EVM to TVM]:
                User balance difference: ${Number(differenceAnyone + differenceResponse) / 10 ** 9} TON
                Response amount: ${Number(differenceResponse) / 10 ** 9} TON
                CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                ---------------------------------------------
                
                USER COSTS:
                - totalGas: ${totalGas}, 
                - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                - Collection kept balance: ${Number(differenceCollection) / 10 ** 9} TON, 
                - Item kept balance: ${Number(differenceItem) / 10 ** 9} TON,
                - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                - Executor storage fee (prevent double spending): ${Number(currentExecutorBalance) / 10 ** 9} TON,  
                - CCL protocol fee: ${protocolFeeSupply} TON
                - ExecutorFee: ${Number(tacExecutorFee + tonExecutorFee) / 10 ** 9} TON

                ---------------------------------------------
                ALL USER COSTS: ${Number(userCosts) / 10 ** 9} TON
                COSTS WITHOUT CCL FEE: ${Number(userCosts - toNano(protocolFeeSupply.toFixed(9))) / 10 ** 9} TON 
                ---------------------------------------------
            `);
        });

        it('SF-2.9: successful nft transfer', async () => {
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await deployNFTProxy();
            await deploySingleNFTItem(nftProxy.address);

            const msgEntry: MsgEntry = {
                needToUnlockTON: false,
                operationId: 1n,
                destinationAddress: nftProxy.address,
                destinationMsgValue: toNano(0.5),
                msgBody: NFTProxy.evmMsgToTVMProxyMessage(0, nftItem.address, anyone.address, toNano(0.1)),
                payloadNumber: Math.round(Math.random() * 100),
            };
            msgEntries.push(msgEntry);

            const messages: Message[] = msgEntries.map((e) => ({
                entries: [e],
                validExecutors: [anyone.address],
                executorFeeToken: wTACTokenAddress,
                executorFeeValue: toNano('0.01'),
            }));
            msgDict = generateMsgsDictionaryBatching(messages);

            const dictCell = beginCell().storeDictDirect(msgDict).endCell();

            blockchain.now = Math.floor(Date.now() / 1000);
            const merkleRoot: MerkleRoot = {
                root: BigInt('0x' + dictCell.hash().toString('hex')),
                validTimestamp: blockchain.now,
            };
            merkleRoots = [merkleRoot];

            const rootResult = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('1'), {
                merkleRoot: merkleRoot.root,
                messageCollectEndTime: nextVotingTime,
            });

            expect(rootResult.transactions.length).toBe(3);
            prevEpoch = 1;
            currEpoch = blockchain.now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            await checkCrossChainLayerFullData();

            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const initAnyoneBalance = await anyone.getBalance();
            const initItemBalance = (await blockchain.getContract(nftItem.address)).balance;
            const initResponseBalance = (await blockchain.getContract(response.address)).balance;
            const initProxyBalance = (await blockchain.getContract(nftProxy.address)).balance;

            isSpent = false;
            payload = getCellByMessage(messages[messages.length - 1]);

            const deployExecutorInfo = await deployExecutor();
            await checkExecutorFullData();

            const merkleProof = msgDict.generateMerkleProof([payload.hash()]);
            const result = await executor.sendProxyMsg(anyone.getSender(), toNano('0.6'), {
                merkleProof,
                feeToAddress: anyone.address.toString(),
                responseAddress: response.address.toString(),
            });

            printTransactionFees(result.transactions);
            expect(result.transactions.length).toBe(11);
            expect(result.transactions).toHaveTransaction({
                from: undefined,
                to: anyone.address,
                success: true,
            });
            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: executor.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.anyone_proxyMsg, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeRef(merkleProof)
                    .storeAddress(anyone.address)
                    .storeAddress(response.address)
                    .endCell(),
                success: true,
                exitCode: ExecutorErrors.noErrors,
            });
            const tx = findTransactionRequired(result.transactions, {
                from: executor.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(ExecutorOpCodes.crossChainLayer_evmMsgToTVM, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeRef(merkleProof)
                    .storeRef(payload)
                    .storeAddress(response.address)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
                outMessagesCount: 4,
            });
            expect((tx.outMessages.get(2)?.info.dest! as ExternalAddress).value).toEqual(
                BigInt(CrossChainLayerOpCodes.executor_evmMsgToTVM),
            );
            expect(tx.outMessages.get(2)?.info.src!.toString()).toEqual(crossChainLayer.address.toString());
            expect(tx.outMessages.get(2)?.body.hash().toString()).toBe(payload.hash().toString());

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: response.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: nftProxy.address,
                body: msgEntry.msgBody,
                value: msgEntry.destinationMsgValue,
                success: true,
                exitCode: CrossChainLayerErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: nftProxy.address,
                to: nftItem.address,
                op: NFTItemOpCodes.owner_transfer,
                body: beginCell()
                    .storeUint(NFTItemOpCodes.owner_transfer, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeAddress(anyone.address)
                    .storeAddress(anyone.address)
                    .storeUint(0, 1)
                    .storeCoins(toNano(0.1))
                    .storeUint(0, 1)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            isSpent = true;

            await checkExecutorFullData();
            await checkCrossChainLayerFullData();

            const totalGas = result.transactions.reduce(sumTxUsedGas, 0n);
            const totalFees =
                result.transactions.reduce(sumTxFees, 0n) + result.transactions.reduce(sumTxForwardFees, 0n);
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;
            const currentExecutorBalance = (await blockchain.getContract(executor.address)).balance;
            const currentAnyoneBalance = await anyone.getBalance();
            const currentResponseBalance = await response.getBalance();
            const currentItemBalance = (await blockchain.getContract(nftItem.address)).balance;
            const currentProxyBalance = (await blockchain.getContract(nftProxy.address)).balance;

            const differenceCrossChainLayer = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const differenceAnyone = currentAnyoneBalance - initAnyoneBalance;
            const differenceResponse = currentResponseBalance - initResponseBalance;
            const differenceItem = currentItemBalance - initItemBalance;
            const differenceProxy = currentProxyBalance - initProxyBalance;

            const userCosts =
                totalFees +
                differenceProxy +
                differenceItem +
                deployExecutorInfo.totalFees +
                currentExecutorBalance +
                toNano(protocolFeeSupply.toFixed(9));

            console.log(`
                [EVM to TVM]:
                User balance difference: ${Number(differenceAnyone + differenceResponse) / 10 ** 9} TON
                Response amount: ${Number(differenceResponse) / 10 ** 9} TON
                CrossChainLayer balance difference: ${Number(differenceCrossChainLayer) / 10 ** 9} TON
                ---------------------------------------------
                
                USER COSTS:
                - totalGas: ${totalGas}, 
                - totalFees: ${Number(totalFees) / 10 ** 9} TON,  
                - Collection kept balance: ${Number(differenceProxy) / 10 ** 9} TON, 
                - Item kept balance: ${Number(differenceItem) / 10 ** 9} TON,
                - Executor deploy gas: ${deployExecutorInfo.totalGas},  
                - Executor deploy fee: ${Number(deployExecutorInfo.totalFees) / 10 ** 9} TON,  
                - Executor storage fee (prevent double spending): ${Number(currentExecutorBalance) / 10 ** 9} TON,  
                - CCL protocol fee: ${protocolFeeSupply} TON
                - ExecutorFee: ${Number(tacExecutorFee + tonExecutorFee) / 10 ** 9} TON

                ---------------------------------------------
                ALL USER COSTS: ${Number(userCosts) / 10 ** 9} TON
                COSTS WITHOUT CCL FEE: ${Number(userCosts - toNano(protocolFeeSupply.toFixed(9))) / 10 ** 9} TON 
                ---------------------------------------------
            `);
        });
    });
});
