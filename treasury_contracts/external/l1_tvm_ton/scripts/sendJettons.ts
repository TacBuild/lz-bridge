import { Address, beginCell, Cell, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { JettonWallet } from '../wrappers/JettonWallet';

export async function run(provider: NetworkProvider) {
    const jettonWallet = provider.open(
        JettonWallet.createFromAddress(Address.parse('EQCNby7Gc9QVGeuZPFfxJpE95xZuUng25AFv9dlGnCfwzUwF')),
    );

    const forwardPayload = Cell.fromBase64(
        'te6cckEBAgEAqQAB4YgB0pgnjtsXcYc+k/VAgjb6NjkSZgQIiAyFpmRfs1X/8tACBqDMqFjeIMbFD2Jei/q+UTshBfRGzHVelikZvXMEh3rPS6vm2hmfM1UvKb09wNs/kjXtZzYwUH3P87Qhzyk4AU1NGLs04e8oAAAAEAAcAQBmYgBPkd3LnHsXtC1jZGShFCBhpRzyGqj5FYbnkeuVh88SnpzEtAAAAAAAAAAAAAAAAAAA0EUKRA==',
    );

    console.log(forwardPayload.hash().toString('hex'));

    await jettonWallet.sendTransfer(provider.sender(), toNano('0.35'), {
        jettonAmount: 10,
        toOwnerAddress: 'EQBcB0XZEv-T_9tYnbJc-DoYqAFz71k5KUkZTLX1etwfuMIB',
        responseAddress: 'EQCEuIGH8I2bkAf8rLpuxkWmDJ_xZedEHDvjs6aCAN2FrkFp',
        forwardTonAmount: 0.2,
        forwardPayload: beginCell().storeRef(forwardPayload).endCell(),
    });
}
