import { randomAddress, compareTransaction, flattenTransaction, FlatTransactionComparable } from '@ton/test-utils';
import { Address, Transaction, Cell, Dictionary, Message, toNano, beginCell } from '@ton/core';
import { Blockchain, BlockchainTransaction, internal, SandboxContract, SendMessageResult } from '@ton/sandbox';
import { extractEvents } from '@ton/sandbox/dist/event/Event';
import { JettonMinter } from '../wrappers/JettonMinter';
import {compile} from '@ton/blueprint';

export const NATIVE_TAC_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
import {
    calcStorageFee,
    computeFwdFees,
    computeMessageForwardFees,
    getStoragePrices,
    MsgPrices,
    StorageStats,
} from '../wrappers/utils/GasUtils';
import { KeyPair, mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';

export const differentAddress = (oldAddr: Address) => {
    let newAddr: Address;

    do {
        newAddr = randomAddress(oldAddr.workChain);
    } while (newAddr.equals(oldAddr));

    return newAddr;
};

export const getRandom = (min: number, max: number) => {
    return Math.random() * (max - min) + min;
};

export type KeyPairs = {
    mnemonics: string[][];
    keyPairs: KeyPair[];
};

export async function createKeyPairs(n: number): Promise<KeyPairs> {
    let mnemonics = [];
    let keyPairs = [];

    const mnemonicPromises = Array.from({ length: n }, () => mnemonicNew());
    mnemonics = await Promise.all(mnemonicPromises);
    const keyPairPromises = mnemonics.map((mnemonic) => mnemonicToPrivateKey(mnemonic));
    keyPairs = await Promise.all(keyPairPromises);

    return {
        mnemonics,
        keyPairs,
    };
}

export const getRandomInt = (min: number, max: number) => {
    return Math.round(getRandom(min, max));
};

export const findTransaction = <T extends Transaction>(txs: T[], match: FlatTransactionComparable) => {
    return txs.find((x) => compareTransaction(flattenTransaction(x), match));
};

export const getMsgPrices = (configRaw: Cell, workchain: 0 | -1) => {
    const config = configRaw.beginParse().loadDictDirect(Dictionary.Keys.Int(32), Dictionary.Values.Cell());

    const prices = config.get(25 + workchain);

    if (prices === undefined) {
        throw Error('No prices defined in config');
    }

    const sc = prices.beginParse();
    let magic = sc.loadUint(8);

    if (magic != 0xea) {
        throw Error('Invalid message prices magic number!');
    }
    return {
        lumpPrice: sc.loadUintBig(64),
        bitPrice: sc.loadUintBig(64),
        cellPrice: sc.loadUintBig(64),
        ihrPriceFactor: sc.loadUintBig(32),
        firstFrac: sc.loadUintBig(16),
        nextFrac: sc.loadUintBig(16),
    };
};

export const storageCollected = (trans: Transaction) => {
    if (trans.description.type !== 'generic') throw 'Expected generic transaction';
    return trans.description.storagePhase ? trans.description.storagePhase.storageFeesCollected : 0n;
};
export const computedGeneric = (trans: Transaction) => {
    if (trans.description.type !== 'generic') throw 'Expected generic transaction';
    if (trans.description.computePhase.type !== 'vm') throw 'Compute phase expected';
    return trans.description.computePhase;
};

type MsgQueued = {
    msg: Message;
    parent?: BlockchainTransaction;
};
export class TxIterator implements AsyncIterator<BlockchainTransaction> {
    private msqQueue: MsgQueued[];
    private blockchain: Blockchain;

    constructor(bc: Blockchain, msg: Message) {
        this.msqQueue = [{ msg }];
        this.blockchain = bc;
    }

    public async next(): Promise<IteratorResult<BlockchainTransaction>> {
        if (this.msqQueue.length == 0) {
            return { done: true, value: undefined };
        }
        const curMsg = this.msqQueue.shift()!;
        const inMsg = curMsg.msg;
        if (inMsg.info.type !== 'internal') throw Error('Internal only');
        const smc = await this.blockchain.getContract(inMsg.info.dest);
        const res = await smc.receiveMessage(inMsg, { now: this.blockchain.now });
        const bcRes = {
            ...res,
            events: extractEvents(res),
            parent: curMsg.parent,
            children: [],
            externals: [],
        };
        for (let i = 0; i < res.outMessagesCount; i++) {
            const outMsg = res.outMessages.get(i)!;
            // Only add internal for now
            if (outMsg.info.type === 'internal') {
                this.msqQueue.push({ msg: outMsg, parent: bcRes });
            }
        }
        return { done: false, value: bcRes };
    }
}

export const executeTill = async (
    txs: AsyncIterable<BlockchainTransaction> | AsyncIterator<BlockchainTransaction>,
    match: FlatTransactionComparable,
) => {
    let executed: BlockchainTransaction[] = [];
    let txIterable = txs as AsyncIterable<BlockchainTransaction>;
    let txIterator = txs as AsyncIterator<BlockchainTransaction>;
    if (txIterable[Symbol.asyncIterator]) {
        for await (const tx of txIterable) {
            executed.push(tx);
            if (compareTransaction(flattenTransaction(tx), match)) {
                return executed;
            }
        }
    } else {
        let iterResult = await txIterator.next();
        while (!iterResult.done) {
            executed.push(iterResult.value);
            if (compareTransaction(flattenTransaction(iterResult.value), match)) {
                return executed;
            }
            iterResult = await txIterator.next();
        }
    }
    // Will fail with common error message format
    expect(executed).toHaveTransaction(match);
    return executed;
};
export const executeFrom = async (txs: AsyncIterator<BlockchainTransaction>) => {
    let executed: BlockchainTransaction[] = [];
    let iterResult = await txs.next();
    while (!iterResult.done) {
        executed.push(iterResult.value);
        iterResult = await txs.next();
    }
    return executed;
};

export function minBigInt(a: bigint, b: bigint): bigint {
    if (a < b) {
        return a;
    } else {
        return b;
    }
}

export function getStorageFee(
    blockchain: Blockchain,
    initBalance: bigint,
    stats: StorageStats,
    duration: number,
): bigint {
    const storagePrices = getStoragePrices(blockchain.config);
    const minTonForStorage = calcStorageFee(storagePrices, stats, BigInt(duration));
    return minTonForStorage - minBigInt(initBalance, minTonForStorage);
}

export const sumTxFees = (sum: bigint, tx: BlockchainTransaction) => sum + tx.totalFees.coins;
export const sumTxUsedGas = (sum: bigint, tx: BlockchainTransaction) => {
    let gasUsed = 0n;
    try {
        gasUsed = computedGeneric(tx).gasUsed;
    } catch (e) {}
    return sum + gasUsed;
};

const sumBigInt = (sum: bigint, newValue: bigint) => sum + newValue;

export const sumTxForwardFees = (sum: bigint, tx: BlockchainTransaction) =>
    sum +
    tx.outMessages
        .values()
        // @ts-ignore
        .map((x) => x.info?.forwardFee || 0n)
        .reduce(sumBigInt, 0n);

export async function calculateFeesData(
    blockchain: Blockchain,
    contract: SandboxContract<any>,
    result: SendMessageResult,
    initBalance: bigint,
) {
    let totalFees = 0n;
    totalFees += result.transactions.reduce(sumTxFees, 0n);
    const currentBalance = (await blockchain.getContract(contract.address)).balance;
    result.transactions.shift();

    let totalContractUsedGas = 0n;
    totalContractUsedGas += result.transactions.reduce(sumTxUsedGas, 0n);

    let totalContractFees = 0n;
    totalContractFees += result.transactions.reduce(sumTxFees, 0n);

    let totalForwardFees = 0n;
    totalForwardFees += result.transactions.reduce(sumTxForwardFees, 0n);

    console.log(`
            Total fees: ${Number(totalFees) / 10 ** 9} TON
            Total contract gas used: ${totalContractUsedGas}
            Total contract fees: ${Number(totalContractFees) / 10 ** 9} TON
            Total forward fees: ${Number(totalForwardFees) / 10 ** 9} TON
            Balance difference: ${Number(currentBalance - initBalance) / 10 ** 9} TON
            Init balance: ${Number(initBalance) / 10 ** 9} TON
            Current balance: ${Number(currentBalance) / 10 ** 9} TON
            `);
}

export function printTxGasStats(name: string, transaction: Transaction) {
    const txComputed = computedGeneric(transaction);
    console.log(`${name} used ${txComputed.gasUsed} gas`);
    console.log(`${name} cost: ${Number(txComputed.gasFees) / 10 ** 9} TON`);
    return txComputed.gasFees;
}

export function forwardOverhead(prices: MsgPrices, stats: StorageStats) {
    // Meh, kinda lazy way of doing that, but tests are bloated enough already
    return computeFwdFees(prices, stats.cells, stats.bits) - prices.lumpPrice;
}

export const TIME_ONE_YEAR = 365 * 24 * 3600;

export function estimateFwdFee(body: Cell, prices: MsgPrices) {
    // Purpose is to account for the first biggest one fwd fee.
    // So, we use fwd_amount here only for body calculation
    const mockAddr = new Address(0, Buffer.alloc(32, 'A'));
    const testMsg = internal({
        from: mockAddr,
        to: mockAddr,
        value: toNano('1'),
        body,
    });
    const feesRes = computeMessageForwardFees(prices, testMsg);
    // @ts-ignore
    return feesRes.fees.total;
}

export async function calculateMaxStorageState(blockchain: Blockchain, contractName: string, contractAddress: Address) {
    const smc = await blockchain.getContract(contractAddress);
    if (smc.accountState === undefined) throw new Error(`Can't access ${contractName} account state`);
    if (smc.accountState.type !== 'active') throw new Error(`${contractName} account is not active`);
    if (smc.account.account === undefined || smc.account.account === null)
        throw new Error(`Can't access ${contractName} account!`);
    console.log(`${contractName} max storage stats:`, smc.account.account.storageStats.used);
}

export async function deployTestToken(
    blockchain: Blockchain,
    adminAddress: Address,
    evmAddress: string,
    totalSupply: number = 0,
) {
    const deployer = await blockchain.treasury('deployer');

    const jettonMinterCode = await compile('JettonMinter');
    const jettonWalletCodeRaw = await compile('JettonWallet');
    const lib_jetton_prep = beginCell().storeUint(2, 8).storeBuffer(jettonWalletCodeRaw.hash()).endCell();
    const jettonWalletCode = new Cell({exotic: true, bits: lib_jetton_prep.bits, refs: lib_jetton_prep.refs});
    const jettonMinterConfig = {
        adminAddress: adminAddress,
        content: beginCell().endCell(),
        jettonWalletCode,
        evmTokenAddress: evmAddress,
        totalSupply: totalSupply,
    };
    const jettonMinter = blockchain.openContract(JettonMinter.createFromConfig(jettonMinterConfig, jettonMinterCode));

    const deployResult = await jettonMinter.sendDeploy(deployer.getSender(), toNano('0.05'));
    expect(deployResult.transactions).toHaveTransaction({
        from: deployer.address,
        to: jettonMinter.address,
        deploy: true,
        success: true,
    });

    return jettonMinter.address;
}
