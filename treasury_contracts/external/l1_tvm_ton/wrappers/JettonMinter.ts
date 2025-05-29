import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    toNano,
} from '@ton/ton';
import { Maybe } from '@ton/core/dist/utils/maybe';
import { CrossChainLayerOpCodes, OperationType } from './CrossChainLayer';
import { fromNano } from '@ton/core';
import { Params } from './Constants';

export const JettonMinterOpCodes = {
    mint: 0xd7b9c06e,
    changeAdmin: 0x581879bc,
    cancelChangingAdminAddress: 0x60094a1b,
    confirmChangingAdminAddress: 0x6a4fbe34,
    changeContent: 0x23f78ab7,
    burnNotification: 0x7bdd97de,
    excesses: 0xd53276db,
    withdrawExtraTon: 0x1754ab63,
    
};

export const JettonMinterErrors = {
    noErrors: 0,

    notFromAdmin: 73,
    notFromJettonWallet: 74,
    notFromNewAdmin: 75,

    newAdminAddressIsNone: 80,
};

export type JettonMinterConfig = {
    totalSupply: number;
    adminAddress: Address;
    newAdminAddress?: Address;
    content: Cell;
    jettonWalletCode: Cell;
    evmTokenAddress: string;
};

export function jettonMinterConfigToCell(config: JettonMinterConfig): Cell {
    return beginCell()
        .storeCoins(toNano(config.totalSupply.toFixed(9)))
        .storeAddress(config.adminAddress)
        .storeAddress(config.newAdminAddress ?? null)
        .storeRef(config.content)
        .storeRef(config.jettonWalletCode)
        .storeStringTail(config.evmTokenAddress)
        .endCell();
}

export class JettonMinter implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new JettonMinter(address);
    }

    static createFromConfig(config: JettonMinterConfig, code: Cell, workchain = 0) {
        const data = jettonMinterConfigToCell(config);
        const init = { code, data };
        return new JettonMinter(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendErrorNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            queryId?: number | bigint;
            operation?: number | bigint;
            jettonOwnerAddress: Address;
            jettonAmount: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(CrossChainLayerOpCodes.anyone_errorNotification, 32)
                .storeUint(params.queryId || 0, 64)
                .storeUint(params.operation || OperationType.jettonBurn, 32)
                .storeAddress(params.jettonOwnerAddress)
                .storeCoins(toNano(params.jettonAmount.toFixed(9)))
                .endCell(),
        });
    }

    static mintMessage(
        to: Address,
        jettonAmount: number,
        responseAddress?: Address,
        forwardTonAmount?: number,
        forwardPayload?: Maybe<Cell>,
        newContent?: Maybe<Cell>,
        queryId?: number | bigint,
    ) {
        return beginCell()
            .storeUint(JettonMinterOpCodes.mint, 32)
            .storeUint(queryId ?? 0, 64)
            .storeAddress(to)
            .storeCoins(toNano(jettonAmount.toFixed(9)))
            .storeAddress(responseAddress ?? null)
            .storeCoins(toNano(forwardTonAmount?.toFixed(9) ?? 0))
            .storeMaybeRef(forwardPayload)
            .storeMaybeRef(newContent)
            .endCell();
    }

    async sendMint(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            to: Address;
            jettonAmount: number;
            forwardTonAmount: number;
            responseAddress?: Address;
            forwardPayload?: Maybe<Cell>;
            newContent?: Maybe<Cell>;
            queryId?: number | bigint;
        },
    ) {
        if (value <= params.forwardTonAmount) {
            throw new Error('totalTonAmount should be > forward amount');
        }
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: JettonMinter.mintMessage(
                params.to,
                params.jettonAmount,
                params.responseAddress,
                params.forwardTonAmount,
                params.forwardPayload,
                params.newContent,
                params.queryId || 0,
            ),
            value,
        });
    }

    async sendChangeAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params?: { newAdmin?: Address; queryId?: number | bigint },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonMinterOpCodes.changeAdmin, 32)
                .storeUint(params?.queryId || 0, 64)
                .storeAddress(params?.newAdmin ?? null)
                .endCell(),
            value,
        });
    }

    async sendCancelChangingAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts?: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonMinterOpCodes.cancelChangingAdminAddress, Params.bitsize.op)
                .storeUint(opts?.queryId || 0, Params.bitsize.queryId)
                .endCell(),
        });
    }

    async sendConfirmNewAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts?: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonMinterOpCodes.confirmChangingAdminAddress, Params.bitsize.op)
                .storeUint(opts?.queryId || 0, Params.bitsize.queryId)
                .endCell(),
        });
    }

    async sendChangeContent(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: { content: Cell; queryId?: number | bigint },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonMinterOpCodes.changeContent, 32)
                .storeUint(params.queryId || 0, 64)
                .storeRef(params.content)
                .endCell(),
            value,
        });
    }

    async sendBurnNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params: {
            jettonAmount: number;
            from: Address;
            responseAddress: Address;
            crossChainTonAmount?: number;
            feeData?: Cell | null;
            crossChainPayload?: Cell | null;
        },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonMinterOpCodes.burnNotification, 32)
                .storeUint(0, 64)
                .storeCoins(toNano(params.jettonAmount.toFixed(9)))
                .storeAddress(params.from)
                .storeAddress(params.responseAddress)
                .storeCoins(toNano(params.crossChainTonAmount?.toFixed(9) ?? 0))
                .storeMaybeRef(params.feeData)
                .storeMaybeRef(params.crossChainPayload)
                .endCell(),
            value,
        });
    }

    async sendWithdrawExtraTon(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params?: { queryId?: bigint | number },
    ) {
        await provider.internal(via, {
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonMinterOpCodes.withdrawExtraTon, 32)
                .storeUint(params?.queryId || 0, 64)
                .endCell(),
            value,
        });
    }

    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const res = await provider.get('get_wallet_address', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return res.stack.readAddress();
    }

    async getJettonData(provider: ContractProvider) {
        const res = await provider.get('get_jetton_data', []);
        const totalSupply = Number(fromNano(res.stack.readBigNumber()));
        const mintable = res.stack.readBoolean();
        const adminAddress = res.stack.readAddress();
        const content = res.stack.readCell();
        const walletCode = res.stack.readCell();
        return {
            totalSupply,
            mintable,
            adminAddress,
            content,
            walletCode,
        };
    }

    async getEVMTokenAddress(provider: ContractProvider) {
        const res = await provider.get('get_evm_token_address', []);
        return res.stack.readString();
    }

    async getFullData(provider: ContractProvider) {
        const res = await provider.get('get_full_data', []);
        const totalSupply = Number(fromNano(res.stack.readBigNumber()));
        const adminAddress = res.stack.readAddress();
        const newAdminAddress = res.stack.readAddressOpt();
        const content = res.stack.readCell();
        const walletCode = res.stack.readCell();
        const evmTokenAddress = res.stack.readString();
        return {
            totalSupply,
            adminAddress,
            newAdminAddress,
            content,
            walletCode,
            evmTokenAddress,
        };
    }
}
