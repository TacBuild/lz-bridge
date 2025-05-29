import { address, beginCell, internal, MessageRelaxed, SendMode, storeMessageRelaxed, toNano } from '@ton/core';
import { MultisigV1 } from '../wrappers/MultisigV1';
import { compile, NetworkProvider } from '@ton/blueprint';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { MultisigOrder } from '@ton/ton';

export function getOrderByMsg(
    sendMode: SendMode,
    msg: MessageRelaxed,
    walletId: number = 0,
    queryOffset: number = 7200,
) {
    const time = BigInt(Math.floor(Date.now() / 1000 + queryOffset));
    const queryId = time << 32n;

    let message = beginCell().store(storeMessageRelaxed(msg)).endCell();

    return MultisigOrder.fromPayload(
        beginCell().storeUint(walletId, 32).storeUint(queryId, 64).storeUint(sendMode, 8).storeRef(message).endCell(),
    );
}

export async function run(provider: NetworkProvider) {
    const multisigV1 = provider.open(
        MultisigV1.createFromConfig(
            {
                publicKeys: [
                    Buffer.from('VY9GiQu8h/I/vkf3Olkyr/IbU0cSxKKuWnv3iVP7Qbw=', 'base64'),
                    Buffer.from('qxwu/trDIEMgG0zTCidOgv6gPSklbaZU3VfgXJXBOBg=', 'base64'),
                ],
                walletId: 0,
                k: 2,
            },
            await compile('MultisigV1'),
        ),
    );

    await multisigV1.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(multisigV1.address);
    // run methods on `multisigV1`
}
