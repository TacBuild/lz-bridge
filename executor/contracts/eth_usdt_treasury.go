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

const USDT_TREASURY_BRIDGE_TO_ETH uint64 = 0x2906ab02

type EthUsdtTreasuryContract struct {
	BaseContract
}

func NewEthUsdtTreasuryContract(api ton.APIClientWrapped, name string, address *address.Address) *EthUsdtTreasuryContract {
	return &EthUsdtTreasuryContract{
		BaseContract: *NewBaseContract(api, name, address),
	}
}

func (c *EthUsdtTreasuryContract) GetData(
	ctx context.Context,
) (*entity.EthUsdtTreasuryData, error) {

	result, err := c.view(
		ctx,
		"get_full_data",
	)
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

	oAppAddress, err := result.Slice(4)
	if err != nil {
		return nil, err
	}
	oAppAddr, err := oAppAddress.LoadAddr()
	if err != nil {
		return nil, err
	}

	dstEvmAddress, err := result.Int(5)
	if err != nil {
		return nil, err
	}

	ethEid, err := result.Int(6)
	if err != nil {
		return nil, err
	}

	maxBridgeAmount, err := result.Int(6)
	if err != nil {
		return nil, err
	}

	nativeFee, err := result.Int(7)
	if err != nil {
		return nil, err
	}

	estimatedGasCost, err := result.Int(8)
	if err != nil {
		return nil, err
	}

	jettonTransferGasCost, err := result.Int(9)
	if err != nil {
		return nil, err
	}

	treasuryFee, err := result.Int(10)
	if err != nil {
		return nil, err
	}

	return &entity.EthUsdtTreasuryData{
		JettonMasterAddress:   jettonMasterAddr,
		JettonWalletCode:      jettonWalletCode,
		OAppAddress:           oAppAddr,
		EthEid:                ethEid,
		MaxBridgeAmount:       maxBridgeAmount,
		DstEvmAddress:         dstEvmAddress,
		NativeFee:             nativeFee,
		EstimatedGasCost:      estimatedGasCost,
		JettonTransferGasCost: jettonTransferGasCost,
		TreasuryFee:           treasuryFee,
	}, nil
}

func (c *EthUsdtTreasuryContract) GetBalance(ctx context.Context) (*big.Int, error) {
	block, err := c.api.CurrentMasterchainInfo(ctx)
	if err != nil {
		return nil, err
	}
	state, err := c.api.GetAccount(ctx, block, c.Address())
	if err != nil {
		return nil, err
	}

	balance := state.State.Balance.Nano()

	return balance, nil
}

func (c *EthUsdtTreasuryContract) TriggerBridge(ctx context.Context, sender *wallet.Wallet, amount *big.Int, value *big.Int) error {
	fmt.Println("trigger bridge ton->eth")
	body := cell.BeginCell().
		MustStoreUInt(USDT_TREASURY_BRIDGE_TO_ETH, 32).
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
