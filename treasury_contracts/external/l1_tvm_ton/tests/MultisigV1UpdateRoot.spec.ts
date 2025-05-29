import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, internal, MessageRelaxed, SendMode, storeMessageRelaxed, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { CrossChainLayer, CrossChainLayerErrors, CrossChainLayerOpCodes } from '../wrappers/CrossChainLayer';
import { Params } from '../wrappers/Constants';
import { createKeyPairs, KeyPairs, sumTxFees, sumTxForwardFees, sumTxUsedGas } from './utils';
import { MultisigV1 } from '../wrappers/MultisigV1';
import { MultisigOrder } from '@ton/ton';
import { arrayToCell, MerkleRoot } from '../wrappers/utils/MerkleRoots';
import { generateMsgsDictionaryBatching, Message } from '../wrappers/utils/MsgUtils';

export function getOrderByMsg(
    sendMode: SendMode,
    msg: MessageRelaxed,
    walletId: number = 0,
    queryOffset: number = 7200,
) {
    const time = BigInt(Math.floor(Date.now() / 1000 + queryOffset));
    const queryId = time << 32n;

    let message = beginCell().store(storeMessageRelaxed(msg)).endCell();

    return MultisigOrder.fromPayload(
        beginCell().storeUint(walletId, 32).storeUint(queryId, 64).storeUint(sendMode, 8).storeRef(message).endCell(),
    );
}

describe('MultisigV1 UpdateRoot', () => {
    let initialState: BlockchainSnapshot;

    let curTime: () => number;
    let restoreConfig: () => void;

    //wallets
    const maxWalletNumber = 5;
    let signersKpData: KeyPairs;

    // CrossChainLayer
    let crossChainLayerCode: Cell;
    let blockchain: Blockchain;
    let admin: SandboxContract<TreasuryContract>;
    let sequencerMultisig: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;
    let crossChainLayer: SandboxContract<CrossChainLayer>;

    let adminAddress: string;
    let sequencerMultisigAddress: string;
    let merkleRoots: MerkleRoot[];
    let maxRootsSize: number;
    let prevEpoch: number;
    let currEpoch: number;
    let epochDelay: number;
    let messageCollectEndTime: number;
    let nextVotingTime: number;
    let tacProtocolFee: number;
    let tonProtocolFee: number;
    let protocolFeeSupply: number;

    let tonRate: number;

    let maxSignerFlood: number;

    // Executor
    let executorCode: Cell;

    // MultisigV1

    let multisigCode: Cell;
    let simplifiedMultisigCode: Cell;

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
        expect(data.messageCollectEndTime).toBe(messageCollectEndTime);
        expect(data.nextVotingTime).toBe(nextVotingTime);
        expect(data.tacProtocolFee).toBe(tacProtocolFee);
        expect(data.tonProtocolFee).toBe(tonProtocolFee);
        expect(data.protocolFeeSupply).toBe(protocolFeeSupply);
        expect(data.executorCode.hash().toString()).toBe(executorCode.hash().toString());
    }

    async function getTonToUsdRate(retries = 3, timeout = 5000): Promise<number> {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(
                'https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd',
                { signal: controller.signal },
            );

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`Failed to fetch TON to USD rate: ${response.statusText}`);
            }

            const data = await response.json();

            if (!data || !data['the-open-network'] || typeof data['the-open-network'].usd !== 'number') {
                throw new Error('Invalid response format from Coingecko API');
            }

            return data['the-open-network'].usd;
        } catch (error) {
            console.error('Error fetching TON to USD rate:', error);

            if (
                retries > 0 &&
                (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError'))
            ) {
                console.log(`Retrying... (${retries} attempts left)`);
                return getTonToUsdRate(retries - 1, timeout);
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`Failed to get TON/USD rate after multiple attempts: ${errorMessage}`);
            return 3;
        }
    }

    async function spamMessage(multisig: SandboxContract<MultisigV1>, n: number) {
        const maxSpamMessageNumber = maxSignerFlood * n;

        for (let i = 0; i < maxSpamMessageNumber - 1; i++) {
            const msg = internal({
                to: crossChainLayer.address,
                value: toNano('0.1'),
                body: beginCell().storeUint(CrossChainLayerOpCodes.anyone_excesses, 32).storeUint(i, 64).endCell(),
            });
            const order = getOrderByMsg(SendMode.PAY_GAS_SEPARATELY, msg, 0, i);
            const result = await multisig.sendOrder(order, signersKpData.keyPairs[i % n].secretKey, i % n);

            expect(result.transactions).not.toHaveTransaction({
                actionResultCode: (x) => x! != 0,
                exitCode: (x) => x! != 0,
            });
        }
        blockchain.now! += epochDelay * maxSpamMessageNumber;
    }

    async function deployCrossChainLayer() {
        crossChainLayer = blockchain.openContract(
            CrossChainLayer.createFromConfig(
                {
                    adminAddress,
                    executorCode,
                    tacProtocolFee,
                    tonProtocolFee,
                    protocolFeeSupply,
                    messageCollectEndTime,
                    maxRootsSize,
                    merkleRoots,
                    prevEpoch,
                    currEpoch,
                    epochDelay,
                    nextVotingTime,
                    sequencerMultisigAddress,
                },
                crossChainLayerCode,
            ),
        );

        const deployResult = await crossChainLayer.sendDeploy(admin.getSender(), toNano('2'));

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
    }

    beforeAll(async () => {
        crossChainLayerCode = await compile('CrossChainLayer');
        executorCode = await compile('Executor');
        multisigCode = await compile('MultisigV1');
        simplifiedMultisigCode = await compile('MultisigV1Simplified');

        curTime = () => blockchain.now ?? Math.floor(Date.now() / 1000);

        blockchain = await Blockchain.create();
        blockchain.now = curTime();

        admin = await blockchain.treasury('admin');
        anyone = await blockchain.treasury('anyone');
        sequencerMultisig = await blockchain.treasury('sequencerMultisig');

        restoreConfig = () => {
            adminAddress = admin.address.toString();
            sequencerMultisigAddress = sequencerMultisig.address.toString();
            epochDelay = 30;
            maxRootsSize = 3;
            const initMerkleRoots = () => {
                let merkleRoots: MerkleRoot[] = [];
                for (let i = -2; i < maxRootsSize - 2; i++) {
                    merkleRoots.push({
                        root: BigInt(i + 2),
                        validTimestamp: curTime() + i * epochDelay,
                    });
                }
                return merkleRoots;
            };

            merkleRoots = initMerkleRoots();

            prevEpoch = 0;
            currEpoch = 0;
            messageCollectEndTime = 0;
            nextVotingTime = merkleRoots[merkleRoots.length - 1].validTimestamp;
            tacProtocolFee = 0.01;
            tonProtocolFee = 0.02;
            protocolFeeSupply = 0;
        };

        restoreConfig();

        signersKpData = await createKeyPairs(maxWalletNumber);

        initialState = blockchain.snapshot();

        tonRate = await getTonToUsdRate();

        maxSignerFlood = 3;
    });

    // Each case state is independent
    afterEach(async () => {
        await blockchain.loadFrom(initialState);

        restoreConfig();
    });

    it('MV1-UR-1: update root default', async () => {
        let totalGas = 0n;
        let totalFees = 0n;

        sequencerMultisigAddress = sequencerMultisig.address.toString();
        await deployCrossChainLayer();
        await checkCrossChainLayerFullData();

        const msgEntries = [
            {
                operationId: toNano('1'),
                destinationAddress: anyone.address,
                destinationMsgValue: toNano('1'),
                msgBody: beginCell().storeUint(54321, 32).endCell(),
                payloadNumber: 1357,
            },
        ];

        const msg: Message = {
            entries: msgEntries,
            validExecutors: [anyone.address],
            executorFeeToken: null,
            executorFeeValue: toNano('0.01'),
        };

        const dict = generateMsgsDictionaryBatching([msg]);
        const dictCell = beginCell().storeDictDirect(dict).endCell();
        const newMerkleRoot = BigInt('0x' + dictCell.hash().toString('hex'));

        blockchain.now = nextVotingTime + epochDelay;

        const initSenderBalance = await sequencerMultisig.getBalance();
        const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

        const res = await crossChainLayer.sendUpdateMerkleRoot(sequencerMultisig.getSender(), toNano('0.012382'), {
            merkleRoot: newMerkleRoot,
            messageCollectEndTime: nextVotingTime,
        });
        printTransactionFees(res.transactions);

        totalFees += res.transactions.reduce(sumTxFees, 0n) + res.transactions.reduce(sumTxForwardFees, 0n);
        totalGas += res.transactions.reduce(sumTxUsedGas, 0n);

        expect(res.transactions).toHaveTransaction({
            from: sequencerMultisig.address,
            to: crossChainLayer.address,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, 32)
                .storeUint(0, 64)
                .storeUint(newMerkleRoot, Params.bitsize.hash)
                .storeUint(nextVotingTime, Params.bitsize.time)
                .endCell(),
            success: true,
        });

        prevEpoch = currEpoch;
        currEpoch = res.transactions[1].now;
        messageCollectEndTime = nextVotingTime;
        nextVotingTime = currEpoch + epochDelay;

        const merkleRoot: MerkleRoot = {
            root: newMerkleRoot,
            validTimestamp: nextVotingTime,
        };
        merkleRoots.push(merkleRoot);
        merkleRoots = merkleRoots.filter((root) => root.validTimestamp > currEpoch - maxRootsSize * epochDelay);
        await checkCrossChainLayerFullData();

        const currentSenderBalance = await sequencerMultisig.getBalance();
        const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

        const senderBalanceDifference = currentSenderBalance - initSenderBalance;
        const crossChainLayerBalanceDifference = currentCrossChainLayerBalance - initCrossChainLayerBalance;
        const monthlyOperationsCost = totalFees * ((30n * 24n * 60n * 60n) / BigInt(epochDelay));

        console.log(`
                [Update Merkle Root]: 
                   totalGas: ${totalGas} 
                   totalFees: ${Number(totalFees) / 10 ** 9} TON
                   ---------------------------------------------
                   Sender balance difference: ${Number(senderBalanceDifference) / 10 ** 9} TON
                   CrossChainLayer balance difference: ${Number(crossChainLayerBalanceDifference) / 10 ** 9} TON
                   ---------------------------------------------
                   Root setting delay: ${epochDelay}
                   Max stored roots in CCL: ${maxRootsSize}
                   ---------------------------------------------
                   ALL COSTS: ${Math.abs(Number(senderBalanceDifference + crossChainLayerBalanceDifference) / 10 ** 9)} TON
                   ALL COSTS IN USD: ${Math.abs(Number(senderBalanceDifference + crossChainLayerBalanceDifference) / 10 ** 9) * tonRate} USD
                   ---------------------------------------------
                   MONTHLY OPERATIONS COST IN TON: ${Number(monthlyOperationsCost) / 10 ** 9} TON
                   TON TO USD RATE: ${tonRate} USD
                   MONTHLY OPERATIONS COST IN USD: ${(Number(monthlyOperationsCost) / 10 ** 9) * tonRate} USD
            `);
    }, 500000);

    it('MV1-UR-2: multiple signature by multisig', async () => {
        const assertUpdateMerkleRootMultisig = async (threshold: number, total: number) => {
            let totalGas = 0n;
            let totalFees = 0n;

            const currentSignersData = signersKpData.keyPairs.slice(0, total);
            const currentSignersPublicKeys = currentSignersData.map((x) => {
                return x.publicKey;
            });

            const multisig = blockchain.openContract(
                MultisigV1.createFromConfig(
                    {
                        k: threshold,
                        publicKeys: currentSignersPublicKeys,
                        walletId: 0,
                    },
                    multisigCode,
                ),
            );

            let res = await multisig.sendDeploy(admin.getSender(), toNano('100'));
            expect(res.transactions).toHaveTransaction({
                from: admin.address,
                to: multisig.address,
                deploy: true,
                success: true,
            });

            sequencerMultisigAddress = multisig.address.toString();
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await spamMessage(multisig, total);

            const msgEntries = [
                {
                    operationId: toNano('1'),
                    destinationAddress: anyone.address,
                    destinationMsgValue: toNano('1'),
                    msgBody: beginCell().storeUint(54321, 32).endCell(),
                    payloadNumber: 1357,
                },
            ];

            const dictMsg: Message = {
                entries: msgEntries,
                validExecutors: [anyone.address],
                executorFeeToken: null,
                executorFeeValue: toNano('0.01'),
            };

            const dict = generateMsgsDictionaryBatching([dictMsg]);
            const dictCell = beginCell().storeDictDirect(dict).endCell();
            const newMerkleRoot = BigInt('0x' + dictCell.hash().toString('hex'));

            blockchain.now = nextVotingTime + epochDelay;

            const msg = internal({
                to: crossChainLayer.address,
                value: toNano('0.013'),
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, 32)
                    .storeUint(0, 64)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(nextVotingTime, Params.bitsize.time)
                    .endCell(),
            });

            const order = getOrderByMsg(SendMode.NONE, msg);

            for (let i = 0; i < threshold; i++) {
                order.sign(i, signersKpData.keyPairs[i].secretKey);
            }

            const initMultisigBalance = (await blockchain.getContract(multisig.address)).balance;
            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            res = await multisig.sendOrder(order, signersKpData.keyPairs[total - 1].secretKey, total - 1);
            printTransactionFees(res.transactions);

            totalFees += res.transactions.reduce(sumTxFees, 0n) + res.transactions.reduce(sumTxForwardFees, 0n);
            totalGas += res.transactions.reduce(sumTxUsedGas, 0n);

            expect(res.transactions).toHaveTransaction({
                from: undefined,
                to: multisig.address,
                exitCode: 0,
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: multisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, 32)
                    .storeUint(0, 64)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(nextVotingTime, Params.bitsize.time)
                    .endCell(),
                success: true,
            });

            prevEpoch = currEpoch;
            currEpoch = res.transactions[1].now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            const merkleRoot: MerkleRoot = {
                root: newMerkleRoot,
                validTimestamp: nextVotingTime,
            };
            merkleRoots.push(merkleRoot);
            merkleRoots = merkleRoots.filter((root) => root.validTimestamp > currEpoch - maxRootsSize * epochDelay);
            await checkCrossChainLayerFullData();

            const currentMultisigBalance = (await blockchain.getContract(multisig.address)).balance;
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const multisigBalanceDifference = currentMultisigBalance - initMultisigBalance;
            const crossChainLayerBalanceDifference = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const monthlyOperationsCost = totalFees * ((30n * 24n * 60n * 60n) / BigInt(epochDelay));

            console.log(`
                [Update Merkle Root]: 
                   signers N: ${total}
                   K (threshold): ${threshold}
                   totalGas: ${totalGas} 
                   totalFees: ${Number(totalFees) / 10 ** 9} TON
                   ---------------------------------------------
                   Multisig balance difference: ${Number(multisigBalanceDifference) / 10 ** 9} TON
                   CrossChainLayer balance difference: ${Number(crossChainLayerBalanceDifference) / 10 ** 9} TON
                   ---------------------------------------------
                   Root setting delay: ${epochDelay}
                   Max signers flood: ${maxSignerFlood}
                   Max stored roots in CCL: ${maxRootsSize}
                   ---------------------------------------------
                   ALL COSTS: ${Math.abs(Number(multisigBalanceDifference + crossChainLayerBalanceDifference) / 10 ** 9)} TON
                   ALL COSTS IN USD: ${Math.abs(Number(multisigBalanceDifference + crossChainLayerBalanceDifference) / 10 ** 9) * tonRate} USD
                   ---------------------------------------------
                   MONTHLY OPERATIONS COST IN TON: ${Number(monthlyOperationsCost) / 10 ** 9} TON
                   TON TO USD RATE: ${tonRate} USD
                   MONTHLY OPERATIONS COST IN USD: ${(Number(monthlyOperationsCost) / 10 ** 9) * tonRate} USD
            `);
            await blockchain.loadFrom(initialState);
            restoreConfig();
        };

        await assertUpdateMerkleRootMultisig(1, 1);
        await assertUpdateMerkleRootMultisig(3, 5);
        // await assertUpdateMerkleRootMultisig(5, 5);
        // await assertUpdateMerkleRootMultisig(7, 10);
        // await assertUpdateMerkleRootMultisig(10, 15);
        // await assertUpdateMerkleRootMultisig(15, 20);
        // await assertUpdateMerkleRootMultisig(20, 25);
        // await assertUpdateMerkleRootMultisig(25, 50);
        // await assertUpdateMerkleRootMultisig(50, 75);
        // await assertUpdateMerkleRootMultisig(70, 100);
        // await assertUpdateMerkleRootMultisig(100, 150);
        // await assertUpdateMerkleRootMultisig(150, 150);
    }, 500000);

    it('MV1-UR-3: single signature by multisig', async () => {
        const assertUpdateMerkleRootMultisig = async (threshold: number, total: number) => {
            let totalGas = 0n;
            let totalFees = 0n;

            const currentSignersData = signersKpData.keyPairs.slice(0, total);
            const currentSignersPublicKeys = currentSignersData.map((x) => {
                return x.publicKey;
            });

            const multisig = blockchain.openContract(
                MultisigV1.createFromConfig(
                    {
                        k: threshold,
                        publicKeys: currentSignersPublicKeys,
                        walletId: 0,
                    },
                    multisigCode,
                ),
            );

            let res = await multisig.sendDeploy(admin.getSender(), toNano('100'));
            expect(res.transactions).toHaveTransaction({
                from: admin.address,
                to: multisig.address,
                deploy: true,
                success: true,
            });

            sequencerMultisigAddress = multisig.address.toString();
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await spamMessage(multisig, total);

            const msgEntries = [
                {
                    operationId: toNano('1'),
                    destinationAddress: anyone.address,
                    destinationMsgValue: toNano('1'),
                    msgBody: beginCell().storeUint(54321, 32).endCell(),
                    payloadNumber: 1357,
                },
            ];

            const dictMsg: Message = {
                entries: msgEntries,
                validExecutors: [anyone.address],
                executorFeeToken: null,
                executorFeeValue: toNano('0.01'),
            };

            const dict = generateMsgsDictionaryBatching([dictMsg]);
            const dictCell = beginCell().storeDictDirect(dict).endCell();
            const newMerkleRoot = BigInt('0x' + dictCell.hash().toString('hex'));

            blockchain.now = nextVotingTime + epochDelay;

            const msg = internal({
                to: crossChainLayer.address,
                value: toNano('0.013'),
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, 32)
                    .storeUint(0, 64)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(nextVotingTime, Params.bitsize.time)
                    .endCell(),
            });

            let initMultisigBalance = (await blockchain.getContract(multisig.address)).balance;
            let initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const order = getOrderByMsg(SendMode.PAY_GAS_SEPARATELY, msg);

            for (let i = 1; i <= threshold; i++) {
                res = await multisig.sendOrder(order, signersKpData.keyPairs[total - i].secretKey, total - i);

                totalFees += res.transactions.reduce(sumTxFees, 0n) + res.transactions.reduce(sumTxForwardFees, 0n);
                totalGas += res.transactions.reduce(sumTxUsedGas, 0n);
            }

            printTransactionFees(res.transactions);
            expect(res.transactions).toHaveTransaction({
                from: undefined,
                to: multisig.address,
                exitCode: 0,
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: multisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, 32)
                    .storeUint(0, 64)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(nextVotingTime, Params.bitsize.time)
                    .endCell(),
                success: true,
            });

            prevEpoch = currEpoch;
            currEpoch = res.transactions[1].now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            const merkleRoot: MerkleRoot = {
                root: newMerkleRoot,
                validTimestamp: nextVotingTime,
            };
            merkleRoots.push(merkleRoot);
            merkleRoots = merkleRoots.filter((root) => root.validTimestamp > currEpoch - maxRootsSize * epochDelay);
            await checkCrossChainLayerFullData();

            const currentMultisigBalance = (await blockchain.getContract(multisig.address)).balance;
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const multisigBalanceDifference = currentMultisigBalance - initMultisigBalance;
            const crossChainLayerBalanceDifference = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const monthlyOperationsCost = totalFees * ((30n * 24n * 60n * 60n) / BigInt(epochDelay));

            console.log(`
                [Update Merkle Root]: 
                   signers N: ${total}
                   K (threshold): ${threshold}
                   totalGas: ${totalGas} 
                   totalFees: ${Number(totalFees) / 10 ** 9} TON
                   ---------------------------------------------
                   Multisig balance difference: ${Number(multisigBalanceDifference) / 10 ** 9} TON
                   CrossChainLayer balance difference: ${Number(crossChainLayerBalanceDifference) / 10 ** 9} TON
                   ---------------------------------------------
                   Root setting delay: ${epochDelay}
                   Max signers flood: ${maxSignerFlood}
                   Max stored roots in CCL: ${maxRootsSize}
                   ---------------------------------------------
                   ALL COSTS: ${Math.abs(Number(multisigBalanceDifference + crossChainLayerBalanceDifference) / 10 ** 9)} TON
                   ALL COSTS IN USD: ${Math.abs(Number(multisigBalanceDifference + crossChainLayerBalanceDifference) / 10 ** 9) * tonRate} USD
                   ---------------------------------------------
                   MONTHLY OPERATIONS COST IN TON: ${Number(monthlyOperationsCost) / 10 ** 9} TON
                   TON TO USD RATE: ${tonRate} USD
                   MONTHLY OPERATIONS COST IN USD: ${(Number(monthlyOperationsCost) / 10 ** 9) * tonRate} USD
                   
                   
            `);
            await blockchain.loadFrom(initialState);
            restoreConfig();
        };

        await assertUpdateMerkleRootMultisig(1, 1);
        await assertUpdateMerkleRootMultisig(3, 5);
        // await assertUpdateMerkleRootMultisig(5, 5);
        // await assertUpdateMerkleRootMultisig(7, 10);
        // await assertUpdateMerkleRootMultisig(10, 15);
        // await assertUpdateMerkleRootMultisig(15, 20);
        // await assertUpdateMerkleRootMultisig(20, 25);
        // await assertUpdateMerkleRootMultisig(25, 50);
        // await assertUpdateMerkleRootMultisig(50, 75);
        // await assertUpdateMerkleRootMultisig(70, 100);
        // await assertUpdateMerkleRootMultisig(100, 150);
        // await assertUpdateMerkleRootMultisig(150, 150);
    }, 500000);

    it('MV1-UR-4: multiple signature by simplified multisig', async () => {
        const assertUpdateMerkleRootMultisig = async (threshold: number, total: number) => {
            let totalGas = 0n;
            let totalFees = 0n;

            const currentSignersData = signersKpData.keyPairs.slice(0, total);
            const currentSignersPublicKeys = currentSignersData.map((x) => {
                return x.publicKey;
            });

            const multisig = blockchain.openContract(
                MultisigV1.createFromConfig(
                    {
                        k: threshold,
                        publicKeys: currentSignersPublicKeys,
                        walletId: 0,
                    },
                    simplifiedMultisigCode,
                ),
            );

            let res = await multisig.sendDeploy(admin.getSender(), toNano('100'));
            expect(res.transactions).toHaveTransaction({
                from: admin.address,
                to: multisig.address,
                deploy: true,
                success: true,
            });

            sequencerMultisigAddress = multisig.address.toString();
            await deployCrossChainLayer();
            await checkCrossChainLayerFullData();

            await spamMessage(multisig, total);

            const msgEntries = [
                {
                    operationId: toNano('1'),
                    destinationAddress: anyone.address,
                    destinationMsgValue: toNano('1'),
                    msgBody: beginCell().storeUint(54321, 32).endCell(),
                    payloadNumber: 1357,
                },
            ];

            const dictMsg: Message = {
                entries: msgEntries,
                validExecutors: [anyone.address],
                executorFeeToken: null,
                executorFeeValue: toNano('0.01'),
            };

            const dict = generateMsgsDictionaryBatching([dictMsg]);
            const dictCell = beginCell().storeDictDirect(dict).endCell();
            const newMerkleRoot = BigInt('0x' + dictCell.hash().toString('hex'));

            blockchain.now = nextVotingTime + epochDelay;

            const msg = internal({
                to: crossChainLayer.address,
                value: toNano('0.013'),
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, 32)
                    .storeUint(0, 64)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(nextVotingTime, Params.bitsize.time)
                    .endCell(),
            });

            const order = getOrderByMsg(SendMode.NONE, msg);

            for (let i = 0; i < threshold; i++) {
                order.sign(i, signersKpData.keyPairs[i].secretKey);
            }

            const initMultisigBalance = (await blockchain.getContract(multisig.address)).balance;
            const initCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            res = await multisig.sendOrder(order, signersKpData.keyPairs[total - 1].secretKey, total - 1);
            printTransactionFees(res.transactions);

            totalFees += res.transactions.reduce(sumTxFees, 0n) + res.transactions.reduce(sumTxForwardFees, 0n);
            totalGas += res.transactions.reduce(sumTxUsedGas, 0n);

            expect(res.transactions).toHaveTransaction({
                from: undefined,
                to: multisig.address,
                exitCode: 0,
                success: true,
            });

            expect(res.transactions).toHaveTransaction({
                from: multisig.address,
                to: crossChainLayer.address,
                body: beginCell()
                    .storeUint(CrossChainLayerOpCodes.sequencerMultisig_updateMerkleRoot, 32)
                    .storeUint(0, 64)
                    .storeUint(newMerkleRoot, Params.bitsize.hash)
                    .storeUint(nextVotingTime, Params.bitsize.time)
                    .endCell(),
                success: true,
            });

            prevEpoch = currEpoch;
            currEpoch = res.transactions[1].now;
            messageCollectEndTime = nextVotingTime;
            nextVotingTime = currEpoch + epochDelay;

            const merkleRoot: MerkleRoot = {
                root: newMerkleRoot,
                validTimestamp: nextVotingTime,
            };
            merkleRoots.push(merkleRoot);
            merkleRoots = merkleRoots.filter((root) => root.validTimestamp > currEpoch - maxRootsSize * epochDelay);
            await checkCrossChainLayerFullData();

            const currentMultisigBalance = (await blockchain.getContract(multisig.address)).balance;
            const currentCrossChainLayerBalance = (await blockchain.getContract(crossChainLayer.address)).balance;

            const multisigBalanceDifference = currentMultisigBalance - initMultisigBalance;
            const crossChainLayerBalanceDifference = currentCrossChainLayerBalance - initCrossChainLayerBalance;
            const monthlyOperationsCost = totalFees * ((30n * 24n * 60n * 60n) / BigInt(epochDelay));

            console.log(`
                [Update Merkle Root]: 
                   signers N: ${total}
                   K (threshold): ${threshold}
                   totalGas: ${totalGas} 
                   totalFees: ${Number(totalFees) / 10 ** 9} TON
                   ---------------------------------------------
                   Multisig balance difference: ${Number(multisigBalanceDifference) / 10 ** 9} TON
                   CrossChainLayer balance difference: ${Number(crossChainLayerBalanceDifference) / 10 ** 9} TON
                   ---------------------------------------------
                   Root setting delay: ${epochDelay}
                   Max signers flood: ${maxSignerFlood}
                   Max stored roots in CCL: ${maxRootsSize}
                   ---------------------------------------------
                   ALL COSTS: ${Math.abs(Number(multisigBalanceDifference + crossChainLayerBalanceDifference) / 10 ** 9)} TON
                   ALL COSTS IN USD: ${Math.abs(Number(multisigBalanceDifference + crossChainLayerBalanceDifference) / 10 ** 9) * tonRate} USD
                   ---------------------------------------------
                   MONTHLY OPERATIONS COST IN TON: ${Number(monthlyOperationsCost) / 10 ** 9} TON
                   TON TO USD RATE: ${tonRate} USD
                   MONTHLY OPERATIONS COST IN USD: ${(Number(monthlyOperationsCost) / 10 ** 9) * tonRate} USD
            `);
            await blockchain.loadFrom(initialState);
            restoreConfig();
        };

        await assertUpdateMerkleRootMultisig(1, 1);
        await assertUpdateMerkleRootMultisig(3, 5);
        // await assertUpdateMerkleRootMultisig(5, 5);
        // await assertUpdateMerkleRootMultisig(7, 10);
        // await assertUpdateMerkleRootMultisig(10, 15);
        // await assertUpdateMerkleRootMultisig(15, 20);
        // await assertUpdateMerkleRootMultisig(20, 25);
        // await assertUpdateMerkleRootMultisig(25, 50);
        // await assertUpdateMerkleRootMultisig(50, 75);
        // await assertUpdateMerkleRootMultisig(70, 100);
        // await assertUpdateMerkleRootMultisig(100, 150);
        // await assertUpdateMerkleRootMultisig(150, 150);
    }, 500000);
});
