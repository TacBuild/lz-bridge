import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    Slice,
    toNano,
} from '@ton/core';
import { OperationType } from './CrossChainLayer';
import { Params } from './Constants';

export type JettonProxyConfig = {
    crossChainLayerAddress: string;
    adminAddress: string;
    newAdminAddress?: string;
};

export const JettonProxyOpCodes = {
    jettonWallet_transfer: 0xf8a7ea5,
    jettonWallet_transferNotification: 0x7362d09c,

    crossChainLayerAddress_evmMsgToTVMproxy: 0x7817b330,
    crossChainLayerAddress_errorNotification: 0xae7df95b,

    anyone_tvmMsgToEVM: 0x6c582059,

    admin_changeAdminAddress: 0x581879bc,
    admin_cancelChangingAdminAddress: 0x60094a1b,
    admin_updateCode: 0x20faec53,

    newAdmin_confirmChangingAdminAddress: 0x6a4fbe34,
};

export const JettonProxyErrors = {
    noErrors: 0,

    notFromCrossChainLayer: 70,
    notFromAdmin: 71,
    notFromNewAdmin: 72,

    newAdminAddressIsNone: 80,

    notEnoughTon: 100,

    invalidPayload: 200,
};

export function jettonProxyConfigToCell(config: JettonProxyConfig): Cell {
    return beginCell()
        .storeAddress(Address.parse(config.crossChainLayerAddress))
        .storeAddress(Address.parse(config.adminAddress))
        .storeAddress(config.newAdminAddress ? Address.parse(config.adminAddress) : null)
        .endCell();
}

export class JettonProxy implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new JettonProxy(address);
    }

    static createFromConfig(config: JettonProxyConfig, code: Cell, workchain = 0) {
        const data = jettonProxyConfigToCell(config);
        const init = { code, data };
        return new JettonProxy(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendTransferNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            receivedJettonAmount: number;
            depositorAddress: string;
            crossChainTonAmount?: number;
            feeData?: Cell;
            evmData?: Cell;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonProxyOpCodes.jettonWallet_transferNotification, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeCoins(toNano(opts.receivedJettonAmount.toFixed(9)))
                .storeAddress(Address.parse(opts.depositorAddress))
                .storeMaybeRef(beginCell()
                            .storeCoins(toNano(opts.crossChainTonAmount?.toFixed(9) ?? 0))
                            .storeMaybeRef(opts.feeData)
                            .storeMaybeRef(opts.evmData))
                .endCell(),
        });
    }

    async sendErrorNotification(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            jettonWalletAddress: string;
            ownerAddress: string;
            receivedJettonAmount: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonProxyOpCodes.crossChainLayerAddress_errorNotification, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeUint(OperationType.jettonTransfer, 32)
                .storeAddress(Address.parse(opts.jettonWalletAddress))
                .storeAddress(Address.parse(opts.ownerAddress))
                .storeCoins(toNano(opts.receivedJettonAmount.toFixed(9)))
                .endCell(),
        });
    }
    async sendProxy(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            jettonWalletAddress: string;
            toOwnerAddress: string;
            jettonAmount: number;
            responseAddress: string;
            forwardTonAmount?: number;
            forwardPayload?: Cell;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonProxyOpCodes.crossChainLayerAddress_evmMsgToTVMproxy, 32)
                .storeUint(opts.queryId || 0, 64)
                .storeAddress(Address.parse(opts.jettonWalletAddress))
                .storeAddress(Address.parse(opts.toOwnerAddress))
                .storeCoins(toNano(opts.jettonAmount.toFixed(9)))
                .storeAddress(Address.parse(opts.responseAddress))
                .storeCoins(toNano(opts.forwardTonAmount?.toFixed(9) || 0))
                .storeMaybeRef(opts.forwardPayload)
                .endCell(),
        });
    }

    async sendChangeAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts?: {
            queryId?: number;
            adminAddress?: string;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonProxyOpCodes.admin_changeAdminAddress, Params.bitsize.op)
                .storeUint(opts?.queryId || 0, Params.bitsize.queryId)
                .storeAddress(opts?.adminAddress ? Address.parse(opts.adminAddress) : null)
                .endCell(),
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
                .storeUint(JettonProxyOpCodes.admin_cancelChangingAdminAddress, Params.bitsize.op)
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
                .storeUint(JettonProxyOpCodes.newAdmin_confirmChangingAdminAddress, Params.bitsize.op)
                .storeUint(opts?.queryId || 0, Params.bitsize.queryId)
                .endCell(),
        });
    }

    async sendUpdateCode(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: {
            queryId?: number;
            code: Cell;
            data: Cell;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(JettonProxyOpCodes.admin_updateCode, Params.bitsize.op)
                .storeUint(opts.queryId || 0, Params.bitsize.queryId)
                .storeRef(opts.code)
                .storeRef(opts.data)
                .endCell(),
        });
    }

    async getFullData(provider: ContractProvider): Promise<JettonProxyConfig> {
        const result = await provider.get('get_full_data', []);

        const crossChainLayerAddress = result.stack.readAddress().toString();
        const adminAddress = result.stack.readAddress().toString();
        const newAdminAddress = result.stack.readAddressOpt()?.toString();

        return {
            crossChainLayerAddress,
            adminAddress,
            newAdminAddress,
        };
    }
}
