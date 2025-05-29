import { toNano } from '@ton/core';
import { Librarian } from '../wrappers/Librarian';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    // const order_code_raw = await compile('Order');
    //
    // // deploy lib
    //
    // const librarian_code = await compile('Librarian');
    // const librarian = provider.open(Librarian.createFromConfig({code: order_code_raw}, librarian_code));
    // await librarian.sendDeploy(provider.sender(), toNano("10"));

    const executor_code_raw = await compile('Executor');

    // deploy lib

    const librarian_code = await compile('Librarian');
    const librarian = provider.open(Librarian.createFromConfig({code: executor_code_raw}, librarian_code));
    await librarian.sendDeploy(provider.sender(), toNano("10"));
}
