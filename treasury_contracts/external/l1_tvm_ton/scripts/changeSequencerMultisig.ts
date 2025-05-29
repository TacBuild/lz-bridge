import {Address, toNano} from '@ton/core';
import { CrossChainLayer } from '../wrappers/CrossChainLayer';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const crossChainLayer = provider.open(CrossChainLayer.createFromAddress(Address.parse("EQAdiCkHjVgEDH27PRhfMv4lxo30pHwgxyElHTtSj72fme0s")));

    await crossChainLayer.sendChangeSequencerMultisig(provider.sender(), toNano('0.05'), {
        sequencerMultisigAddress: "0QBshzK3qgIwHozYzVAvEaOKF3YXdY1veim4XLSoNDz1oXCV"
    });
}
