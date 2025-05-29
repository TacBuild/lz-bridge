import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Dictionary, fromNano, storeStateInit, toNano } from '@ton/core';
import {findTransaction, findTransactionRequired} from '@ton/test-utils';
import { compile } from '@ton/blueprint';

import { calculateFeesData, calculateMaxStorageState, printTxGasStats } from '../external/l1_tvm_ton/tests/utils';

import { Op, Errors } from '../external/stablecoin-contract/wrappers/JettonConstants';
import { JettonMinter, JettonMinterConfig, JettonMinterContent, jettonContentToCell } from '../external/stablecoin-contract/wrappers/JettonMinter';

import { JettonWallet, JettonWalletConfig  } from '../external/stablecoin-contract/wrappers/JettonWallet';

import { Params } from '../external/l1_tvm_ton/wrappers/Constants';

import { buildOFTSendPayload } from '../scripts/bridge'

import { 
    EthUsdtTreasury, 
    EthUsdtTreasuryConfig, 
    EthUsdtTreasuryOpCodes, 
    EthUsdtTreasuryErrors 
} from '../wrappers/EthUsdtTreasury';

import { 
    LayerZeroMock,
    LayerZeroMockConfig 
} from '../wrappers/LayerZeroMock';
import { MAX_CELL_BITS } from '@layerzerolabs/lz-ton-sdk-v2';


describe('EthUsdtTreasury', () => {

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;
    let admin: SandboxContract<TreasuryContract>;

    let adminAddress: string;

    let minTonAmount: number;
    let lzFee: number;
    let layerZeroMock: SandboxContract<LayerZeroMock>;
    let layerZeroMockConfig: LayerZeroMockConfig;

    let usdtTreasury: SandboxContract<EthUsdtTreasury>;
    let usdtTreasuryConfig: EthUsdtTreasuryConfig;

    let usdtJettonWalletCode: Cell;
    let usdtUserWallet: (address: Address) => Promise<SandboxContract<JettonWallet>>;

    let usdtJettonMinter: SandboxContract<JettonMinter>;
    let usdtJettonMinterCode: Cell;
    let usdtJettonMinterConfig: JettonMinterConfig;
    let usdtDefaultContent: JettonMinterContent
    let initialState: BlockchainSnapshot;

    let oAppAddress: Address;
    let dstEvmAddress: string;
    let ethEid: number;
    let maxBridgeAmount: bigint;
    let nativeFee: number;
    let estimatedGasCost: number;
    let jettonTransferGasCost: number;
    let treasuryFee: number;

    const curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);

    async function checkFullData() {
        const data = await usdtTreasury.getFullData();
        expect(data.jettonMaster.toString()).toBe(usdtJettonMinter.address.toString());
        expect(data.jettonWalletCode.hash().toString()).toBe(usdtJettonWalletCode.hash().toString());
        expect(data.oAppAddress.toString()).toBe(oAppAddress.toString());
        expect(data.dstEvmAddress).toBe(BigInt(dstEvmAddress));
        expect(data.ethEid).toBe(ethEid);
        expect(data.maxBridgeAmount).toBe(maxBridgeAmount);
        expect(data.nativeFee).toBe(nativeFee);
        expect(data.estimatedGasCost).toBe(estimatedGasCost);
        expect(data.treasuryFee).toBe(treasuryFee);
    } 
    
    async function deployUsdtTreasury() {
        usdtTreasuryConfig = {
            jettonMaster: usdtJettonMinter.address,
            jettonWalletCode: usdtJettonWalletCode,
            oAppAddress,
            dstEvmAddress: BigInt(dstEvmAddress),
            ethEid,
            maxBridgeAmount,
            nativeFee,
            estimatedGasCost,
            jettonTransferGasCost,
            treasuryFee,
        }

        usdtTreasury = blockchain.openContract(
            EthUsdtTreasury.createFromConfig(
                usdtTreasuryConfig,
                await compile('EthUsdtTreasury'),
            ),
        );
        const treasuryDeployResult = await usdtTreasury.sendDeploy(deployer.getSender(), toNano(nativeFee + estimatedGasCost));
        expect(treasuryDeployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: usdtTreasury.address,
            deploy: true,
            success: true,
        });

        await checkFullData();
    }

    async function deployLayerZeroMock() {
        layerZeroMockConfig = {
            jettonMaster: usdtJettonMinter.address,
            jettonWalletCode: usdtJettonWalletCode,
            minTonAmount,
            lzFee,
        };
        layerZeroMock = blockchain.openContract(
            LayerZeroMock.createFromConfig(
                layerZeroMockConfig,
                await compile('LayerZeroMock'),
            ),
        );
        const layerZeroDeployResult = await layerZeroMock.sendDeploy(deployer.getSender(), toNano('10'));
        expect(layerZeroDeployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: layerZeroMock.address,
            deploy: true,
            success: true,
        });
        
        oAppAddress = layerZeroMock.address;
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
        oAppAddress = Address.parse("EQAXByU5SqVhNvvSfQzjHYqY4PiucqTSN5td3oPiEaLV-p0-");
        dstEvmAddress = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
        ethEid = 30101;
        jettonTransferGasCost = 1;
        treasuryFee = 1;
        maxBridgeAmount = 1_000_000_000_000n;
        nativeFee = 100;
        estimatedGasCost = 100;

        lzFee = 2;
        minTonAmount = 2;

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

        usdtUserWallet = async (address:Address) => blockchain.openContract(
            JettonWallet.createFromAddress(
              await usdtJettonMinter.getWalletAddress(address)
            )
        );

        initialState = blockchain.snapshot();
    });

    afterEach(async () => {
        await checkFullData();
        await blockchain.loadFrom(initialState);
    });

    describe('ETH-UT-1: storage gas stats', () => {
        it('ETH-UT-1.1: should collect stats for usdt treasury', async () => {
            await deployUsdtTreasury();
            await calculateMaxStorageState(blockchain, 'Treasury', usdtTreasury.address);
        });
    });

    describe('ETH-UT-2: birdge usdt', () => {
        it('ETH-UT-2.1: successfully bridge tokens', async () => {
            await deployLayerZeroMock();
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);

            const initBalance = (await blockchain.getContract(usdtTreasury.address)).balance;
            const birdgeAmount = 100_000_000_000n;
            let neededValue = toNano(nativeFee) + toNano(estimatedGasCost) + toNano(treasuryFee) + toNano(jettonTransferGasCost) - initBalance;
            if (neededValue < toNano(treasuryFee + jettonTransferGasCost)) {
                neededValue = toNano(treasuryFee + jettonTransferGasCost);
            }

            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), neededValue, {
                usdtAmount: birdgeAmount,
            });

            expect(bridgeTx.transactions.length).toBe(7);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(EthUsdtTreasuryOpCodes.bridge_usdt_to_eth, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
                exitCode: 0,
            });
            
            const lzPayload = buildOFTSendPayload({
                dstEid: ethEid,
                dstEvmAddress,
                minAmount: 0n,
                nativeFee: toNano(nativeFee.toFixed(9))
            })
            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasury.address,
                to: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(layerZeroMock.address)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(null) 
                    .storeCoins(toNano(nativeFee + estimatedGasCost))
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const lzMockUsdtWallet = await usdtUserWallet(layerZeroMock.address);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasuryJettonWallet.address,
                to: lzMockUsdtWallet.address,
                body: beginCell()
                    .storeUint(Op.internal_transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(nativeFee + estimatedGasCost)) 
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: lzMockUsdtWallet.address,
                to: layerZeroMock.address,
                body: beginCell()
                    .storeUint(Op.transfer_notification, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: layerZeroMock.address,
                to: usdtTreasury.address,
                body: beginCell().endCell(),
                value: toNano(nativeFee + estimatedGasCost - lzFee),
                success: true,
                exitCode: 0,
            });

            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - birdgeAmount);
            expect(await lzMockUsdtWallet.getJettonBalance()).toEqual(birdgeAmount);
        });   
        
        it('ETH-UT-2.3: bridge amount too big', async () => {
            await deployLayerZeroMock();
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);

            const initBalance = (await blockchain.getContract(usdtTreasury.address)).balance;
            const birdgeAmount = maxBridgeAmount + 1n;
            let neededValue = toNano(nativeFee) + toNano(estimatedGasCost) + toNano(treasuryFee) + toNano(jettonTransferGasCost) - initBalance;
            if (neededValue < toNano(treasuryFee + jettonTransferGasCost)) {
                neededValue = toNano(treasuryFee + jettonTransferGasCost);
            }

            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), neededValue, {
                usdtAmount: birdgeAmount,
            });

            expect(bridgeTx.transactions.length).toBe(3);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(EthUsdtTreasuryOpCodes.bridge_usdt_to_eth, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeMaybeRef(null)
                    .endCell(),
                success: false,
                exitCode: EthUsdtTreasuryErrors.bridgeAmountTooBig,
            });

            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        });

        it('ETH-UT-2.4: not enough msg value add fee', async () => {
            await deployLayerZeroMock();
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);

            const initBalance = (await blockchain.getContract(usdtTreasury.address)).balance;
            const birdgeAmount = 100n;
            let neededValue = toNano(treasuryFee) + toNano(jettonTransferGasCost) - 1n;

            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), neededValue, {
                usdtAmount: birdgeAmount,
            });

            expect(bridgeTx.transactions.length).toBe(3);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(EthUsdtTreasuryOpCodes.bridge_usdt_to_eth, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeMaybeRef(null)
                    .endCell(),
                success: false,
                exitCode: EthUsdtTreasuryErrors.notEnoughMsgValueAddFee,
            });

            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
        });

        it('ETH-UT-2.5: fee too low, funds should be returned back', async () => {
            minTonAmount = nativeFee + estimatedGasCost + jettonTransferGasCost;
            await deployLayerZeroMock();
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);

            const initBalance = (await blockchain.getContract(usdtTreasury.address)).balance;
            const birdgeAmount = 100_000_000_000n;
            let neededValue = toNano(nativeFee) + toNano(estimatedGasCost) + toNano(treasuryFee) + toNano(jettonTransferGasCost) - initBalance;
            if (neededValue < toNano(treasuryFee + jettonTransferGasCost)) {
                neededValue = toNano(treasuryFee + jettonTransferGasCost);
            }

            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), neededValue, {
                usdtAmount: birdgeAmount,
            });

            expect(bridgeTx.transactions.length).toBe(10);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(EthUsdtTreasuryOpCodes.bridge_usdt_to_eth, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeMaybeRef(null)
                    .endCell(),
                success: true,
                exitCode: 0,
            });
            
            const lzPayload = buildOFTSendPayload({
                dstEid: ethEid,
                dstEvmAddress,
                minAmount: 0n,
                nativeFee: toNano(nativeFee.toFixed(9))
            })
            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasury.address,
                to: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(layerZeroMock.address)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(null) 
                    .storeCoins(toNano(nativeFee + estimatedGasCost))
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const lzMockUsdtWallet = await usdtUserWallet(layerZeroMock.address);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasuryJettonWallet.address,
                to: lzMockUsdtWallet.address,
                body: beginCell()
                    .storeUint(Op.internal_transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(nativeFee + estimatedGasCost)) 
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: lzMockUsdtWallet.address,
                to: layerZeroMock.address,
                body: beginCell()
                    .storeUint(Op.transfer_notification, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: layerZeroMock.address,
                to: lzMockUsdtWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(layerZeroMock.address)
                    .storeMaybeRef(null) 
                    .storeCoins(toNano(nativeFee + estimatedGasCost - lzFee))
                    .storeMaybeRef(beginCell().endCell())
                    .endCell(),

                success: true,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: lzMockUsdtWallet.address,
                to: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.internal_transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(layerZeroMock.address)
                    .storeAddress(layerZeroMock.address)
                    .storeCoins(toNano(nativeFee + estimatedGasCost - lzFee)) 
                    .storeMaybeRef(beginCell().endCell())
                    .endCell(),
                success: true,
            });

            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);
            expect((await blockchain.getContract(usdtTreasury.address)).balance).toBeGreaterThan(initBalance + neededValue - toNano(lzFee) - toNano(jettonTransferGasCost));
        });

        it('ETH-UT-2.6: fee too low, but we will add fee', async () => {
            minTonAmount = nativeFee + estimatedGasCost + jettonTransferGasCost;
            await deployLayerZeroMock();
            await deployUsdtTreasury();

            const initialJettonBalance = toNano(100);
            await mintUsdtToAddress(usdtTreasury.address, initialJettonBalance);
            const usdtTreasuryJettonWallet = await usdtUserWallet(usdtTreasury.address);
            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance);

            const addNativeFee = 1;
            const initBalance = (await blockchain.getContract(usdtTreasury.address)).balance;

            const birdgeAmount = 100_000_000_000n;
            let neededValue = toNano(nativeFee) + toNano(estimatedGasCost) + toNano(treasuryFee) + toNano(jettonTransferGasCost) - initBalance;
            if (neededValue < toNano(treasuryFee + jettonTransferGasCost)) {
                neededValue = toNano(treasuryFee + jettonTransferGasCost);
            }
            neededValue += toNano(addNativeFee);

            const bridgeTx = await usdtTreasury.sendBridgeUsdt(deployer.getSender(), neededValue, {
                usdtAmount: birdgeAmount,
                addFee: {
                    addNativeFee,
                    addJettonTransferGasCost: 0,
                    addEstimatedGasCost: 0,
                }
            });

            expect(bridgeTx.transactions.length).toBe(7);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: deployer.address,
                to: usdtTreasury.address,
                body: beginCell()
                    .storeUint(EthUsdtTreasuryOpCodes.bridge_usdt_to_eth, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeMaybeRef(beginCell()
                                .storeCoins(toNano(addNativeFee))
                                .storeCoins(0)
                                .storeCoins(0)
                                .endCell())
                    .endCell(),
                success: true,
                exitCode: 0,
            });
            
            const lzPayload = buildOFTSendPayload({
                dstEid: ethEid,
                dstEvmAddress,
                minAmount: 0n,
                nativeFee: toNano((nativeFee + addNativeFee).toFixed(9))
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasury.address,
                to: usdtTreasuryJettonWallet.address,
                body: beginCell()
                    .storeUint(Op.transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(layerZeroMock.address)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(null)
                    .storeCoins(toNano(nativeFee + addNativeFee + estimatedGasCost))
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            const lzMockUsdtWallet = await usdtUserWallet(layerZeroMock.address);

            expect(bridgeTx.transactions).toHaveTransaction({
                from: usdtTreasuryJettonWallet.address,
                to: lzMockUsdtWallet.address,
                body: beginCell()
                    .storeUint(Op.internal_transfer, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(usdtTreasury.address)
                    .storeAddress(usdtTreasury.address)
                    .storeCoins(toNano(nativeFee + addNativeFee + estimatedGasCost)) 
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: lzMockUsdtWallet.address,
                to: layerZeroMock.address,
                body: beginCell()
                    .storeUint(Op.transfer_notification, 32)
                    .storeUint(0, Params.bitsize.queryId)
                    .storeCoins(birdgeAmount)
                    .storeAddress(usdtTreasury.address)
                    .storeMaybeRef(lzPayload)
                    .endCell(),
                success: true,
                exitCode: 0,
            });

            expect(bridgeTx.transactions).toHaveTransaction({
                from: layerZeroMock.address,
                to: usdtTreasury.address,
                body: beginCell().endCell(),
                value: toNano(nativeFee + addNativeFee + estimatedGasCost - lzFee),
                success: true,
                exitCode: 0,
            });

            expect(await usdtTreasuryJettonWallet.getJettonBalance()).toEqual(initialJettonBalance - birdgeAmount);
            expect(await lzMockUsdtWallet.getJettonBalance()).toEqual(birdgeAmount);
        });
    });

    describe('ETH-UT-3: get methods', () => {});
});
