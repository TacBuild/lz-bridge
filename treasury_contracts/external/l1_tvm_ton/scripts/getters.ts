import {Address, toNano} from '@ton/core';
import { CrossChainLayer } from '../wrappers/CrossChainLayer';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const crossChainLayer = provider.open(CrossChainLayer.createFromAddress(Address.parse("kQCirJ_HFJuEpN0JdtKMCu8YeEtxqON1pdVCbv7Yh9FKwThY")));

    console.log(await crossChainLayer.getFullData())
}
