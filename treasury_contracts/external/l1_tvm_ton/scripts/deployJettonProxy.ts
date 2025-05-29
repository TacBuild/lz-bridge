import { toNano } from '@ton/core';
import { JettonProxy } from '../wrappers/JettonProxy';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const jettonProxy = provider.open(JettonProxy.createFromConfig({
        crossChainLayerAddress: "EQDe-bQjPC43CYZgsiamIHaiTshR8aAdCPYc_N3E-cU_q7bx",
        adminAddress: "EQCEuIGH8I2bkAf8rLpuxkWmDJ_xZedEHDvjs6aCAN2FrkFp"
    }, await compile('JettonProxy')));

    await jettonProxy.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(jettonProxy.address);

    // run methods on `jettonProxy`
}
