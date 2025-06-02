package contracts

import (
	"context"
	"executor/entity"
	"fmt"
	"math/big"
	"math/rand"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/tlb"
	"github.com/xssnick/tonutils-go/ton"
	"github.com/xssnick/tonutils-go/ton/wallet"
	"github.com/xssnick/tonutils-go/tvm/cell"
)

const USDT_TREASURY_BRIDGE_TO_TAC uint64 = 0x2906ab02

type TacUsdtTreasuryContract struct {
	BaseContract
}

func NewTacUsdtTreasuryContract(api ton.APIClientWrapped, name string, address *address.Address) *TacUsdtTreasuryContract {
	return &TacUsdtTreasuryContract{
		BaseContract: *NewBaseContract(api, name, address),
	}
}

func (c *TacUsdtTreasuryContract) GetData(
	ctx context.Context,
) (*entity.TacUsdtTreasuryData, error) {

	result, err := c.view(
		ctx,
		"get_full_data",
	)
	if err != nil {
		return nil, err
	}

	evmData, err := result.Cell(0)
	if err != nil {
		return nil, err
	}

	cclJettonProxyAddress, err := result.Slice(1)
	if err != nil {
		return nil, err
	}
	cclJettonProxyAddr, err := cclJettonProxyAddress.LoadAddr()
	if err != nil {
		return nil, err
	}

	jettonMasterAddress, err := result.Slice(2)
	if err != nil {
		return nil, err
	}
	jettonMasterAddr, err := jettonMasterAddress.LoadAddr()
	if err != nil {
		return nil, err
	}

	jettonWalletCode, err := result.Cell(3)
	if err != nil {
		return nil, err
	}

	cclProtocolFee, err := result.Int(4)
	if err != nil {
		return nil, err
	}

	tacExecutorFee, err := result.Int(5)
	if err != nil {
		return nil, err
	}

	tonExecutorFee, err := result.Int(6)
	if err != nil {
		return nil, err
	}

	jettonTransferTonAmount, err := result.Int(7)
	if err != nil {
		return nil, err
	}

	treasuryFee, err := result.Int(8)
	if err != nil {
		return nil, err
	}

	return &entity.TacUsdtTreasuryData{
		EVMData:                 evmData,
		CCLJettonProxyAddress:   cclJettonProxyAddr,
		JettonMasterAddress:     jettonMasterAddr,
		JettonWalletCode:        jettonWalletCode,
		CCLProtocolFee:          cclProtocolFee,
		TACProtocolFee:          tacExecutorFee,
		TONProtocolFee:          tonExecutorFee,
		JettonTransferTonAmount: jettonTransferTonAmount,
		TreasuryFee:             treasuryFee,
	}, nil
}

func (c *TacUsdtTreasuryContract) TriggerBridge(ctx context.Context, sender *wallet.Wallet, amount *big.Int, value *big.Int) error {
	fmt.Println("trigger bridge ton->tac")

	body := cell.BeginCell().
		MustStoreUInt(USDT_TREASURY_BRIDGE_TO_TAC, 32).
		MustStoreUInt(rand.Uint64(), 64).
		MustStoreBigCoins(amount).
		MustStoreMaybeRef(nil).
		EndCell()

	msg := &wallet.Message{
		Mode: wallet.PayGasSeparately,
		InternalMessage: &tlb.InternalMessage{
			Bounce:  true,
			DstAddr: c.address,
			Amount:  tlb.FromNanoTON(value),
			Body:    body,
		},
	}

	tx, _, err := sender.SendWaitTransaction(ctx, msg)
	if err != nil {
		return err
	}
	err = CheckTVMTransactionSuccess(tx)
	if err != nil {
		return err
	}

	return nil
}
