package contracts

import (
	"context"
	"math/big"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/ton"
)

type UsdtWallet struct {
	BaseContract
}

func NewUsdtWallet(api ton.APIClientWrapped, name string, address *address.Address) *UsdtWallet {
	return &UsdtWallet{
		BaseContract: *NewBaseContract(api, name, address),
	}
}

func (c *UsdtWallet) GetBalance(
	ctx context.Context,
) (*big.Int, error) {

	result, err := c.view(
		ctx,
		"get_wallet_data",
	)
	if err != nil {
		return nil, err
	}

	balance, err := result.Int(0)
	if err != nil {
		return nil, err
	}

	return balance, nil
}
