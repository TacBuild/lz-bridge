package entity

import (
	"math/big"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/tvm/cell"
)

type EthUsdtTreasuryData struct {
	JettonMasterAddress   *address.Address `json:"jettonMasterAddress"`
	JettonWalletCode      *cell.Cell       `json:"jettonWalletCode"`
	OAppAddress           *address.Address `json:"oAppAddress"`
	DstEvmAddress         *big.Int         `json:"dstEvmAddress"`
	EthEid                *big.Int         `json:"ethEid"`
	MaxBridgeAmount       *big.Int         `json:"tonProtocolFee"`
	NativeFee             *big.Int         `json:"nativeFee"`
	EstimatedGasCost      *big.Int         `json:"estimatedGasCost"`
	JettonTransferGasCost *big.Int         `json:"jettonTransferGasCost"`
	TreasuryFee           *big.Int         `json:"treasuryFee"`
}

func (u *EthUsdtTreasuryData) GetTONValue() *big.Int {
	totalValue := new(big.Int)
	totalValue.Add(totalValue, u.NativeFee)
	totalValue.Add(totalValue, u.EstimatedGasCost)
	totalValue.Add(totalValue, u.JettonTransferGasCost)
	totalValue.Add(totalValue, u.TreasuryFee)
	return totalValue
}

func (u *EthUsdtTreasuryData) GetMinTonValue() *big.Int {
	totalValue := new(big.Int)
	totalValue.Add(totalValue, u.JettonTransferGasCost)
	totalValue.Add(totalValue, u.TreasuryFee)
	return totalValue
}
