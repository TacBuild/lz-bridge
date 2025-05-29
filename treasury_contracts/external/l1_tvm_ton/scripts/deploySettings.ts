import { address, Dictionary, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import { Settings } from '../wrappers/Settings';
import {Address} from "@ton/ton";

export async function run(provider: NetworkProvider) {
    const settings = provider.open(
        Settings.createFromConfig(
            {
                settingsId: 127,
                adminAddress: Address.parse("EQDoF2OkxsI3gc5jAuxlqozN9H_SgEOUCopMa1yU4djLaXuL"),
                settings: Dictionary.empty(),
            },
            await compile('Settings'),
        ),
    );

    await settings.sendDeploy(provider.sender(), toNano(0.05));

    await provider.waitForDeploy(settings.address);

    console.log('Deployed at address: ', settings.address);
}
