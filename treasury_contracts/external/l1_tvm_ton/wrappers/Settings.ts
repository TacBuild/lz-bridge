import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    Sender,
    SendMode,
} from '@ton/core';
import { StorageStats } from './utils/GasUtils';

export type SettingsConfig = {
    settingsId?: number;
    settings: Dictionary<bigint, Cell>;
    adminAddress: Address;
    newAdminAddress?: Address;
};

export type SendValueParams = {
    queryId?: number;
    key: bigint;
    value: Cell;
};

export type ChangeAdminParams = {
    queryId?: number;
    adminAddress: Address;
};

export type GetValueParams = {
    queryId?: number;
    key: bigint;
};

export type SettingsValue = {
    found: boolean;
    value: Cell | null;
};

export type AdminAddresses = {
    adminAddress: Address;
    newAdminAddress: Address | undefined;
};

export const SettingsOpCodes = {
    admin_setValue: 0x245e9406,
    admin_changeAdmin: 0x581879bc,
    admin_cancelChangingAdmin: 0x60094a1b,

    newAdmin_confirmChangingAdmin: 0x6a4fbe34,

    anyone_getValue: 0x399685b8,
    anyone_getAll: 0x40148d4a,

    settings_sendValue: 0x707a28d2,
    settings_sendAll: 0xcf03b318,
};

export const SettingsErrors = {
    noErrors: 0,

    notFromAdmin: 70,
    notFromNewAdmin: 71,

    newAdminAddressIsNone: 80,

    notEnoughTon: 100,
};

export function settingsConfigToCell(config: SettingsConfig): Cell {
    return beginCell()
        .storeUint(config.settingsId ?? 0, 8)
        .storeAddress(config.adminAddress)
        .storeAddress(config.newAdminAddress ?? null)
        .storeDict(config.settings)
        .endCell();
}

export class Settings implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
        readonly configuration?: SettingsConfig,
    ) {}

    static minStorageDuration = 10 * 365 * 24 * 3600; // 10 years
    static minStorageStats = new StorageStats(29557n, 104n);

    static createFromAddress(address: Address) {
        return new Settings(address);
    }

    static createFromConfig(config: SettingsConfig, code: Cell, workchain = 0) {
        const data = settingsConfigToCell(config);
        const init = { code, data };

        return new Settings(contractAddress(workchain, init), init, config);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    async sendSetValue(provider: ContractProvider, via: Sender, value: bigint, params: SendValueParams) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SettingsOpCodes.admin_setValue, 32)
                .storeUint(params.queryId ?? 0, 64)
                .storeUint(params.key, 256)
                .storeRef(params.value)
                .endCell(),
        });
    }

    async sendGetValue(provider: ContractProvider, via: Sender, value: bigint, params: GetValueParams) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SettingsOpCodes.anyone_getValue, 32)
                .storeUint(params.queryId ?? 0, 64)
                .storeUint(params.key, 256)
                .endCell(),
        });
    }

    async sendGetAll(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params?: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SettingsOpCodes.anyone_getAll, 32)
                .storeUint(params?.queryId ?? 0, 64)
                .endCell(),
        });
    }

    async sendChangeAdmin(provider: ContractProvider, via: Sender, value: bigint, params?: ChangeAdminParams) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SettingsOpCodes.admin_changeAdmin, 32)
                .storeUint(params?.queryId ?? 0, 64)
                .storeAddress(params?.adminAddress ?? null)
                .endCell(),
        });
    }

    async sendCancelChangingAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params?: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SettingsOpCodes.admin_cancelChangingAdmin, 32)
                .storeUint(params?.queryId ?? 0, 64)
                .endCell(),
        });
    }

    async sendConfirmChangingAdmin(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        params?: {
            queryId?: number;
        },
    ) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(SettingsOpCodes.newAdmin_confirmChangingAdmin, 32)
                .storeUint(params?.queryId ?? 0, 64)
                .endCell(),
        });
    }

    async getValue(provider: ContractProvider, key: bigint): Promise<SettingsValue> {
        const { stack } = await provider.get('get', [{ type: 'int', value: key }]);
        return {
            value: stack.readCellOpt(),
            found: stack.readBoolean(),
        };
    }

    async getAdminAddresses(provider: ContractProvider): Promise<AdminAddresses> {
        const { stack } = await provider.get('get_admin_addresses', []);
        return {
            adminAddress: stack.readAddress(),
            newAdminAddress: stack.readAddressOpt() ?? undefined,
        };
    }

    async getAll(provider: ContractProvider): Promise<Cell> {
        const { stack } = await provider.get('get_all', []);
        return stack.readCellOpt() ?? beginCell().endCell();
    }

    async getFullData(provider: ContractProvider): Promise<SettingsConfig> {
        const { stack } = await provider.get('get_full_data', []);

        const settingsId = stack.readNumber();
        const adminAddress = stack.readAddress();
        const newAdminAddress = stack.readAddressOpt() ?? undefined;
        const settings = stack.readCellOpt();

        return {
            settingsId,
            adminAddress,
            newAdminAddress,
            settings:
                settings?.beginParse().loadDictDirect(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()) ??
                Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell()),
        };
    }
}
