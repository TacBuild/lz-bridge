import {Address, beginCell, Cell, Dictionary, toNano} from '@ton/core';
import {Executor} from '../wrappers/Executor';
import {compile, NetworkProvider} from '@ton/blueprint';

export async function run(provider: NetworkProvider) {

    const executorCodeRaw = await compile('Executor');
    let lib_jetton_prep = beginCell().storeUint(2, 8).storeBuffer(executorCodeRaw.hash()).endCell();
    const executorCode = new Cell({ exotic: true, bits: lib_jetton_prep.bits, refs: lib_jetton_prep.refs});

    const executor = provider.open(Executor.createFromConfig({
        isSpent: false,
        crossChainLayerAddress: "EQBJZ9aLguSKJEDU6r8Pt-ehVDmOqIJ1H8AG-PQac3sTK2B8",
        payload: beginCell()
            .storeAddress(Address.parse('EQBHAq-D1x7NJdw-_vMJajB8vQzMe0WtOSxUXC5N8GwZ_9Os'))
            .storeCoins(toNano('1'))
            .storeRef(beginCell().endCell())
            .storeUint(1, 32)
            .endCell()
    }, executorCodeRaw));

    await executor.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(executor.address);
}
