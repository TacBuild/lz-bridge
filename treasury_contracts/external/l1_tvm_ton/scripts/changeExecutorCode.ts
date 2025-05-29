import { Address, beginCell, Cell, toNano } from '@ton/core';
import { CrossChainLayer } from '../wrappers/CrossChainLayer';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const crossChainLayer = provider.open(
        CrossChainLayer.createFromAddress(Address.parse('EQBpMmayBZXoBmITijP58oSjDhbdIjI52lCmBTcpY0rOku5c')),
    );

    const executorCodeRaw = await compile('Executor');
    const libExecutorPrep = beginCell().storeUint(2, 8).storeBuffer(executorCodeRaw.hash()).endCell();
    const executorCode = new Cell({ exotic: true, bits: libExecutorPrep.bits, refs: libExecutorPrep.refs });

    await crossChainLayer.sendUpdateExecutorCode(provider.sender(), toNano('0.05'), {
        code: executorCode,
    });
}
