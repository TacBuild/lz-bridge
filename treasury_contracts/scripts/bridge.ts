import { beginCell, Cell, Slice, toNano, ContractProvider, SendMode, Sender } from '@ton/core';
import { Address } from '@ton/ton';
import { compile, NetworkProvider } from '@ton/blueprint';
  
const JETTON_TRANSFER_GAS = 0.07;

import {
  buildClass,
  decodeClass,
  emptyCell,
  generateBuildClass,
  generateDecodeClass,
} from '@layerzerolabs/lz-ton-sdk-v2';
import {tonObjects} from './allObjects';

const oftBuildClass = generateBuildClass(tonObjects);

export function buildOFTSendPayload({
    dstEid,
    dstEvmAddress,
    minAmount,
    nativeFee,
    zroFee = 0n,
    extraOptions = beginCell().endCell(),
    composeMessage = beginCell().storeUint(0, 1).endCell(),
}: {
        dstEid: number;
        dstEvmAddress: string;
        minAmount: bigint;
        nativeFee: bigint;
        zroFee?: bigint;
        extraOptions?: Cell;
        composeMessage?: Cell;
}) {
    return oftBuildClass('OFTSend', {
      dstEid: BigInt(dstEid),
      to: BigInt(dstEvmAddress),
      minAmount: minAmount,
      nativeFee,
      zroFee: zroFee,
      extraOptions,
      composeMessage,
    });
}

function buildTonTransferCell(
    opts: {
        fromAddress?: Address;
        toAddress: Address;
        queryId?: number;
        fwdAmount: bigint;
        jettonAmount: bigint;
        forwardPayload?: Cell | Slice | null;
}) {
    const builder = beginCell()
        .storeUint(0xf8a7ea5, 32)
        .storeUint(opts.queryId ?? 0, 64)
        .storeCoins(opts.jettonAmount)
        .storeAddress(opts.toAddress)
        .storeAddress(opts.fromAddress ?? null)
        .storeUint(0, 1)
        .storeCoins(opts.fwdAmount);

    if (opts.forwardPayload instanceof Slice) {
        builder.storeBit(0).storeSlice(opts.forwardPayload);
    } else if (opts.forwardPayload instanceof Cell) {
        builder.storeBit(1).storeRef(opts.forwardPayload);
    } else {
        builder.storeBit(0);
    }

    return builder.endCell();
}

export async function sendJettonBridgeTransfer(
    via: Sender,
    jettonWalletAddress: Address,
    oAppAddress: Address,
    dstEvmAddress: string,
    jettonAmount: bigint,
    nativeFee: bigint = toNano('0.5'),
    estimatedGasCost: bigint = toNano('0.5')
) {
    const oftSend = buildOFTSendPayload({
        dstEid: 30101,
        dstEvmAddress,
        minAmount: 0n,
        nativeFee,
    });

    const transferBody = buildTonTransferCell({
        toAddress: oAppAddress,
        fromAddress: via.address,
        fwdAmount: nativeFee + estimatedGasCost,
        jettonAmount,
        forwardPayload: oftSend,
    });
    
    const value = nativeFee + estimatedGasCost + toNano(JETTON_TRANSFER_GAS);

    await via.send({
        to: jettonWalletAddress,
        value: value,
        body: transferBody,
        sendMode: SendMode.PAY_GAS_SEPARATELY,
    });
}

export async function run(provider: NetworkProvider) {
    const jettonWalletAddress = Address.parse("EQCdPG4yzLb5cy-6cx0NPpSjuMRyYKEqcfMXfaFo_ulNA0gn");
    const oAppAddress = Address.parse("EQAXByU5SqVhNvvSfQzjHYqY4PiucqTSN5td3oPiEaLV-p0-");
    const dstEvm = "0x84Cb8Be69037069E35147C9C18350Ed8895877FD";

    await sendJettonBridgeTransfer(
      provider.sender(),
      jettonWalletAddress,
      oAppAddress,
      dstEvm,
      1_000n,
    );
}