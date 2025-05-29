import { Address, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { JettonProxy, jettonProxyConfigToCell } from '../wrappers/JettonProxy';

export async function run(provider: NetworkProvider) {
    const jettonProxy = provider.open(
        JettonProxy.createFromAddress(Address.parse('EQBVKFr9uECnS6Nu7IrH2NoHYilZzJIoohzMTQhiDjmBWYtA')),
    );

    // const data = await jettonProxy.getFullData();
    // console.log(data);
    await jettonProxy.sendUpdateCode(provider.sender(), toNano('0.05'), {
        code: await compile('JettonProxy'),
        data: jettonProxyConfigToCell({
            adminAddress: 'EQCEuIGH8I2bkAf8rLpuxkWmDJ_xZedEHDvjs6aCAN2FrkFp',
            crossChainLayerAddress: 'EQBpMmayBZXoBmITijP58oSjDhbdIjI52lCmBTcpY0rOku5c',
        }),
    });
}
