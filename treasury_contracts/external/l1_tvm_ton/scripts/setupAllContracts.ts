import { compile, NetworkProvider, sleep } from '@ton/blueprint';
import { CrossChainLayer } from '../wrappers/CrossChainLayer';
import { JettonProxy } from '../wrappers/JettonProxy';
import { JettonMinter, JettonMinterConfig } from '../wrappers/JettonMinter';
import { Settings } from '../wrappers/Settings';
import { address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { sha256toBigInt } from '../wrappers/utils/sha256';
import { Librarian } from '../wrappers/Librarian';
import { NFTProxy } from '../wrappers/NFTProxy';
import { MultisigV1 } from '../wrappers/MultisigV1';

export async function run(provider: NetworkProvider) {
    const adminAddress = 'EQDoF2OkxsI3gc5jAuxlqozN9H_SgEOUCopMa1yU4djLaXuL';
    if (!adminAddress) {
        throw new Error('specify admin address');
    }
    const randomWalletId = Math.floor(Math.random() * 2 ** 32); // from 0 to 4,294,967,296

    // deploy lib
    console.log('deploying lib for executor');
    const executorCodeRaw = await compile('Executor');
    const librarianCode = await compile('Librarian');
    const executorLibrarian = provider.open(Librarian.createFromConfig({ code: executorCodeRaw }, librarianCode));
    if (await provider.isContractDeployed(executorLibrarian.address)) {
        console.log('lib for executor already deployed');
    } else {
        await executorLibrarian.sendDeploy(provider.sender(), toNano('20'));
        await provider.waitForDeploy(executorLibrarian.address);
        await sleep(5 * 1000);
    }
    const libExecutorPrep = beginCell().storeUint(2, 8).storeBuffer(executorCodeRaw.hash()).endCell();
    const executorCode = new Cell({ exotic: true, bits: libExecutorPrep.bits, refs: libExecutorPrep.refs });

    console.log('deploying lib for jetton wallet');
    const jettonCodeRaw = await compile('JettonWallet');
    const jettonLibrarian = provider.open(Librarian.createFromConfig({ code: jettonCodeRaw }, librarianCode));
    if (await provider.isContractDeployed(jettonLibrarian.address)) {
        console.log('lib for jetton wallet already deployed');
    } else {
        await jettonLibrarian.sendDeploy(provider.sender(), toNano('20'));
        await provider.waitForDeploy(jettonLibrarian.address);
        await sleep(5 * 1000);
    }
    const libJettonPrep = beginCell().storeUint(2, 8).storeBuffer(jettonCodeRaw.hash()).endCell();
    const jettonWalletCode = new Cell({ exotic: true, bits: libJettonPrep.bits, refs: libJettonPrep.refs });

    console.log('deploying lib for nft item');
    const nftItemRawCode = await compile('NFTItem');
    const nftItemLibrarian = provider.open(Librarian.createFromConfig({ code: nftItemRawCode }, librarianCode));
    if (await provider.isContractDeployed(nftItemLibrarian.address)) {
        console.log('lib for nft item already deployed');
    } else {
        await nftItemLibrarian.sendDeploy(provider.sender(), toNano('20'));
        await provider.waitForDeploy(nftItemLibrarian.address);
        await sleep(5 * 1000);
    }
    const nftItemPrep = beginCell().storeUint(2, 8).storeBuffer(nftItemRawCode.hash()).endCell();
    const nftItemCode = new Cell({ exotic: true, bits: nftItemPrep.bits, refs: nftItemPrep.refs });

    const code = {
        CCL: await compile('CrossChainLayer'),
        executor: executorCode,
        jettonProxy: await compile('JettonProxy'),
        settings: await compile('Settings'),
        jettonWallet: jettonWalletCode,
        jettonMinter: await compile('JettonMinter'),
        nftItem: nftItemCode,
        nftCollection: await compile('NFTCollection'),
        nftProxy: await compile('NFTProxy'),
        multisigV1: await compile('MultisigV1'),
    };
    console.log('all contracts are compiled');

    const multisigV1 = provider.open(
        MultisigV1.createFromConfig(
            {
                publicKeys: [Buffer.from('558f46890bbc87f23fbe47f73a5932aff21b534712c4a2ae5a7bf78953fb41bc', 'hex')],
                walletId: randomWalletId,
                k: 1,
            },
            await compile('MultisigV1'),
        ),
    );

    const now = Math.floor(Date.now() / 1000);
    const epochDelay = 30;

    const CCL_Contract = CrossChainLayer.createFromConfig(
        {
            adminAddress: adminAddress,
            sequencerMultisigAddress: multisigV1.address.toString(),
            currEpoch: now,
            epochDelay,
            messageCollectEndTime: now,
            nextVotingTime: now + epochDelay,
            executorCode: code.executor,
            tacProtocolFee: 0.01,
            tonProtocolFee: 0.001,
            maxRootsSize: 3,
        },
        code.CCL,
    );
    const jettonProxyContract = JettonProxy.createFromConfig(
        {
            crossChainLayerAddress: CCL_Contract.address.toString(),
            adminAddress: adminAddress,
        },
        code.jettonProxy,
    );

    const nftProxyContract = NFTProxy.createFromConfig(
        {
            cclAddress: CCL_Contract.address,
            adminAddress: address(adminAddress),
        },
        code.nftProxy,
    );

    const allSettings: Dictionary<bigint, Cell> = Dictionary.empty(
        Dictionary.Keys.BigUint(256),
        Dictionary.Values.Cell(),
    );

    allSettings.set(sha256toBigInt('CrossChainLayerAddress'), beginCell().storeAddress(CCL_Contract.address).endCell());
    allSettings.set(sha256toBigInt('MerkleTreeDuration'), beginCell().storeUint(608800, 64).endCell());
    allSettings.set(sha256toBigInt('MaxEpochDuration'), beginCell().storeUint(86400, 64).endCell());
    allSettings.set(
        sha256toBigInt('JettonProxyAddress'),
        beginCell().storeAddress(jettonProxyContract.address).endCell(),
    );
    allSettings.set(sha256toBigInt('NFTProxyAddress'), beginCell().storeAddress(nftProxyContract.address).endCell());
    allSettings.set(sha256toBigInt('JettonWalletCode'), code.jettonWallet);
    allSettings.set(sha256toBigInt('JettonMinterCode'), code.jettonMinter);
    allSettings.set(sha256toBigInt('NFTItemCode'), code.nftItem);
    allSettings.set(sha256toBigInt('NFTCollectionCode'), code.nftCollection);
    allSettings.set(sha256toBigInt('MultisigV1Code'), code.multisigV1);
    allSettings.set(sha256toBigInt('NFTPrefixURI'), beginCell().storeStringTail('https://nft.tac.build').endCell());

    const settingsContract = Settings.createFromConfig(
        {
            settings: allSettings,
            adminAddress: address(adminAddress),
        },
        code.settings,
    );
    console.log('all wrappers are created');
    console.log('');
    console.log('deploying MultisigV1');
    await multisigV1.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(multisigV1.address);
    await sleep(5 * 1000);
    console.log('');
    console.log('deploying CCL');
    await provider.open(CCL_Contract).sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(CCL_Contract.address);
    await sleep(5 * 1000);
    console.log('');
    console.log('deploying Jetton Proxy');
    await provider.open(jettonProxyContract).sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(jettonProxyContract.address);
    await sleep(5 * 1000);
    console.log('');
    console.log('deploying NFT Proxy');
    await provider.open(nftProxyContract).sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(nftProxyContract.address);
    await sleep(5 * 1000);
    console.log('');
    console.log('deploying Settings');
    await provider.open(settingsContract).sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(settingsContract.address);
    await sleep(5 * 1000);

    console.log('');

    const jettonMinterConfig: JettonMinterConfig = {
        adminAddress: CCL_Contract.address,
        content: beginCell().endCell(),
        jettonWalletCode,
        evmTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
        totalSupply: 0,
    };

    const jettonMinter = provider.open(JettonMinter.createFromConfig(jettonMinterConfig, code.jettonMinter));
    console.log('deploying TAC minter');
    await jettonMinter.sendDeploy(provider.sender(), toNano('0.05'));
    await provider.waitForDeploy(jettonMinter.address);
    console.log('');
}
