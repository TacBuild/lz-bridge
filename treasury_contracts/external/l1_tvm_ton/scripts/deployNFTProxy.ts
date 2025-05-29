import { address, toNano } from '@ton/core';
import { NFTProxy } from '../wrappers/NFTProxy';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const nftProxy = provider.open(
        NFTProxy.createFromConfig(
            {
                cclAddress: address(''),
                adminAddress: provider.sender().address!,
            },
            await compile('NFTProxy'),
        ),
    );

    await nftProxy.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(nftProxy.address);
}
