import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, storeStateInit, toNano } from '@ton/core';
import {findTransaction, findTransactionRequired} from '@ton/test-utils';
import { compile } from '@ton/blueprint';

import { calculateFeesData, calculateMaxStorageState, printTxGasStats } from '../external/l1_tvm_ton/tests/utils';
import { arrayToCell, MerkleRoot } from '../external/l1_tvm_ton/wrappers/utils/MerkleRoots';

import { Op, Errors } from '../external/stablecoin-contract/wrappers/JettonConstants';
import { JettonMinter, JettonMinterConfig, JettonMinterContent, jettonContentToCell } from '../external/stablecoin-contract/wrappers/JettonMinter';

import { JettonWallet, JettonWalletConfig  } from '../external/stablecoin-contract/wrappers/JettonWallet';

import { Params } from '../external/l1_tvm_ton/wrappers/Constants';

import { 
    TacUsdtTreasury, 
    TacUsdtTreasuryConfig, 
    TacUsdtTreasuryOpCodes, 
    TacUsdtTreasuryErrors 
} from '../wrappers/TacUsdtTreasury';

import {
    CrossChainLayer,
    CrossChainLayerErrors,
    CrossChainLayerOpCodes,
    OperationType,
} from '../external/l1_tvm_ton/wrappers/CrossChainLayer';

import { JettonProxy, JettonProxyErrors, JettonProxyOpCodes } from '../external/l1_tvm_ton/wrappers/JettonProxy';

describe('TacUsdtTreasury', () => {

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;
    let admin: SandboxContract<TreasuryContract>;

    let adminAddress: string;

    let usdtTreasury: SandboxContract<TacUsdtTreasury>;
    let usdtTreasuryConfig: TacUsdtTreasuryConfig;
    let evmData: Cell;

    let usdtJettonWalletCode: Cell;
    let usdtUserWallet: (address: Address) => Promise<SandboxContract<JettonWallet>>;

    let usdtJettonMinter: SandboxContract<JettonMinter>;
    let usdtJettonMinterCode: Cell;
    let usdtJettonMinterConfig: JettonMinterConfig;
    let usdtDefaultContent: JettonMinterContent
    let initialState: BlockchainSnapshot;

    let jettonProxy: SandboxContract<JettonProxy>;
    let jettonProxyCode: Cell;

    let crossChainLayerCode: Cell;
    let crossChainLayer: SandboxContract<CrossChainLayer>;

    let protocolFee: number;
    let tacExecutorsFee: number;
    let tonExecutorsFee: number;
    let jettonTransferTonAmount: number;
    let treasuryFee: number;

    let cclTacProtocolFee: number;
    let cclTonProtocolFee: number;
    let protocolFeeSupply: number;

    const curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);

    async function checkFullData() {
        const data = await usdtTreasury.getFullData();
        expect(data.evmData.hash().toString()).toBe(evmData.hash().toString());
        expect(data.cclJettonProxy.toString()).toBe(jettonProxy.address.toString());
        expect(data.jettonMaster.toString()).toBe(usdtJettonMinter.address.toString());
        expect(data.jettonWalletCode.hash().toString()).toBe(usdtJettonWalletCode.hash().toString());
        expect(data.protocolFee).toBe(protocolFee);
        expect(data.tacExecutorsFee).toBe(tacExecutorsFee);
        expect(data.tonExecutorsFee).toBe(tonExecutorsFee);
        expect(data.jettonTransferTonAmount).toBe(jettonTransferTonAmount);
        expect(data.treasuryFee).toBe(treasuryFee);
    }    

    async function checkCrossChainLayerFullData() {
        const data = await crossChainLayer.getFullData();
        expect(data.adminAddress).toBe(adminAddress);
        expect(data.newAdminAddress).toBe(undefined);
        expect(data.sequencerMultisigAddress).toBe(adminAddress);
        expect(data.merkleRoots?.length).toBe(0);
        const expectedRoots: MerkleRoot[] = [];
        const receivedRoots = data.merkleRoots?.sort((a, b) => a.validTimestamp - b.validTimestamp);
        expect(receivedRoots).toStrictEqual(expectedRoots);
        expect(data.prevEpoch).toBe(0);
        expect(data.currEpoch).toBe(0);
        expect(data.epochDelay).toBe(0);
        expect(data.nextVotingTime).toBe(0);
        expect(data.currEpoch).toBe(0);
        expect(data.tacProtocolFee).toBe(cclTacProtocolFee);
        expect(data.tonProtocolFee).toBe(cclTonProtocolFee);
        expect(data.protocolFeeSupply).toBe(protocolFeeSupply);
        expect(data.executorCode.hash().toString()).toBe(beginCell().endCell().hash().toString());
    }

    async function deployCrossChainLayer() {
        crossChainLayer = blockchain.openContract(
            CrossChainLayer.createFromConfig(
                {
                    adminAddress,
                    executorCode: beginCell().endCell(),
                    merkleRoots: [],
                    prevEpoch: 0,
                    currEpoch: 0,
                    epochDelay: 0,
                    maxRootsSize: 10,
                    nextVotingTime: 0,
                    tacProtocolFee: cclTacProtocolFee,
                    tonProtocolFee: cclTonProtocolFee,
                    protocolFeeSupply,
                    sequencerMultisigAddress: adminAddress,
                },
                crossChainLayerCode,
            ),
        );

        const deployResult = await crossChainLayer.sendDeploy(admin.getSender(), toNano(0.5));

        expect(deployResult.transactions.length).toBe(2);

        expect(deployResult.transactions).toHaveTransaction({
            from: admin.address,
            to: crossChainLayer.address,
            body: beginCell().endCell(),
            initData: beginCell()
                .storeAddress(Address.parse(adminAddress))
                .storeAddress(null)
                .storeAddress(Address.parse(adminAddress))
                .storeRef(
                    beginCell()
                        .storeCoins(toNano(cclTacProtocolFee.toFixed(9)))
                        .storeCoins(toNano(cclTonProtocolFee.toFixed(9)))
                        .storeCoins(toNano(protocolFeeSupply.toFixed(9)))
                        .endCell(),
                )
                .storeRef(beginCell().endCell())
                .storeRef(
                    beginCell()
                        .storeUint(0, Params.bitsize.time)
                        .storeUint(0, Params.bitsize.time)
                        .storeUint(0, Params.bitsize.time)
                        .storeUint(0, Params.bitsize.time)
                        .storeUint(0, Params.bitsize.time)
                        .storeUint(10, 4)
                        .storeDict(arrayToCell([]))
                        .endCell(),
                )
                .endCell(),
            deploy: true,
            success: true,
            exitCode: CrossChainLayerErrors.noErrors,
        });

        await checkCrossChainLayerFullData();
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
    
    async function deployUsdtTreasury() {
        usdtTreasuryConfig = {
            evmData: evmData,
            cclJettonProxy: jettonProxy.address,
            jettonMaster: usdtJettonMinter.address,
            jettonWalletCode: usdtJettonWalletCode,
            protocolFee,
            tacExecutorsFee,
            tonExecutorsFee,
            jettonTransferTonAmount,
            treasuryFee,
        }

        usdtTreasury = blockchain.openContract(
            TacUsdtTreasury.createFromConfig(
                usdtTreasuryConfig,
                await compile('TacUsdtTreasury'),
            ),
        );
        const treasuryDeployResult = await usdtTreasury.sendDeploy(deployer.getSender(), toNano('0.05'));
        expect(treasuryDeployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: usdtTreasury.address,
            deploy: true,
            success: true,
        });

        await checkFullData();
    }   

    function buildEvmDataCell(evmTargetAdress: string, gasLimit: number, evmValidExecutors: string[], tvmValidExecutors: string[]): Cell {    
        const json = JSON.stringify({
            evmCall: {
                target: evmTargetAdress,
                methodName: "",
                arguments: "",
                gasLimit: gasLimit,
            },
            shardsKey: "1",
            shardCount: 1,
            evmValidExecutors: evmValidExecutors,
            tvmValidExecutors: tvmValidExecutors,
        });
    
        return beginCell().storeStringTail(json).endCell();
    }

    async function mintUsdtToAddress(address: Address, balance: bigint) {
        const mintResult = await usdtJettonMinter.sendMint(deployer.getSender(), address, balance, null, null, null, 0n, toNano('1'));
        const usdtTreasuryJettonWallet = await usdtUserWallet(address);

        findTransactionRequired(mintResult.transactions, {
            from: usdtJettonMinter.address,
            to: usdtTreasuryJettonWallet.address,
            deploy: true,
            success: true
        });
    }

    beforeAll(async () => {
        protocolFee = 1;
        tacExecutorsFee = 2;
        tonExecutorsFee = 3;
        jettonTransferTonAmount = 1;
        treasuryFee = 1;

        protocolFeeSupply = 0;
        cclTacProtocolFee = 0.1;
        cclTonProtocolFee = 0.1;
        
        usdtJettonMinterCode = await compile('UsdtJettonMinter');
        usdtDefaultContent = {
            uri: 'https://some_stablecoin.org/meta.json'
        };

        blockchain = await Blockchain.create();
        blockchain.now = curTime();

        const usdtJettonWalletCodeRaw = await compile('UsdtJettonWallet');
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${usdtJettonWalletCodeRaw.hash().toString('hex')}`), usdtJettonWalletCodeRaw);
        blockchain.libs = beginCell().storeDictDirect(_libs).endCell();
        let lib_jetton_prep = beginCell().storeUint(2, 8).storeBuffer(usdtJettonWalletCodeRaw.hash()).endCell();
        usdtJettonWalletCode = new Cell({ exotic: true, bits: lib_jetton_prep.bits, refs: lib_jetton_prep.refs });

        deployer = await blockchain.treasury('deployer');
        anyone = await blockchain.treasury('anyone');
        admin = await blockchain.treasury('admin');

        adminAddress = admin.address.toString();

        usdtJettonMinterConfig = {
            admin: deployer.address,
            wallet_code: usdtJettonWalletCode,
            jetton_content: jettonContentToCell(usdtDefaultContent)
        };

        usdtJettonMinter = blockchain.openContract(JettonMinter.createFromConfig(usdtJettonMinterConfig, usdtJettonMinterCode));
        const deployResult = await usdtJettonMinter.sendDeploy(deployer.getSender(), toNano('10'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: usdtJettonMinter.address,
            deploy: true,
            success: true,
        });
        expect(deployResult.transactions).not.toHaveTransaction({
            on: deployer.address,
            from: usdtJettonMinter.address,
            inMessageBounced: true
        });


        crossChainLayerCode = await compile('CrossChainLayer');
        await deployCrossChainLayer();
        await checkCrossChainLayerFullData();

        jettonProxyCode = await compile('JettonProxy');
        await deployJettonProxy();

        usdtUserWallet = async (address:Address) => blockchain.openContract(
            JettonWallet.createFromAddress(
              await usdtJettonMinter.getWalletAddress(address)
            )
        );

        evmData = buildEvmDataCell("", 1_000_000, [], []);
    
        initialState = blockchain.snapshot();
    });

    afterEach(async () => {
        await checkFullData();
        await blockchain.loadFrom(initialState);

        protocolFee = 1;
        tacExecutorsFee = 2;
        tonExecutorsFee = 3;
        jettonTransferTonAmount = 1;
        treasuryFee = 1;
    });

    describe('TAC-UT-1: storage gas stats', () => {
        it('TAC-UT-1.1: should collect stats for usdt treasury', async () => {
            await deployUsdtTreasury();
            await calculateMaxStorageState(blockchain, 'Treasury', usdtTreasury.address);
        });
    });

    describe('TAC-UT-2: birdge usdt', () => {
        it('TAC-UT-2.1: successfully bridge tokens', async () => {
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        
            const birdgeAmount = 100;
            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount + treasuryFee), {
                usdtAmount: birdgeAmount,
            });

            expect(bridgeTx.transactions.length).toBe(8);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(TacUsdtTreasuryOpCodes.bridge_usdt_to_tac, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const feeData = beginCell()
                        .storeUint(1, 1)
                        .storeCoins(toNano(protocolFee.toFixed(9)))
                        .storeCoins(toNano(tacExecutorsFee.toFixed(9)))
                        .storeCoins(toNano(tonExecutorsFee.toFixed(9)))
                        .endCell();

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasury.address,
                to: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(jettonProxy.address)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(null) 
                    .storeCoins(toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const jettonProxyUsdtWallet = await usdtUserWallet(jettonProxy.address);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasuryJettonWallet.address,
                to: jettonProxyUsdtWallet.address,
                body: beginCell()
                    .storeUint(Op.internal_transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxyUsdtWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer_notification, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                to: jettonProxy.address,
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxyUsdtWallet.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                to: usdtTreasury.address,
                success: true,
                exitCode: 0,
            });

                        
            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxy.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(OperationType.jettonTransfer, 32)
                    .storeCoins(0)
                    .storeMaybeRef(feeData)
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(jettonProxyUsdtWallet.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(birdgeAmount))
                    .storeRef(evmData)
                    .endCell(),
                to: crossChainLayer.address,
                success: true,
                outMessagesCount: 2,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const logPayload = beginCell()
                .storeUint(OperationType.jettonTransfer, 32)
                .storeUint(0, 64)
                .storeAddress(jettonProxy.address)
                .storeCoins(0)
                .storeMaybeRef(
                    beginCell()
                        .storeMaybeRef(feeData)
                        .storeCoins(toNano(cclTacProtocolFee.toFixed(9)))
                        .storeCoins(toNano(cclTonProtocolFee.toFixed(9)))
                        .endCell(),
                )
                .storeAddress(jettonProxyUsdtWallet.address)
                .storeAddress(usdtTreasury.address)
                .storeCoins(toNano(birdgeAmount))
                .storeRef(evmData)
                .endCell();

                expect(bridgeTx.transactions[bridgeTx.transactions.length - 2].outMessagesCount).toBe(2);
                expect(
                    bridgeTx.transactions[bridgeTx.transactions.length - 2].outMessages.get(0)?.info.src!.toString(),
                ).toEqual(crossChainLayer.address.toString());
                expect(
                    bridgeTx.transactions[bridgeTx.transactions.length - 2].outMessages.get(0)?.body.hash().toString(),
                ).toBe(logPayload.hash().toString());

                expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(0n);
        });

        it('TAC-UT-2.2: unsuccessfully bridge tokens, insufficient protocolFee, usdt should return back', async () => {
            protocolFee = 0.1; // doesn't enough for ccl
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        
            const birdgeAmount = 100;
            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount + treasuryFee), {
                usdtAmount: birdgeAmount,
            });

            expect(bridgeTx.transactions.length).toBe(11);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(TacUsdtTreasuryOpCodes.bridge_usdt_to_tac, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const feeData = beginCell()
                        .storeUint(1, 1)
                        .storeCoins(toNano(protocolFee.toFixed(9)))
                        .storeCoins(toNano(tacExecutorsFee.toFixed(9)))
                        .storeCoins(toNano(tonExecutorsFee.toFixed(9)))
                        .endCell();

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasury.address,
                to: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(jettonProxy.address)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(null) 
                    .storeCoins(toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const jettonProxyUsdtWallet = await usdtUserWallet(jettonProxy.address);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.internal_transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                to: jettonProxyUsdtWallet.address,
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxyUsdtWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer_notification, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                to: jettonProxy.address,
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxyUsdtWallet.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                to: usdtTreasury.address,
                success: true,
                exitCode: 0,
            });

                        
            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxy.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(OperationType.jettonTransfer, 32)
                    .storeCoins(0)
                    .storeMaybeRef(feeData)
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(jettonProxyUsdtWallet.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(birdgeAmount))
                    .storeRef(evmData)
                    .endCell(),
                to: crossChainLayer.address,
                success: true,
                outMessagesCount: 1,
                exitCode: CrossChainLayerErrors.notEnoughProtocolFee,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: jettonProxy.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(OperationType.jettonTransfer, 32)
                    .storeAddress(jettonProxyUsdtWallet.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(birdgeAmount.toFixed(9)))
                    .storeRef(evmData)
                    .endCell(),
                success: true,
                exitCode: JettonProxyErrors.noErrors,
            });

            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(toNano(birdgeAmount));
        });

        it('TAC-UT-2.3: successfully bridge tokens with add feeData', async () => {
            const initBalance = (await blockchain.getContract(usdtTreasury.address)).balance;

            protocolFee = 0;
            jettonTransferTonAmount = 0;
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        
            const birdgeAmount = 100;
            const addProtocolFee = 1;
            const addJettonTransferTonAmount = 1;

            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), toNano(protocolFee + addProtocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount + addJettonTransferTonAmount + treasuryFee), {
                usdtAmount: birdgeAmount,
                addFee: {
                    addProtocolFee,
                    addJettonTransferTonAmount,
                }
            });

            expect(bridgeTx.transactions.length).toBe(8);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(TacUsdtTreasuryOpCodes.bridge_usdt_to_tac, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeMaybeRef(beginCell()
                                .storeCoins(toNano(addProtocolFee))
                                .storeCoins(toNano(addJettonTransferTonAmount))            
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const feeData = beginCell()
                        .storeUint(1, 1)
                        .storeCoins(toNano((protocolFee + addProtocolFee).toFixed(9)))
                        .storeCoins(toNano(tacExecutorsFee.toFixed(9)))
                        .storeCoins(toNano(tonExecutorsFee.toFixed(9)))
                        .endCell();

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasury.address,
                to: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(jettonProxy.address)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(null) 
                    .storeCoins(toNano(protocolFee + addProtocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount + addJettonTransferTonAmount))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const jettonProxyUsdtWallet = await usdtUserWallet(jettonProxy.address);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.internal_transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(protocolFee + addProtocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount + addJettonTransferTonAmount))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                to: jettonProxyUsdtWallet.address,
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxyUsdtWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer_notification, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                to: jettonProxy.address,
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxyUsdtWallet.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                to: usdtTreasury.address,
                success: true,
                exitCode: 0,
            });
                        
            expect(bridgeTx.transactions).toHaveTransaction({
                from: jettonProxy.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_tvmMsgToEVM, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeUint(OperationType.jettonTransfer, 32)
                    .storeCoins(0)
                    .storeMaybeRef(feeData)
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(jettonProxyUsdtWallet.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(birdgeAmount))
                    .storeRef(evmData)
                    .endCell(),
                to: crossChainLayer.address,
                success: true,
                outMessagesCount: 2,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: crossChainLayer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.anyone_excesses, Params.bitsize.op)
                    .storeUint(0, Params.bitsize.queryId)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const logPayload = beginCell()
                .storeUint(OperationType.jettonTransfer, 32)
                .storeUint(0, 64)
                .storeAddress(jettonProxy.address)
                .storeCoins(0)
                .storeMaybeRef(
                    beginCell()
                        .storeMaybeRef(feeData)
                        .storeCoins(toNano(cclTacProtocolFee.toFixed(9)))
                        .storeCoins(toNano(cclTonProtocolFee.toFixed(9)))
                        .endCell(),
                )
                .storeAddress(jettonProxyUsdtWallet.address)
                .storeAddress(usdtTreasury.address)
                .storeCoins(toNano(birdgeAmount))
                .storeRef(evmData)
                .endCell();

                expect(bridgeTx.transactions[bridgeTx.transactions.length - 2].outMessagesCount).toBe(2);
                expect(
                    bridgeTx.transactions[bridgeTx.transactions.length - 2].outMessages.get(0)?.info.src!.toString(),
                ).toEqual(crossChainLayer.address.toString());
                expect(
                    bridgeTx.transactions[bridgeTx.transactions.length - 2].outMessages.get(0)?.body.hash().toString(),
                ).toBe(logPayload.hash().toString());

                expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(0n);

                // const initBridgeTx = findTransactionRequired(bridgeTx.transactions, {
                //     from: deployer.address,
                //     to: usdtTreasury.address,
                //     success: true,
                // });

                // printTxGasStats('USDT Bridge', initBridgeTx);
                // await calculateFeesData(blockchain, usdtTreasury, bridgeTx, initBalance); // if want to calculate usdtTreasury gas exactly
        });

        it('TAC-UT-2.4: successfully bridge usdt, balance_error on usdt Wallet', async () => {
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
            
            const birdgeAmount = 101;
            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount + treasuryFee), {
                usdtAmount: birdgeAmount,
            });

            expect(bridgeTx.transactions.length).toBe(3);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(TacUsdtTreasuryOpCodes.bridge_usdt_to_tac, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
            });

            const feeData = beginCell()
                        .storeUint(1, 1)
                        .storeCoins(toNano(protocolFee.toFixed(9)))
                        .storeCoins(toNano(tacExecutorsFee.toFixed(9)))
                        .storeCoins(toNano(tonExecutorsFee.toFixed(9)))
                        .endCell();

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasury.address,
                to: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeAddress(jettonProxy.address)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(null) 
                    .storeCoins(toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount))
                    .storeMaybeRef(beginCell()
                                .storeCoins(0)
                                .storeMaybeRef(feeData)
                                .storeMaybeRef(evmData)
                                .endCell())
                    .endCell(),
                success: false,
                exitCode: Errors.balance_error,
            });

            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        });

        it('TAC-UT-2.5: unsuccessfully bridge usdt not enough msg value', async () => {
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
            
            const birdgeAmount = 100;
            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), toNano(protocolFee + tacExecutorsFee + tonExecutorsFee + jettonTransferTonAmount), {
                usdtAmount: birdgeAmount,
            });

            expect(bridgeTx.transactions.length).toBe(3);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(TacUsdtTreasuryOpCodes.bridge_usdt_to_tac, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(toNano(birdgeAmount))
                    .storeMaybeRef(null)
                    .endCell(),
                success: false,
                exitCode: TacUsdtTreasuryErrors.notEnoughMsgValue,
            });
        });            
    });

    describe('TAC-UT-3: get methods', () => {});
});
