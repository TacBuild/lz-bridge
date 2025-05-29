import { Address, beginCell, Cell, Dictionary } from '@ton/core';
import { Params } from '../Constants';

export type MsgEntry = {
    needToUnlockTON?: boolean;
    operationId: bigint;
    destinationAddress: Address;
    destinationMsgValue: bigint;
    msgBody: Cell;
    maybeStateInit?: Cell;
    payloadNumber: number;
};

export type Message = {
    entries: MsgEntry[];
    validExecutors: Address[];
    executorFeeToken: Address | null;
    executorFeeValue: bigint;
};

export type MsgEntryInfo = {
    cell: Cell;
    index: Buffer;
};

export function generateMsgsDictionaryBatching(messages: Message[]): Dictionary<Buffer, boolean> {
    let dict: Dictionary<Buffer, boolean> = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Bool());

    for (let i = 0; i < messages.length; i++) {
        const index = getCellByMessage(messages[i]);
        dict.set(index.hash(), true);
    }

    return dict;
}

export function getEntryCell(entry: MsgEntry): Cell {
    return beginCell()
        .storeUint(entry.operationId, Params.bitsize.hash)
        .storeAddress(entry.destinationAddress)
        .storeCoins(entry.destinationMsgValue)
        .storeRef(
            beginCell()
                .storeBit(entry.needToUnlockTON ?? false)
                .storeRef(entry.msgBody)
                .storeMaybeRef(entry.maybeStateInit)
                .endCell(),
        )
        .storeUint(entry.payloadNumber, 32)
        .endCell();
}

export function getEntryDict(entries: MsgEntry[]): Dictionary<bigint, Cell> {
    let entryDict: Dictionary<bigint, Cell> = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (let i = 0; i < entries.length; i++) {
        entryDict.set(BigInt(i), getEntryCell(entries[i]));
    }

    return entryDict;
}

export function getValidExecutorsDict(addresses: Address[]) {
    const validExecutorsDict: Dictionary<bigint, Cell> = Dictionary.empty(
        Dictionary.Keys.BigUint(256),
        Dictionary.Values.Cell(),
    );
    for (let i = 0; i < addresses.length; i++) {
        const executorAddress = addresses[i];
        const addressHash = beginCell().storeAddress(executorAddress).endCell().hash();
        const executorAddressKey = BigInt('0x' + addressHash.toString('hex'));
        validExecutorsDict.set(executorAddressKey, beginCell().storeUint(1, 1).endCell());
    }

    return validExecutorsDict;
}

export function getCellByMessage(message: Message): Cell {
    const entryDict = getEntryDict(message.entries);
    const validExecutorsDict = getValidExecutorsDict(message.validExecutors);
    return beginCell()
        .storeDict(entryDict)
        .storeDict(validExecutorsDict)
        .storeAddress(message.executorFeeToken)
        .storeCoins(message.executorFeeValue)
        .endCell();
}

export function generateWrongMsgDictionary(): Dictionary<bigint, boolean> {
    let dict: Dictionary<bigint, boolean> = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Bool());

    for (let i = 0; i < 3; i++) {
        dict.set(BigInt(i), true);
    }

    return dict;
}
