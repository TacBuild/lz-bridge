import { toNano } from '@ton/core';
import { NFTCollection } from '../wrappers/NFTCollection';
import { compile, NetworkProvider } from '@ton/blueprint';

import { beginCell, Builder, Cell, Dictionary } from '@ton/core';
import { Sha256 } from '@aws-crypto/sha256-js';

export const ONCHAIN_CONTENT_PREFIX = 0x00;
export const OFFCHAIN_CONTENT_PREFIX = 0x01;

const SNAKE_PREFIX = 0x00;

export interface JettonMetadata {
    uri?: string;
    name: string;
    description: string;
    image?: string;
    image_data?: string;
    symbol: string;
    decimals?: string;
}

export function buildJettonOffChainMetadata(contentUri: string) {
    return beginCell().storeInt(OFFCHAIN_CONTENT_PREFIX, 8).storeBuffer(Buffer.from(contentUri, 'ascii')).endCell();
}

export type JettonMetaDataKeys = 'uri' | 'name' | 'description' | 'image' | 'symbol' | 'image_data' | 'decimals';

const jettonOnChainMetadataSpec: {
    [key in JettonMetaDataKeys]: 'utf8' | 'ascii' | undefined;
} = {
    uri: 'ascii',
    name: 'utf8',
    description: 'utf8',
    image: 'ascii',
    image_data: 'ascii',
    symbol: 'utf8',
    decimals: 'utf8',
};

const sha256 = (str: string) => {
    const sha = new Sha256();
    sha.update(str);
    return Buffer.from(sha.digestSync());
};

function storeSnakeContent(content: Buffer, isFirst: boolean): Cell {
    const CELL_MAX_SIZE_BYTES = Math.floor((1023 - 8) / 8);
    let cell = new Builder();
    if (isFirst) {
        cell.storeUint(SNAKE_PREFIX, 8);
    }
    cell.storeBuffer(content.subarray(0, CELL_MAX_SIZE_BYTES));
    const remainingContent = content.subarray(CELL_MAX_SIZE_BYTES);
    if (remainingContent.length > 0) {
        cell.storeRef(storeSnakeContent(remainingContent, false));
    }
    return cell.endCell();
}

export function buildJettonOnchainMetadata(data: JettonMetadata) {
    const dict = Dictionary.empty();

    Object.entries(data).forEach(([k, v]: [string, string | undefined]) => {
        if (!jettonOnChainMetadataSpec[k as JettonMetaDataKeys]) throw new Error(`Unsupported onchain key: ${k}`);
        if (!v || v == '' || v == null) return;

        let bufferToStore = Buffer.from(v, jettonOnChainMetadataSpec[k as JettonMetaDataKeys]);

        dict.set(sha256(k), storeSnakeContent(bufferToStore, true));
    });

    return beginCell()
        .storeInt(ONCHAIN_CONTENT_PREFIX, 8)
        .storeDict(dict, Dictionary.Keys.Buffer(32), Dictionary.Values.Cell())
        .endCell();
}

export async function run(provider: NetworkProvider) {
    const sender = provider.sender();

    let owner = sender.address;

    const nftItemCode = await compile('NFTItem');

    let content = buildJettonOnchainMetadata({
        name: 'My fake Collection',
        description: 'this is fake',
        symbol: 'FK',
    });

    const collection = NFTCollection.createFromConfig(
        {
            ownerAddress: owner!,
            content: content,
            nftItemCode: nftItemCode,
            originalAddress: '0x1234',
        },
        await compile('NFTCollection'),
    );

    const deployAmount = toNano('0.5');
    await provider.open(collection).sendDeploy(provider.sender(), deployAmount);
    await provider.waitForDeploy(collection.address);
}
