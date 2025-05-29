import { beginCell, Cell, toNano } from '@ton/core';
import { CrossChainLayer } from '../wrappers/CrossChainLayer';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const executorCodeRaw = await compile('Executor');
    let lib_jetton_prep = beginCell().storeUint(2, 8).storeBuffer(executorCodeRaw.hash()).endCell();
    const executorCode = new Cell({ exotic: true, bits: lib_jetton_prep.bits, refs: lib_jetton_prep.refs });

    const crossChainLayer = provider.open(
        CrossChainLayer.createFromConfig(
            {
                adminAddress: 'EQCEuIGH8I2bkAf8rLpuxkWmDJ_xZedEHDvjs6aCAN2FrkFp',
                sequencerMultisigAddress: '0QBshzK3qgIwHozYzVAvEaOKF3YXdY1veim4XLSoNDz1oXCV',
                executorCode: executorCode,
                merkleRoots: [],
                tacProtocolFee: 0.01,
                tonProtocolFee: 0.02,
                prevEpoch: 0,
                currEpoch: 0,
                epochDelay: 20,
                nextVotingTime: 0,
                maxRootsSize: 0,
            },
            await compile('CrossChainLayer'),
        ),
    );

    await crossChainLayer.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(crossChainLayer.address);

    // run methods on `evm`
}
