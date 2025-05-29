import { Address, Cell, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { Executor } from '../wrappers/Executor';

export async function run(provider: NetworkProvider) {
    const executor = provider.open(
        Executor.createFromAddress(Address.parse('EQCPKmShX_TneriIZNNizfncE6FYK_qEyVdTp6BAV5b0jG7H')),
    );

    const proof = Cell.fromBase64(
        'te6cckEBAgEASgAJRgOAtExOPiH3AAJQ3eqPOEFuaFR4Y4LLL4kbeM3cxstAowAAAQBD0AbhO5WK3Nmzw//wMKT4ttgtGo5Mit9lq2Q46cxcbARHqG7zJgE=',
    );

    await executor.sendProxyMsg(provider.sender(), toNano('0.15'), {
        merkleProof: proof,
        responseAddress: provider.sender().address?.toString(),
        feeToAddress: 'EQCEuIGH8I2bkAf8rLpuxkWmDJ_xZedEHDvjs6aCAN2FrkFp',
    });
}
