import { beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { Blockchain, BlockchainSnapshot, printTransactionFees, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Settings, SettingsErrors, SettingsOpCodes } from '../wrappers/Settings';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { calculateFeesData, calculateMaxStorageState, getStorageFee } from './utils';
import { sha256toBigInt } from '../wrappers/utils/sha256';

describe('Settings', () => {
    let code: Cell;
    let blockchain: Blockchain;
    let settingsContract: SandboxContract<Settings>;
    let admin: SandboxContract<TreasuryContract>;
    let anyone: SandboxContract<TreasuryContract>;

    let adminAddress: string;
    let newAdminAddress: string | undefined;
    let settingsId: number;
    let settings: Dictionary<bigint, Cell>;

    let initState: BlockchainSnapshot;

    async function checkFullData() {
        if ((await blockchain.getContract(settingsContract.address)).accountState?.type === 'frozen') return;
        const data = await settingsContract.getFullData();
        expect(data.settingsId).toBe(settingsId);
        expect(data.adminAddress.toString()).toBe(adminAddress);
        expect(data.newAdminAddress?.toString()).toBe(newAdminAddress);

        const receivedSettingsCell =
            data.settings.size > 0 ? beginCell().storeDictDirect(data.settings).endCell() : beginCell().endCell();
        const expectedSettingsCell =
            settings.size > 0 ? beginCell().storeDictDirect(settings).endCell() : beginCell().endCell();
        expect(receivedSettingsCell).toEqualCell(expectedSettingsCell);
    }

    beforeAll(async () => {
        code = await compile('Settings');

        blockchain = await Blockchain.create();
        admin = await blockchain.treasury('admin');
        anyone = await blockchain.treasury('anyone');

        adminAddress = admin.address.toString();
        newAdminAddress = undefined;
        settingsId = 0;
        settings = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());

        settingsContract = blockchain.openContract(
            Settings.createFromConfig(
                {
                    settingsId,
                    settings,
                    adminAddress: admin.address,
                    newAdminAddress: undefined,
                },
                code,
            ),
        );
        await settingsContract.sendDeploy(admin.getSender(), toNano(0.05));

        await checkFullData();

        initState = blockchain.snapshot();
    });

    afterEach(async () => {
        await checkFullData();

        adminAddress = admin.address.toString();
        newAdminAddress = undefined;
        settingsId = 0;
        settings = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());

        settingsContract = blockchain.openContract(
            Settings.createFromConfig(
                {
                    settingsId,
                    settings,
                    adminAddress: admin.address,
                    newAdminAddress: undefined,
                },
                code,
            ),
        );

        await blockchain.loadFrom(initState);
    });

    describe('S-1: storage gas stats', () => {
        it('S-1.1: (empty settings) estimate storage usage(bits and cells)', async () => {
            await calculateMaxStorageState(blockchain, 'Settings', settingsContract.address);
        });

        it('S-1.2: (default settings) estimate storage usage(bits and cells)', async () => {
            const jettonMinterCode = await compile('JettonMinter');
            const nftCollectionCode = await compile('NFTCollection');
            const multisigV1Code = await compile('MultisigV1');

            const jettonWalletCodeRaw = await compile('JettonWallet');
            const nftItemCodeRaw = await compile('NFTItem');
            const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
            _libs.set(BigInt(`0x${jettonWalletCodeRaw.hash().toString('hex')}`), jettonWalletCodeRaw);
            _libs.set(BigInt(`0x${nftItemCodeRaw.hash().toString('hex')}`), nftItemCodeRaw);
            blockchain.libs = beginCell().storeDictDirect(_libs).endCell();
            let lib_jetton_prep = beginCell().storeUint(2, 8).storeBuffer(jettonWalletCodeRaw.hash()).endCell();
            const jettonWalletCode = new Cell({ exotic: true, bits: lib_jetton_prep.bits, refs: lib_jetton_prep.refs });
            let lib_nft_item_prep = beginCell().storeUint(2, 8).storeBuffer(nftItemCodeRaw.hash()).endCell();
            const nftItemCode = new Cell({ exotic: true, bits: lib_nft_item_prep.bits, refs: lib_nft_item_prep.refs });

            settings.set(sha256toBigInt('CrossChainLayerAddress'), beginCell().storeAddress(anyone.address).endCell());
            settings.set(sha256toBigInt('MerkleTreeDuration'), beginCell().storeUint(608800, 64).endCell());
            settings.set(sha256toBigInt('MaxEpochDuration'), beginCell().storeUint(86400, 64).endCell());
            settings.set(sha256toBigInt('JettonProxyAddress'), beginCell().storeAddress(anyone.address).endCell());
            settings.set(sha256toBigInt('NFTProxyAddress'), beginCell().storeAddress(anyone.address).endCell());
            settings.set(sha256toBigInt('JettonWalletCode'), jettonWalletCode);
            settings.set(sha256toBigInt('JettonMinterCode'), jettonMinterCode);
            settings.set(sha256toBigInt('NFTItemCode'), nftItemCode);
            settings.set(sha256toBigInt('NFTCollectionCode'), nftCollectionCode);
            settings.set(sha256toBigInt('MultisigV1Code'), multisigV1Code);
            settings.set(
                sha256toBigInt('NFTPrefixURI'),
                beginCell().storeStringTail('https://nft.tac.build').endCell(),
            );

            settingsContract = blockchain.openContract(
                Settings.createFromConfig(
                    {
                        settings: settings,
                        adminAddress: admin.address,
                    },
                    code,
                ),
            );
            const result = await settingsContract.sendDeploy(admin.getSender(), toNano(1));

            printTransactionFees(result.transactions);

            await calculateMaxStorageState(blockchain, 'Settings', settingsContract.address);
        });
    });

    describe('S-2: set value', () => {
        it('S-2.1: should reject if there are not enough TONs', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const key = BigInt(1);
            const value = 123;
            const valueBitSize = 10;

            const tonAmount = getStorageFee(
                blockchain,
                initBalance,
                Settings.minStorageStats,
                Settings.minStorageDuration,
            );
            const result = await settingsContract.sendSetValue(admin.getSender(), tonAmount, {
                key,
                value: beginCell().storeUint(value, valueBitSize).endCell(),
            });
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.admin_setValue, 32)
                    .storeUint(0, 64)
                    .storeUint(key, 256)
                    .storeRef(beginCell().storeUint(value, valueBitSize).endCell())
                    .endCell(),
                success: false,
                exitCode: SettingsErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: admin.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            const returnedValue = await settingsContract.getValue(key);
            expect(returnedValue.found).toBe(false);

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-2.2: should reject set value request not from admin', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const key = BigInt(1);
            const value = 123;
            const valueBitSize = 10;

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendSetValue(anyone.getSender(), tonAmount, {
                key,
                value: beginCell().storeUint(value, valueBitSize).endCell(),
            });
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.admin_setValue, 32)
                    .storeUint(0, 64)
                    .storeUint(key, 256)
                    .storeRef(beginCell().storeUint(value, valueBitSize).endCell())
                    .endCell(),
                success: false,
                exitCode: SettingsErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: anyone.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            const returnedValue = await settingsContract.getValue(key);
            expect(returnedValue.found).toBe(false);

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-2.3: should set new value', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const key = BigInt(1);
            const value = 123;
            const valueBitSize = 10;
            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendSetValue(admin.getSender(), tonAmount, {
                key,
                value: beginCell().storeUint(value, valueBitSize).endCell(),
            });
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.admin_setValue, 32)
                    .storeUint(0, 64)
                    .storeUint(key, 256)
                    .storeRef(beginCell().storeUint(value, valueBitSize).endCell())
                    .endCell(),
                success: true,
            });
            const returnedValue = await settingsContract.getValue(key);
            expect(returnedValue.found).toBe(true);
            expect(returnedValue.value?.beginParse().loadUint(valueBitSize)).toBe(value);

            settings.set(key, beginCell().storeUint(value, valueBitSize).endCell());

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-2.4: should update already existing value', async () => {
            const initBalanceForStorageFee = (await blockchain.getContract(settingsContract.address)).balance;
            const key = BigInt(1);

            const value = 123;
            const valueBitSize = 10;
            const newValue = 456;

            let tonAmount =
                getStorageFee(
                    blockchain,
                    initBalanceForStorageFee,
                    Settings.minStorageStats,
                    Settings.minStorageDuration,
                ) + toNano(0.1);
            await settingsContract.sendSetValue(admin.getSender(), tonAmount, {
                key,
                value: beginCell().storeUint(value, valueBitSize).endCell(),
            });

            settings.set(key, beginCell().storeUint(value, valueBitSize).endCell());

            await checkFullData();

            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;
            tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendSetValue(admin.getSender(), tonAmount, {
                key,
                value: beginCell().storeUint(newValue, valueBitSize).endCell(),
            });
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.admin_setValue, 32)
                    .storeUint(0, 64)
                    .storeUint(key, 256)
                    .storeRef(beginCell().storeUint(newValue, valueBitSize).endCell())
                    .endCell(),
                success: true,
            });

            const returnedValue = await settingsContract.getValue(key);
            expect(returnedValue.found).toBe(true);
            expect(returnedValue.value?.beginParse().loadUint(valueBitSize)).toBe(newValue);

            settings.set(key, beginCell().storeUint(newValue, valueBitSize).endCell());

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-2.5: should handle multiple key-values', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const key1 = BigInt(1);
            const value1 = 123;
            const key2 = BigInt(10);
            const value2 = 123;
            const valueBitSize = 10;

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            await settingsContract.sendSetValue(admin.getSender(), tonAmount, {
                key: key1,
                value: beginCell().storeUint(value1, valueBitSize).endCell(),
            });
            await settingsContract.sendSetValue(admin.getSender(), tonAmount, {
                key: key2,
                value: beginCell().storeUint(value2, valueBitSize).endCell(),
            });

            settings.set(key1, beginCell().storeUint(value1, valueBitSize).endCell());
            settings.set(key2, beginCell().storeUint(value2, valueBitSize).endCell());

            const returnedValue1 = await settingsContract.getValue(key1);
            expect(returnedValue1.found).toBe(true);
            expect(returnedValue1.value?.beginParse().loadUint(valueBitSize)).toBe(value1);

            const returnedValue2 = await settingsContract.getValue(key2);
            expect(returnedValue2.found).toBe(true);
            expect(returnedValue2.value?.beginParse().loadUint(valueBitSize)).toBe(value2);
        });
    });

    describe('S-3: change admin', () => {
        it('S-3.1: should reject if there are not enough TONs', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount = getStorageFee(
                blockchain,
                initBalance,
                Settings.minStorageStats,
                Settings.minStorageDuration,
            );
            const result = await settingsContract.sendChangeAdmin(admin.getSender(), tonAmount, {
                adminAddress: anyone.address,
            });
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.admin_changeAdmin, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                exitCode: SettingsErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: admin.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-3.2: should reject request not from admin', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendChangeAdmin(anyone.getSender(), tonAmount, {
                adminAddress: anyone.address,
            });
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.admin_changeAdmin, 32)
                    .storeUint(0, 64)
                    .storeAddress(anyone.address)
                    .endCell(),
                success: false,
                exitCode: SettingsErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: anyone.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-3.3: should throw error if new_admin_address is none', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendChangeAdmin(admin.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.admin_changeAdmin, 32)
                    .storeUint(0, 64)
                    .storeAddress(null)
                    .endCell(),
                success: false,
                exitCode: SettingsErrors.newAdminAddressIsNone,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: admin.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-3.4: should save new_admin address', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const newAdmin = await blockchain.treasury('newAdmin');
            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendChangeAdmin(admin.getSender(), tonAmount, {
                adminAddress: newAdmin.address,
            });
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.admin_changeAdmin, 32)
                    .storeUint(0, 64)
                    .storeAddress(newAdmin.address)
                    .endCell(),
                success: true,
            });

            newAdminAddress = newAdmin.address.toString();

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });
    });

    describe('S-4: cancel changing admin', () => {
        beforeEach(async () => {
            const newAdmin = await blockchain.treasury('newAdmin');
            newAdminAddress = newAdmin.address.toString();

            settingsContract = blockchain.openContract(
                Settings.createFromConfig(
                    {
                        settings: settings,
                        adminAddress: admin.address,
                        newAdminAddress: newAdmin.address,
                    },
                    code,
                ),
            );
            await settingsContract.sendDeploy(admin.getSender(), toNano(0.05));
            await checkFullData();
        });

        it('S-4.1: should reject if there are not enough TONs', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount = getStorageFee(
                blockchain,
                initBalance,
                Settings.minStorageStats,
                Settings.minStorageDuration,
            );
            const result = await settingsContract.sendCancelChangingAdmin(admin.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell().storeUint(SettingsOpCodes.admin_cancelChangingAdmin, 32).storeUint(0, 64).endCell(),
                success: false,
                exitCode: SettingsErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: admin.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-4.2: should reject request not from admin', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendCancelChangingAdmin(anyone.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: settingsContract.address,
                body: beginCell().storeUint(SettingsOpCodes.admin_cancelChangingAdmin, 32).storeUint(0, 64).endCell(),
                success: false,
                exitCode: SettingsErrors.notFromAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: anyone.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-4.3: should cancel new admin', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendCancelChangingAdmin(admin.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell().storeUint(SettingsOpCodes.admin_cancelChangingAdmin, 32).storeUint(0, 64).endCell(),
                success: true,
            });

            newAdminAddress = undefined;

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });
    });

    describe('S-5: confirm changing admin', () => {
        beforeEach(async () => {
            const newAdmin = await blockchain.treasury('newAdmin');
            newAdminAddress = newAdmin.address.toString();

            settingsContract = blockchain.openContract(
                Settings.createFromConfig(
                    {
                        settings: settings,
                        adminAddress: admin.address,
                        newAdminAddress: newAdmin.address,
                    },
                    code,
                ),
            );
            await settingsContract.sendDeploy(admin.getSender(), toNano(0.05));

            await checkFullData();
        });

        it('S-5.1: should reject if there are not enough TONs', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;
            const newAdmin = await blockchain.treasury('newAdmin');

            const tonAmount = getStorageFee(
                blockchain,
                initBalance,
                Settings.minStorageStats,
                Settings.minStorageDuration,
            );
            const result = await settingsContract.sendConfirmChangingAdmin(newAdmin.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: newAdmin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.newAdmin_confirmChangingAdmin, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: false,
                exitCode: SettingsErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: newAdmin.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-5.2: should reject request not from admin', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendConfirmChangingAdmin(admin.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions.length).toBe(3);

            expect(result.transactions).toHaveTransaction({
                from: admin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.newAdmin_confirmChangingAdmin, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: false,
                exitCode: SettingsErrors.notFromNewAdmin,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: admin.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-5.3: should change admin', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;
            const newAdmin = await blockchain.treasury('newAdmin');

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendConfirmChangingAdmin(newAdmin.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: newAdmin.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.newAdmin_confirmChangingAdmin, 32)
                    .storeUint(0, 64)
                    .endCell(),
                success: true,
            });

            adminAddress = newAdmin.address.toString();
            newAdminAddress = undefined;

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });
    });

    describe('S-6: get value', () => {
        beforeEach(async () => {
            settings.set(BigInt(1), beginCell().storeUint(123, 10).endCell());

            settingsContract = blockchain.openContract(
                Settings.createFromConfig(
                    {
                        settings: settings,
                        adminAddress: admin.address,
                    },
                    code,
                ),
            );
            await settingsContract.sendDeploy(admin.getSender(), toNano(0.05));
        });

        it('S-6.1: should reject if there are not enough TONs', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const key = BigInt(1);
            const tonAmount = getStorageFee(
                blockchain,
                initBalance,
                Settings.minStorageStats,
                Settings.minStorageDuration,
            );
            const result = await settingsContract.sendGetValue(anyone.getSender(), tonAmount, {
                key,
            });
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.anyone_getValue, 32)
                    .storeUint(0, 64)
                    .storeUint(key, 256)
                    .endCell(),
                success: false,
                exitCode: SettingsErrors.notEnoughTon,
            });
            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: anyone.address,
                success: true,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-6.2: should get value', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const key = BigInt(1);
            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendGetValue(anyone.getSender(), tonAmount, {
                key,
            });
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: settingsContract.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.anyone_getValue, 32)
                    .storeUint(0, 64)
                    .storeUint(key, 256)
                    .endCell(),
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            const returnedValue = settings.get(key);
            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: anyone.address,
                body: beginCell()
                    .storeUint(SettingsOpCodes.settings_sendValue, 32)
                    .storeUint(0, 64)
                    .storeUint(key, 256)
                    .storeMaybeRef(returnedValue)
                    .endCell(),
                success: true,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });
    });

    describe('S-7: get all', () => {
        beforeEach(async () => {
            settings.set(BigInt(1), beginCell().storeUint(123, 10).endCell());
            settings.set(BigInt(10), beginCell().storeUint(123, 10).endCell());

            settingsContract = blockchain.openContract(
                Settings.createFromConfig(
                    {
                        settings: settings,
                        adminAddress: admin.address,
                    },
                    code,
                ),
            );
            await settingsContract.sendDeploy(admin.getSender(), toNano(0.05));
            await checkFullData();
        });

        it('S-7.1: should reject if there are not enough TONs', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount = getStorageFee(
                blockchain,
                initBalance,
                Settings.minStorageStats,
                Settings.minStorageDuration,
            );
            const result = await settingsContract.sendGetAll(anyone.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: settingsContract.address,
                body: beginCell().storeUint(SettingsOpCodes.anyone_getAll, 32).storeUint(0, 64).endCell(),
                success: false,
                exitCode: SettingsErrors.notEnoughTon,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: anyone.address,
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });

        it('S-7.2: should get all settings at once', async () => {
            const initBalance = (await blockchain.getContract(settingsContract.address)).balance;

            const tonAmount =
                getStorageFee(blockchain, initBalance, Settings.minStorageStats, Settings.minStorageDuration) +
                toNano(0.1);
            const result = await settingsContract.sendGetAll(anyone.getSender(), tonAmount);
            printTransactionFees(result.transactions);

            expect(result.transactions).toHaveTransaction({
                from: anyone.address,
                to: settingsContract.address,
                body: beginCell().storeUint(SettingsOpCodes.anyone_getAll, 32).storeUint(0, 64).endCell(),
                success: true,
                exitCode: SettingsErrors.noErrors,
            });

            expect(result.transactions).toHaveTransaction({
                from: settingsContract.address,
                to: anyone.address,
                success: true,
                body: beginCell()
                    .storeUint(SettingsOpCodes.settings_sendAll, 32)
                    .storeUint(0, 64)
                    .storeDict(settings)
                    .endCell(),
                exitCode: SettingsErrors.noErrors,
            });

            await calculateFeesData(blockchain, settingsContract, result, initBalance);
        });
    });

    describe('S-8: get methods', () => {
        let key1: bigint = BigInt(1);
        let value1: Cell = beginCell().storeUint(123, 10).endCell();
        let key2: bigint = BigInt(10);
        let value2: Cell = beginCell().storeUint(321, 10).endCell();

        beforeEach(async () => {
            settings.set(key1, value1);
            settings.set(key2, value2);

            settingsContract = blockchain.openContract(
                Settings.createFromConfig(
                    {
                        settings: settings,
                        adminAddress: admin.address,
                    },
                    code,
                ),
            );
            await settingsContract.sendDeploy(admin.getSender(), toNano(0.05));
            await checkFullData();
        });

        it('S-8.1: get_full_data', async () => {
            const data = await settingsContract.getFullData();
            expect(data.settingsId).toBe(settingsId);
            expect(data.adminAddress.toString()).toBe(adminAddress);
            expect(data.newAdminAddress?.toString()).toBe(newAdminAddress);

            const receivedSettingsCell =
                data.settings.size > 0 ? beginCell().storeDictDirect(data.settings).endCell() : beginCell().endCell();
            const expectedSettingsCell =
                settings.size > 0 ? beginCell().storeDictDirect(settings).endCell() : beginCell().endCell();
            expect(receivedSettingsCell).toEqualCell(expectedSettingsCell);
        });

        it('S-8.2: get', async () => {
            const data = await settingsContract.getValue(key1);
            expect(data.found).toBeTruthy();
            expect(data.value).toEqualCell(value1);
        });

        it('S-8.3: get_admin_addresses ', async () => {
            const data = await settingsContract.getAdminAddresses();
            expect(data.adminAddress.toString()).toBe(adminAddress);
            expect(data.newAdminAddress?.toString()).toBe(newAdminAddress);
        });

        it('S-8.4: get_all', async () => {
            const data = await settingsContract.getAll();
            const expectedSettingsCell =
                settings.size > 0 ? beginCell().storeDictDirect(settings).endCell() : beginCell().endCell();
            expect(data).toEqualCell(expectedSettingsCell);
        });
    });
});
