import { beginCell, Cell, fromNano, storeStateInit, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { collectCellStats } from '../wrappers/utils/GasUtils';

describe('MultisigV1', () => {
    //TODO external and internal test for all errors

    describe('MV1-1: storage gas stats', () => {
        it('MV1-1.1: should collect stats for multisig', async () => {});
    });
});
