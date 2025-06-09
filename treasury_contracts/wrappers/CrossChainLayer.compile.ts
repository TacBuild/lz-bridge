import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'func',
    targets: ['external/l1_tvm_ton/contracts/cross_chain_layer.fc'],
};

