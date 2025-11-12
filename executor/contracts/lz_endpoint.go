package contracts

import (
	"context"
	"math/big"

	"github.com/xssnick/tonutils-go/address"
	"github.com/xssnick/tonutils-go/ton"
)

type LzEndpointContract struct {
	BaseContract
}

func NewLzEndpointContract(api ton.APIClientWrapped, name string, address *address.Address) *LzEndpointContract {
	return &LzEndpointContract{
		BaseContract: *NewBaseContract(api, name, address),
	}
}

func (c *LzEndpointContract) GetEthCredit(
	ctx context.Context,
) (*big.Int, error) {
	
	result, err := c.view(
		ctx,
		"getAllCredits",
	)
	if err != nil {
		return nil, err
	}

	ethCredit, err := result.Int(2)
	if err != nil {
		return nil, err
	}

	return ethCredit, nil
}
