import { Address, beginCell, toNano } from '@ton/core';
import { CrossChainLayer, OperationType } from '../wrappers/CrossChainLayer';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const crossChainLayer = provider.open(
        CrossChainLayer.createFromAddress(Address.parse('EQC0sjc_Eu_n8BtdWWL6j_tZCWZVKXSnhuYookpg24BYtosa')),
    );

    await crossChainLayer.sendTVMMsgToEVM(provider.sender(), toNano('0.05'), {
        operationType: OperationType.tonTransfer,
        payload: beginCell().endCell().beginParse(),
        crossChainTonAmount: 0,
    });

    // run methods on `evm`
}
