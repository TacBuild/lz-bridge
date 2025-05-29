import { Cell, Dictionary } from '@ton/core';
import { Params } from '../Constants';

export type MerkleRoot = {
    root: bigint;
    validTimestamp: number;
};

export function cellToArray(addrDict: Cell | null): Array<MerkleRoot> {
    let resArr: Array<MerkleRoot> = [];
    if (addrDict !== null) {
        const dict = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(Params.bitsize.hash),
            Dictionary.Values.Uint(Params.bitsize.time),
            addrDict,
        );
        resArr = dict.keys().map((root) => {
            const time = dict.get(root);
            return {
                root: root,
                validTimestamp: time!,
            };
        });
    }
    return resArr;
}

export function arrayToCell(arr: Array<MerkleRoot>): Dictionary<bigint, number> {
    let dict = Dictionary.empty(
        Dictionary.Keys.BigUint(Params.bitsize.hash),
        Dictionary.Values.Uint(Params.bitsize.time),
    );
    for (let i = 0; i < arr.length; i++) {
        dict.set(arr[i].root, arr[i].validTimestamp);
    }
    return dict;
}
