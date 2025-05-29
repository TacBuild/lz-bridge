import {Address, toNano} from '@ton/core';
import {CrossChainLayer, crossChainLayerConfigToCell} from '../wrappers/CrossChainLayer';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const crossChainLayer = provider.open(CrossChainLayer.createFromAddress(Address.parse("EQCtedmVBAGBPm-OE2vCuTOPoUb2y586hw9cXJbY2eWt0Isn")));

    const data = await crossChainLayer.getFullData();

    await crossChainLayer.sendUpdateCode(provider.sender(), toNano('0.05'), {
        code: await compile("CrossChainLayer"),
        data: crossChainLayerConfigToCell(data),
    });
}
