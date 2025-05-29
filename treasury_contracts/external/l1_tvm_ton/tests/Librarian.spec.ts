import { Cell, fromNano, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Librarian } from '../wrappers/Librarian';
import {
    calcMasterchainStorageFee,
    collectCellStats,
    getStoragePrices,
    StorageValue,
} from '../wrappers/utils/GasUtils';

describe('Librarian', () => {
    let code: Cell;
    let initialState: BlockchainSnapshot;
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let librarian: SandboxContract<Librarian>;

    let jettonWalletCode: Cell;
    let jettonMinterCode: Cell;
    let executorCode: Cell;

    let storageDuration: number[];

    let storagePrices: StorageValue;

    beforeAll(async () => {
        blockchain = await Blockchain.create();

        code = await compile('Librarian');
        deployer = await blockchain.treasury('deployer');
        initialState = blockchain.snapshot();
        const year = 365 * 24 * 60 * 60;
        storageDuration = [year, 5 * year, 10 * year, 50 * year, 100 * year];

        jettonWalletCode = await compile('JettonWallet');
        jettonMinterCode = await compile('JettonMinter');
        executorCode = await compile('Executor');

        storagePrices = getStoragePrices(blockchain.config);
    });

    afterEach(async () => {
        await blockchain.loadFrom(initialState);
    });

    describe('L-1: JettonWallet', () => {
        it('L-1.1: should reserve balance', async () => {
            librarian = blockchain.openContract(Librarian.createFromConfig({ code: jettonWalletCode }, code));
            const result = await librarian.sendDeploy(deployer.getSender(), toNano('100'));
            printTransactionFees(result.transactions);

            expect(result.transactions).not.toHaveTransaction({
                actionResultCode: (x) => x! != 0,
                exitCode: (x) => x! != 0,
            });

            const currentBalance = (await blockchain.getContract(librarian.address)).balance;
            expect(currentBalance).toBeGreaterThan(0n);
            console.log(fromNano(currentBalance));
        });

        it('L-1.2: should calc reserve amount', async () => {
            for (const duration of storageDuration) {
                const stats = collectCellStats(jettonWalletCode, []);
                const minTonForStorage = calcMasterchainStorageFee(storagePrices, stats, BigInt(duration));
                console.log(fromNano(minTonForStorage));
            }
        });
    });

    describe('L-2: JettonMinter', () => {
        it('L-2.1: should reserve balance', async () => {
            librarian = blockchain.openContract(Librarian.createFromConfig({ code: jettonMinterCode }, code));
            const result = await librarian.sendDeploy(deployer.getSender(), toNano('100'));
            printTransactionFees(result.transactions);

            expect(result.transactions).not.toHaveTransaction({
                actionResultCode: (x) => x! != 0,
                exitCode: (x) => x! != 0,
            });

            const currentBalance = (await blockchain.getContract(librarian.address)).balance;
            expect(currentBalance).toBeGreaterThan(0n);
            console.log(fromNano(currentBalance));
        });

        it('L-2.2: should calc reserve amount', async () => {
            for (const duration of storageDuration) {
                const stats = collectCellStats(jettonMinterCode, []);
                const minTonForStorage = calcMasterchainStorageFee(storagePrices, stats, BigInt(duration));
                console.log(fromNano(minTonForStorage));
            }
        });
    });

    describe('L-3: Executor', () => {
        it('L-3.1: should reserve balance', async () => {
            const executorCode = await compile('Executor');
            librarian = blockchain.openContract(Librarian.createFromConfig({ code: executorCode }, code));
            const result = await librarian.sendDeploy(deployer.getSender(), toNano('100'));
            printTransactionFees(result.transactions);

            expect(result.transactions).not.toHaveTransaction({
                actionResultCode: (x) => x! != 0,
                exitCode: (x) => x! != 0,
            });

            const currentBalance = (await blockchain.getContract(librarian.address)).balance;
            expect(currentBalance).toBeGreaterThan(0n);
            console.log(fromNano(currentBalance));
        });

        it('L-3.2: should calc reserve amount', async () => {
            for (const duration of storageDuration) {
                const stats = collectCellStats(executorCode, []);
                const minTonForStorage = calcMasterchainStorageFee(storagePrices, stats, BigInt(duration));
                console.log(fromNano(minTonForStorage));
            }
        });
    });
});
