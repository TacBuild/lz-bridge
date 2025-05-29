import { sha256_sync } from '@ton/crypto';

export function sha256toBigInt(ContractName: string): bigint {
    const hash = sha256_sync(ContractName);

    return BigInt('0x' + hash.toString('hex'));
}
