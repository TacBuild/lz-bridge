package entity

import (
	"math/big"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/tvm/cell"
)

type UsdtTreasuryData struct {
	EVMData                 *cell.Cell       `json:"evmData"`
	CCLJettonProxyAddress   *address.Address `json:"cclJettonProxyAddress"`
	JettonMasterAddress     *address.Address `json:"jettonMasterAddress"`
	JettonWalletCode        *cell.Cell       `json:"jettonWalletCode"`
	CCLProtocolFee          *big.Int         `json:"cclProtocolFee"`
	TACProtocolFee          *big.Int         `json:"tacProtocolFee"`
	TONProtocolFee          *big.Int         `json:"tonProtocolFee"`
	JettonTransferTonAmount *big.Int         `json:"jettonTransferTonAmount"`
	TreasuryFee             *big.Int         `json:"treasuryFee"`
}

func (u *UsdtTreasuryData) GetTONValue() *big.Int {
	totalValue := new(big.Int)
	totalValue.Add(totalValue, u.CCLProtocolFee)
	totalValue.Add(totalValue, u.TACProtocolFee)
	totalValue.Add(totalValue, u.TONProtocolFee)
	totalValue.Add(totalValue, u.JettonTransferTonAmount)
	totalValue.Add(totalValue, u.TreasuryFee)
	return totalValue
}
