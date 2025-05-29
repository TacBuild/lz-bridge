import { Address, beginCell, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { NFTCollection } from '../wrappers/NFTCollection';

export async function run(provider: NetworkProvider) {
    const collectionAddress = Address.parse(''); // Replace with actual collection address
    const collection = provider.open(NFTCollection.createFromAddress(collectionAddress));

    await collection.sendDeployNFTItem(provider.sender(), toNano('0.05'), {
        itemIndex: 0, // Replace with the actual item index
        itemOwner: provider.sender().address!,
        nftContent: beginCell().endCell(),
    });
}
